-- system_health.lua — system health dashboard

oxis.command("health", function()
  oxis.run([[
    Write-Host "  ── OXIS System Health ──────────────────────────────────────"
    Write-Host ""

    # OS
    $os = Get-CimInstance Win32_OperatingSystem
    Write-Host "  OS:       $($os.Caption) (Build $($os.BuildNumber))"

    # CPU
    $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
    $load = [math]::Round((Get-CimInstance Win32_Processor).LoadPercentage)
    Write-Host "  CPU:      $($cpu.Name)"
    Write-Host "  CPU Load: ${load}%"

    # RAM
    $ramTotal = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
    $ramFree  = [math]::Round($os.FreePhysicalMemory     / 1MB, 1)
    $ramUsed  = [math]::Round(($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / 1MB, 1)
    $ramPct   = [math]::Round($ramUsed / $ramTotal * 100)
    Write-Host "  RAM:      ${ramUsed}GB / ${ramTotal}GB used (${ramPct}%)"

    # Disk
    Write-Host ""
    Write-Host "  ── Disks ───────────────────────────────────────────────────"
    Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -ne $null } |
      ForEach-Object {
        $tot  = [math]::Round(($_.Used + $_.Free) / 1GB, 1)
        $used = [math]::Round($_.Used / 1GB, 1)
        $pct  = if ($tot -gt 0) { [math]::Round($_.Used / ($_.Used + $_.Free) * 100) } else { 0 }
        $bar  = ("#" * [math]::Round($pct / 5)).PadRight(20)
        Write-Host "  $($_.Name):  [$bar] ${used}GB/${tot}GB (${pct}%)"
      }

    # Network
    Write-Host ""
    Write-Host "  ── Network ─────────────────────────────────────────────────"
    Get-NetIPAddress | Where-Object { $_.AddressFamily -eq "IPv4" -and $_.IPAddress -ne "127.0.0.1" } |
      Format-Table IPAddress,InterfaceAlias -AutoSize

    # Tools check
    Write-Host "  ── Tools ───────────────────────────────────────────────────"
    @("git","node","npm","go","python","docker","code") | ForEach-Object {
      $v = & $_ --version 2>&1 | Select-String '\d' | Select-Object -First 1
      if ($LASTEXITCODE -eq 0 -or $v) { Write-Host "  ✓  $_ — $v" }
      else { Write-Host "  ✗  $_ — not found" }
    }
    Write-Host ""
    Write-Host "  ────────────────────────────────────────────────────────────"
  ]])
end, "full system health dashboard: OS, CPU, RAM, disks, network, tools")

oxis.command("temps", function()
  oxis.run([[
    Get-CimInstance MSAcpi_ThermalZoneTemperature -Namespace "root/wmi" -ErrorAction SilentlyContinue |
      ForEach-Object {
        $c = [math]::Round($_.CurrentTemperature / 10 - 273.15, 1)
        Write-Host "  Thermal zone: ${c}°C"
      }
    if (!$?) { Write-Host "  Temperature sensors not available on this system." }
  ]])
end, "show hardware thermal zone temperatures")
