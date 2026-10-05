//go:build windows

package pty

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"

	"github.com/UserExistsError/conpty"
	"github.com/gorilla/websocket"
)

// Whether a process ignores Ctrl+C is inherited from whatever launched
// it, and shell sessions inherit it from OXIS. If OXIS was started with
// Ctrl+C ignored, the \x03 the terminal sends would never interrupt
// anything, so restore normal handling once at startup.
func init() {
	_, _, _ = syscall.NewLazyDLL("kernel32.dll").NewProc("SetConsoleCtrlHandler").Call(0, 0)
}

func HandleSession(conn *websocket.Conn) {
	defer conn.Close()
	var mu sync.Mutex

	_, raw, err := conn.ReadMessage()
	if err != nil {
		return
	}

	var msg inMsg
	if json.Unmarshal(raw, &msg) != nil || msg.Type != "init" {
		safeSend(conn, &mu, outMsg{Type: "error", Message: "expected init"})
		return
	}

	cols, rows := int(msg.Cols), int(msg.Rows)
	if cols <= 0 {
		cols = 200
	}
	if rows <= 0 {
		rows = 50
	}

	shellCmd := buildShellCmd(msg.Shell)
	opts := []conpty.ConPtyOption{conpty.ConPtyDimensions(cols, rows), conpty.ConPtyEnv(shellEnv("COLORTERM=truecolor"))}
	if dir := startDir(msg.Dir); dir != "" {
		opts = append(opts, conpty.ConPtyWorkDir(dir))
	}
	cpty, err := conpty.Start(shellCmd, opts...)
	if err != nil {
		log.Printf("[oxis] ConPTY failed: %v", err)
		safeSend(conn, &mu, outMsg{Type: "error", Message: "ConPTY failed — requires Windows 10 1809+"})
		return
	}

	safeSend(conn, &mu, outMsg{Type: "ready", Shell: shellKind(shellCmd)})

	size := newTermSize(cols, rows)
	var repaint RepaintGuard // ConPTY repaints the screen after a resize
	// Set by a resize for a shell that may lose the next key (shiftTap).
	tapKey := losesKeyAfterResize(shellCmd)
	var resized atomic.Bool
	var rec recorder // 'record
	defer rec.Stop()

	go func() {
		err := pumpOutput(recordingReader{cpty, &rec}, size, func(kind, data string) {
			safeSend(conn, &mu, outMsg{Type: kind, Data: data})
		}, &repaint, true)
		if err != io.EOF {
			log.Printf("[oxis] read: %v", err)
		}
		code, _ := cpty.Wait(context.Background())
		safeSend(conn, &mu, outMsg{Type: "exit", Code: int(code)})
		conn.Close()
	}()

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			break
		}
		var m inMsg
		if json.Unmarshal(raw, &m) != nil {
			continue
		}
		switch m.Type {
		case "input":
			if m.Data != "" {
				data := consoleInput(m.Data)
				if resized.Swap(false) {
					data = shiftTap + data
				}
				_, _ = io.WriteString(cpty, data)
			}
		case "resize":
			if m.Cols > 0 && m.Rows > 0 {
				repaint.Arm()
				size.set(int(m.Cols), int(m.Rows))
				rec.Resize(int(m.Cols), int(m.Rows))
				_ = cpty.Resize(int(m.Cols), int(m.Rows))
				if tapKey {
					resized.Store(true)
				}
			}
		case "screen-exit":
			repaint.LeaveScreen()
		case "record-start", "record-stop":
			recordMsg(&rec, m, size, func(o outMsg) { safeSend(conn, &mu, o) })
		case "kill":
			cpty.Close()
			return
		}
	}
	cpty.Close()
}

// withIntegration adds shell integration (shellhooks.go) to an OXIS_SHELL
// that is just bash, the way Git Bash and MSYS2 are set up
// ("C:\Program Files\Git\bin\bash.exe", maybe with -i): anything more
// (a login shell, other flags) is used as it is.
func withIntegration(custom string) string {
	m := plainShellRe.FindStringSubmatch(strings.TrimSpace(custom))
	if m == nil {
		return custom
	}
	path := m[1] + m[2]
	args, _ := shellStart(path)
	if args == nil {
		return custom
	}
	line := `"` + path + `"`
	for _, a := range args {
		// bash on Windows reads C:/… paths; quoted for spaces in them.
		line += ` "` + filepath.ToSlash(a) + `"`
	}
	if m[3] != "" {
		line += " -i"
	}
	return line
}

// A bash executable, quoted or not, and at most -i after it. (fish's hook
// is a script with quotes in it, which this command line can't carry.)
var plainShellRe = regexp.MustCompile(`(?i)^"?([^"]*[\\/])?(bash(?:\.exe)?)"?(\s+-i)?$`)

func buildShellCmd(choice string) string {
	// OXIS_SHELL overrides the pwsh 7 > Windows PowerShell > cmd.exe
	// chain. It is used verbatim as the command line, so quote paths
	// with spaces, e.g. OXIS_SHELL="\"C:\Program Files\Git\bin\bash.exe\"".
	// One picked in OXIS (the setting "shell", or 'shell <name>) comes
	// first: it's the most recent choice.
	if sh, ok := shellByName(choice); ok {
		return shellCommand(sh)
	}
	if custom := os.Getenv("OXIS_SHELL"); custom != "" {
		return withIntegration(custom)
	}
	// PowerShell starts with shell integration (shellhooks.go).
	psFlags := psArgs()
	for _, c := range []struct{ path, flag string }{
		{os.Getenv("ProgramFiles") + `\PowerShell\7\pwsh.exe`, psFlags},
		{`C:\Program Files\PowerShell\7\pwsh.exe`, psFlags},
		{os.Getenv("SystemRoot") + `\System32\WindowsPowerShell\v1.0\powershell.exe`, psFlags},
		{`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, psFlags},
	} {
		if _, err := os.Stat(c.path); err == nil {
			return `"` + c.path + `" ` + c.flag
		}
	}
	return "cmd.exe"
}
