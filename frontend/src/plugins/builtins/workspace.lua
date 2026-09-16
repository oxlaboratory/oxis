-- workspace.lua — OXIS project workspace
-- Location: <project>/.oxis/workspace.lua
--
-- Drop this file in any project directory.
-- OXIS detects it automatically when you cd into the project.

-- Set workspace theme
oxis.theme("midnight")

-- Enable project-specific plugins
oxis.plugin.enable("git")
oxis.plugin.enable("docker")
oxis.plugin.enable("npm")

-- Define project commands
oxis.command("dev", function()
  oxis.run("npm run dev")
end)

oxis.command("build", function()
  oxis.run("npm run build")
end)

oxis.command("deploy", function()
  oxis.run("./deploy.sh")
end)

-- Define tasks (run with 'task <name>)
oxis.task("frontend", "npm run dev")
oxis.task("backend",  "go run .")
oxis.task("test",     "npm test")

-- Announce workspace loaded
oxis.autocmd("WorkspaceLoaded", function()
  oxis.echo("Workspace loaded: my-project")
end)
