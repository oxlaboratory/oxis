--[[@manifest
version: 1.0.0
description: Re-runs your tests the moment you save a file and tells you in one line whether they pass. Finds the test command itself (npm, Go, Cargo, pytest) or takes yours.
author: Oxide Labs
category: devops
min_oxis_version: 1.2.1
os: windows, unix
permissions: fs, shell
]]

-- autotest.lua — 'autotest watches the current project (oxis.fs.watch)
-- and, after each burst of saves, runs its tests (oxis.process.spawn),
-- printing one line: pass with the time taken, or fail with the lines
-- that explain why. 'autotest stop ends it.

local watcher, proc
local dirty, busy = false, false
local command, root

local function now() return os.clock() end

-- The first project file found decides the command.
local DETECT = {
  { file = "package.json",   cmd = "npm test --silent" },
  { file = "go.mod",         cmd = "go test ./..." },
  { file = "Cargo.toml",     cmd = "cargo test --quiet" },
  { file = "pyproject.toml", cmd = "python -m pytest -q" },
  { file = "pytest.ini",     cmd = "python -m pytest -q" },
}

local function detect(dir, i, done)
  local d = DETECT[i]
  if not d then return done(nil) end
  oxis.fs.stat(dir .. "/" .. d.file, function(err, st)
    if not err and st and st.exists then return done(d.cmd) end
    detect(dir, i + 1, done)
  end)
end

-- Lines worth showing when tests fail: which test, and what it got
-- versus what it expected — not the whole log or its summary counts.
local KEEP = { "^%s*✖", "^%s*✗", "%-%-%- FAIL", "^FAIL", "FAILED", "panicked", "Error", "error%[",
               "[Ee]xpected", "[Aa]ctual", "!==", " != ", "assert" }
local SKIP = { "^%s*ℹ", "failing tests:", "ERR_ASSERTION'", "^%s*at ", "^%s*test at " }

local function matchesAny(line, patterns)
  for _, p in ipairs(patterns) do if line:find(p) then return true end end
  return false
end

local function reasons(lines)
  local out, seen = {}, {}
  for _, l in ipairs(lines) do
    local key = l:gsub("^%s+", ""):gsub("%s+$", "")
    if key ~= "" and not seen[key] and matchesAny(l, KEEP) and not matchesAny(l, SKIP) then
      seen[key] = true
      out[#out + 1] = key
      if #out >= 5 then break end
    end
  end
  return out
end

local function run()
  if busy then dirty = true return end
  busy, dirty = true, false
  local started = now()
  local lines = {}
  oxis.echo("⟳ " .. command)
  proc = oxis.process.spawn({ shell = command, cwd = root, lines = true }, {
    stdout = function(l) lines[#lines + 1] = l end,
    stderr = function(l) lines[#lines + 1] = l end,
    exit = function(code, err)
      proc = nil
      busy = false
      local took = string.format("%.1fs", now() - started)
      if err == "killed" then
        -- stopped by 'autotest stop
      elseif code == 0 then
        oxis.echo("✓ tests pass (" .. took .. ")")
      else
        oxis.echo("✗ tests fail (exit " .. tostring(code or err) .. ", " .. took .. ")")
        for _, l in ipairs(reasons(lines)) do oxis.echo("   " .. l) end
      end
      if dirty and watcher then run() end
    end,
  })
end

local function stop()
  if watcher then watcher.close() watcher = nil end
  if proc then proc.kill() proc = nil end
  busy, dirty = false, false
end

oxis.command("autotest", function(args, rest)
  if not (oxis.fs.watch and oxis.process.spawn) then
    oxis.echo("autotest needs a newer OXIS (with oxis.fs.watch): 'update install")
    return
  end
  if args[1] == "stop" then
    if watcher then stop() oxis.echo("autotest stopped") else oxis.echo("autotest isn't running") end
    return
  end
  stop()
  root = oxis.cwd()
  local start = function(cmd)
    if not cmd then
      oxis.echo("no test command found here — give one: 'autotest npm run test:unit")
      return
    end
    command = cmd
    watcher = oxis.fs.watch(root, {
      change = function(ev)
        -- Only source changes; build output and editor temp files don't count.
        if ev.path:find("[/\\]dist[/\\]") or ev.path:find("[/\\]build[/\\]") or ev.path:find("~$") then return end
        run()
      end,
      ready = function()
        local name = root:match("[^/\\]+$") or root
        oxis.echo("autotest: watching " .. name .. " — saving a file runs `" .. command .. "` ('autotest stop to end)")
        run()
      end,
    }, { debounce = 300, ignore = { ".git", "node_modules", "target", "__pycache__", ".venv" } })
  end
  if rest ~= "" then start(rest) else detect(root, 1, start) end
end, "re-run the tests on every save ('autotest stop, or 'autotest <command>)")
