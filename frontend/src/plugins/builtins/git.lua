-- git.lua — OXIS built-in Git plugin
-- Edit: %USERPROFILE%\.oxis\plugins\git.lua

oxis.command("gs",  function() oxis.run("git status") end, "show working tree status")
oxis.command("gl",  function() oxis.run("git log --oneline -20") end, "show the last 20 commits, one line each")
oxis.command("gd",  function() oxis.run("git diff") end, "show unstaged changes")
oxis.command("ga",  function() oxis.run("git add -A && git status") end, "stage everything, then show status")
oxis.command("gp",  function() oxis.run("git push") end, "push the current branch")
oxis.command("gpl", function() oxis.run("git pull") end, "pull the current branch")
oxis.command("gb",  function() oxis.run("git branch -a") end, "list all branches (local + remote)")
oxis.command("gst", function() oxis.run("git stash") end, "stash working tree changes")

oxis.autocmd("ShellOpen", function()
  oxis.echo("git plugin ready")
end)
