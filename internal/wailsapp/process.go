package wailsapp

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"
)

// ProcessOptions is what oxis.process.spawn passes in: a program and
// its arguments (Cmd, Args; no shell involved), or a command line for
// the platform's shell (Shell).
type ProcessOptions struct {
	Cmd   string            `json:"cmd"`
	Args  []string          `json:"args"`
	Shell string            `json:"shell"`
	Cwd   string            `json:"cwd"`
	Env   map[string]string `json:"env"`
}

// processWaitDelay bounds how long an exited process's output is
// waited for when something it started (a daemon, say) still holds its
// stdout open.
const processWaitDelay = 2 * time.Second

// running spawned processes by stream id: their stdin, and how to stop
// them (used by StreamClose through the stream's context, and on exit).
var processes sync.Map // id → *spawned

type spawned struct {
	stdin io.WriteCloser
	tree  *processTree
	done  chan struct{}
}

// ProcessStart backs oxis.process.spawn. The process gets pipes for
// stdin, stdout and stderr; its output arrives as "stdout"/"stderr"
// events and "end" carries the exit code. StreamClose (the plugin's
// handle.kill()) stops it and everything it started. The plugin's
// "shell" permission is checked before this is called (pluginAPI.ts).
func (a *App) ProcessStart(id string, o ProcessOptions) (int, error) {
	name, args, err := processArgv(o, runtime.GOOS)
	if err != nil {
		return 0, err
	}
	dir := resolvePath(o.Cwd)
	if o.Cwd == "" {
		dir, _ = os.UserHomeDir()
	}
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		return 0, fmt.Errorf("not a directory: %s", dir)
	}

	ctx, err := streams.open(id)
	if err != nil {
		return 0, err
	}
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	cmd.Env = mergeEnv(os.Environ(), o.Env, runtime.GOOS == "windows")
	cmd.WaitDelay = processWaitDelay
	prepareProcessTree(cmd)
	stdout := &streamWriter{id: id, typ: "stdout"}
	stderr := &streamWriter{id: id, typ: "stderr"}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		streams.drop(id)
		return 0, err
	}
	if err := cmd.Start(); err != nil {
		streams.drop(id)
		return 0, fmt.Errorf("couldn't start %s: %w", name, unwrapExecError(err))
	}

	p := &spawned{stdin: stdin, tree: attachProcessTree(cmd), done: make(chan struct{})}
	processes.Store(id, p)
	go func() {
		select {
		case <-ctx.Done():
			p.tree.kill(p.done)
		case <-p.done:
		}
	}()
	go func() {
		err := cmd.Wait()
		close(p.done)
		processes.Delete(id)
		p.tree.release()
		stdout.flush()
		stderr.flush()
		end := StreamEvent{ID: id, Code: cmd.ProcessState.ExitCode()}
		var exitErr *exec.ExitError
		switch {
		case ctx.Err() != nil:
			end.Error = "killed"
		case err != nil && !errors.As(err, &exitErr) && !errors.Is(err, exec.ErrWaitDelay):
			end.Error = err.Error()
		}
		streams.finish(end)
	}()
	return cmd.Process.Pid, nil
}

// ProcessWrite writes to a spawned process's stdin.
func (a *App) ProcessWrite(id string, data string) error {
	v, ok := processes.Load(id)
	if !ok {
		return errors.New("the process isn't running")
	}
	_, err := io.WriteString(v.(*spawned).stdin, data)
	return err
}

// ProcessCloseInput closes a spawned process's stdin, so a program
// reading until end of input (sort, a compiler reading a file from
// stdin) finishes.
func (a *App) ProcessCloseInput(id string) error {
	v, ok := processes.Load(id)
	if !ok {
		return errors.New("the process isn't running")
	}
	return v.(*spawned).stdin.Close()
}

// stopAllProcesses kills every spawned process when OXIS exits and
// waits (briefly) for them to go, so none outlives the window.
func stopAllProcesses() {
	var pending []*spawned
	processes.Range(func(_, v any) bool {
		p := v.(*spawned)
		p.tree.killNow()
		pending = append(pending, p)
		return true
	})
	deadline := time.After(3 * time.Second)
	for _, p := range pending {
		select {
		case <-p.done:
		case <-deadline:
			return
		}
	}
}

// processArgv turns the options into a program and its arguments. A
// Shell line runs in PowerShell on Windows (pwsh when it's installed,
// with UTF-8 output) and /bin/sh elsewhere.
func processArgv(o ProcessOptions, goos string) (string, []string, error) {
	if strings.TrimSpace(o.Shell) != "" {
		if o.Cmd != "" {
			return "", nil, errors.New("give either cmd (a program) or shell (a command line), not both")
		}
		if goos == "windows" {
			ps := "powershell.exe"
			if p, err := exec.LookPath("pwsh"); err == nil {
				ps = p
			}
			utf8 := "$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); "
			return ps, []string{"-NoLogo", "-NoProfile", "-NonInteractive", "-Command", utf8 + o.Shell}, nil
		}
		return "/bin/sh", []string{"-c", o.Shell}, nil
	}
	if strings.TrimSpace(o.Cmd) == "" {
		return "", nil, errors.New("oxis.process.spawn needs { cmd = \"program\", args = {...} } or { shell = \"command line\" }")
	}
	return o.Cmd, o.Args, nil
}

// mergeEnv returns base with extra's variables set (replacing any with
// the same name; names ignore case on Windows).
func mergeEnv(base []string, extra map[string]string, foldCase bool) []string {
	if len(extra) == 0 {
		return base
	}
	same := func(a, b string) bool {
		if foldCase {
			return strings.EqualFold(a, b)
		}
		return a == b
	}
	out := make([]string, 0, len(base)+len(extra))
	for _, kv := range base {
		name, _, _ := strings.Cut(kv, "=")
		replaced := false
		for k := range extra {
			if same(name, k) {
				replaced = true
				break
			}
		}
		if !replaced {
			out = append(out, kv)
		}
	}
	for k, v := range extra {
		out = append(out, k+"="+v)
	}
	return out
}

// unwrapExecError drops exec's `exec: "name": ` prefix.
func unwrapExecError(err error) error {
	var e *exec.Error
	if errors.As(err, &e) {
		return e.Err
	}
	return err
}

// streamWriter is a process's stdout or stderr: each write becomes a
// stream event. It waits while the page is behind (backpressure) and
// discards output once the stream is closed, so the process never
// blocks on a full pipe after its plugin has gone.
type streamWriter struct {
	id, typ string
	mu      sync.Mutex
	joiner  utf8Joiner
}

func (w *streamWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if s := w.joiner.text(p); s != "" {
		streams.push(StreamEvent{ID: w.id, Type: w.typ, Data: s})
	}
	return len(p), nil
}

func (w *streamWriter) flush() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if s := w.joiner.flush(); s != "" {
		streams.push(StreamEvent{ID: w.id, Type: w.typ, Data: s})
	}
}
