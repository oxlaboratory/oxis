//go:build !windows

package wailsapp

import (
	"os/exec"
	"runtime"
	"strings"
)

// showNotification: notify-send on Linux, the system notifier on macOS.
func showNotification(title, body string) bool {
	switch runtime.GOOS {
	case "darwin":
		q := func(s string) string { return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) + `"` }
		return exec.Command("osascript", "-e", "display notification "+q(body)+" with title "+q(title)).Start() == nil
	default:
		if _, err := exec.LookPath("notify-send"); err != nil {
			return false
		}
		return exec.Command("notify-send", "--app-name=OXIS", title, body).Start() == nil
	}
}
