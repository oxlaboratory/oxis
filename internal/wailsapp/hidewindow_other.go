//go:build !windows

package wailsapp

import "os/exec"

// hideWindow is a no-op on Linux/macOS — there's no equivalent
// "spawning a console program pops up its own window" behavior to
// suppress there in the first place. See hidewindow_windows.go for
// the real fix and the bug it addresses.
func hideWindow(_ *exec.Cmd) {}
