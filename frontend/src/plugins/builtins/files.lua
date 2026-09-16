-- files.lua — OXIS built-in file operations plugin
oxis.command("flatest", function()
  oxis.run("Get-ChildItem -Recurse -File -EA SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 10 LastWriteTime,Name | Format-Table -AutoSize")
end, "list the 10 most recently modified files")
oxis.command("fbig", function()
  oxis.run("Get-ChildItem -Recurse -File -EA SilentlyContinue | Sort-Object Length -Descending | Select-Object -First 10 @{N='MB';E={[math]::Round($_.Length/1MB,2)}},Name | Format-Table -AutoSize")
end, "list the 10 largest files (recursive)")
