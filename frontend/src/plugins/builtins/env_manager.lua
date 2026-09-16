-- env_manager.lua — .env file manager

oxis.command("envload", function()
  oxis.run([[
    $f = ".env"
    if (!(Test-Path $f)) { Write-Host "No .env file found in current directory."; return }
    $loaded = 0
    Get-Content $f | ForEach-Object {
      if ($_ -match '^\s*([^#=\s]+)\s*=\s*(.*)$') {
        [System.Environment]::SetEnvironmentVariable($Matches[1], $Matches[2].Trim('"'''), "Process")
        Write-Host "  set $($Matches[1])"
        $loaded++
      }
    }
    Write-Host "Loaded $loaded variables from .env"
  ]])
end, "load .env variables into the current session")

oxis.command("envshow", function()
  oxis.run([[
    $f = ".env"
    if (!(Test-Path $f)) { Write-Host "No .env found."; return }
    Write-Host "--- .env ---"
    Get-Content $f | Where-Object { $_ -notmatch '^\s*#' -and $_ -match '=' } |
      ForEach-Object {
        $k = ($_ -split '=')[0]
        Write-Host "  $k = ***"
      }
  ]])
end, "list .env variable names (values hidden)")

oxis.command("envcheck", function()
  oxis.run([[
    $f = ".env.example"
    if (!(Test-Path $f)) { Write-Host "No .env.example found."; return }
    $missing = 0
    Get-Content $f | Where-Object { $_ -match '^\s*([^#=\s]+)\s*=' } | ForEach-Object {
      $k = $Matches[1]
      if (![System.Environment]::GetEnvironmentVariable($k,"Process")) {
        Write-Host "  MISSING: $k"
        $missing++
      }
    }
    if ($missing -eq 0) { Write-Host "All .env.example variables are set." }
    else { Write-Host "$missing variable(s) missing from environment." }
  ]])
end, "check env against .env.example for missing vars")
