package pty

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

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
	// Shell is sent with "ready": "powershell", "pwsh", "cmd", "bash",
	// "zsh", "fish" or "sh", so the frontend can use the right syntax.
	Shell string `json:"shell,omitempty"`
}

// shellKind names the shell a command line or path starts.
func shellKind(command string) string {
	c := strings.ToLower(command)
	for _, k := range []string{"pwsh", "powershell", "fish", "zsh", "bash"} {
		if strings.Contains(c, k) {
			return k
		}
	}
	if strings.Contains(c, "cmd.exe") || strings.TrimSpace(c) == "cmd" {
		return "cmd"
	}
	return "sh"
}

// shellEnv is the environment the shell starts with: OXIS's own, with
// `set` applied (KEY=VALUE, replacing any existing KEY; keys compare
// case-insensitively, as Windows does). Pagers are always turned off:
// the terminal is line-based, so less would sit waiting at its prompt
// after `git log` or `man` instead of printing.
func shellEnv(set ...string) []string {
	set = append([]string{"PAGER=cat", "GIT_PAGER=cat"}, set...)
	key := func(kv string) string {
		k, _, _ := strings.Cut(kv, "=")
		return strings.ToUpper(k)
	}
	replaced := make(map[string]bool, len(set))
	for _, kv := range set {
		replaced[key(kv)] = true
	}
	env := make([]string, 0, len(os.Environ())+len(set))
	for _, kv := range os.Environ() {
		if !replaced[key(kv)] {
			env = append(env, kv)
		}
	}
	return append(env, set...)
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

// wrapScrollRe matches what ConPTY sends when a line longer than the
// terminal wraps while the cursor is on the bottom row: it scrolls with
// "\r\n", moves back to the last column of the row above, and prints
// that column's character again (after any colour codes) before
// carrying on.
var wrapScrollRe = regexp.MustCompile(`\r\n\x1b\[\d+;(\d+)H((?:\x1b\[[0-9;]*m)*)`)

// joinWrappedRows undoes that, so a long line stays one line: the
// "\r\n", the cursor move and the repeated character are dropped.
// Moves to any column but the last one or two (a wide character) are
// left alone.
func joinWrappedRows(s string, cols int) string {
	if cols <= 0 || !strings.Contains(s, "\r\n\x1b[") {
		return s
	}
	var b strings.Builder
	last := 0
	for _, m := range wrapScrollRe.FindAllStringSubmatchIndex(s, -1) {
		col, err := strconv.Atoi(s[m[2]:m[3]])
		if err != nil || col < cols-1 {
			continue
		}
		r, size := utf8.DecodeRuneInString(s[m[1]:])
		if size == 0 || r == '\x1b' || r == '\r' || r == '\n' {
			continue
		}
		b.WriteString(s[last:m[0]])
		b.WriteString(s[m[4]:m[5]]) // keep the colour codes
		last = m[1] + size
	}
	if last == 0 {
		return s
	}
	b.WriteString(s[last:])
	return b.String()
}

// heldTailRe matches output that may be the start of a wrapScrollRe
// sequence cut off by the end of a read.
var heldTailRe = regexp.MustCompile(`\r(?:\n(?:\x1b(?:\[\d*;?\d*H?)?)?(?:\x1b(?:\[[0-9;]*m?)?)*)?$`)

// completeEscRe matches one complete escape sequence at the start.
var completeEscRe = regexp.MustCompile(
	`^(?:\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\x1b[\x20-\x7e])`)

// splitForNextRead splits off what shouldn't be sent yet because the
// next read may complete it: a partial UTF-8 character, a partial
// escape sequence, or a trailing "\r\n" that may turn out to be a
// wrapped row (joinWrappedRows).
func splitForNextRead(data []byte) (complete, hold []byte) {
	complete, hold = splitIncompleteUTF8(data)
	if len(hold) > 0 {
		return complete, hold
	}
	if loc := heldTailRe.FindIndex(complete); loc != nil {
		return complete[:loc[0]], complete[loc[0]:]
	}
	if i := bytes.LastIndexByte(complete, 0x1b); i >= 0 && len(complete)-i < 256 && !completeEscRe.Match(complete[i:]) {
		return complete[:i], complete[i:]
	}
	return complete, nil
}

// heldFlushDelay is how long held output waits for the rest of it
// before being sent as it is.
const heldFlushDelay = 30 * time.Millisecond

// pumpOutput reads the PTY until it fails, sending cleaned-up output.
// cols reports the current width (0 skips joinWrappedRows). Returns
// the read error that ended it.
func pumpOutput(r io.Reader, cols func() int, send func(string)) error {
	type readResult struct {
		data []byte
		err  error
	}
	reads := make(chan readResult, 16)
	go func() {
		for {
			buf := make([]byte, 8192)
			n, err := r.Read(buf)
			reads <- readResult{buf[:n], err}
			if err != nil {
				return
			}
		}
	}()
	emit := func(b []byte) {
		if s := stripCtrl(joinWrappedRows(string(b), cols())); s != "" {
			send(s)
		}
	}
	var held []byte
	for {
		var res readResult
		if len(held) > 0 {
			select {
			case res = <-reads:
			case <-time.After(heldFlushDelay):
				emit(held)
				held = nil
				continue
			}
		} else {
			res = <-reads
		}
		data := append(held, res.data...)
		var complete []byte
		complete, held = splitForNextRead(data)
		held = append([]byte(nil), held...)
		emit(complete)
		if res.err != nil {
			emit(held)
			return res.err
		}
	}
}

func safeSend(conn *websocket.Conn, mu *sync.Mutex, msg outMsg) {
	b, _ := json.Marshal(msg)
	mu.Lock()
	defer mu.Unlock()
	_ = conn.WriteMessage(websocket.TextMessage, b)
}
