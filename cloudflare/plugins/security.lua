-- security.lua — password generation and permission audits

oxis.command("genpass", function()
  oxis.run([[
    $len = Read-Host "Password length (default 20)"
    if (!$len) { $len = 20 }
    $chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*"
    $pass = -join ((1..$len) | ForEach-Object { $chars[(Get-Random -Maximum $chars.Length)] })
    Write-Host "Generated password (copied to clipboard)"
    Set-Clipboard -Value $pass
  ]])
end, "generate a random password and copy it to the clipboard")

oxis.command("perms", function()
  oxis.run([[
    $p = Read-Host "Path (default current directory)"
    if (!$p) { $p = "." }
    Get-ChildItem $p -EA SilentlyContinue | Get-Acl -EA SilentlyContinue | Format-List Path,Owner
  ]])
end, "show owner + path ACL info for a directory's contents")

oxis.command("permaudit", function()
  oxis.run([[
    $p = Read-Host "Path (default current directory)"
    if (!$p) { $p = "." }
    Write-Host "Scanning $p for wide-open ACLs..."
    Get-ChildItem $p -Recurse -EA SilentlyContinue |
      ForEach-Object { Get-Acl $_.FullName -EA SilentlyContinue } |
      Where-Object { $_.AccessToString -match "Everyone" }
  ]])
end, "recursively scan a path for ACLs granting access to Everyone")

oxis.command("secretcheck", function()
  oxis.echo("Reminder: rotate any secrets older than 90 days.")
end, "reminder to rotate secrets older than 90 days")
