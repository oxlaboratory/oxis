-- process_manager.lua — look at running processes and ports

local WIN = oxis.platform == "windows"

local function run(ps, sh) oxis.run(WIN and ps or sh) end

-- A script line setting `var` from the command's argument, or asking
-- for it when there isn't one.
local function ask(var, value, question)
  if value ~= "" then return (WIN and "$" or "") .. var .. "=" .. oxis.quote(value) end
  if WIN then return "$" .. var .. ' = Read-Host "' .. question .. '"' end
  return "read -r -p " .. oxis.quote(question .. ": ") .. " " .. var
end

oxis.command("ptop", function()
  run([[Get-Process | Sort-Object CPU -Descending | Select-Object -First 20 Name, Id, @{N='CPU (s)';E={[math]::Round($_.CPU, 1)}}, @{N='RAM (MB)';E={[math]::Round($_.WorkingSet64 / 1MB)}}, @{N='Threads';E={$_.Threads.Count}} | Format-Table -AutoSize]],
      [[ps -eo pid,comm,%cpu,%mem,nlwp,etime --sort=-%cpu | head -n 21]])
end, "the 20 processes using the most CPU")

oxis.command("pnet", function()
  run([[Get-NetTCPConnection -State Established | Sort-Object OwningProcess | Select-Object -First 30 LocalAddress, LocalPort, RemoteAddress, RemotePort, @{N='Process';E={(Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).Name}} | Format-Table -AutoSize]],
      [[ss -tnp state established 2>/dev/null | head -n 31]])
end, "open network connections and the processes that own them")

oxis.command("pwatch", function(_, rest)
  run(ask("name", rest, "Process name (without .exe)") .. [[

Write-Host "Watching $name every 2 s. Ctrl+C stops."
while ($true) {
  $p = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
  $time = Get-Date -Format 'HH:mm:ss'
  if ($p.Count) {
    $cpu = ($p | Measure-Object CPU -Sum).Sum
    $ram = ($p | Measure-Object WorkingSet64 -Sum).Sum / 1MB
    Write-Host ("{0}  {1} process(es)  CPU {2:N1} s  RAM {3:N0} MB" -f $time, $p.Count, $cpu, $ram)
  } else { Write-Host "$time  $name isn't running" }
  Start-Sleep 2
}
]], ask("name", rest, "Process name") .. [[

echo "Watching $name every 2 s. Ctrl+C stops."
while true; do
  stats=$(ps -C "$name" -o %cpu=,rss= | awk '{ c += $1; r += $2; n++ } END { if (n) printf "%d process(es)  CPU %.1f%%  RAM %d MB", n, c, r / 1024 }')
  echo "$(date +%T)  ${stats:-$name is not running}"
  sleep 2
done
]])
end, "show a process's CPU and memory every 2 seconds: 'pwatch <name>")

oxis.command("pfind", function(_, rest)
  if rest ~= "" and not rest:match("^%d+$") then oxis.echo("usage: 'pfind <port>"); return end
  run(ask("port", rest, "Port") .. [[

$c = @(Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue)
if (!$c.Count) { Write-Host "Nothing is using port $port."; return }
$c | Select-Object LocalAddress, LocalPort, State, @{N='PID';E={$_.OwningProcess}}, @{N='Process';E={(Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).Name}} | Format-Table -AutoSize
]], ask("port", rest, "Port") .. [[

out=$(ss -tulnpH 2>/dev/null | awk -v p=":$port" '$5 ~ p "$"')
if [ -z "$out" ]; then echo "Nothing is listening on port $port."; else printf '%s\n' "$out"; fi
]])
end, "which process is using a port: 'pfind <port>")
