-- benchmark.lua — command benchmarking

oxis.command("time", function()
  oxis.run([[
    $cmd   = $args -join ' '
    $start = Get-Date
    Invoke-Expression $cmd
    $end   = Get-Date
    $ms    = [math]::Round(($end - $start).TotalMilliseconds)
    Write-Host ""
    Write-Host "  Time elapsed: ${ms}ms"
  ]])
end, "time how long a command takes to run")

oxis.command("bench", function()
  oxis.run([[
    $runs  = 5
    $times = @()
    Write-Host "Benchmarking $runs runs..."
    for ($i = 1; $i -le $runs; $i++) {
      $s = Get-Date
      Invoke-Expression ($args -join ' ') | Out-Null
      $times += [math]::Round((Get-Date - $s).TotalMilliseconds)
    }
    $avg = [math]::Round(($times | Measure-Object -Average).Average)
    $min = ($times | Measure-Object -Minimum).Minimum
    $max = ($times | Measure-Object -Maximum).Maximum
    Write-Host "  avg: ${avg}ms  min: ${min}ms  max: ${max}ms"
  ]])
end, "run a command 5x and report avg/min/max timing")
