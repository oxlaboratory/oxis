-- npm.lua — OXIS built-in npm plugin
oxis.command("ni",  function() oxis.run("npm install") end, "npm install")
oxis.command("nb",  function() oxis.run("npm run build") end, "npm run build")
oxis.command("nd",  function() oxis.run("npm run dev") end, "npm run dev")
oxis.command("nt",  function() oxis.run("npm test") end, "npm test")
oxis.command("nls", function() oxis.run("npm list --depth=0") end, "list top-level installed packages")
