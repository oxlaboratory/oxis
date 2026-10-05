--[[@manifest
version: 1.0.0
description: A countdown that ticks in place ('timer 25m tea), and pomodoro rounds of work and breaks. Ctrl+C stops.
author: Oxide Labs
category: productivity
min_oxis_version: 1.2.1
os: windows, unix
permissions:
]]

-- timer.lua — 'timer 90s, 'timer 25m write docs, 'timer 1h30m.
-- 'pomodoro [work] [break] counts 25/5-minute rounds until Ctrl+C.

-- "90", "90s", "25m", "1h30m", "1:30" (minutes:seconds) → seconds.
local function parse(text)
  if not text or text == "" then return nil end
  local m, s = text:match("^(%d+):(%d%d)$")
  if m then return tonumber(m) * 60 + tonumber(s) end
  if text:match("^%d+$") then return tonumber(text) * 60 end -- a bare number is minutes
  local total, any = 0, false
  for n, unit in text:gmatch("(%d+)([hms])") do
    any = true
    total = total + tonumber(n) * ({ h = 3600, m = 60, s = 1 })[unit]
  end
  if not any or text:gsub("%d+[hms]", "") ~= "" then return nil end
  return total
end

local function clock(sec)
  sec = math.max(0, math.floor(sec + 0.5))
  local h, m, s = sec // 3600, sec % 3600 // 60, sec % 60
  if h > 0 then return ("%d:%02d:%02d"):format(h, m, s) end
  return ("%d:%02d"):format(m, s)
end

local function bar(done, total)
  local width = 24
  local filled = total > 0 and math.floor(width * done / total + 0.5) or width
  return ("█"):rep(filled) .. ("░"):rep(width - filled)
end

-- Counts down `total` seconds on one line; calls finished when it's
-- over (not when stopped).
local function countdown(total, label, finished)
  local started = os.time()
  local line = oxis.line("⏳ " .. clock(total) .. "  " .. bar(0, total) .. "  " .. label, "accent")
  local job
  job = oxis.every(1, function()
    local left = total - (os.time() - started)
    if left <= 0 then
      job:stop()
      line:set("✓ " .. label .. " — " .. clock(total) .. " done", "ok")
      if finished then finished() end
      return
    end
    line:set("⏳ " .. clock(left) .. "  " .. bar(total - left, total) .. "  " .. label, "accent")
  end, { foreground = true, stop = function()
    local left = total - (os.time() - started)
    if left > 0 then line:set("■ " .. label .. " stopped with " .. clock(left) .. " left", "dim") end
  end })
end

oxis.command("timer", function(args, rest)
  local amount, label = rest:match("^(%S+)%s*(.*)$")
  local total = parse(amount)
  if not total or total <= 0 then
    return oxis.echo("'timer 90s · 'timer 25m tea · 'timer 1h30m · 'timer 1:30", "warn")
  end
  countdown(total, label ~= "" and label or "timer")
end, "count down: 'timer 25m [what for] (Ctrl+C stops)")

oxis.command("pomodoro", function(args)
  local work = parse(args[1] or "25m") or 1500
  local rest = parse(args[2] or "5m") or 300
  local round = 0
  local function nextRound()
    round = round + 1
    countdown(work, ("work · round %d"):format(round), function()
      countdown(rest, "break", nextRound)
    end)
  end
  oxis.echo(("pomodoro: %s work, %s break — Ctrl+C stops"):format(clock(work), clock(rest)), "dim")
  nextRound()
end, "rounds of work and a break: 'pomodoro [25m] [5m] (Ctrl+C stops)")
