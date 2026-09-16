-- sysmon.lua — OXIS built-in system monitoring plugin
oxis.command("mem", function()
  oxis.run("$o=Get-CimInstance Win32_OperatingSystem;Write-Host 'RAM:' $([math]::Round(($o.TotalVisibleMemorySize-$o.FreePhysicalMemory)/1MB,1))'GB used'")
end, "show RAM used / total")
oxis.command("cpu", function()
  oxis.run("Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,MaxClockSpeed | Format-List")
end, "show CPU name, cores, and clock speed")
