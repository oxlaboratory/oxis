-- session_notes.lua — scratchpad/notes inside OXIS
-- Notes stored in %USERPROFILE%\.oxis\notes\

oxis.command("note", function()
  oxis.run([[
    $dir = "$env:USERPROFILE\.oxis\notes"
    if (!(Test-Path $dir)) { New-Item -ItemType Directory $dir | Out-Null }
    $file = "$dir\$(Get-Date -Format 'yyyy-MM-dd').md"
    if (!(Test-Path $file)) {
      Set-Content $file "# Notes — $(Get-Date -Format 'dddd, MMMM dd yyyy')`n`n"
    }
    Write-Host "Note file: $file"
    Write-Host "(use 'edit to open in OXIS editor)"
  ]])
end, "open (or create) today's scratchpad note")

oxis.command("notenew", function()
  oxis.run([[
    $dir  = "$env:USERPROFILE\.oxis\notes"
    if (!(Test-Path $dir)) { New-Item -ItemType Directory $dir | Out-Null }
    $file = "$dir\$(Get-Date -Format 'yyyy-MM-dd-HHmmss').md"
    Set-Content $file "# $(Get-Date -Format 'dddd, MMMM dd yyyy HH:mm')`n`n"
    Write-Host "Created: $file"
  ]])
end, "create a new timestamped note")

oxis.command("notels", function()
  oxis.run([[
    $dir = "$env:USERPROFILE\.oxis\notes"
    if (!(Test-Path $dir)) { Write-Host "No notes yet. Run 'note to create one."; return }
    Get-ChildItem $dir -Filter "*.md" | Sort-Object LastWriteTime -Descending |
      Format-Table @{N='Date';E={$_.LastWriteTime.ToString('yyyy-MM-dd HH:mm')}},
                   @{N='Size';E={"$([math]::Round($_.Length/1KB,1))KB"}},Name -AutoSize
  ]])
end, "list saved notes")

oxis.command("notecat", function()
  oxis.run([[
    $dir  = "$env:USERPROFILE\.oxis\notes"
    $last = Get-ChildItem $dir -Filter "*.md" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($last) { Get-Content $last.FullName } else { Write-Host "No notes found." }
  ]])
end, "print the most recently modified note")
