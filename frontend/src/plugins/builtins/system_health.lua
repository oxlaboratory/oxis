-- system_health.lua — a quick look at the machine

local WIN = oxis.platform == "windows"

local function run(ps, sh) oxis.run(WIN and ps or sh) end

oxis.command("health", function()
  run([[
$os = Get-CimInstance Win32_OperatingSystem
$cpus = @(Get-CimInstance Win32_Processor)
$load = ($cpus | Measure-Object LoadPercentage -Average).Average
$total = $os.TotalVisibleMemorySize / 1MB
$used = ($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / 1MB
Write-Host "  OS    $($os.Caption) (build $($os.BuildNumber))"
Write-Host "  CPU   $($cpus[0].Name.Trim()), $load% busy"
Write-Host ("  RAM   {0:N1} GB used of {1:N1} GB ({2:N0}%)" -f $used, $total, ($used / $total * 100))
Write-Host ""
Write-Host "  Disks"
Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -ne $null -and ($_.Used + $_.Free) -gt 0 } | ForEach-Object {
  $size = $_.Used + $_.Free
  $pct = [math]::Round($_.Used / $size * 100)
  $bar = ('#' * [math]::Round($pct / 5)).PadRight(20, '.')
  Write-Host ("  {0}:  [{1}] {2:N1} of {3:N1} GB ({4}%)" -f $_.Name, $bar, ($_.Used / 1GB), ($size / 1GB), $pct)
}
Write-Host ""
Write-Host "  Network"
Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254.*' } | ForEach-Object { Write-Host "  $($_.InterfaceAlias): $($_.IPAddress)" }
Write-Host ""
Write-Host "  Tools"
foreach ($t in 'git', 'node', 'npm', 'go', 'python', 'docker', 'code') {
  $c = Get-Command $t -ErrorAction SilentlyContinue | Select-Object -First 1
  # python.exe in WindowsApps is only the Microsoft Store installer stub.
  if (!$c -or $c.Source -like '*\WindowsApps\python*') { Write-Host ("  {0,-8} not found" -f $t); continue }
  $v = if ($t -eq 'go') { go version } else { & $t --version 2>$null | Select-Object -First 1 }
  Write-Host ("  {0,-8} {1}" -f $t, $v)
}
]], [[
. /etc/os-release 2>/dev/null
echo "  OS    ${PRETTY_NAME:-$(uname -s)} (kernel $(uname -r))"
echo "  CPU   $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2- | sed 's/^ *//'), $(nproc) threads, load $(cut -d' ' -f1-3 /proc/loadavg)"
free -h | awk '/^Mem:/ { print "  RAM   " $3 " used of " $2 }'
echo
echo "  Disks"
df -h -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null | awk 'NR > 1 { printf "  %-24s %6s used of %6s (%s)\n", $6, $3, $2, $5 }'
echo
echo "  Network"
ip -4 -o addr show scope global 2>/dev/null | awk '{ print "  " $2 ": " $4 }'
echo
echo "  Tools"
for t in git node npm go python3 docker code; do
  if command -v "$t" >/dev/null 2>&1; then
    if [ "$t" = go ]; then v=$(go version); else v=$("$t" --version 2>/dev/null | head -n 1); fi
    printf '  %-8s %s\n' "$t" "$v"
  else
    printf '  %-8s not found\n' "$t"
  fi
done
]])
end, "OS, CPU, memory, disks, network addresses and installed dev tools")

oxis.command("temps", function()
  run([[
$zones = @(Get-CimInstance MSAcpi_ThermalZoneTemperature -Namespace root/wmi -ErrorAction SilentlyContinue)
if (!$zones.Count) { Write-Host "No readable temperature sensors. On Windows this usually needs OXIS running as administrator."; return }
foreach ($z in $zones) { Write-Host ("  {0}: {1:N1} °C" -f $z.InstanceName, ($z.CurrentTemperature / 10 - 273.15)) }
]], [[
found=0
for z in /sys/class/thermal/thermal_zone*; do
  [ -r "$z/temp" ] || continue
  printf '  %-24s %s °C\n' "$(cat "$z/type")" "$(awk '{ printf "%.1f", $1 / 1000 }' "$z/temp")"
  found=1
done
[ "$found" = 1 ] || echo "No temperature sensors found."
]])
end, "temperature sensors, where the system exposes them")
