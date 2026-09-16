-- system.lua — extra system info
-- Complements the built-in sysmon plugin (top, mem, cpu, uptime)

oxis.command("diskspace", function() oxis.run("Get-PSDrive -PSProvider FileSystem | Format-Table -AutoSize") end, "show free/used space for every mounted drive")

oxis.command("battery", function()
  oxis.run([[
    $b = Get-CimInstance -ClassName Win32_Battery
    if ($b) { $b | Select-Object EstimatedChargeRemaining,BatteryStatus }
    else    { Write-Host "No battery detected (desktop system)." }
  ]])
end, "show battery charge + status (if this machine has one)")

oxis.command("procount", function() oxis.run("(Get-Process).Count") end, "count all running processes")

oxis.command("topmem", function() oxis.run("Get-Process | Sort-Object WS -Descending | Select-Object -First 5 Name,WS") end, "list the 5 processes using the most memory")
