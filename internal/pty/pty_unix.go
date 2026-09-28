//go:build !windows

package pty

import (
	"encoding/json"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sync"

	gpty "github.com/creack/pty"
	"github.com/gorilla/websocket"
)

// HandleSession manages one WebSocket ↔ PTY session.
func HandleSession(conn *websocket.Conn) {
	defer conn.Close()

	var (
		ptmx *os.File
		cmd  *exec.Cmd
		mu   sync.Mutex
		// A real PTY doesn't repaint, so this is never armed; it's how
		// the page leaves a full-screen view by hand.
		screen RepaintGuard
		size   = newTermSize(120, 30)
	)

	// Read the first message to init the PTY
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var msg inMsg
		if err := json.Unmarshal(raw, &msg); err != nil {
			continue
		}

		switch msg.Type {
		case "init":
			cols := msg.Cols
			rows := msg.Rows
			if cols == 0 {
				cols = 120
			}
			if rows == 0 {
				rows = 30
			}
			size.set(int(cols), int(rows))

			// OXIS_SHELL overrides $SHELL; /bin/bash is the last resort.
			shell := os.Getenv("OXIS_SHELL")
			if shell == "" {
				shell = os.Getenv("SHELL")
			}
			if shell == "" {
				shell = "/bin/bash"
			}

			// Shell integration (shellhooks.go), except for a custom shell.
			var args, extra []string
			if os.Getenv("OXIS_SHELL") == "" {
				args, extra = shellStart(shell)
			}
			cmd = exec.Command(shell, args...)
			cmd.Env = shellEnv(append([]string{"TERM=xterm-256color", "COLORTERM=truecolor"}, extra...)...)

			ptmx, err = gpty.StartWithSize(cmd, &gpty.Winsize{
				Rows: rows,
				Cols: cols,
			})
			if err != nil {
				safeSend(conn, &mu, outMsg{Type: "error", Message: err.Error()})
				return
			}
			defer ptmx.Close()

			safeSend(conn, &mu, outMsg{Type: "ready", Shell: shellKind(filepath.Base(shell))})

			// PTY → WebSocket in background
			go func() {
				_ = pumpOutput(ptmx, size, func(kind, data string) {
					safeSend(conn, &mu, outMsg{Type: kind, Data: data})
				}, &screen, false)
				code := 0
				if cmd != nil {
					if werr := cmd.Wait(); werr != nil {
						if exitErr, ok := werr.(*exec.ExitError); ok {
							code = exitErr.ExitCode()
						} else {
							code = -1
						}
					}
				}
				safeSend(conn, &mu, outMsg{Type: "exit", Code: code})
				conn.Close()
			}()

			// WebSocket → PTY (rest of loop below)
			goto readLoop

		default:
			// ignore unknown messages before init
		}
	}

readLoop:
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			break
		}
		var msg inMsg
		if err := json.Unmarshal(raw, &msg); err != nil {
			continue
		}

		switch msg.Type {
		case "input":
			if ptmx != nil && msg.Data != "" {
				_, _ = ptmx.Write([]byte(msg.Data))
			}
		case "resize":
			if ptmx != nil && msg.Cols > 0 && msg.Rows > 0 {
				size.set(int(msg.Cols), int(msg.Rows))
				_ = gpty.Setsize(ptmx, &gpty.Winsize{
					Rows: msg.Rows,
					Cols: msg.Cols,
				})
			}
		case "screen-exit":
			screen.LeaveScreen()
		case "kill":
			if ptmx != nil {
				ptmx.Close()
			}
			return
		}
	}

	if ptmx != nil {
		ptmx.Close()
	}
	log.Printf("[oxis] session closed")
}
