//go:build !windows

package wailsapp

import (
	"os/exec"
	"sync"
	"syscall"
	"time"
)

// processTree is a spawned process and everything it starts: the
// process leads a new process group, and its children join it.
type processTree struct {
	pid      int
	mu       sync.Mutex
	killed   bool
	released bool
}

// processTermGrace is how long a process group gets to exit after
// SIGTERM before SIGKILL.
const processTermGrace = 2 * time.Second

func prepareProcessTree(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func attachProcessTree(cmd *exec.Cmd) *processTree { return &processTree{pid: cmd.Process.Pid} }

// kill asks the group to stop (SIGTERM, so servers can clean up) and
// forces it (SIGKILL) if the process hasn't exited after a grace period.
func (t *processTree) kill(done <-chan struct{}) {
	if !t.signal(syscall.SIGTERM) {
		return
	}
	go func() {
		select {
		case <-done:
		case <-time.After(processTermGrace):
			t.signal(syscall.SIGKILL)
		}
	}()
}

// killNow is for OXIS exiting: no grace period.
func (t *processTree) killNow() { t.signal(syscall.SIGKILL) }

// signal signals the process group unless the process has exited (its
// group id could be reused).
func (t *processTree) signal(sig syscall.Signal) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.released || (sig == syscall.SIGTERM && t.killed) {
		return false
	}
	t.killed = true
	_ = syscall.Kill(-t.pid, sig)
	return true
}

func (t *processTree) release() {
	t.mu.Lock()
	t.released = true
	t.mu.Unlock()
}
