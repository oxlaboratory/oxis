//go:build !windows

package wailsapp

import "os/exec"

// hideWindow is a no-op outside Windows.
func hideWindow(_ *exec.Cmd) {}
