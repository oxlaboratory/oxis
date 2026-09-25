//go:build windows

package pty

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"os"
	"sync"
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

	shellCmd := buildShellCmd()
	cpty, err := conpty.Start(shellCmd, conpty.ConPtyDimensions(cols, rows))
	if err != nil {
		log.Printf("[oxis] ConPTY failed: %v", err)
		safeSend(conn, &mu, outMsg{Type: "error", Message: "ConPTY failed — requires Windows 10 1809+"})
		return
	}

	safeSend(conn, &mu, outMsg{Type: "ready"})

	go func() {
		buf := make([]byte, 8192)
		var pending []byte // incomplete UTF-8 tail carried to the next read
		for {
			n, err := cpty.Read(buf)
			if n > 0 {
				chunk := buf[:n]
				if len(pending) > 0 {
					chunk = append(append([]byte{}, pending...), chunk...)
				}
				complete, newPending := splitIncompleteUTF8(chunk)
				pending = append([]byte{}, newPending...) // copy: buf is reused
				data := stripCtrl(string(complete))
				if data != "" {
					safeSend(conn, &mu, outMsg{Type: "output", Data: data})
				}
			}
			if err != nil {
				if err != io.EOF {
					log.Printf("[oxis] read: %v", err)
				}
				break
			}
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
				_, _ = io.WriteString(cpty, m.Data)
			}
		case "resize":
			if m.Cols > 0 && m.Rows > 0 {
				_ = cpty.Resize(int(m.Cols), int(m.Rows))
			}
		case "kill":
			cpty.Close()
			return
		}
	}
	cpty.Close()
}

func buildShellCmd() string {
	// OXIS_SHELL overrides the pwsh 7 > Windows PowerShell > cmd.exe
	// chain. It is used verbatim as the command line, so quote paths
	// with spaces, e.g. OXIS_SHELL="\"C:\Program Files\Git\bin\bash.exe\"".
	if custom := os.Getenv("OXIS_SHELL"); custom != "" {
		return custom
	}
	// OXIS edits the command line itself and sends it whole, so
	// PSReadLine's in-place redrawing only garbles the echo once escape
	// codes are stripped; unload it for this session.
	const psFlags = `-NoLogo -NoExit -Command "Remove-Module PSReadLine -ErrorAction SilentlyContinue"`
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
