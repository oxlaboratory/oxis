package pty

import (
	"encoding/json"
	"regexp"
	"sync"

	"github.com/gorilla/websocket"
)

// Message types (client → server)
type inMsg struct {
	Type string `json:"type"`
	Data string `json:"data,omitempty"`
	Cols uint16 `json:"cols,omitempty"`
	Rows uint16 `json:"rows,omitempty"`
}

// Message types (server → client)
type outMsg struct {
	Type    string `json:"type"`
	Data    string `json:"data,omitempty"`
	Code    int    `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
}

// stripCtrl removes all ANSI/VT escape sequences from PTY output.
// We pass NOTHING through — no colors, no SGR, no OSC title-set, no
// bracketed-paste mode toggles, nothing. The frontend renders its own
// theme-driven colors and doesn't need (or want) raw terminal escapes;
// leaving them in corrupts the display with visible garbage like
// "[?2004h" or the raw OSC window-title sequence.
//
// Shared by both pty_windows.go (ConPTY) and pty_unix.go (creack/pty) so
// output is identical across platforms — this used to only run on
// Windows, which meant Linux/macOS builds leaked raw escape codes.
var ansiRe = regexp.MustCompile(
	// OSC sequences: ESC ] ... ST
	`\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)` +
		// CSI sequences: ESC [ ... final-byte (includes SGR \x1b[...m)
		`|\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]` +
		// ESC + single character (ESC 7, ESC 8, ESC =, ESC >, etc.)
		`|\x1b[\x20-\x7e]` +
		// Bare ESC with nothing after it
		`|\x1b`,
)

func stripCtrl(s string) string {
	return ansiRe.ReplaceAllString(s, "")
}

func safeSend(conn *websocket.Conn, mu *sync.Mutex, msg outMsg) {
	b, _ := json.Marshal(msg)
	mu.Lock()
	defer mu.Unlock()
	_ = conn.WriteMessage(websocket.TextMessage, b)
}
