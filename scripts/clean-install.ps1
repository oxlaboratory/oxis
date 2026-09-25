<#
.SYNOPSIS
  Removes stale OXIS files and registry entries before installing a fresh
  build. Run it BEFORE extracting a new dist/ zip or running a new MSI.

.DESCRIPTION
  An MSI upgrade replaces the previous install cleanly. A portable dist/
  folder doesn't: extracting a new zip on top of an old one keeps the
  old workspaces/registry.json and workspace files, so old tasks and
  workspaces show up in what looks like a fresh install. This script
  clears that data.

  It only removes what it can identify as OXIS's own (a folder with
  oxis.exe next to it, or the MSI's registry keys). It never touches
  projects you connected with 'workspace link.

  It shows what it found and asks before deleting anything, unless run
  with -Force.

.PARAMETER DistPath
  Path to a portable dist/ folder to clean (the "Downloads\oxis-full-
  v.../dist" style folder this script exists for). Optional - if
  omitted, only the MSI-installed location and registry keys are
  checked.

.PARAMETER Force
  Skip confirmation prompts. For scripted/CI use - an interactive user
  should almost always leave this off and read what's about to happen.

.EXAMPLE
  .\clean-install.ps1 -DistPath "C:\Users\Admin\Downloads\oxis-full-v1.2.1\oxis-full\dist"
  # Review what it finds, confirm, then extract your new zip into a
  # clean folder afterward.

.EXAMPLE
  .\clean-install.ps1
  # Just cleans up a previous MSI install + its registry keys, if any
  # - do this before running a newly downloaded .msi.
#>

param(
  [string]$DistPath,
  [switch]$Force
)

$ErrorActionPreference = "Stop"

function Confirm-Action($Message) {
  if ($Force) { return $true }
  $answer = Read-Host "$Message [y/N]"
  return $answer -match '^[Yy]'
}

Write-Host "OXIS clean-install helper" -ForegroundColor Cyan
Write-Host "This removes STALE OXIS data before a fresh install - it never touches your own projects." -ForegroundColor DarkGray
Write-Host ""

# -- 1. Stop any running OXIS process --------------------------------
$running = Get-Process -Name "oxis" -ErrorAction SilentlyContinue
if ($running) {
  Write-Host "Found $($running.Count) running oxis.exe process(es)."
  if (Confirm-Action "Stop them before continuing?") {
    $running | Stop-Process -Force
    Write-Host "  stopped." -ForegroundColor Green
  } else {
    Write-Host "  left running - files may fail to delete while OXIS is open." -ForegroundColor Yellow
  }
}
Write-Host ""

# -- 2. MSI-installed location + registry keys -----------------------
# Newer MSIs install under the user profile; older ones used Program Files.
foreach ($installDir in @((Join-Path $env:USERPROFILE "OXIS"), (Join-Path ${env:ProgramFiles} "OXIS"))) {
  if (-not (Test-Path (Join-Path $installDir "oxis.exe"))) { continue }
  Write-Host "Found an installed OXIS at: $installDir"
  if (Confirm-Action "Remove it? (Use Windows' 'Uninstall OXIS' first if it's still listed; this is for a broken or partial uninstall.)") {
    Remove-Item -Recurse -Force $installDir
    Write-Host "  removed." -ForegroundColor Green
  }
}
foreach ($regPath in @("HKLM:\Software\OXIS", "HKCU:\Software\OXIS")) {
  if (Test-Path $regPath) {
    Write-Host "Found leftover registry key: $regPath"
    if (Confirm-Action "Remove it?") {
      Remove-Item -Recurse -Force $regPath
      Write-Host "  removed." -ForegroundColor Green
    }
  }
}
Write-Host ""

# -- 3. A portable dist/ folder, if one was given --------------------
if ($DistPath) {
  $exePath = Join-Path $DistPath "oxis.exe"
  if (-not (Test-Path $exePath)) {
    Write-Host "No oxis.exe found at $DistPath - nothing to clean there (refusing to touch a folder that doesn't look like an OXIS dist/ folder)." -ForegroundColor Yellow
  } else {
    Write-Host "Found a portable OXIS folder at: $DistPath"
    # Only these specific subfolders/files - never a blanket delete of
    # the whole directory, since a user could have other things sitting
    # alongside oxis.exe in the same folder.
    $knownItems = @("workspaces", "created-plugins", "created-documents", "plugins") | ForEach-Object { Join-Path $DistPath $_ } | Where-Object { Test-Path $_ }
    if ($knownItems.Count -eq 0) {
      Write-Host "  no workspace/plugin data found there - nothing to clean." -ForegroundColor DarkGray
    } else {
      Write-Host "  data that would be removed:"
      $knownItems | ForEach-Object { Write-Host "    - $_" }
      if (Confirm-Action "Remove this OXIS data? (oxis.exe itself is left alone - this only clears workspace/plugin state, ready for a fresh extraction on top of or instead of it.)") {
        $knownItems | ForEach-Object { Remove-Item -Recurse -Force $_ }
        Write-Host "  removed." -ForegroundColor Green
      }
    }
  }
}
Write-Host ""
Write-Host "Done. Extract or install the new build now." -ForegroundColor Cyan