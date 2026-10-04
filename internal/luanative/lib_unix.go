//go:build !windows && cgo

package luanative

// libraryPath: Lua is compiled into the binary (lua_unix.c).
func libraryPath() (string, error) { return "", nil }

// cModuleExt is what Lua C modules are called here.
const cModuleExt = "so"
