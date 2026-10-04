//go:build !windows

package wailsapp

// flashWindow: nothing to flash outside Windows (yet).
func flashWindow() bool { return false }

// taskbarProgress: no taskbar progress outside Windows (yet).
func taskbarProgress(state, pct int) bool { return false }
