-- ui.lua — theme cycling and dashboard config

local THEMES = { "default", "midnight", "slate", "forest", "ember", "rose", "dusk", "void" }
local themeIndex = 1

oxis.command("themecycle", function()
  themeIndex = themeIndex % #THEMES + 1
  local nextTheme = THEMES[themeIndex]
  oxis.theme(nextTheme)
  oxis.echo("Theme -> " .. nextTheme)
end, "switch to the next theme in the built-in rotation")

oxis.command("dark", function() oxis.theme("void") end, "switch to the void (pure black) theme")

oxis.keymap("normal", "<C-A-t>", function() oxis.newTerminal() end)

oxis.dashboard({
  header = "OXIS",
  theme  = "midnight",
  shortcuts = { "New Terminal", "Recent Projects", "Plugins" }
})
