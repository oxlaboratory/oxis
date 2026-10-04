package pty

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// Message types (client → server)
type inMsg struct {
	Type string `json:"type"`
	Data string `json:"data,omitempty"`
	Cols uint16 `json:"cols,omitempty"`
	Rows uint16 `json:"rows,omitempty"`
	// Dir, with "init": the folder to start the shell in (a restored
	// tab's); ignored unless it's an existing directory.
	Dir string `json:"dir,omitempty"`
}

// startDir is dir if it's an existing directory, else "" (the default).
func startDir(dir string) string {
	if dir == "" {
		return ""
	}
	if info, err := os.Stat(dir); err == nil && info.IsDir() {
		return dir
	}
	return ""
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

// Git Bash and the other MSYS/Cygwin shells sometimes lose the first key
// typed after their console is resized, however long after (a race in
// their console input; ConPTY alone shows it, about one resize in three).
// So on Windows the first input after a resize starts with a Shift press
// and release, sent as win32-input-mode key events
// (ESC [ Vk ; Sc ; Uc ; Kd ; Cs ; Rc _): it's what gets lost, if anything,
// and a key with no character does nothing in any console program.
const shiftTap = "\x1b[16;42;0;1;16;1_\x1b[16;42;0;0;0;1_"

// escKey is the Escape key as win32-input-mode press and release events.
// ConPTY reads a lone ESC byte as the start of an escape sequence and
// holds it until the next key, which then arrives as Alt+key: Esc in
// vim never left Insert mode, and Esc : came out as Alt+:. Sent as a key
// event, it's just Escape (Windows Terminal sends keys this way too).
const escKey = "\x1b[27;1;27;1;0;1_\x1b[27;1;27;0;0;1_"

// consoleInput is what to write to ConPTY for keys from the page.
func consoleInput(data string) string {
	if data == "\x1b" {
		return escKey
	}
	return data
}

// losesKeyAfterResize says whether a shell command line starts one of
// those shells.
func losesKeyAfterResize(command string) bool {
	switch shellKind(command) {
	case "bash", "zsh", "fish", "sh":
		return true
	}
	return false
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

// completeEscRe matches one complete escape sequence at the start. A
// lone "ESC [" or "ESC ]" is the start of a longer sequence, not a
// two-byte one: sent early, the rest of it ("32m", "?25h") would show
// up as text.
var completeEscRe = regexp.MustCompile(
	`^(?:\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\x1b[\x20-\x5a\x5c\x5e-\x7e])`)

// splitForNextRead splits off what shouldn't be handled yet because the
// next read may complete it: a partial UTF-8 character or a partial
// escape sequence.
func splitForNextRead(data []byte) (complete, hold []byte) {
	complete, hold = splitIncompleteUTF8(data)
	if len(hold) > 0 {
		return complete, hold
	}
	if i := bytes.LastIndexByte(complete, 0x1b); i >= 0 && len(complete)-i < 256 && !completeEscRe.Match(complete[i:]) {
		return complete[:i], complete[i:]
	}
	return complete, nil
}

// heldFlushDelay is how long held output waits for the rest of it
// before being sent as it is. (A variable so tests that feed output
// instantly can wait longer, and not depend on the machine's speed.)
var heldFlushDelay = 30 * time.Millisecond

// traceEnv names a file that gets a copy of the shell's raw output,
// escape sequences included, for diagnosing rendering problems. The
// file's name plus ".reads" gets a line per read: its length and the
// terminal's size then, so a session can be played again exactly.
const traceEnv = "OXIS_PTY_TRACE"

func openTrace() *os.File {
	if os.Getenv(traceEnv) == "" {
		return nil
	}
	return openTraceFile(os.Getenv(traceEnv))
}

func openTraceFile(path string) *os.File {
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
// leaves the alternate screen: cursor home, every row again, then the
// cursor put back where the shell carries on. The line view has all of
// it already, so a repaint that starts within repaintWait of either is
// dropped. Before the cursor goes home ConPTY may hide the cursor,
// report the new size (ESC [8;rows;cols t) and switch input modes
// (win32-input-mode 9001, focus events 1004, bracketed paste 2004), as
// it does when Git Bash's console is set up again. The repaint is one
// frame, which ends by showing the cursor again (or, with the cursor
// hidden, when the output stops for repaintQuiet); where it leaves the
// cursor comes from playing it on a scratch screen.
const repaintPrefix = `\x1b\[\?25[hl]|\x1b\[8;\d+;\d+t|\x1b\[\?(?:9001|1004|2004)[hl]`

var (
	repaintStartRe = regexp.MustCompile(`^(?:` + repaintPrefix + `)*\x1b\[H`)
	// cursorOnlyRe is output that only shows or hides the cursor, reports
	// the size or switches an input mode: what can come just before a
	// repaint, in a read of its own.
	cursorOnlyRe = regexp.MustCompile(`^(?:` + repaintPrefix + `)+$`)
	repaintEndRe = regexp.MustCompile(`\x1b\[\?25h`)
)

var (
	repaintWait  = 250 * time.Millisecond
	repaintQuiet = 20 * time.Millisecond
)

const (
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
// types), besides the line view's kindRewind and kindCursor.
const (
	kindOutput      = "output"       // line view: text and colour codes (see lineScreen)
	kindScreen      = "screen"       // a full-screen program's raw output
	kindScreenStart = "screen-start" // one has started
	kindScreenEnd   = "screen-end"   // …and ended
)

// termSize is the terminal's size, set by the session as it's resized
// and read by the output pump.
type termSize struct{ v atomic.Uint32 }

func (t *termSize) set(cols, rows int) { t.v.Store(uint32(cols)<<16 | uint32(rows)&0xffff) }

func (t *termSize) get() (cols, rows int) {
	v := t.v.Load()
	return int(v >> 16), int(v & 0xffff)
}

func newTermSize(cols, rows int) *termSize {
	t := &termSize{}
	t.set(cols, rows)
	return t
}

// screenSplitter routes output between the line view (through a
// lineScreen) and a full-screen program's grid, and drops ConPTY's
// repaints.
type screenSplitter struct {
	size     *termSize
	send     func(kind, data string)
	guard    *RepaintGuard
	repaints bool // ConPTY: the screen is repainted when a program exits
	screen   bool
	lines    *lineScreen
	// repaint is the scratch screen a repaint being dropped is played on
	// (nil when there isn't one); dropped is how much of it there's been.
	repaint *lineScreen
	dropped int
}

// endRepaint puts the line view's cursor where the repaint left it.
func (sp *screenSplitter) endRepaint(shown bool) {
	m := sp.model()
	m.rebase(sp.repaint, shown)
	m.flush()
	sp.repaint = nil
}

// model is the line view's screen, at the terminal's current size.
func (sp *screenSplitter) model() *lineScreen {
	cols, rows := sp.size.get()
	if sp.lines == nil {
		sp.lines = newLineScreen(cols, rows, sp.send)
	} else {
		sp.lines.setSize(cols, rows)
	}
	return sp.lines
}

func (sp *screenSplitter) line(s string) {
	if s != "" {
		m := sp.model()
		m.write(s)
		m.flush()
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
		case sp.repaint != nil:
			loc := repaintEndRe.FindStringIndex(s)
			if loc == nil {
				sp.repaint.write(s)
				if sp.dropped += len(s); sp.dropped > repaintMax {
					sp.endRepaint(false)
				}
				return // all repaint; the rest follows
			}
			sp.repaint.write(s[:loc[1]])
			sp.endRepaint(true)
			s = s[loc[1]:]
		case sp.guard.armed() && cursorOnlyRe.MatchString(s):
			return // the start of a repaint, in a read of its own
		case sp.guard.armed() && repaintStartRe.MatchString(s):
			cols, rows := sp.size.get()
			sp.repaint, sp.dropped = newLineScreen(cols, rows, func(string, string) {}), 0
			s = s[repaintStartRe.FindStringIndex(s)[1]:]
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

// pumpOutput reads the PTY until it fails, sending the line view's
// output (and a full-screen program's raw output, see screenSplitter).
// size is the terminal's size; guard steers the splitter (repaints,
// leaving a full-screen view) and may be nil; repaints is true for
// ConPTY. Returns the read error that ended it.
func pumpOutput(r io.Reader, size *termSize, send func(kind, data string), guard *RepaintGuard, repaints bool) error {
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
				if f := openTraceFile(os.Getenv(traceEnv) + ".reads"); f != nil {
					cols, rows := size.get()
					fmt.Fprintf(f, "%d %d %d\n", n, cols, rows)
					f.Close()
				}
			}
			reads <- readResult{buf[:n], err}
			if err != nil {
				return
			}
		}
	}()
	sp := &screenSplitter{size: size, send: send, guard: guard, repaints: repaints}
	emit := func(b []byte) {
		if len(b) > 0 {
			sp.write(string(b))
		}
	}
	var held []byte
	for {
		var res readResult
		var wait time.Duration
		if len(held) > 0 {
			wait = heldFlushDelay
		}
		if sp.repaint != nil {
			wait = repaintQuiet
		}
		if wait > 0 {
			select {
			case res = <-reads:
			case <-time.After(wait):
				emit(held)
				held = nil
				if sp.repaint != nil {
					sp.endRepaint(false) // a repaint with the cursor hidden
				}
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
