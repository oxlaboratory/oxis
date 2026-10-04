//go:build cgo

package luanative

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// searchPaths is what goes in front of package.path and package.cpath:
// ~/.oxis/lua (modules of your own), then LuaRocks' user tree (and on
// Linux, the distribution's Lua 5.4 folders), so `require` finds what
// `luarocks install --lua-version 5.4` put there.
func searchPaths() (path, cpath string) {
	var lua, c []string
	add := func(root string) {
		if root == "" {
			return
		}
		lua = append(lua, filepath.Join(root, "?.lua"), filepath.Join(root, "?", "init.lua"))
		c = append(c, filepath.Join(root, "?."+cModuleExt))
	}
	rocks := func(tree string) {
		if tree == "" {
			return
		}
		lua = append(lua, filepath.Join(tree, "share", "lua", "5.4", "?.lua"), filepath.Join(tree, "share", "lua", "5.4", "?", "init.lua"))
		c = append(c, filepath.Join(tree, "lib", "lua", "5.4", "?."+cModuleExt))
	}
	home, _ := os.UserHomeDir()
	if home != "" {
		add(filepath.Join(home, ".oxis", "lua"))
	}
	if runtime.GOOS == "windows" {
		if appdata := os.Getenv("APPDATA"); appdata != "" {
			rocks(filepath.Join(appdata, "luarocks"))
		}
	} else {
		if home != "" {
			rocks(filepath.Join(home, ".luarocks"))
		}
		lua = append(lua, "/usr/share/lua/5.4/?.lua", "/usr/share/lua/5.4/?/init.lua")
		c = append(c, "/usr/lib/x86_64-linux-gnu/lua/5.4/?.so", "/usr/lib/lua/5.4/?.so")
	}
	return join(lua), join(c)
}

func join(parts []string) string {
	if len(parts) == 0 {
		return ""
	}
	return strings.Join(parts, ";") + ";"
}
