-- process_manager.lua — advanced process manager

oxis.command("ptop", function()
  oxis.run([[
    Clear-Host
    Write-Host "  ── TOP PROCESSES ────────────────────────────────────────────"
    Get-Process |
      Sort-Object CPU -Descending |
      Select-Object -First 20 `
        Name,
        Id,
        @{N='CPU%';  E={[math]::Round($_.CPU,1)}},
        @{N='RAM(MB)';E={[math]::Round($_.WorkingSet/1MB,0)}},
        @{N='Threads';E={$_.Threads.Count}},
        @{N='Started';E={if($_.StartTime){$_.StartTime.ToString('HH:mm:ss')}else{'?'}}} |
      Format-Table -AutoSize
    Write-Host "  ────────────────────────────────────────────────────────────"
  ]])
end, "top 20 processes by CPU usage")

oxis.command("pnet", function()
  oxis.run([[
    Get-NetTCPConnection -State Established |
      Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort,
        @{N='Process';E={(Get-Process -Id $_.OwningProcess -EA SilentlyContinue).Name}} |
      Sort-Object Process |
      Format-Table -AutoSize |
      Select-Object -First 30
  ]])
end, "established network connections by process")

oxis.command("pwatch", function()
  oxis.run([[
    $name = Read-Host "Process name to watch"
    while ($true) {
      $p = Get-Process -Name $name -ErrorAction SilentlyContinue
      if ($p) {
        Write-Host "$name  CPU:$([math]::Round($p.CPU,1))  RAM:$([math]::Round($p.WorkingSet/1MB,0))MB  PID:$($p.Id)"
      } else { Write-Host "$name not running." }
      Start-Sleep 2
    }
  ]])
end, "poll a process's CPU/RAM usage every 2s")

oxis.command("pfind", function()
  oxis.run([[
    $port = Read-Host "Port number"
    Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
      Select-Object LocalPort,State,
        @{N='PID';    E={$_.OwningProcess}},
        @{N='Process';E={(Get-Process -Id $_.OwningProcess -EA SilentlyContinue).Name}} |
      Format-Table -AutoSize
  ]])
end, "find which process is listening on a port")
