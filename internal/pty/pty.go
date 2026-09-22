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

// splitIncompleteUTF8 returns (complete, pending): pending is any
// trailing bytes at the end of data that start a multi-byte UTF-8
// sequence but don't yet have all their continuation bytes present.
// Shared by both pty_unix.go and pty_windows.go's read loops — each
// PTY read is converted to a Go string directly (string(buf[:n])),
// and if a real multi-byte character (an emoji, a non-English
// filename, accented characters, CJK output from a tool that prints
// them) happens to land exactly across the read buffer's boundary,
// converting each half separately corrupts it: json.Marshal replaces
// each invalid half with one or more U+FFFD replacement characters
// BEFORE the two chunks ever reach the frontend to be concatenated —
// by the time the browser sees them, the character is already gone,
// not just split. A real, reproduced bug: "hello 🎉 world" split
// mid-emoji became "hello ���� world" on the wire. The fix: hold back
// an incomplete trailing sequence and prepend it to the NEXT read
// before converting anything to a string, so a chunk is only ever
// turned into a string once it can't possibly be cut mid-character.
func splitIncompleteUTF8(data []byte) (complete []byte, pending []byte) {
	n := len(data)
	if n == 0 {
		return data, nil
	}
	// UTF-8 sequences are at most 4 bytes, so an incomplete lead byte
	// can never be more than 3 bytes from the end.
	for back := 1; back <= 3 && back <= n; back++ {
		b := data[n-back]
		if b&0xC0 == 0x80 {
			continue // a continuation byte — keep looking further back for the lead byte
		}
		var seqLen int
		switch {
		case b&0x80 == 0x00:
			seqLen = 1 // ASCII
		case b&0xE0 == 0xC0:
			seqLen = 2
		case b&0xF0 == 0xE0:
			seqLen = 3
		case b&0xF8 == 0xF0:
			seqLen = 4
		default:
			seqLen = 1 // not a valid lead byte at all — genuinely invalid input, not an incomplete-read artifact; leave it for stripCtrl/json.Marshal to handle as they already do
		}
		if seqLen > back {
			return data[:n-back], data[n-back:]
		}
		break // this lead byte already has all its continuation bytes (or is ASCII) — nothing incomplete
	}
	return data, nil
}

func safeSend(conn *websocket.Conn, mu *sync.Mutex, msg outMsg) {
	b, _ := json.Marshal(msg)
	mu.Lock()
	defer mu.Unlock()
	_ = conn.WriteMessage(websocket.TextMessage, b)
}
