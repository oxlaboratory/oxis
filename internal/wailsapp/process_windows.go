//go:build windows

package wailsapp

import (
	"os/exec"
	"strconv"
	"sync"

	"golang.org/x/sys/windows"
)

// processTree is a spawned process and everything it starts, held in a
// job object so they can be stopped together (a dev server started by
// npm is a child of npm, not the process OXIS started).
type processTree struct {
	pid      int
	mu       sync.Mutex
	job      windows.Handle
	released bool
}

func prepareProcessTree(cmd *exec.Cmd) { hideWindow(cmd) }

// attachProcessTree puts the started process in a new job object; its
// children join the job automatically. Without a job (creating one
// failed), kill falls back to taskkill /T.
func attachProcessTree(cmd *exec.Cmd) *processTree {
	t := &processTree{pid: cmd.Process.Pid}
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return t
	}
	h, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(t.pid))
	if err != nil {
		windows.CloseHandle(job)
		return t
	}
	defer windows.CloseHandle(h)
	if windows.AssignProcessToJobObject(job, h) != nil {
		windows.CloseHandle(job)
		return t
	}
	t.job = job
	return t
}

// kill stops the process and everything it started. A windowless
// process on Windows has no graceful stop.
func (t *processTree) kill(_ <-chan struct{}) { t.killNow() }

func (t *processTree) killNow() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.released {
		return // it has exited; its pid may belong to something else now
	}
	if t.job != 0 && windows.TerminateJobObject(t.job, 1) == nil {
		return
	}
	cmd := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(t.pid))
	hideWindow(cmd)
	_ = cmd.Run()
}

// release closes the job once the process has exited. Anything it left
// running (a program it launched and meant to keep) carries on.
func (t *processTree) release() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.released = true
	if t.job != 0 {
		windows.CloseHandle(t.job)
		t.job = 0
	}
}
