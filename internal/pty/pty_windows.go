//go:build windows

package pty

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"os"
	"sync"

	"github.com/UserExistsError/conpty"
	"github.com/gorilla/websocket"
)

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
		var pending []byte // see splitIncompleteUTF8's own doc comment in pty.go
		for {
			n, err := cpty.Read(buf)
			if n > 0 {
				chunk := buf[:n]
				if len(pending) > 0 {
					chunk = append(append([]byte{}, pending...), chunk...)
				}
				complete, newPending := splitIncompleteUTF8(chunk)
				pending = append([]byte{}, newPending...) // copy — chunk's backing array is buf, reused next iteration
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
	// Shell profile support: OXIS_SHELL, set before launching OXIS,
	// overrides the auto-detected pwsh7 > powershell5.1 > cmd.exe
	// chain below entirely — e.g. OXIS_SHELL="C:\Program Files\Git\bin\bash.exe"
	// to use Git Bash, or OXIS_SHELL=wsl.exe for WSL. Passed through
	// verbatim as the whole command line to conpty.Start() (same as
	// the auto-detected candidates below, which quote their own path)
	// — so quote it yourself if the path has spaces:
	// OXIS_SHELL="\"C:\Program Files\Git\bin\bash.exe\"". Not
	// stat-checked like the candidates below are — if it's wrong, the
	// shell just fails to start, same as a typo in any other env var.
	if custom := os.Getenv("OXIS_SHELL"); custom != "" {
		return custom
	}
	for _, c := range []struct{ path, flag string }{
		{os.Getenv("ProgramFiles") + `\PowerShell\7\pwsh.exe`, "-NoLogo"},
		{`C:\Program Files\PowerShell\7\pwsh.exe`, "-NoLogo"},
		{`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, "-NoLogo"},
	} {
		if _, err := os.Stat(c.path); err == nil {
			return `"` + c.path + `" ` + c.flag
		}
	}
	return "cmd.exe"
}
