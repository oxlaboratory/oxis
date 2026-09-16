-- filesystem.lua — extra file operations
-- Complements the built-in files plugin (fsize, fopen, fhash, flatest, fbig)

oxis.command("fcount", function() oxis.run("(Get-ChildItem -Recurse -File -EA SilentlyContinue).Count") end, "count all files recursively from here")

oxis.command("fempty", function()
  oxis.run("Get-ChildItem -Recurse -Directory -EA SilentlyContinue | Where-Object { (Get-ChildItem $_.FullName -EA SilentlyContinue).Count -eq 0 }")
end, "list empty directories recursively")

oxis.command("ftotal", function()
  oxis.run("(Get-ChildItem -Recurse -File -EA SilentlyContinue | Measure-Object Length -Sum).Sum / 1MB")
end, "total size in MB of all files recursively")

oxis.command("frecent", function()
  oxis.run("Get-ChildItem -Recurse -File -EA SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 10 Name,LastWriteTime")
end, "list the 10 most recently modified files")

oxis.command("fext", function()
  oxis.run([[
    $ext = Read-Host "Extension (e.g. log, js, md)"
    Get-ChildItem -Recurse -Filter "*.$ext" -EA SilentlyContinue
  ]])
end, "list all files matching a given extension")

oxis.task("cleanup-empty-dirs", "Get-ChildItem -Recurse -Directory -EA SilentlyContinue | Where-Object { (Get-ChildItem $_.FullName -EA SilentlyContinue).Count -eq 0 } | Remove-Item", "delete every empty directory found recursively")
