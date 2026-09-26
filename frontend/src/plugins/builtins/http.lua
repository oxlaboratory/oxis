-- http.lua — quick HTTP checks without leaving OXIS
-- Linux uses curl (and jq, when installed, to format JSON).

local WIN = oxis.platform == "windows"

-- Windows PowerShell 5.1 doesn't offer TLS 1.2 by default.
local PS_TLS = "[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12\n"

local function run(ps, sh) oxis.run(WIN and (PS_TLS .. ps) or sh) end

oxis.command("get", function(_, rest)
  if rest == "" then oxis.echo("usage: 'get <url>"); return end
  local url = oxis.quote(rest)
  run(([[
try {
  $r = Invoke-WebRequest -Uri %s -UseBasicParsing
  try { $r.Content | ConvertFrom-Json | ConvertTo-Json -Depth 20 } catch { $r.Content }
} catch { Write-Host "Error: $($_.Exception.Message)" }
]]):format(url), ([[
body=$(curl -sSL --max-time 30 %s) || exit 1
if command -v jq >/dev/null 2>&1 && printf '%%s' "$body" | jq . 2>/dev/null; then :; else printf '%%s\n' "$body"; fi
]]):format(url))
end, "GET a URL and print the body (JSON is formatted): 'get <url>")

oxis.command("hget", function(_, rest)
  if rest == "" then oxis.echo("usage: 'hget <url>"); return end
  local url = oxis.quote(rest)
  run(([[
try {
  $r = Invoke-WebRequest -Uri %s -UseBasicParsing
  Write-Host "$($r.StatusCode) $($r.StatusDescription)"
  foreach ($k in $r.Headers.Keys) { Write-Host "${k}: $($r.Headers[$k])" }
  Write-Host ""
  ($r.Content -split "`n" | Select-Object -First 30) -join "`n"
} catch { Write-Host "Error: $($_.Exception.Message)" }
]]):format(url), ([[
curl -sS -i -L --max-time 30 %s | head -n 60
]]):format(url))
end, "status, headers and the first lines of a URL's response: 'hget <url>")

oxis.command("ping4", function(args)
  local hosts = #args > 0 and args or { "google.com", "github.com", "npmjs.com", "pypi.org" }
  local quoted = {}
  for i, h in ipairs(hosts) do quoted[i] = oxis.quote(h) end
  run(([[
foreach ($h in @(%s)) {
  $r = Test-Connection $h -Count 1 -ErrorAction SilentlyContinue
  if ($r) {
    $ms = if ($r.PSObject.Properties['Latency']) { $r.Latency } else { $r.ResponseTime }
    Write-Host "  ok    $h  ($ms ms)"
  } else { Write-Host "  FAIL  $h  (no reply)" }
}
]]):format(table.concat(quoted, ",")), ([[
for h in %s; do
  ms=$(ping -c 1 -W 2 "$h" 2>/dev/null | sed -n 's/.*time=\([0-9.]*\).*/\1/p')
  if [ -n "$ms" ]; then echo "  ok    $h  ($ms ms)"; else echo "  FAIL  $h  (no reply)"; fi
done
]]):format(table.concat(quoted, " ")))
end, "ping a few well-known sites once each (or your own): 'ping4 [host...]")

oxis.command("myip2", function()
  run([[
try {
  $i = Invoke-RestMethod 'https://ipapi.co/json/'
  Write-Host "IP:      $($i.ip)"
  Write-Host "City:    $($i.city)"
  Write-Host "Country: $($i.country_name)"
  Write-Host "ISP:     $($i.org)"
} catch { Write-Host "Error: $($_.Exception.Message)" }
]], [[
j=$(curl -sS --max-time 15 https://ipapi.co/json/) || exit 1
v() { printf '%s\n' "$j" | sed -n "s/.*\"$1\": *\"\([^\"]*\)\".*/\1/p" | head -n 1; }
echo "IP:      $(v ip)"
echo "City:    $(v city)"
echo "Country: $(v country_name)"
echo "ISP:     $(v org)"
]])
end, "public IP address with its city, country and ISP")
