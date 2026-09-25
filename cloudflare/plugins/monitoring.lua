-- monitoring.lua — log tailing and process watching.
-- Every script branches on oxis.platform (PowerShell or bash).

oxis.command("tail", function()
  if oxis.platform == "windows" then
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
  else
    oxis.run([[
      read -p "Log file (blank = newest *.log): " f
      if [ -z "$f" ]; then
        f=$(ls -t *.log 2>/dev/null | head -n 1)
      fi
      if [ -z "$f" ]; then
        echo "No .log files found in the current directory."
      else
        echo "Tailing $f (Ctrl+C to stop)..."
        tail -f -n 20 "$f"
      fi
    ]])
  end
end, "tail a log file (defaults to the newest *.log here)")

oxis.command("healthcheck", function()
  if oxis.platform == "windows" then
    oxis.run([[
      $url = Read-Host "URL (default http://localhost:3000/health)"
      if (!$url) { $url = "http://localhost:3000/health" }
      Invoke-WebRequest $url -UseBasicParsing | Select-Object StatusCode
    ]])
  else
    oxis.run([[
      read -p "URL (default http://localhost:3000/health): " url
      url=${url:-http://localhost:3000/health}
      code=$(curl -s -o /dev/null -w "%{http_code}" "$url")
      echo "StatusCode : $code"
    ]])
  end
end, "GET a health endpoint and show the status code")

-- Runs until Ctrl+C. oxis.task() takes a fixed string, so pick the
-- platform's command at registration time.
if oxis.platform == "windows" then
  oxis.task("watch-mem",
    "while ($true) { Get-Process | Sort-Object WS -Descending | Select-Object -First 5 Name,WS; Start-Sleep 5 }",
    "poll the top 5 memory-hungry processes every 5 seconds until stopped")
else
  oxis.task("watch-mem",
    "while true; do echo; echo \"NAME              %MEM\"; ps -eo comm,%mem --sort=-%mem | head -n 6 | tail -n 5; sleep 5; done",
    "poll the top 5 memory-hungry processes every 5 seconds until stopped")
end