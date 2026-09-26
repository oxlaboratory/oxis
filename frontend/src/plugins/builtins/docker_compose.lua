-- docker_compose.lua — Docker Compose workflow (Compose v2: `docker compose`)

local DC = "docker compose"

-- " 'svc1' 'svc2'" from the command's arguments, or "" for all services.
local function services(args)
  local out = ""
  for _, a in ipairs(args) do out = out .. " " .. oxis.quote(a) end
  return out
end

oxis.command("dcup", function(args)
  oxis.run(DC .. " up -d" .. services(args) .. " && " .. DC .. " ps")
end, "start services in the background, then show status: 'dcup [service...]")

oxis.command("dcdown", function() oxis.run(DC .. " down") end, "stop and remove the project's containers")

oxis.command("dcrestart", function(args)
  oxis.run(DC .. " restart" .. services(args) .. " && " .. DC .. " ps")
end, "restart services: 'dcrestart [service...]")

oxis.command("dcps", function() oxis.run(DC .. " ps") end, "service status")

oxis.command("dclogs", function(args)
  oxis.run(DC .. " logs --tail=100 -f" .. services(args))
end, "follow the last 100 log lines (Ctrl+C stops): 'dclogs [service...]")

oxis.command("dcbuild", function(args)
  oxis.run(DC .. " build --no-cache" .. services(args))
end, "rebuild images without the cache: 'dcbuild [service...]")

oxis.command("dcpull", function() oxis.run(DC .. " pull && " .. DC .. " up -d") end,
  "pull newer images and recreate what changed")

oxis.command("dcprune", function() oxis.run("docker system prune && docker volume prune") end,
  "remove stopped containers, unused networks, dangling images and unused volumes (Docker asks first)")

oxis.command("dcstats", function()
  oxis.run([[docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}']])
end, "CPU, memory and network use of running containers")

oxis.command("dcexec", function(args)
  if #args == 0 then oxis.echo("usage: 'dcexec <service> [command]   (default command: sh)"); return end
  local cmd = #args > 1 and table.concat(args, " ", 2) or "sh"
  oxis.run(DC .. " exec " .. oxis.quote(args[1]) .. " " .. cmd)
end, "run a command (default: a shell) inside a service: 'dcexec <service> [command]")
