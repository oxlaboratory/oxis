//go:build !windows

package wailsapp

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// moveToTrash moves full (an absolute path) to the Trash: ~/.Trash on
// macOS, the freedesktop.org trash (with its .trashinfo) elsewhere.
func moveToTrash(full string) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	if runtime.GOOS == "darwin" {
		dir := filepath.Join(home, ".Trash")
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
		return os.Rename(full, uniqueIn(dir, filepath.Base(full), ""))
	}
	base := os.Getenv("XDG_DATA_HOME")
	if base == "" {
		base = filepath.Join(home, ".local", "share")
	}
	files, info := filepath.Join(base, "Trash", "files"), filepath.Join(base, "Trash", "info")
	if err := os.MkdirAll(files, 0o700); err != nil {
		return err
	}
	if err := os.MkdirAll(info, 0o700); err != nil {
		return err
	}
	dest := uniqueIn(files, filepath.Base(full), ".trashinfo")
	name := filepath.Base(dest)
	escaped := strings.ReplaceAll(url.PathEscape(full), "%2F", "/")
	entry := fmt.Sprintf("[Trash Info]\nPath=%s\nDeletionDate=%s\n", escaped, time.Now().Format("2006-01-02T15:04:05"))
	infoPath := filepath.Join(info, name+".trashinfo")
	if err := os.WriteFile(infoPath, []byte(entry), 0o600); err != nil {
		return err
	}
	if err := os.Rename(full, dest); err != nil {
		os.Remove(infoPath)
		return fmt.Errorf("couldn't move %s to the Trash: %w", full, err)
	}
	return nil
}

// uniqueIn is dir/name, or dir/"name 2"… when that (or its info file,
// name+infoExt in the sibling info folder) is taken.
func uniqueIn(dir, name, infoExt string) string {
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	for i := 1; ; i++ {
		n := name
		if i > 1 {
			n = fmt.Sprintf("%s %d%s", stem, i, ext)
		}
		p := filepath.Join(dir, n)
		if _, err := os.Lstat(p); err == nil {
			continue
		}
		if infoExt != "" {
			if _, err := os.Lstat(filepath.Join(filepath.Dir(dir), "info", n+infoExt)); err == nil {
				continue
			}
		}
		return p
	}
}
