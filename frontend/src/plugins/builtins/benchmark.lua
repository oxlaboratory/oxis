-- benchmark.lua — time commands
-- The command runs in your shell exactly as typed after 'time or 'bench.

local WIN = oxis.platform == "windows"

oxis.command("time", function(_, rest)
  if rest == "" then oxis.echo("usage: 'time <command>"); return end
  if WIN then
    oxis.run("$oxisSw = [Diagnostics.Stopwatch]::StartNew(); " .. rest ..
      "; Write-Host ''; Write-Host \"  took $($oxisSw.ElapsedMilliseconds) ms\"")
  else
    oxis.run("oxis_t=$(date +%s%N); " .. rest ..
      "; echo; echo \"  took $(( ($(date +%s%N) - oxis_t) / 1000000 )) ms\"")
  end
end, "how long a command takes: 'time <command>")

oxis.command("bench", function(_, rest)
  local runs, cmd = rest:match("^(%d+)%s+(.+)$")
  runs, cmd = tonumber(runs) or 5, cmd or rest
  if cmd == "" then oxis.echo("usage: 'bench [runs] <command>   (default 5 runs)"); return end
  if WIN then
    oxis.run(([[
Write-Host "Running %d times:" %s
$times = @()
for ($i = 1; $i -le %d; $i++) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  & { %s } *> $null
  $times += $sw.ElapsedMilliseconds
}
$m = $times | Measure-Object -Average -Minimum -Maximum
Write-Host ("  avg {0:N0} ms   min {1} ms   max {2} ms" -f $m.Average, $m.Minimum, $m.Maximum)
]]):format(runs, oxis.quote(cmd), runs, cmd))
  else
    oxis.run(([[
echo "Running %d times:" %s
for i in $(seq %d); do
  s=$(date +%%s%%N)
  { %s ; } >/dev/null 2>&1
  echo $(( ($(date +%%s%%N) - s) / 1000000 ))
done | awk '{ t += $1; if (NR == 1 || $1 < lo) lo = $1; if ($1 > hi) hi = $1 }
  END { printf "  avg %%d ms   min %%d ms   max %%d ms\n", t / NR, lo, hi }'
]]):format(runs, oxis.quote(cmd), runs, cmd))
  end
end, "run a command several times and report avg/min/max: 'bench [runs] <command>")
