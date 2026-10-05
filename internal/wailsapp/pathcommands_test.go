package wailsapp

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestScanPath(t *testing.T) {
	dir := t.TempDir()
	write := func(name string, mode os.FileMode) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), mode); err != nil {
			t.Fatal(err)
		}
	}
	write("tool.exe", 0o755)
	write("script.cmd", 0o755)
	write("readme.txt", 0o644)
	write("runme", 0o755)
	got := map[string]bool{}
	for _, n := range scanPath(dir + string(os.PathListSeparator) + filepath.Join(dir, "missing")) {
		got[n] = true
	}
	if runtime.GOOS == "windows" {
		if !got["tool"] || !got["script"] || got["readme"] || got["runme"] || got["readme.txt"] {
			t.Errorf("windows: %v", got)
		}
	} else if !got["runme"] || got["readme.txt"] {
		t.Errorf("unix: %v", got)
	}
}
