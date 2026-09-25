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

// ansiRe matches every ANSI/VT escape sequence. The frontend renders its
// own theme colours, so all escapes are stripped from PTY output on
// every platform.
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

// rowStartRe matches "move the cursor to column 1 of row N". ConPTY uses
// it instead of CRLF when it repaints, so it has to become a line break
// or consecutive rows run together once escapes are stripped.
var rowStartRe = regexp.MustCompile(`\x1b\[\d+;1H`)

func stripCtrl(s string) string {
	return ansiRe.ReplaceAllString(rowStartRe.ReplaceAllString(s, "\n"), "")
}

// splitIncompleteUTF8 splits off a trailing, incomplete multi-byte UTF-8
// sequence so it can be prepended to the next PTY read instead of being
// turned into U+FFFD when the chunk is converted to a string.
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
			continue // continuation byte
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
			seqLen = 1 // invalid lead byte; pass it through
		}
		if seqLen > back {
			return data[:n-back], data[n-back:]
		}
		break
	}
	return data, nil
}

func safeSend(conn *websocket.Conn, mu *sync.Mutex, msg outMsg) {
	b, _ := json.Marshal(msg)
	mu.Lock()
	defer mu.Unlock()
	_ = conn.WriteMessage(websocket.TextMessage, b)
}
