--[[@manifest
version: 1.0.0
description: Lists what a project can run — package.json scripts and Makefile targets — numbered, and runs the one you pick.
author: Oxide Labs
category: devops
min_oxis_version: 1.2.1
os: windows, unix
permissions: fs, shell
]]

-- scripts.lua — 'scripts shows the current folder's package.json scripts
-- (with the command each runs) and Makefile targets, numbered; type a
-- number or a name to run it. 'scripts <name> runs one straight away.

local function readJSON(path, done)
  oxis.fs.read(path, function(err, text)
    if err then return done(nil) end
    local ok, value = pcall(oxis.json.decode, text)
    done(ok and value or nil)
  end)
end

-- Makefile targets: "name:" at the start of a line, not .PHONY and the
-- like, and not variable assignments (name := …).
local function makeTargets(text)
  local out, seen = {}, {}
  for line in (text .. "\n"):gmatch("([^\n]*)\n") do
    local name = line:match("^([%w][%w%-_%.]*)%s*:[^=]")
      or line:match("^([%w][%w%-_%.]*)%s*:$")
    if name and not seen[name] then
      seen[name] = true
      out[#out + 1] = name
    end
  end
  return out
end

local function collect(done)
  local dir = oxis.cwd()
  local found = {}
  readJSON(dir .. "/package.json", function(pkg)
    local runner = "npm run"
    oxis.fs.stat(dir .. "/pnpm-lock.yaml", function(_, pn)
      oxis.fs.stat(dir .. "/yarn.lock", function(_, yl)
        if pn and pn.exists then runner = "pnpm" elseif yl and yl.exists then runner = "yarn" end
        if pkg and type(pkg.scripts) == "table" then
          local names = {}
          for name in pairs(pkg.scripts) do names[#names + 1] = name end
          table.sort(names)
          for _, name in ipairs(names) do
            found[#found + 1] = { name = name, run = runner .. " " .. name, what = tostring(pkg.scripts[name]) }
          end
        end
        oxis.fs.read(dir .. "/Makefile", function(err, text)
          if not err then
            for _, t in ipairs(makeTargets(text)) do
              found[#found + 1] = { name = t, run = "make " .. t, what = "make target" }
            end
          end
          done(found)
        end)
      end)
    end)
  end)
end

oxis.command("scripts", function(args, rest)
  collect(function(found)
    if #found == 0 then
      return oxis.echo("nothing to run here: no package.json scripts or Makefile targets in " .. oxis.cwd(), "warn")
    end
    if rest ~= "" then
      for _, s in ipairs(found) do
        if s.name == rest then return oxis.run(s.run) end
      end
      return oxis.echo("no script called " .. rest .. " — 'scripts lists them", "err")
    end
    for i, s in ipairs(found) do
      oxis.echo(("%3d  %-18s %s"):format(i, s.name, s.what), i % 2 == 0 and "dim" or nil)
    end
    oxis.ask("Run which? (number or name, Enter for none)", function(answer)
      answer = answer:gsub("^%s+", ""):gsub("%s+$", "")
      if answer == "" then return end
      local pick = found[tonumber(answer) or -1]
      if not pick then
        for _, s in ipairs(found) do if s.name == answer then pick = s end end
      end
      if not pick then return oxis.echo("no script " .. answer, "err") end
      oxis.run(pick.run)
    end, { label = "scripts" })
  end)
end, "list the project's scripts and Makefile targets, and run one")
