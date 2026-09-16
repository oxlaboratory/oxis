-- fuzzy.lua — fuzzy file finder
-- Searches filenames recursively and displays ranked matches

oxis.command("ff", function()
  oxis.run([[
    $files = Get-ChildItem -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -notmatch '\\node_modules\\|\\\.git\\|\\dist\\|\\\.next\\' } |
      Select-Object -First 80 -ExpandProperty FullName
    $files | ForEach-Object { Write-Host $_ }
  ]])
end, "list files under the current folder (fuzzy-find source)")

oxis.command("fd", function()
  oxis.run([[
    $dirs = Get-ChildItem -Recurse -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -notmatch '\\node_modules\\|\\\.git\\|\\dist\\' } |
      Select-Object -First 60 -ExpandProperty FullName
    $dirs | ForEach-Object { Write-Host $_ }
  ]])
end, "list directories under the current folder")

oxis.command("frec", function()
  oxis.run([[
    Get-ChildItem -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object { $_.LastWriteTime -gt (Get-Date).AddDays(-3) } |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 30 |
      Format-Table LastWriteTime,@{N='File';E={$_.FullName}} -AutoSize
  ]])
end, "list files modified in the last 3 days")

oxis.autocmd("ShellOpen", function()
  oxis.echo("fuzzy: ff=find files  fd=find dirs  frec=recent files")
end)
