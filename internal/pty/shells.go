package pty

import (
	"os"
	"strings"
)

// Shell is one the page can ask for by Name (the setting "shell", or
// 'shell <name>): never a path or a command line, so a page can only
// start what this machine already has under a known name.
type Shell struct {
	Name  string `json:"name"`
	Label string `json:"label"`
	Path  string `json:"path"`
	// Default: what a tab starts when nothing is picked in OXIS (the
	// OXIS_SHELL one when that's set, else the first).
	Default bool `json:"default,omitempty"`
}

// Shells lists the shells found on this machine, the default first.
func Shells() []Shell {
	shells := findShells()
	custom := strings.ToLower(os.Getenv("OXIS_SHELL"))
	for i := range shells {
		if custom == "" {
			shells[i].Default = i == 0
		} else {
			shells[i].Default = strings.Contains(custom, strings.ToLower(shells[i].Path))
		}
	}
	return shells
}

// shellByName is the found shell called name, if there is one.
func shellByName(name string) (Shell, bool) {
	if name == "" || name == "auto" {
		return Shell{}, false
	}
	for _, s := range findShells() {
		if s.Name == name {
			return s, true
		}
	}
	return Shell{}, false
}
