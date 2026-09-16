-- network.lua — network diagnostics
-- Complements the built-in network plugin (myip, wifi, ports, ping, dns)

oxis.command("nettest", function()
  oxis.run([[
    $h = Read-Host "Host (default github.com)"
    if (!$h) { $h = "github.com" }
    $p = Read-Host "Port (default 443)"
    if (!$p) { $p = 443 }
    Test-NetConnection $h -Port $p
  ]])
end, "test TCP connectivity to a host:port")

oxis.command("nettrace", function()
  oxis.run([[
    $h = Read-Host "Host (default github.com)"
    if (!$h) { $h = "github.com" }
    Test-NetConnection $h -TraceRoute
  ]])
end, "traceroute to a host")

oxis.command("geoip", function()
  oxis.run([[
    $ip = Read-Host "IP to look up (blank = your own)"
    if ($ip) { $info = Invoke-RestMethod "https://ipapi.co/$ip/json/" }
    else     { $info = Invoke-RestMethod "https://ipapi.co/json/" }
    Write-Host "IP:      $($info.ip)"
    Write-Host "City:    $($info.city)"
    Write-Host "Country: $($info.country_name)"
    Write-Host "ISP:     $($info.org)"
  ]])
end, "look up city/country/ISP for an IP (blank = your own)")

oxis.command("dnscheck", function()
  oxis.run([[
    $d = Read-Host "Domain (default github.com)"
    if (!$d) { $d = "github.com" }
    Resolve-DnsName $d -Server 8.8.8.8
  ]])
end, "resolve a domain against Google's DNS (8.8.8.8)")
