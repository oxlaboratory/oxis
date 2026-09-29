//go:build windows

package pty

import (
	"os/exec"
	"syscall"
)

// runPowerShell runs PowerShell with `command` quoted on its command line
// exactly as buildShellCmd quotes the hook, so the quoting is tested too.
func runPowerShell(ps, command string) ([]byte, error) {
	cmd := exec.Command(ps)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CmdLine: `"` + ps + `" -NoProfile -NonInteractive -Command "` + command + `"`,
	}
	return cmd.CombinedOutput()
}
