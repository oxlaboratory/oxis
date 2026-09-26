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

			// OXIS_SHELL overrides $SHELL; /bin/bash is the last resort.
			shell := os.Getenv("OXIS_SHELL")
			if shell == "" {
				shell = os.Getenv("SHELL")
			}
			if shell == "" {
				shell = "/bin/bash"
			}

			cmd = exec.Command(shell)
			cmd.Env = shellEnv("TERM=xterm-256color", "COLORTERM=truecolor")

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
				// A real PTY wraps without ConPTY's cursor jumps: width 0
				// skips joinWrappedRows.
				_ = pumpOutput(ptmx, func() int { return 0 }, func(data string) {
					safeSend(conn, &mu, outMsg{Type: "output", Data: data})
				})
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
				_ = gpty.Setsize(ptmx, &gpty.Winsize{
					Rows: msg.Rows,
					Cols: msg.Cols,
				})
			}
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
