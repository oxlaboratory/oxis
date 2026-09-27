package wailsapp

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestMigrateLegacyData(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("the migration only runs on Windows")
	}
	home := t.TempDir()
	t.Setenv("USERPROFILE", home)
	legacy := filepath.Join(home, "Downloads", "OXIS")
	write := func(p, s string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(legacy, "workspaces", "registry.json"), `[{"name":"devlab"}]`)
	write(filepath.Join(legacy, "workspaces", "devlab", "workspace.lua"), "-- mine")
	write(filepath.Join(legacy, "plugins", "p.lua"), "-- plugin")
	write(filepath.Join(legacy, "source", "README.md"), "not copied")

	app := filepath.Join(home, "OXIS")
	write(filepath.Join(app, "plugins", "p.lua"), "-- newer, keep")
	if err := os.MkdirAll(filepath.Join(app, "workspaces"), 0o755); err != nil {
		t.Fatal(err)
	}

	migrateLegacyData(app)

	read := func(p string) string { b, _ := os.ReadFile(p); return string(b) }
	if got := read(filepath.Join(app, "workspaces", "devlab", "workspace.lua")); got != "-- mine" {
		t.Errorf("workspace not copied: %q", got)
	}
	if got := read(filepath.Join(app, "plugins", "p.lua")); got != "-- newer, keep" {
		t.Errorf("existing file overwritten: %q", got)
	}
	if _, err := os.Stat(filepath.Join(app, "source")); err == nil {
		t.Error("source clone copied")
	}
	if _, err := os.Stat(filepath.Join(legacy, "workspaces", "registry.json")); err != nil {
		t.Error("old folder was changed")
	}

	// Runs once: later changes in the old folder stay there.
	write(filepath.Join(legacy, "workspaces", "later.txt"), "x")
	migrateLegacyData(app)
	if _, err := os.Stat(filepath.Join(app, "workspaces", "later.txt")); err == nil {
		t.Error("migration ran twice")
	}
}

func TestFallbackDataDirFor(t *testing.T) {
	sep := string(filepath.Separator)
	cases := []struct {
		name, goos, xdg, local string
		legacy                 bool
		want                   string
	}{
		{"linux default", "linux", "", "", false, "H" + sep + ".local" + sep + "share" + sep + "oxis"},
		{"linux XDG", "linux", sep + "data", "", false, sep + "data" + sep + "oxis"},
		{"relative XDG is ignored", "linux", "rel", "", false, "H" + sep + ".local" + sep + "share" + sep + "oxis"},
		{"windows", "windows", "", "L", false, "L" + sep + "OXIS"},
		{"old Downloads folder stays", "linux", "", "", true, "H" + sep + "Downloads" + sep + "OXIS"},
	}
	for _, c := range cases {
		xdg := c.xdg
		if xdg == sep+"data" {
			xdg, _ = filepath.Abs(xdg)
			c.want = filepath.Join(xdg, "oxis")
		}
		if got := fallbackDataDirFor("H", c.goos, xdg, c.local, c.legacy); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}
