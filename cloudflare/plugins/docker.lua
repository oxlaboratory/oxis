--[[@manifest
version: 1.0.0
description: Your containers at a glance — a live list that updates in place, logs that stream, and a prune that asks first.
author: Oxide Labs
category: devops
min_oxis_version: 1.2.1
os: windows, unix
permissions: shell
]]

-- docker.lua — 'containers shows running containers (name, image,
-- status, ports) and keeps the list current every 2 s until Ctrl+C;
-- 'containers all includes stopped ones. 'dlogs <name> streams a
-- container's logs. 'dprune asks, then runs docker system prune.

local function rows(all, done)
  local out = {}
  -- docker itself, not through a shell: no quoting, and quick to say
  -- so when docker isn't there.
  local args = { "ps", "--format", "{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}" }
  if all then table.insert(args, 2, "-a") end
  oxis.process.spawn({ cmd = "docker", args = args, lines = true }, {
    stdout = function(l)
      local name, image, status, ports = l:match("^([^\t]*)\t([^\t]*)\t([^\t]*)\t?(.*)$")
      if name then out[#out + 1] = { name = name, image = image, status = status, ports = ports } end
    end,
    exit = function(code)
      if code ~= 0 then return done(nil) end
      done(out)
    end,
  })
end

local function render(r)
  local up = r.status:match("^Up") ~= nil
  local text = ("%s %-22s %-28s %-22s %s"):format(up and "●" or "○", r.name:sub(1, 22), r.image:sub(1, 28), r.status:sub(1, 22), r.ports)
  return text, up and "ok" or "dim"
end

oxis.command("containers", function(args)
  local all = args[1] == "all"
  local header = oxis.line(("  %-22s %-28s %-22s %s"):format("NAME", "IMAGE", "STATUS", "PORTS"), "accent")
  local lines = {}
  local note = oxis.line("…", "dim")
  local function refresh()
    rows(all, function(list)
      if not list then
        note:set("✗ docker didn't answer — is Docker running?", "err")
        return
      end
      for i, r in ipairs(list) do
        local text, kind = render(r)
        if lines[i] then lines[i]:set(text, kind) else lines[i] = oxis.line(text, kind) end
      end
      for i = #list + 1, #lines do lines[i]:set("", "dim") end
      note:set(#list == 0 and "no containers" .. (all and "" or " running ('containers all for stopped ones)") or ("%d container%s · Ctrl+C stops"):format(#list, #list == 1 and "" or "s"), "dim")
    end)
  end
  refresh()
  oxis.every(2, refresh, { foreground = true, stop = function() note:set("stopped", "dim") end })
end, "running containers, kept up to date ('containers all for every one)")

oxis.command("dlogs", function(args, rest)
  if rest == "" then return oxis.echo("'dlogs <container> — 'containers lists them", "warn") end
  local proc
  proc = oxis.process.spawn({ cmd = "docker", args = { "logs", "--tail", "50", "-f", rest }, lines = true }, {
    stdout = function(l) oxis.echo(l) end,
    stderr = function(l) oxis.echo(l, "dim") end,
    exit = function(code, err)
      if err == "killed" then oxis.echo("■ stopped following " .. rest, "dim")
      elseif code ~= 0 then oxis.echo("✗ docker logs ended (" .. tostring(code) .. ")", "err") end
    end,
  })
  oxis.echo("following " .. rest .. " — Ctrl+C stops", "dim")
  oxis.every(3600, function() end, { foreground = true, stop = function() if proc then proc:kill() end end })
end, "stream a container's logs (Ctrl+C stops)")

oxis.command("dprune", function()
  oxis.ask("Remove stopped containers, unused networks and dangling images? (yes/no)", function(answer)
    if answer ~= "yes" and answer ~= "y" then return oxis.echo("left as it is", "dim") end
    oxis.run("docker system prune -f")
  end, { label = "docker" })
end, "docker system prune, after asking")
