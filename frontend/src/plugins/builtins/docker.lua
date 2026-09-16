-- docker.lua — OXIS built-in Docker plugin
oxis.command("dps",   function() oxis.run("docker ps") end, "list running containers")
oxis.command("dimg",  function() oxis.run("docker images") end, "list local images")
oxis.command("dup",   function() oxis.run("docker-compose up -d") end, "docker-compose up -d")
oxis.command("ddown", function() oxis.run("docker-compose down") end, "docker-compose down")
