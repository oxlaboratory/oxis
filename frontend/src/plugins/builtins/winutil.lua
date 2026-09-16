-- winutil.lua — OXIS built-in Windows utilities plugin
oxis.command("admin",  function() oxis.run("Start-Process powershell -Verb runAs") end, "relaunch PowerShell elevated (UAC prompt)")
oxis.command("winver", function() oxis.run("[System.Environment]::OSVersion.Version") end, "show the Windows version")
