-- env_manager.lua — work with the .env file in the current folder
-- Lines look like KEY=value (optionally "export KEY=value"); # starts a
-- comment.

local WIN = oxis.platform == "windows"

oxis.command("envload", function()
  if WIN then
    oxis.run([=[
if (!(Test-Path .env)) { Write-Host "No .env file in this folder."; return }
$n = 0
foreach ($line in Get-Content .env) {
  if ($line -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
    $v = $Matches[2]
    if ($v.Length -ge 2 -and ($v[0] -eq '"' -or $v[0] -eq "'") -and $v[-1] -eq $v[0]) { $v = $v.Substring(1, $v.Length - 2) }
    [Environment]::SetEnvironmentVariable($Matches[1], $v, 'Process')
    Write-Host "  set $($Matches[1])"
    $n++
  }
}
Write-Host "Loaded $n variable(s) from .env"
]=])
  else
    -- One line, so it runs in your shell rather than a child process.
    oxis.run([=[if [ -f .env ]; then set -a; . ./.env; set +a; echo "Loaded $(grep -cE '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=' .env) variable(s) from .env"; else echo "No .env file in this folder."; fi]=])
  end
end, "load .env into this shell session")

oxis.command("envshow", function()
  if WIN then
    oxis.run([=[
if (!(Test-Path .env)) { Write-Host "No .env file in this folder."; return }
foreach ($line in Get-Content .env) {
  if ($line -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=') { Write-Host "  $($Matches[1]) = ***" }
}
]=])
  else
    oxis.run([=[
if [ ! -f .env ]; then echo "No .env file in this folder."; exit 0; fi
sed -nE 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=.*/  \2 = ***/p' .env
]=])
  end
end, "list the names in .env (values hidden)")

oxis.command("envcheck", function()
  if WIN then
    oxis.run([=[
if (!(Test-Path .env.example)) { Write-Host "No .env.example in this folder."; return }
$missing = 0
foreach ($line in Get-Content .env.example) {
  if ($line -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=' -and ![Environment]::GetEnvironmentVariable($Matches[1])) {
    Write-Host "  missing: $($Matches[1])"
    $missing++
  }
}
if ($missing -eq 0) { Write-Host "Every variable in .env.example is set." } else { Write-Host "$missing variable(s) not set." }
]=])
  else
    oxis.run([=[
if [ ! -f .env.example ]; then echo "No .env.example in this folder."; exit 0; fi
missing=0
for k in $(sed -nE 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=.*/\2/p' .env.example); do
  if [ -z "${!k}" ]; then echo "  missing: $k"; missing=$((missing + 1)); fi
done
if [ "$missing" -eq 0 ]; then echo "Every variable in .env.example is set."; else echo "$missing variable(s) not set."; fi
]=])
  end
end, "list variables named in .env.example that aren't set in this session ('envload first)")
