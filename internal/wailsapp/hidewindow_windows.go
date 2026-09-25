//go:build windows

package wailsapp

import (
	"os/exec"
	"syscall"
)

// hideWindow stops console programs (git, tasklist, taskkill) spawned by
// this GUI process from opening their own console window.
func hideWindow(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
}
