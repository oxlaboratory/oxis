//go:build windows && cgo

package luanative

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
)

// lua54.dll, built from third_party/lua by scripts/build-lua.js.
//
//go:embed lua54.dll
var luaDLL []byte

// libraryPath writes lua54.dll out (once per build of it) and returns
// where. It keeps that name: a Lua C module imports "lua54.dll", and
// Windows hands it the one already loaded, so module and plugin share
// one Lua.
func libraryPath() (string, error) {
	sum := sha256.Sum256(luaDLL)
	base, err := os.UserCacheDir()
	if err != nil {
		base = os.TempDir()
	}
	dir := filepath.Join(base, "oxis", "lua-"+hex.EncodeToString(sum[:6]))
	path := filepath.Join(dir, "lua54.dll")
	if have, err := os.ReadFile(path); err == nil && bytes.Equal(have, luaDLL) {
		return path, nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("couldn't write lua54.dll: %w", err)
	}
	// Written beside and renamed, so another OXIS starting at the same
	// moment never loads half a file.
	tmp := fmt.Sprintf("%s.%d.tmp", path, os.Getpid())
	if err := os.WriteFile(tmp, luaDLL, 0o644); err != nil {
		return "", fmt.Errorf("couldn't write lua54.dll: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		// Another OXIS got there first and has it loaded: use theirs if
		// it's the same.
		if have, rerr := os.ReadFile(path); rerr == nil && bytes.Equal(have, luaDLL) {
			return path, nil
		}
		return "", fmt.Errorf("couldn't write lua54.dll: %w", err)
	}
	return path, nil
}

// cModuleExt is what Lua C modules are called here.
const cModuleExt = "dll"
