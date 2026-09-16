-- http.lua — HTTP client
-- Quick HTTP requests without leaving OXIS

oxis.command("get", function()
  oxis.run("Invoke-RestMethod -Uri $args[0] -Method GET | ConvertTo-Json -Depth 5")
end, "GET a URL and print the JSON response")

oxis.command("hget", function()
  oxis.run([[
    $url = Read-Host "URL"
    try {
      $r = Invoke-WebRequest -Uri $url -UseBasicParsing
      Write-Host "Status: $($r.StatusCode) $($r.StatusDescription)"
      Write-Host "Headers: $($r.Headers | ConvertTo-Json -Depth 2)"
      Write-Host ($r.Content | Select-String -Pattern '.' | Select-Object -First 30)
    } catch { Write-Host "Error: $_" }
  ]])
end)

oxis.command("ping4", function()
  oxis.run([[
    $sites = @("google.com","github.com","npmjs.com","pypi.org")
    $sites | ForEach-Object {
      $r = Test-Connection $_ -Count 1 -ErrorAction SilentlyContinue
      if ($r) { Write-Host "✓ $_ ($($r.Latency)ms)" }
      else    { Write-Host "✗ $_ (unreachable)" }
    }
  ]])
end)

oxis.command("myip2", function()
  oxis.run([[
    $ip   = (Invoke-WebRequest 'https://api.ipify.org' -UseBasicParsing).Content
    $info = Invoke-RestMethod "https://ipapi.co/$ip/json/"
    Write-Host "IP:      $ip"
    Write-Host "City:    $($info.city)"
    Write-Host "Country: $($info.country_name)"
    Write-Host "ISP:     $($info.org)"
  ]])
end)
