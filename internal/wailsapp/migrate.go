package wailsapp

import (
	"io"
	"log"
	"os"
	"path/filepath"
	"runtime"
)

// legacyMigratedMarker, in the app folder, records that data from the
// Downloads fallback was copied in (or that there was none to copy).
const legacyMigratedMarker = ".oxis-migrated"

// migrateLegacyData copies data from ~/Downloads/OXIS into appDir once.
//
// MSI builds before this fix installed to C:\Users\<name>OXIS (a lost
// backslash), a folder users can't write to, so OXIS kept its data in
// the ~/Downloads/OXIS fallback. Installed properly, the app folder is
// writable and that data would be left behind. Only a Windows app
// folder that has no workspaces of its own yet takes part; files that
// already exist are never overwritten, and the old folder is kept.
func migrateLegacyData(appDir string) {
	if runtime.GOOS != "windows" {
		return
	}
	marker := filepath.Join(appDir, legacyMigratedMarker)
	if _, err := os.Stat(marker); err == nil {
		return
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	legacy := filepath.Join(home, "Downloads", "OXIS")
	if sameDir(legacy, appDir) {
		return
	}
	_, ownErr := os.Stat(filepath.Join(appDir, "workspaces", "registry.json"))
	_, oldErr := os.Stat(filepath.Join(legacy, "workspaces", "registry.json"))
	if ownErr == nil || oldErr != nil {
		_ = os.WriteFile(marker, []byte("nothing to copy\n"), 0o644)
		return
	}
	copied := 0
	for _, name := range []string{"workspaces", "plugins", "created-plugins", "created-documents", "window.json"} {
		copied += copyTreeNoOverwrite(filepath.Join(legacy, name), filepath.Join(appDir, name))
	}
	log.Printf("[oxis] copied %d file(s) from %s into %s", copied, legacy, appDir)
	_ = os.WriteFile(marker, []byte("copied from "+legacy+"\n"), 0o644)
}

func sameDir(a, b string) bool {
	ai, err1 := os.Stat(a)
	bi, err2 := os.Stat(b)
	return err1 == nil && err2 == nil && os.SameFile(ai, bi)
}

// copyTreeNoOverwrite copies src (a file or folder) to dst, skipping
// anything that already exists there. Returns how many files it wrote.
func copyTreeNoOverwrite(src, dst string) int {
	info, err := os.Stat(src)
	if err != nil {
		return 0
	}
	if !info.IsDir() {
		if _, err := os.Stat(dst); err == nil {
			return 0
		}
		if copyNewFile(src, dst) == nil {
			return 1
		}
		return 0
	}
	entries, err := os.ReadDir(src)
	if err != nil {
		return 0
	}
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return 0
	}
	n := 0
	for _, e := range entries {
		n += copyTreeNoOverwrite(filepath.Join(src, e.Name()), filepath.Join(dst, e.Name()))
	}
	return n
}

func copyNewFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(dst)
		return err
	}
	return out.Close()
}
