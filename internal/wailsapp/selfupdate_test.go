package wailsapp

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// buildHelper compiles a tiny program: "stay" runs for a few seconds,
// "crash" exits at once. It stands in for a new OXIS build.
func buildHelper(t *testing.T, dir, kind string) string {
	t.Helper()
	src := filepath.Join(dir, kind+".go")
	body := `package main

import "time"

func main() { time.Sleep(6 * time.Second) }
`
	if kind == "stay-old" { // same behaviour, different bytes
		body = strings.Replace(body, "6 *", "7 *", 1)
	}
	if kind == "crash" {
		body = `package main

import "os"

func main() { os.Exit(3) }
`
	}
	if err := os.WriteFile(src, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(dir, kind)
	if runtime.GOOS == "windows" {
		out += ".exe"
	}
	cmd := exec.Command("go", "build", "-o", out, src)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("building %s helper: %v\n%s", kind, err, b)
	}
	return out
}

func copyFile(t *testing.T, from, to string) {
	t.Helper()
	b, err := os.ReadFile(from)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(to, b, 0o755); err != nil {
		t.Fatal(err)
	}
}

func killAll(names ...string) {
	for _, n := range names {
		if runtime.GOOS == "windows" {
			_ = exec.Command("taskkill", "/F", "/IM", filepath.Base(n)).Run()
		} else {
			_ = exec.Command("pkill", "-f", n).Run()
		}
	}
}

// installed checks exePath holds want's bytes.
func installed(t *testing.T, exePath, want string) bool {
	t.Helper()
	a, _ := os.ReadFile(exePath)
	b, _ := os.ReadFile(want)
	return len(a) > 0 && bytes.Equal(a, b)
}

func backups(dir string) []string {
	m, _ := filepath.Glob(filepath.Join(dir, ".oxis-update-backup-*"))
	return m
}

func TestInstallAndRestart(t *testing.T) {
	if testing.Short() {
		t.Skip("builds helper programs")
	}
	tools := t.TempDir()
	stay := buildHelper(t, tools, "stay")
	stayOld := buildHelper(t, tools, "stay-old")
	crash := buildHelper(t, tools, "crash")

	ext := filepath.Ext(stay)
	t.Run("new build starts: swapped in, old one backed up", func(t *testing.T) {
		dir := t.TempDir()
		exe := filepath.Join(dir, "oxis-under-test"+ext)
		copyFile(t, stayOld, exe)
		// Replace the executable while it's running, as a real update does
		// (Windows allows renaming a running .exe, not overwriting it).
		old := exec.Command(exe)
		if err := old.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = old.Process.Kill(); killAll(exe) })

		staged := filepath.Join(dir, ".oxis-update-1.tmp")
		copyFile(t, stay, staged)
		ok, reason := installAndRestart(exe, staged)
		if !ok {
			t.Fatalf("installAndRestart failed: %s", reason)
		}
		if !installed(t, exe, stay) {
			t.Error("the new build isn't at the executable path")
		}
		if len(backups(dir)) != 1 {
			t.Errorf("expected one backup of the old build, found %v", backups(dir))
		}
	})

	t.Run("new build exits at once: the old one is restored", func(t *testing.T) {
		dir := t.TempDir()
		exe := filepath.Join(dir, "oxis-under-test"+ext)
		copyFile(t, stay, exe)
		staged := filepath.Join(dir, ".oxis-update-2.tmp")
		copyFile(t, crash, staged)
		t.Cleanup(func() { killAll(exe) })

		ok, reason := installAndRestart(exe, staged)
		if ok {
			t.Fatal("a build that exits immediately was accepted")
		}
		if !strings.Contains(reason, "exited immediately") {
			t.Errorf("reason = %q", reason)
		}
		if !installed(t, exe, stay) {
			t.Error("the previous build wasn't restored")
		}
		if b := backups(dir); len(b) != 0 {
			t.Errorf("backup left behind after rollback: %v", b)
		}
	})
}
