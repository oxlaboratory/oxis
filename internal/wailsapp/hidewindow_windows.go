//go:build windows

package wailsapp

import (
	"os/exec"
	"syscall"
)

// hideWindow prevents a spawned console program (git.exe, tasklist,
// taskkill, ...) from popping up its own visible console window.
//
// Found as the actual root cause of a real, reported bug: 'task
// commit appeared to hang with an empty, visible "git.exe" window —
// not a crash, not a deadlock, just Windows doing exactly what it
// does by default whenever a GUI application (Wails has no console
// of its own) spawns a console subprocess: it allocates a brand new
// console window for that child process. exec.Command/CommandContext
// never set anything to suppress this, on any of the four places in
// app.go that spawn a process (RunCommand — the actual 'task commit
// path — plus cloneSourceInBackground's git clone, ListProcesses'
// tasklist/ps, and KillProcess's taskkill), so every one of them
// could flash or leave open a console window on Windows specifically
// — Linux/macOS never had this problem, since there's no equivalent
// "allocate a console for this child" behavior to suppress there.
//
// syscall.SysProcAttr.HideWindow is the documented, standard fix —
// Windows-only (the exec_windows.go stdlib file backing os/exec
// itself uses this field to build the actual CreateProcess call's
// STARTUPINFO), which is why this lives in its own _windows.go file
// rather than directly in app.go: the same field doesn't exist on
// SysProcAttr's Unix build at all, so unconditionally setting it
// would fail to compile everywhere except Windows.
func hideWindow(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
}
