-- python.lua — OXIS built-in Python plugin
oxis.command("venv",   function() oxis.run("python -m venv .venv") end, "create a .venv virtual environment")
oxis.command("act",    function() oxis.run(".venv\\Scripts\\Activate.ps1") end, "activate the .venv virtual environment")
oxis.command("freeze", function() oxis.run("pip freeze > requirements.txt") end, "write installed packages to requirements.txt")
oxis.command("pipu",   function() oxis.run("pip list --outdated") end, "list outdated pip packages")
