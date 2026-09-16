-- Stores last 20 items copied to clipboard across OXIS sessions

oxis.command("clip", function()
  oxis.run([[
    $c = Get-Clipboard
    Write-Host "Clipboard contents:"
    Write-Host "---"
    Write-Host $c
    Write-Host "---"
    Write-Host "($($c.Length) chars)"
  ]])
end, "show current clipboard contents")

oxis.command("clipclear", function()
  oxis.run([[
    Set-Clipboard -Value ""
    Write-Host "Clipboard cleared."
  ]])
end, "clear the clipboard")

oxis.command("cliphex", function()
  oxis.run([[
    $c = Get-Clipboard
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($c)
    $hex = ($bytes | ForEach-Object { $_.ToString("X2") }) -join ' '
    Write-Host $hex
  ]])
end, "show clipboard contents as hex bytes")

oxis.command("clipfile", function()
  oxis.run([[
    $f = Read-Host "File path to copy to clipboard"
    $c = Get-Content $f -Raw
    Set-Clipboard -Value $c
    Write-Host "Copied $($c.Length) chars to clipboard."
  ]])
end, "copy a file's contents to the clipboard")
