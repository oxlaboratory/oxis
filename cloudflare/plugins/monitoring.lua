-- monitoring.lua — log tailing and process watching

oxis.command("tail", function()
  oxis.run([[
    $f = Read-Host "Log file (blank = newest *.log)"
    if (!$f) {
      $file = Get-ChildItem -Filter *.log -EA SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
      if (!$file) { Write-Host "No .log files found in the current directory."; return }
      $f = $file.FullName
    }
    Write-Host "Tailing $f (Ctrl+C to stop)..."
    Get-Content $f -Wait -Tail 20
  ]])
end, "tail a log file (defaults to the newest *.log here)")

oxis.command("healthcheck", function()
  oxis.run([[
    $url = Read-Host "URL (default http://localhost:3000/health)"
    if (!$url) { $url = "http://localhost:3000/health" }
    Invoke-WebRequest $url -UseBasicParsing | Select-Object StatusCode
  ]])
end, "GET a health endpoint and show the status code")

-- Runs until you stop it with Ctrl+C, same convention as the built-in
-- process watcher (pwatch)
oxis.task("watch-mem", "while ($true) { Get-Process | Sort-Object WS -Descending | Select-Object -First 5 Name,WS; Start-Sleep 5 }", "poll the top 5 memory-hungry processes every 5 seconds until stopped")
