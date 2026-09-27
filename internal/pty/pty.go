package pty

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
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

// ansiRe matches every ANSI/VT escape sequence. All of them are
// stripped except colours and text styles (SGR, see sgrRe), which the
// frontend renders with the theme's palette (terminal/ansi.ts).
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

// colOneRe is "move to column 1" (CHA), which Node's readline and npm
// use instead of a carriage return.
var colOneRe = regexp.MustCompile(`\x1b\[1?G`)

// eraseLineRe is a line being erased: "\r" then erase-to-end, or
// erase-whole-line. Spinners and progress bars end this way.
var eraseLineRe = regexp.MustCompile(`\r\x1b\[0?K|\x1b\[2K`)

// lineErased marks where the current line was erased. It survives
// stripping (it isn't an escape sequence) so the frontend can drop what
// was drawn before it (visibleText in terminal.ts); otherwise the last
// frame of a spinner is left behind.
const lineErased = "\x1a"

// cursorForwardRe is "move the cursor right N columns". ConPTY draws
// blank cells that way instead of printing spaces (after a prompt, or
// between coloured runs), so they become spaces again.
var cursorForwardRe = regexp.MustCompile(`\x1b\[(\d*)C`)

func forwardAsSpaces(seq string) string {
	n, err := strconv.Atoi(cursorForwardRe.FindStringSubmatch(seq)[1])
	if err != nil || n < 1 {
		n = 1
	}
	return strings.Repeat(" ", min(n, 300))
}

// sgrRe is a colour/style sequence (Select Graphic Rendition).
var sgrRe = regexp.MustCompile(`^\x1b\[[0-9;:]*m$`)

func keepSGR(seq string) string {
	if sgrRe.MatchString(seq) {
		return seq
	}
	return ""
}

func stripCtrl(s string) string {
	s = rowStartRe.ReplaceAllString(s, "\n")
	s = colOneRe.ReplaceAllString(s, "\r")
	s = eraseLineRe.ReplaceAllString(s, "\r"+lineErased)
	s = cursorForwardRe.ReplaceAllStringFunc(s, forwardAsSpaces)
	return ansiRe.ReplaceAllStringFunc(s, keepSGR)
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

// completeEscRe matches one complete escape sequence at the start. A
// lone "ESC [" or "ESC ]" is the start of a longer sequence, not a
// two-byte one: sent early, the rest of it ("32m", "?25h") would show
// up as text.
var completeEscRe = regexp.MustCompile(
	`^(?:\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\x1b[\x20-\x5a\x5c\x5e-\x7e])`)

// splitForNextRead splits off what shouldn't be sent yet because the
// next read may complete it: a partial UTF-8 character, a partial
// escape sequence, or (outside a full-screen program, where rows are
// joined) a trailing "\r\n" that may turn out to be a wrapped row.
func splitForNextRead(data []byte, screen bool) (complete, hold []byte) {
	complete, hold = splitIncompleteUTF8(data)
	if len(hold) > 0 {
		return complete, hold
	}
	if loc := heldTailRe.FindIndex(complete); loc != nil && !screen {
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

// traceEnv names a file that gets a copy of the shell's raw output,
// escape sequences included, for diagnosing rendering problems.
const traceEnv = "OXIS_PTY_TRACE"

func openTrace() *os.File {
	path := os.Getenv(traceEnv)
	if path == "" {
		return nil
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		log.Printf("[oxis] %s: %v", traceEnv, err)
		return nil
	}
	return f
}

// Full-screen programs (vim, less, htop, lazygit, Microsoft Edit…)
// switch the terminal to its alternate screen and draw with cursor
// moves, which the line view can't show. While one is running its
// output goes to the page untouched, between "screen-start" and
// "screen-end", for a real terminal grid (xterm.js) to draw.
var (
	altScreenOnRe  = regexp.MustCompile(`\x1b\[\?(?:1049|1047|47)h`)
	altScreenOffRe = regexp.MustCompile(`\x1b\[\?(?:1049|1047|47)l`)
)

// ConPTY repaints the whole screen after a resize and when a program
// leaves the alternate screen: cursor home, every row again, then a
// cursor move back to where the shell carries on. The line view has all
// of it already, so a repaint that starts within repaintWait of either
// is dropped.
var (
	repaintStartRe = regexp.MustCompile(`^(?:\x1b\[\?25[hl])*\x1b\[H`)
	// cursorOnlyRe is output that only shows or hides the cursor: what
	// can come just before a repaint, in a read of its own.
	cursorOnlyRe = regexp.MustCompile(`^(?:\x1b\[\?25[hl])+$`)
	repaintEndRe = regexp.MustCompile(`\x1b\[\d+;\d+H(?:\x1b\[\?25h)?`)
)

const (
	repaintWait = 250 * time.Millisecond
	// repaintMax caps what's dropped as one repaint, in case its end
	// never comes.
	repaintMax = 1 << 20
)

// RepaintGuard says when a ConPTY repaint is expected. Arm it when the
// terminal is resized; the splitter arms it when a full-screen program
// exits. For a real PTY, which doesn't repaint, it's never armed.
type RepaintGuard struct {
	until atomic.Int64
	// leave is set when the user leaves the full-screen view by hand (a
	// program that crashed without switching back): the next output
	// goes to the line view again.
	leave atomic.Bool
}

// LeaveScreen ends full-screen mode for a program that never did.
func (g *RepaintGuard) LeaveScreen() { g.leave.Store(true) }

func (g *RepaintGuard) Arm() { g.until.Store(time.Now().Add(repaintWait).UnixNano()) }

func (g *RepaintGuard) armed() bool { return g != nil && time.Now().UnixNano() < g.until.Load() }

// Output kinds passed to pumpOutput's send (the WebSocket message
// types).
const (
	kindOutput      = "output"       // line view: cleaned up, colours kept
	kindScreen      = "screen"       // a full-screen program's raw output
	kindScreenStart = "screen-start" // one has started
	kindScreenEnd   = "screen-end"   // …and ended
)

// screenSplitter routes output between the line view and a full-screen
// program's grid, and drops ConPTY's repaints.
type screenSplitter struct {
	cols      func() int
	send      func(kind, data string)
	guard     *RepaintGuard
	repaints  bool // ConPTY: the screen is repainted when a program exits
	screen    bool
	inRepaint bool
	dropped   int
}

func (sp *screenSplitter) line(s string) {
	if s = stripCtrl(joinWrappedRows(s, sp.cols())); s != "" {
		sp.send(kindOutput, s)
	}
}

func (sp *screenSplitter) write(s string) {
	for s != "" {
		if sp.screen && sp.guard != nil && sp.guard.leave.Swap(false) {
			sp.screen = false
			sp.send(kindScreenEnd, "")
		}
		switch {
		case sp.screen:
			loc := altScreenOffRe.FindStringIndex(s)
			if loc == nil {
				sp.send(kindScreen, s)
				return
			}
			sp.send(kindScreen, s[:loc[1]])
			sp.send(kindScreenEnd, "")
			sp.screen = false
			if sp.guard != nil && sp.repaints {
				sp.guard.Arm()
			}
			s = s[loc[1]:]
		case sp.inRepaint:
			loc := repaintEndRe.FindStringIndex(s)
			if loc == nil {
				if sp.dropped += len(s); sp.dropped > repaintMax {
					sp.inRepaint = false
				}
				return // all repaint; the rest follows
			}
			sp.inRepaint = false
			s = s[loc[1]:]
		case sp.guard.armed() && cursorOnlyRe.MatchString(s):
			return // the start of a repaint, in a read of its own
		case sp.guard.armed() && repaintStartRe.MatchString(s):
			sp.inRepaint, sp.dropped = true, 0
			s = repaintStartRe.ReplaceAllString(s, "")
		default:
			loc := altScreenOnRe.FindStringIndex(s)
			if loc == nil {
				sp.line(s)
				return
			}
			sp.line(s[:loc[0]])
			sp.send(kindScreenStart, "")
			sp.screen = true
			s = s[loc[0]:]
		}
	}
}

// pumpOutput reads the PTY until it fails, sending cleaned-up output
// (and a full-screen program's raw output, see screenSplitter). cols
// reports the current width (0 skips joinWrappedRows); guard steers the
// splitter (repaints, leaving a full-screen view) and may be nil;
// repaints is true for ConPTY. Returns the read error that ended it.
func pumpOutput(r io.Reader, cols func() int, send func(kind, data string), guard *RepaintGuard, repaints bool) error {
	type readResult struct {
		data []byte
		err  error
	}
	reads := make(chan readResult, 16)
	trace := openTrace()
	go func() {
		if trace != nil {
			defer trace.Close()
		}
		for {
			buf := make([]byte, 8192)
			n, err := r.Read(buf)
			if trace != nil && n > 0 {
				_, _ = trace.Write(buf[:n])
			}
			reads <- readResult{buf[:n], err}
			if err != nil {
				return
			}
		}
	}()
	sp := &screenSplitter{cols: cols, send: send, guard: guard, repaints: repaints}
	emit := func(b []byte) {
		if len(b) > 0 {
			sp.write(string(b))
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
		complete, held = splitForNextRead(data, sp.screen)
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
