-- ssh_manager.lua — manage ~/.ssh/config hosts and keys

local WIN = oxis.platform == "windows"

local function run(ps, sh) oxis.run(WIN and ps or sh) end

-- A script line setting `var` from the command's argument, or asking
-- for it when there isn't one.
local function ask(var, value, question)
  if value ~= "" then return (WIN and "$" or "") .. var .. "=" .. oxis.quote(value) end
  if WIN then return "$" .. var .. ' = Read-Host "' .. question .. '"' end
  return "read -r -p " .. oxis.quote(question .. ": ") .. " " .. var
end

oxis.command("sshls", function()
  run([[
$cfg = Join-Path $HOME '.ssh\config'
if (!(Test-Path $cfg)) { Write-Host "No SSH config at $cfg. 'sshadd creates one."; return }
Select-String -Path $cfg -Pattern '^\s*Host\s+(.+)$' | ForEach-Object { $_.Matches[0].Groups[1].Value -split '\s+' } | Where-Object { $_ -and $_ -notmatch '[*?]' } | ForEach-Object { Write-Host "  $_" }
]], [[
cfg="$HOME/.ssh/config"
if [ ! -f "$cfg" ]; then echo "No SSH config at $cfg. 'sshadd creates one."; exit 0; fi
awk 'tolower($1) == "host" { for (i = 2; i <= NF; i++) if ($i !~ /[*?]/) print "  " $i }' "$cfg"
]])
end, "hosts in your SSH config")

oxis.command("sshadd", function()
  run([[
$alias = Read-Host "Alias (e.g. myserver)"
$hostName = Read-Host "Host name or IP"
$user = Read-Host "User (Enter to skip)"
$port = Read-Host "Port (Enter for 22)"
$key = Read-Host "Identity file (Enter for your default key)"
if (!$alias -or !$hostName) { Write-Host "An alias and a host name are needed."; return }
$sshDir = Join-Path $HOME '.ssh'
New-Item -ItemType Directory -Force $sshDir | Out-Null
$cfg = Join-Path $sshDir 'config'
$entry = "`nHost $alias`n  HostName $hostName"
if ($user) { $entry += "`n  User $user" }
if ($port) { $entry += "`n  Port $port" }
if ($key) { $entry += "`n  IdentityFile $key" }
[IO.File]::AppendAllText($cfg, $entry + "`n")
Write-Host "Added $alias to $cfg. Connect with: ssh $alias"
]], [[
read -r -p "Alias (e.g. myserver): " alias
read -r -p "Host name or IP: " host_name
read -r -p "User (Enter to skip): " user
read -r -p "Port (Enter for 22): " port
read -r -p "Identity file (Enter for your default key): " key
if [ -z "$alias" ] || [ -z "$host_name" ]; then echo "An alias and a host name are needed."; exit 1; fi
mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
{
  printf '\nHost %s\n  HostName %s\n' "$alias" "$host_name"
  if [ -n "$user" ]; then printf '  User %s\n' "$user"; fi
  if [ -n "$port" ]; then printf '  Port %s\n' "$port"; fi
  if [ -n "$key" ]; then printf '  IdentityFile %s\n' "$key"; fi
} >> "$HOME/.ssh/config"
chmod 600 "$HOME/.ssh/config"
echo "Added $alias to ~/.ssh/config. Connect with: ssh $alias"
]])
end, "add a host to your SSH config (asks for the details)")

oxis.command("sshkeygen", function(_, rest)
  local name = rest ~= "" and rest or "id_ed25519"
  if not name:match("^[%w._-]+$") then oxis.echo("usage: 'sshkeygen [key file name]"); return end
  run([[
$path = Join-Path $HOME ".ssh\]] .. name .. [["
if (Test-Path $path) { Write-Host "$path already exists."; return }
New-Item -ItemType Directory -Force (Split-Path $path) | Out-Null
ssh-keygen -t ed25519 -f $path -C "$env:USERNAME@$env:COMPUTERNAME"
if ($LASTEXITCODE) { return }
Get-Content "$path.pub" | Set-Clipboard
Write-Host "Public key (copied to the clipboard):"
Get-Content "$path.pub"
]], [[
path="$HOME/.ssh/]] .. name .. [["
if [ -e "$path" ]; then echo "$path already exists."; exit 1; fi
mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
ssh-keygen -t ed25519 -f "$path" -C "$(whoami)@$(hostname)" || exit 1
echo "Public key:"
cat "$path.pub"
]])
end, "create an ed25519 key pair in ~/.ssh: 'sshkeygen [name] (default id_ed25519)")

oxis.command("sshcopy", function(_, rest)
  run(ask("target", rest, "Host (alias or user@host)") .. [[

$key = @('id_ed25519.pub', 'id_rsa.pub') | ForEach-Object { Join-Path $HOME ".ssh\$_" } | Where-Object { Test-Path $_ } | Select-Object -First 1
if (!$key) { Write-Host "No public key in ~/.ssh. 'sshkeygen makes one."; return }
$pub = (Get-Content -Raw $key).Trim()
ssh $target "umask 077; mkdir -p ~/.ssh && echo '$pub' >> ~/.ssh/authorized_keys"
if ($LASTEXITCODE -eq 0) { Write-Host "Key installed. Try: ssh $target" }
]], ask("target", rest, "Host (alias or user@host)") .. [[

key=""
for k in "$HOME/.ssh/id_ed25519.pub" "$HOME/.ssh/id_rsa.pub"; do [ -f "$k" ] && { key=$k; break; }; done
if [ -z "$key" ]; then echo "No public key in ~/.ssh. 'sshkeygen makes one."; exit 1; fi
if command -v ssh-copy-id >/dev/null 2>&1; then
  ssh-copy-id -i "$key" "$target"
else
  ssh "$target" "umask 077; mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys" < "$key" && echo "Key installed. Try: ssh $target"
fi
]])
end, "install your public key on a server so ssh stops asking for a password: 'sshcopy <host>")
