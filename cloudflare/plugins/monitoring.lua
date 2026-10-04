--[[@manifest
version: 2.0.0
description: Watch your machine and your services without leaving OXIS — live CPU and memory with sparklines, the processes eating your RAM and what's growing, logs as they're written (errors in red), health checks that tell you the moment a service goes down, and alerts in the background. Ctrl+C stops anything live.
author: Oxide Labs
category: monitoring
min_oxis_version: 1.2.1
os: windows, unix
permissions: system, process, net, fs
]]

-- monitoring.lua
--
--   'mon [seconds]              live CPU and memory, a line every few seconds
--   'top [n]                    the processes using the most memory
--   'watch-mem [seconds] [n]    those processes, live, with what's growing
--   'tail <file> [filter]       follow a log as it's written
--   'healthcheck <url>… [every <s>]   status and latency, or watch them
--   'alert cpu|mem <percent>    warn (in the background) when it's crossed
--   'alert off                  stop alerting
--
-- Everything live is a foreground job: Ctrl+C stops it and prints a
-- summary. OXIS's own 'sysinfo and 'disk show the machine at a glance.

local SPARKS = { "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█" }

local function needsNewer(...)
  for _, name in ipairs({ ... }) do
    if not oxis[name] then
      oxis.echo("monitoring needs a newer OXIS build for this — run 'update install", "warn")
      return true
    end
  end
  return false
end

local function bar(fraction, width)
  width = width or 20
  fraction = math.max(0, math.min(1, fraction or 0))
  local filled = math.floor(fraction * width + 0.5)
  return ("█"):rep(filled) .. ("░"):rep(width - filled)
end

local function spark(values, top)
  local t = {}
  top = top or 100
  for i, v in ipairs(values) do
    t[i] = SPARKS[math.max(1, math.min(#SPARKS, math.floor(v / top * (#SPARKS - 1) + 1.5)))]
  end
  return table.concat(t)
end

local function gb(mb) return ("%.1f GB"):format((mb or 0) / 1024) end

local function duration(sec)
  sec = math.floor(sec or 0)
  local d, h, m = sec // 86400, (sec % 86400) // 3600, (sec % 3600) // 60
  if d > 0 then return ("%dd %dh %dm"):format(d, h, m) end
  if h > 0 then return ("%dh %dm"):format(h, m) end
  if m > 0 then return ("%dm %ds"):format(m, sec % 60) end
  return sec .. "s"
end

local function clock() return os.date and os.date("%H:%M:%S") or "" end

local function level(pct, warnAt, badAt)
  if pct >= (badAt or 90) then return "err" end
  if pct >= (warnAt or 75) then return "warn" end
  return "ok"
end

local function sysinfo(cb)
  oxis.system.info(function(err, info)
    if err then return oxis.echo("couldn't read the system: " .. err, "err") end
    cb(info)
  end)
end

-- ── 'mon ────────────────────────────────────────────────────

oxis.command("mon", function(args)
  if needsNewer("every") then return end
  local every = math.max(1, tonumber(args[1]) or 2)
  local cpu, peakCpu, peakMem, n, started = {}, 0, 0, 0, os.time()
  local sumCpu = 0
  oxis.echo(("📈 Live every %ds — Ctrl+C stops"):format(every), "accent")
  local function tick()
    sysinfo(function(i)
      local memPct = i.memTotalMB > 0 and i.memUsedMB / i.memTotalMB * 100 or 0
      cpu[#cpu + 1] = i.cpuPercent
      if #cpu > 24 then table.remove(cpu, 1) end
      n, sumCpu = n + 1, sumCpu + i.cpuPercent
      peakCpu, peakMem = math.max(peakCpu, i.cpuPercent), math.max(peakMem, memPct)
      -- Padded by hand: the spark characters are three bytes each.
      local line = spark(cpu) .. (" "):rep(24 - #cpu)
      oxis.echo(("%s  CPU %5.1f%% %s  RAM %5.1f%% %s/%s"):format(clock(), i.cpuPercent, line, memPct, gb(i.memUsedMB), gb(i.memTotalMB)),
        level(math.max(i.cpuPercent, memPct)))
    end)
  end
  tick()
  oxis.every(every, tick, { foreground = true, stop = function()
    if n == 0 then return end
    oxis.echo(("📈 %d samples over %s — CPU avg %.1f%%, peak %.1f%% · RAM peak %.1f%%"):format(n, duration(os.time() - started), sumCpu / n, peakCpu, peakMem), "dim")
  end })
end, "live CPU and memory with a sparkline, a line every few seconds — 'mon [seconds]; Ctrl+C stops")

-- ── 'top / 'watch-mem ───────────────────────────────────────

local function topProcesses(n, cb)
  oxis.process.list(function(err, list)
    if err then return oxis.echo("couldn't list processes: " .. err, "err") end
    -- Several processes with one name (browser tabs, helpers) add up.
    local byName, order = {}, {}
    for _, p in ipairs(list) do
      local e = byName[p.name]
      if not e then
        e = { name = p.name, mem = 0, cpu = 0, count = 0, cpuKnown = (p.cpu or -1) >= 0 }
        byName[p.name] = e
        order[#order + 1] = e
      end
      e.mem = e.mem + (p.memMB or 0)
      e.cpu = e.cpu + math.max(0, p.cpu or 0)
      e.count = e.count + 1
    end
    table.sort(order, function(a, b) return a.mem > b.mem end)
    local top = {}
    for i = 1, math.min(n, #order) do top[i] = order[i] end
    cb(top, #list)
  end)
end

local function printTop(top, previous)
  local most = top[1] and top[1].mem or 1
  for i, p in ipairs(top) do
    local change = ""
    if previous and previous[p.name] then
      local d = p.mem - previous[p.name]
      if d > 5 then change = (" ↑%.0f MB"):format(d) elseif d < -5 then change = (" ↓%.0f MB"):format(-d) end
    end
    local cpu = p.cpuKnown and ("%5.1f%% CPU  "):format(p.cpu) or ""
    local count = p.count > 1 and (" ×" .. p.count) or ""
    oxis.echo(("%2d. %-26s %s %7.0f MB  %s%s"):format(i, (p.name .. count):sub(1, 26), bar(p.mem / most, 12), p.mem, cpu, change),
      change:find("↑") and "warn" or "info")
  end
end

oxis.command("top", function(args)
  local n = math.max(1, math.min(40, tonumber(args[1]) or 10))
  topProcesses(n, function(top, total)
    oxis.echo(("🔝 Top %d of %d processes by memory"):format(#top, total), "accent")
    printTop(top)
  end)
end, "the processes using the most memory (CPU too, on Linux) — 'top [n]")

oxis.command("watch-mem", function(args)
  if needsNewer("every") then return end
  local every = math.max(2, tonumber(args[1]) or 5)
  local n = math.max(1, math.min(20, tonumber(args[2]) or 5))
  local previous, rounds = nil, 0
  oxis.echo(("👀 Top %d by memory every %ds — Ctrl+C stops"):format(n, every), "accent")
  local function tick()
    topProcesses(n, function(top)
      rounds = rounds + 1
      oxis.echo(("── %s"):format(clock()), "dim")
      printTop(top, previous)
      previous = {}
      for _, p in ipairs(top) do previous[p.name] = p.mem end
    end)
  end
  tick()
  oxis.every(every, tick, { foreground = true, stop = function()
    oxis.echo(("👀 Watched %d rounds."):format(rounds), "dim")
  end })
end, "the top memory users, live, with what's growing — 'watch-mem [seconds] [n]; Ctrl+C stops")

-- ── 'tail ───────────────────────────────────────────────────

local function lineKind(line)
  local l = line:lower()
  if l:find("error") or l:find("fatal") or l:find("panic") or l:find("exception") or l:find("fail") then return "err" end
  if l:find("warn") then return "warn" end
  if l:find("debug") or l:find("trace") then return "dim" end
  return "info"
end

oxis.command("tail", function(args)
  if needsNewer("every") then return end
  local path, filter = args[1], args[2] and args[2]:lower()
  if not path then return oxis.echo("'tail <file> [filter] — follows a log as it's written; Ctrl+C stops", "dim") end
  local size, carry, shown = 0, "", 0
  local function emit(text)
    local data = carry .. text
    local lines = {}
    for line in data:gmatch("([^\n]*)\n") do lines[#lines + 1] = line end
    carry = data:match("[^\n]*$") or ""
    for _, line in ipairs(lines) do
      line = line:gsub("\r$", "")
      if not filter or line:lower():find(filter, 1, true) then
        shown = shown + 1
        oxis.echo(line, lineKind(line))
      end
    end
  end
  oxis.fs.read(path, function(err, content)
    if err then return oxis.echo("couldn't read " .. path .. ": " .. err, "err") end
    -- The last 20 lines first, then everything appended.
    local lines = {}
    for line in content:gmatch("[^\n]*\n?") do if line ~= "" then lines[#lines + 1] = line end end
    size = #content
    oxis.echo(("📜 %s — following%s (Ctrl+C stops)"):format(path, filter and (" lines with “" .. filter .. "”") or ""), "accent")
    emit(table.concat(lines, "", math.max(1, #lines - 19)))
    local busy = false
    local function check()
      if busy then return end
      busy = true
      oxis.fs.read(path, function(e, now)
        busy = false
        if e then return end
        if #now < size then oxis.echo("── file was truncated or replaced", "dim") size, carry = 0, "" end
        if #now > size then emit(now:sub(size + 1)) size = #now end
      end)
    end
    -- A change notice reads at once; the poll covers filesystems that
    -- don't send them.
    local okWatch, watcher = pcall(oxis.fs.watch, path, check)
    if not okWatch then watcher = nil end
    oxis.every(2, check, { foreground = true, stop = function()
      if watcher and watcher.stop then watcher:stop() end
      oxis.echo(("📜 Stopped following %s (%d lines shown)."):format(path, shown), "dim")
    end })
  end)
end, "follow a log as it's written, errors in red and warnings in yellow — 'tail <file> [filter]; Ctrl+C stops")

-- ── 'healthcheck ────────────────────────────────────────────

oxis.command("healthcheck", function(args)
  local urls, every = {}, nil
  local i = 1
  while i <= #args do
    if args[i] == "every" and tonumber(args[i + 1]) then every = math.max(2, tonumber(args[i + 1])) i = i + 2
    else
      local u = args[i]
      if not u:match("^https?://") then u = "http://" .. u end
      urls[#urls + 1] = u
      i = i + 1
    end
  end
  if #urls == 0 then urls = { "http://localhost:3000/health" } end
  local stats = {}
  for _, u in ipairs(urls) do stats[u] = { up = 0, down = 0, total = 0, ms = 0, last = nil } end

  local function check(u)
    oxis.net.request({ url = u, method = "GET", timeout = 10 }, function(err, res)
      local s = stats[u]
      s.total = s.total + 1
      local ok = not err and res and res.status < 500
      local state = ok and "up" or "down"
      if ok then s.up = s.up + 1 s.ms = s.ms + (res.ms or 0) else s.down = s.down + 1 end
      local detail = err and err or (("%d · %.0f ms"):format(res.status, res.ms or 0))
      if not every or s.last ~= state then
        local change = (every and s.last) and (state == "up" and "  ▲ back up" or "  ▼ went down") or ""
        oxis.echo(("%s %s %s  %s%s"):format(clock(), ok and "●" or "○", u, detail, change), ok and "ok" or "err")
      end
      s.last = state
    end)
  end
  for _, u in ipairs(urls) do check(u) end
  if not every then return end
  if needsNewer("every") then return end
  oxis.echo(("🩺 Checking %d service%s every %ds — Ctrl+C stops (only changes are shown)"):format(#urls, #urls > 1 and "s" or "", every), "accent")
  oxis.every(every, function() for _, u in ipairs(urls) do check(u) end end, { foreground = true, stop = function()
    for _, u in ipairs(urls) do
      local s = stats[u]
      if s.total > 0 then
        oxis.echo(("🩺 %s  %.1f%% up over %d checks%s"):format(u, s.up / s.total * 100, s.total,
          s.up > 0 and (" · avg %.0f ms"):format(s.ms / s.up) or ""), s.down == 0 and "ok" or "warn")
      end
    end
  end })
end, "status and latency of one or more URLs — 'healthcheck localhost:3000/health api.example.com every 10")

-- ── 'alert ──────────────────────────────────────────────────

local alertTimer
oxis.command("alert", function(args)
  if needsNewer("every") then return end
  local what, limit = (args[1] or ""):lower(), tonumber(args[2])
  if what == "off" then
    if alertTimer then alertTimer:stop() alertTimer = nil end
    return oxis.echo("🔕 Alerts off.", "dim")
  end
  if (what ~= "cpu" and what ~= "mem") or not limit then
    return oxis.echo("'alert cpu <percent> · 'alert mem <percent> · 'alert off — checks every 10 s in the background", "dim")
  end
  if alertTimer then alertTimer:stop() end
  local over = false
  alertTimer = oxis.every(10, function()
    sysinfo(function(i)
      local v = what == "cpu" and i.cpuPercent or (i.memTotalMB > 0 and i.memUsedMB / i.memTotalMB * 100 or 0)
      if v >= limit and not over then
        over = true
        oxis.echo(("🔔 %s is at %.0f%% (alert at %d%%)"):format(what == "cpu" and "CPU" or "Memory", v, limit), "warn")
      elseif v < limit - 5 and over then
        over = false
        oxis.echo(("🔕 %s is back to %.0f%%"):format(what == "cpu" and "CPU" or "Memory", v), "dim")
      end
    end)
  end)
  oxis.echo(("🔔 Alerting when %s passes %d%% (checked every 10 s) — 'alert off to stop"):format(what == "cpu" and "CPU" or "memory", limit), "ok")
end, "warn in the terminal when CPU or memory passes a level — 'alert mem 85, 'alert off")
