-- docker_compose.lua — Docker Compose workflow

oxis.command("dcup",     function() oxis.run("docker-compose up -d && docker-compose ps") end, "docker-compose up -d, then show status")
oxis.command("dcdown",   function() oxis.run("docker-compose down") end, "docker-compose down")
oxis.command("dcrestart",function() oxis.run("docker-compose restart && docker-compose ps") end, "restart all compose services")
oxis.command("dcps",     function() oxis.run("docker-compose ps") end, "show compose service status")
oxis.command("dclogs",   function() oxis.run("docker-compose logs --tail=100 -f") end, "tail compose logs")
oxis.command("dcbuild",  function() oxis.run("docker-compose build --no-cache") end, "rebuild compose images with no cache")
oxis.command("dcpull",   function() oxis.run("docker-compose pull && docker-compose up -d") end, "pull latest images and restart")
oxis.command("dcprune",  function() oxis.run("docker system prune -f && docker volume prune -f") end, "prune unused docker containers and volumes")
oxis.command("dcstats",  function()
  oxis.run("docker stats --no-stream --format 'table {{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}\\t{{.NetIO}}'")
end, "live resource usage for running containers")
oxis.command("dcexec", function()
  oxis.run([[
    $svc = Read-Host "Service name"
    docker-compose exec $svc /bin/sh
  ]])
end, "open a shell inside a compose service")
