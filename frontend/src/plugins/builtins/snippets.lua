-- snippets.lua — code snippet manager
-- Store and recall code snippets by name

oxis.command("snipset", function()
  oxis.run([[
    $dir  = "$env:USERPROFILE\.oxis\snippets"
    if (!(Test-Path $dir)) { New-Item -ItemType Directory $dir | Out-Null }
    $name = Read-Host "Snippet name"
    Write-Host "Paste snippet content (end with a line containing only '###'):"
    $lines = @()
    do {
      $line = Read-Host
      if ($line -ne "###") { $lines += $line }
    } while ($line -ne "###")
    Set-Content "$dir\$name.txt" ($lines -join "`n") -Encoding UTF8
    Write-Host "Snippet '$name' saved."
  ]])
end, "save a new named code snippet")

oxis.command("snipget", function()
  oxis.run([[
    $dir  = "$env:USERPROFILE\.oxis\snippets"
    $name = Read-Host "Snippet name"
    $file = "$dir\$name.txt"
    if (Test-Path $file) {
      $c = Get-Content $file -Raw
      Set-Clipboard -Value $c
      Write-Host "--- $name ---"
      Write-Host $c
      Write-Host "--- (copied to clipboard) ---"
    } else { Write-Host "Snippet '$name' not found. Run 'snipls to list." }
  ]])
end, "print a saved snippet and copy it to the clipboard")

oxis.command("snipls", function()
  oxis.run([[
    $dir = "$env:USERPROFILE\.oxis\snippets"
    if (!(Test-Path $dir)) { Write-Host "No snippets saved yet."; return }
    Get-ChildItem $dir -Filter "*.txt" |
      Format-Table @{N='Name';E={$_.BaseName}},
                   @{N='Size';E={"$([math]::Round($_.Length/1))B"}},
                   @{N='Modified';E={$_.LastWriteTime.ToString('yyyy-MM-dd')}} -AutoSize
  ]])
end, "list saved snippets")

oxis.command("sniprm", function()
  oxis.run([[
    $dir  = "$env:USERPROFILE\.oxis\snippets"
    $name = Read-Host "Snippet to delete"
    $file = "$dir\$name.txt"
    if (Test-Path $file) { Remove-Item $file; Write-Host "Deleted: $name" }
    else { Write-Host "Not found: $name" }
  ]])
end, "delete a saved snippet")
