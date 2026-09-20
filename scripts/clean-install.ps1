<#
.SYNOPSIS
  Removes stale OXIS files/registry entries before installing a fresh
  build — run this BEFORE extracting a new dist/ zip or running a new
  MSI, not after.

.DESCRIPTION
  Written specifically because of a real, reported symptom: an old
  "release" task kept showing up on Home's WORKSPACE panel across
  multiple downloaded builds, long after the actual source code
  (workspaceManager.ts's DEFAULT_TEMPLATE) had been fixed to never
  create it. The template only affects NEWLY created workspaces — it
  can't reach back and fix a workspaces/registry.json + workspace.lua
  that already exists on disk from a PREVIOUS extraction. If a portable
  dist/ folder is run from Downloads (rather than installed via the
  real MSI, which properly upgrades in place via WiX's MajorUpgrade
  element — see dist/oxis-product.wxs), workspace data can persist
  silently across "new" downloads if a new zip is extracted alongside
  or on top of an old one without clearing it first.

  This script does NOT touch:
    - Any file outside what it can specifically identify as OXIS's own
      (a folder containing oxis.exe alongside the workspaces/ registry
      it creates, or the exact MSI-created registry keys/paths).
    - Your actual project files anywhere else on your machine — this
      only ever removes OXIS's OWN application/workspace data, never
      files inside a project you've connected via 'workspace link.

  ALWAYS shows exactly what it found and asks for confirmation before
  deleting anything, unless run with -Force.

.PARAMETER DistPath
  Path to a portable dist/ folder to clean (the "Downloads\oxis-full-
  v.../dist" style folder this script exists for). Optional — if
  omitted, only the MSI-installed location and registry keys are
  checked.

.PARAMETER Force
  Skip confirmation prompts. For scripted/CI use — an interactive user
  should almost always leave this off and read what's about to happen.

.EXAMPLE
  .\clean-install.ps1 -DistPath "C:\Users\Admin\Downloads\oxis-full-v1.2.1\oxis-full\dist"
  # Review what it finds, confirm, then extract your new zip into a
  # clean folder afterward.

.EXAMPLE
  .\clean-install.ps1
  # Just cleans up a previous MSI install + its registry keys, if any
  # — do this before running a newly downloaded .msi.
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
Write-Host "This removes STALE OXIS data before a fresh install — it never touches your own projects." -ForegroundColor DarkGray
Write-Host ""

# ── 1. Stop any running OXIS process ────────────────────────────────
$running = Get-Process -Name "oxis" -ErrorAction SilentlyContinue
if ($running) {
  Write-Host "Found $($running.Count) running oxis.exe process(es)."
  if (Confirm-Action "Stop them before continuing?") {
    $running | Stop-Process -Force
    Write-Host "  stopped." -ForegroundColor Green
  } else {
    Write-Host "  left running — files may fail to delete while OXIS is open." -ForegroundColor Yellow
  }
}
Write-Host ""

# ── 2. MSI-installed location + registry keys ───────────────────────
$installDir = Join-Path ${env:ProgramFiles} "OXIS"
if (Test-Path $installDir) {
  Write-Host "Found an MSI-installed OXIS at: $installDir"
  if (Confirm-Action "Remove it? (Use Windows' own 'Uninstall OXIS' first if it's still registered — this is a fallback for a broken/partial uninstall.)") {
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

# ── 3. A portable dist/ folder, if one was given ────────────────────
if ($DistPath) {
  $exePath = Join-Path $DistPath "oxis.exe"
  if (-not (Test-Path $exePath)) {
    Write-Host "No oxis.exe found at $DistPath — nothing to clean there (refusing to touch a folder that doesn't look like an OXIS dist/ folder)." -ForegroundColor Yellow
  } else {
    Write-Host "Found a portable OXIS folder at: $DistPath"
    # Only these specific subfolders/files — never a blanket delete of
    # the whole directory, since a user could have other things sitting
    # alongside oxis.exe in the same folder.
    $knownItems = @("workspaces", "created-plugins", "created-documents", "plugins") | ForEach-Object { Join-Path $DistPath $_ } | Where-Object { Test-Path $_ }
    if ($knownItems.Count -eq 0) {
      Write-Host "  no workspace/plugin data found there — nothing to clean." -ForegroundColor DarkGray
    } else {
      Write-Host "  data that would be removed:"
      $knownItems | ForEach-Object { Write-Host "    - $_" }
      if (Confirm-Action "Remove this OXIS data? (oxis.exe itself is left alone — this only clears workspace/plugin state, ready for a fresh extraction on top of or instead of it.)") {
        $knownItems | ForEach-Object { Remove-Item -Recurse -Force $_ }
        Write-Host "  removed." -ForegroundColor Green
      }
    }
  }
}
Write-Host ""
Write-Host "Done. Extract or install the new build now." -ForegroundColor Cyan