-- ssh_manager.lua — SSH session manager 

oxis.command("sshls", function()
  oxis.run([[
    $cfg = "$env:USERPROFILE\.ssh\config"
    if (!(Test-Path $cfg)) { Write-Host "No SSH config found at $cfg"; return }
    Write-Host "  SSH Hosts:"
    Select-String -Path $cfg -Pattern "^Host " | ForEach-Object {
      $host = $_.Line.Replace("Host ", "").Trim()
      if ($host -ne "*") { Write-Host "  ● $host" }
    }
  ]])
end, "list hosts from your SSH config")

oxis.command("sshadd", function()
  oxis.run([[
    $alias = Read-Host "Alias (e.g. myserver)"
    $host  = Read-Host "Hostname or IP"
    $user  = Read-Host "Username"
    $port  = Read-Host "Port (default 22)"
    $key   = Read-Host "IdentityFile (leave blank for default)"
    if (!$port) { $port = "22" }
    $cfg  = "$env:USERPROFILE\.ssh\config"
    $entry = "`n`nHost $alias`n  HostName $host`n  User $user`n  Port $port"
    if ($key) { $entry += "`n  IdentityFile $key" }
    Add-Content $cfg $entry -Encoding UTF8
    Write-Host "Added SSH host '$alias' to $cfg"
  ]])
end, "add a new host entry to your SSH config")

oxis.command("sshkeygen", function()
  oxis.run([[
    $name = Read-Host "Key name (default: id_ed25519)"
    if (!$name) { $name = "id_ed25519" }
    $path = "$env:USERPROFILE\.ssh\$name"
    ssh-keygen -t ed25519 -f $path -C "$env:USERNAME@$(hostname)"
    Write-Host "Public key:"
    Get-Content "$path.pub"
    Get-Content "$path.pub" | Set-Clipboard
    Write-Host "(public key copied to clipboard)"
  ]])
end, "generate a new ed25519 SSH key")

oxis.command("sshcopy", function()
  oxis.run([[
    $host = Read-Host "SSH host alias or user@host"
    $key  = "$env:USERPROFILE\.ssh\id_ed25519.pub"
    if (!(Test-Path $key)) { $key = "$env:USERPROFILE\.ssh\id_rsa.pub" }
    $pub  = Get-Content $key
    Write-Host "Run this on the remote server to authorise your key:"
    Write-Host ""
    Write-Host "  echo '$pub' >> ~/.ssh/authorized_keys"
    Write-Host ""
    Write-Host "(command copied to clipboard)"
    Set-Clipboard -Value "echo '$pub' >> ~/.ssh/authorized_keys"
  ]])
end, "print the command to authorize your key on a remote host")
