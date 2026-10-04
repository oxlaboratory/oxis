//go:build !windows

package wailsapp

// flashWindow: nothing to flash outside Windows (yet).
func flashWindow() bool { return false }
