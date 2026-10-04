package wailsapp

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// CopyPath copies a file, or a folder and everything in it, to dst (the
// file tree's Duplicate). It refuses to overwrite, and to copy a folder
// into itself.
func (a *App) CopyPath(src string, dst string) error {
	from, to := resolvePath(src), resolvePath(dst)
	info, err := os.Lstat(from)
	if err != nil {
		return fmt.Errorf("source doesn't exist: %s", from)
	}
	if _, err := os.Lstat(to); err == nil {
		return fmt.Errorf("destination already exists: %s", to)
	}
	if info.IsDir() {
		rel, err := filepath.Rel(from, to)
		if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return fmt.Errorf("can't copy a folder into itself: %s", to)
		}
	}
	return copyTree(from, to)
}

func copyTree(from, to string) error {
	info, err := os.Lstat(from)
	if err != nil {
		return err
	}
	switch {
	case info.Mode()&os.ModeSymlink != 0:
		target, err := os.Readlink(from)
		if err != nil {
			return err
		}
		return os.Symlink(target, to)
	case info.IsDir():
		if err := os.Mkdir(to, info.Mode().Perm()|0o700); err != nil {
			return err
		}
		entries, err := os.ReadDir(from)
		if err != nil {
			return err
		}
		for _, e := range entries {
			if err := copyTree(filepath.Join(from, e.Name()), filepath.Join(to, e.Name())); err != nil {
				return err
			}
		}
		return nil
	default:
		return copyOneFile(from, to, info.Mode().Perm())
	}
}

func copyOneFile(from, to string, perm os.FileMode) error {
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_EXCL, perm|0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
