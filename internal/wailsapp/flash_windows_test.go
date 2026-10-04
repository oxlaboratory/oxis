//go:build windows

package wailsapp

import "testing"

// A test process has no window: nothing found, nothing flashed, and the
// search can run any number of times (one callback, reused).
func TestFlashWithoutAWindow(t *testing.T) {
	for i := 0; i < 3000; i++ {
		if mainWindow() != 0 {
			t.Skip("this process has a window")
		}
	}
	if flashWindow() {
		t.Error("flashed with no window")
	}
}
