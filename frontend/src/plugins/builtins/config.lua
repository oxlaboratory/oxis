-- config.lua — OXIS user configuration
-- Location: %USERPROFILE%\.oxis\config.lua
--
-- This file is loaded at startup. Configure OXIS to your taste.

-- Set startup theme
oxis.theme("default")

-- Set startup page: "home" or "shell"
oxis.option("startupPage", "home")

-- Set shell (windows: "powershell", linux/mac: "bash")
oxis.option("shell", "powershell")

-- Enable plugins
oxis.plugin.enable("git")
oxis.plugin.enable("npm")
oxis.plugin.enable("sysmon")
oxis.plugin.enable("files")

-- Custom keymaps
-- oxis.keymap("normal", "<C-g>", function()
--   oxis.run("git status")
-- end)

-- Custom commands
oxis.command("hello", function()
  oxis.echo("Hello from OXIS!")
end)

-- Dashboard configuration
-- oxis.dashboard({
--   header = "OXIS",
--   theme = "midnight",
--   shortcuts = { "New Terminal", "Recent Projects", "Plugins" }
-- })
