//go:build !windows

package pty

import (
	"os"
	"os/exec"
	"path/filepath"
)

func findShells() []Shell {
	var out []Shell
	seen := map[string]bool{}
	add := func(path string) {
		name := filepath.Base(path)
		if path == "" || seen[name] {
			return
		}
		seen[name] = true
		out = append(out, Shell{name, name, path})
	}
	add(os.Getenv("SHELL")) // the user's own first
	for _, name := range []string{"zsh", "bash", "fish", "sh"} {
		if p, err := exec.LookPath(name); err == nil {
			add(p)
		}
	}
	return out
}
