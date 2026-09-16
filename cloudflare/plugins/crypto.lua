-- crypto.lua — hashing, encoding, and key generation

oxis.command("sha256", function()
  oxis.run([[
    $f = Read-Host "File (blank = hash every file in this folder)"
    if ($f) { Get-FileHash $f -Algorithm SHA256 }
    else    { Get-ChildItem -File | Get-FileHash -Algorithm SHA256 | Format-Table -AutoSize }
  ]])
end, "SHA256-hash one file, or every file in this folder")

oxis.command("b64encode", function()
  oxis.run("[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Clipboard))) | Set-Clipboard; Write-Host 'Clipboard base64-encoded.'")
end, "base64-encode the clipboard contents")

oxis.command("b64decode", function()
  oxis.run("[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String((Get-Clipboard))) | Set-Clipboard; Write-Host 'Clipboard base64-decoded.'")
end, "base64-decode the clipboard contents")

oxis.command("genkey", function()
  oxis.run([[
    $len = Read-Host "Key length in bytes (default 16)"
    if (!$len) { $len = 16 }
    $bytes = New-Object byte[] $len
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $key = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ''
    Write-Host "Key: $key"
    Set-Clipboard -Value $key
    Write-Host "(copied to clipboard)"
  ]])
end, "generate a random hex key and copy it to the clipboard")
