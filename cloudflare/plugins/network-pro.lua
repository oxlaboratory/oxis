-- network-pro.lua  (PAID PLUGIN)
-- A deeper network toolkit than network: port scanning, DNS
-- fingerprinting, and a combined "recon" command — all prompt for a
-- target host instead of a hardcoded one.

local COMMON_PORTS = "21,22,25,80,443,3306,5432,6379,8080,8443"

oxis.command("portscan", function()
  oxis.run([[
    $t = Read-Host "Target (default github.com)"
    if (!$t) { $t = "github.com" }
    "]] .. COMMON_PORTS .. [[" -split ',' | ForEach-Object {
      $open = Test-NetConnection $t -Port $_ -InformationLevel Quiet
      Write-Host "$t`:$_ -> $open"
    }
  ]])
end, "scan common ports (21,22,25,80,443,3306,5432,6379,8080,8443) on a target")

oxis.command("fingerprint", function()
  oxis.run([[
    $t = Read-Host "Target (default github.com)"
    if (!$t) { $t = "github.com" }
    foreach ($type in @("A","AAAA","MX","TXT","NS")) {
      Write-Host "--- $type ---"
      Resolve-DnsName $t -Type $type -EA SilentlyContinue
    }
  ]])
end, "resolve A/AAAA/MX/TXT/NS records for a target")

oxis.command("sniff", function()
  oxis.run([[
    $t = Read-Host "Target (default github.com)"
    if (!$t) { $t = "github.com" }
    (Invoke-WebRequest "https://$t" -UseBasicParsing).Headers
  ]])
end, "fetch and show the HTTP response headers for a target")

oxis.command("recon", function()
  oxis.run([[
    $t = Read-Host "Target (default github.com)"
    if (!$t) { $t = "github.com" }
    Write-Host "=== full recon on $t ==="
    Test-NetConnection $t -Port 443
    Resolve-DnsName $t -Type A -EA SilentlyContinue
    (Invoke-WebRequest "https://$t" -UseBasicParsing).Headers
  ]])
end, "run portscan + DNS + header checks on a target in one pass")

oxis.autocmd("ShellOpen", function()
  oxis.echo("network-pro loaded — try 'recon, 'portscan, 'fingerprint, or 'sniff")
end)
