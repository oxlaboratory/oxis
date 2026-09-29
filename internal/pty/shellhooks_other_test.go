//go:build !windows

package pty

import "os/exec"

// runPowerShell runs pwsh with `command` as one argument, as shellStart
// passes the hook.
func runPowerShell(ps, command string) ([]byte, error) {
	return exec.Command(ps, "-NoProfile", "-NonInteractive", "-Command", command).CombinedOutput()
}
