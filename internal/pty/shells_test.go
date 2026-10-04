package pty

import (
	"runtime"
	"testing"
)

func TestShells(t *testing.T) {
	shells := Shells()
	if len(shells) == 0 {
		t.Fatal("no shells found")
	}
	if runtime.GOOS == "windows" {
		if _, ok := shellByName("cmd"); !ok {
			t.Errorf("cmd not found among %+v", shells)
		}
	}
	for _, name := range []string{"", "auto", "C:\Windows\System32\cmd.exe", "/bin/sh", "nope"} {
		if _, ok := shellByName(name); ok {
			t.Errorf("%q picked a shell; only names from Shells() may", name)
		}
	}
}
