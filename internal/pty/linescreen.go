package pty

import (
	"strconv"
	"strings"

	"github.com/rivo/uniseg"
)

// The line view's output messages besides kindOutput.
const (
	// kindRewind takes back the page's unfinished last line and the N
	// finished lines before it (N is the data); the output that follows
	// replaces them.
	kindRewind = "rewind"
	// kindCursor is "hidden" or "shown": whether the program hid the
	// cursor, as one drawing an arrow-key menu does.
	kindCursor = "cursor"
	// kindMark is a shell-integration mark, as the shell's prompt hook
	// sent it (shellhooks.go): "133;D;<exit code>" when a command has
	// finished, "7;file://host/path" (or "9;9;path") for the working
	// directory. It comes after the output printed before it.
	kindMark = "mark"
)

// lineScreen turns a shell's output into lines for the line view by
// playing it on a model of the terminal's screen, the way a terminal
// would. Output that only adds text reaches the page as it arrives.
// When a program goes back over lines it already drew (an arrow-key
// menu, a spinner, progress bars, a task list), the page is told to
// take those lines back and gets them as they are now, so a redraw
// replaces the old frame instead of printing a new copy under it.
//
// The page's lines are the screen's rows joined where a long line
// wrapped. Rows that scroll off the top can't change any more and are
// forgotten.
type lineScreen struct {
	cols, rows int
	send       func(kind, data string)

	// lines is the screen (its last `rows` entries) and, above it, rows
	// that scrolled off but whose line the page may still need redrawn.
	lines []*screenRow
	// floor is the first row whose line can still be taken back; the
	// page's last len(sent) lines are the lines from floor down, as they
	// were last sent. Rows above it are the page's already.
	floor int
	// touched is the first row the program changed since the last flush;
	// changed is the first that changed at all (rows put in or taken
	// out too). Lines above both, and above the cursor now and at the
	// last flush (sentCursor), are as sent.
	touched, changed, sentCursor int
	sent                         [][]cell

	x, y        int  // the cursor, y counted from the top of the screen
	wrapNext    bool // the last column was written: the next character wraps
	autowrap    bool
	hidden      bool // the program hid the cursor
	lostCursor  bool // …and a repaint left it somewhere meaningless
	sentHidden  bool
	pen         pen
	top, bottom int // scrolling region
	saved       savedCursor
	last        cell   // the last character printed, for REP
	lastW       int    // …and its width
	zw          string // zero-width characters waiting for a character
	carry       string // an escape sequence cut off by the end of a write
	skipping    bool   // inside an overlong OSC/DCS string, until its end
}

type savedCursor struct {
	x, y int
	pen  pen
}

// untouched is "no row" for floor and touched.
const untouched = 1 << 30

// maxKept is how many rows of a wrapped line that runs off the top of
// the screen are kept so the line can still be redrawn whole.
const maxKept = 256

type screenRow struct {
	cells []cell
	cont  bool // the row above wrapped onto this one
}

type cell struct {
	s    string // the character (a grapheme cluster); "" is a blank
	pen  pen
	wide uint8 // 1: the left half of a wide character, 2: its right half
}

// blank is a cell that shows nothing: trailing ones aren't part of a line.
func (c cell) blank() bool {
	return (c.s == "" || c.s == " ") && c.wide == 0 && c.pen.bg == 0 &&
		c.pen.attrs&(attrInverse|attrUnderline|attrStrike) == 0
}

// pen is the colours and text styles characters are written with.
type pen struct {
	fg, bg uint32 // 0 is the default; colorIndexed|n or colorRGB|0xrrggbb
	attrs  uint8
	link   string // an OSC 8 hyperlink's target, while one is open
}

const (
	attrBold uint8 = 1 << iota
	attrDim
	attrItalic
	attrUnderline
	attrInverse
	attrHidden
	attrStrike
)

// The SGR codes of the attributes above, in the same order.
var attrCodes = [...]string{";1", ";2", ";3", ";4", ";7", ";8", ";9"}

const (
	colorIndexed uint32 = 1 << 24
	colorRGB     uint32 = 2 << 24
)

var asciiStrings = func() (t [128]string) {
	for i := 0x20; i < 0x7f; i++ {
		t[i] = string(rune(i))
	}
	return
}()

func newLineScreen(cols, rows int, send func(kind, data string)) *lineScreen {
	m := &lineScreen{send: send, autowrap: true, touched: untouched, changed: untouched, sent: [][]cell{nil}}
	m.cols, m.rows = max(cols, 1), max(rows, 1)
	m.lines = blankRows(m.rows)
	m.bottom = m.rows - 1
	return m
}

func blankRows(n int) []*screenRow {
	rows := make([]*screenRow, n)
	for i := range rows {
		rows[i] = &screenRow{}
	}
	return rows
}

func (m *lineScreen) vpTop() int           { return len(m.lines) - m.rows }
func (m *lineScreen) cursorRow() int       { return m.vpTop() + m.y }
func (m *lineScreen) row(y int) *screenRow { return m.lines[m.vpTop()+y] }
func (m *lineScreen) touch(i int)          { m.touched, m.changed = min(m.touched, i), min(m.changed, i) }

// ── input ────────────────────────────────────────────────────

// write plays output on the screen. Call flush afterwards to send what
// changed.
func (m *lineScreen) write(s string) {
	if m.carry != "" {
		s, m.carry = m.carry+s, ""
	}
	i := 0
	if m.skipping {
		if i = m.skipString(s); i < 0 {
			return
		}
	}
	for i < len(s) {
		c := s[i]
		switch {
		case c == 0x1b:
			n := m.escape(s[i:])
			if n > 0 {
				i += n
				m.lastW = 0 // REP repeats only a character just printed
				continue
			}
			if len(s)-i <= 4096 {
				m.carry = s[i:]
				return
			}
			if isStringStart(s[i:]) { // an overlong OSC/DCS: skip to its end
				m.skipping = true
				if j := m.skipString(s[i+2:]); j >= 0 {
					i += 2 + j
					continue
				}
				return
			}
			i++ // not a sequence after all
		case c < 0x20 || c == 0x7f:
			m.control(c)
			m.lastW = 0
			i++
		default:
			j, ascii := i, true
			for j < len(s) && s[j] >= 0x20 && s[j] != 0x7f && s[j] != 0x1b {
				if s[j] >= 0x80 {
					ascii = false
				}
				j++
			}
			if ascii {
				for k := i; k < j; k++ {
					m.print(asciiStrings[s[k]], 1)
				}
			} else {
				m.text(s[i:j])
			}
			i = j
		}
	}
}

func isStringStart(s string) bool {
	return len(s) > 1 && strings.IndexByte("]PX^_", s[1]) >= 0
}

// skipString skips the rest of an OSC/DCS string: it returns where the
// string ends in s, or -1 if it doesn't end in s.
func (m *lineScreen) skipString(s string) int {
	for j := 0; j < len(s); j++ {
		switch {
		case s[j] == 0x07:
			m.skipping = false
			return j + 1
		case s[j] == 0x1b && j+1 == len(s):
			m.carry = "\x1b"
			return -1
		case s[j] == 0x1b:
			m.skipping = false
			if s[j+1] == '\\' {
				return j + 2
			}
			return j
		}
	}
	return -1
}

// text prints a run of printable characters that isn't all ASCII.
func (m *lineScreen) text(t string) {
	state := -1
	for t != "" {
		var cl string
		var w int
		cl, t, w, state = uniseg.FirstGraphemeClusterInString(t, state)
		if len(cl) == 2 && cl[0] == 0xc2 && cl[1] < 0xa0 {
			continue // a C1 control character
		}
		m.print(cl, w)
	}
}

func (m *lineScreen) control(c byte) {
	switch c {
	case '\r':
		m.x, m.wrapNext = 0, false
	case '\n', '\v', '\f':
		m.lineFeed()
	case '\b':
		if m.wrapNext = false; m.x > 0 {
			m.x--
		}
	case '\t':
		m.tab(1)
	}
}

// escape handles the escape sequence s starts with and returns its
// length, or 0 if s ends before the sequence does.
func (m *lineScreen) escape(s string) int {
	if len(s) < 2 {
		return 0
	}
	switch s[1] {
	case '[':
		j := 2
		for j < len(s) && s[j] >= 0x30 && s[j] <= 0x3f {
			j++
		}
		k := j
		for k < len(s) && s[k] >= 0x20 && s[k] <= 0x2f {
			k++
		}
		if k == len(s) {
			return 0
		}
		if s[k] < 0x40 || s[k] > 0x7e {
			return k // malformed: drop it
		}
		m.csi(s[2:j], s[j:k], s[k])
		return k + 1
	case ']', 'P', 'X', '^', '_':
		for j := 2; j < len(s); j++ {
			end, n := -1, 0
			switch {
			case s[j] == 0x07:
				end, n = j, j+1
			case s[j] == 0x1b && j+1 == len(s):
				return 0
			case s[j] == 0x1b && s[j+1] == '\\':
				end, n = j, j+2
			case s[j] == 0x1b:
				end, n = j, j
			}
			if end >= 0 {
				if s[1] == ']' {
					m.osc(s[2:end])
				}
				return n
			}
		}
		return 0
	case '(', ')', '*', '+', '-', '.', '/', '#', '%', ' ':
		if len(s) < 3 {
			return 0
		}
		return 3
	case '7':
		m.saved = savedCursor{m.x, m.y, m.pen}
	case '8':
		m.x, m.y, m.pen, m.wrapNext = min(m.saved.x, m.cols-1), min(m.saved.y, m.rows-1), m.saved.pen, false
	case 'D':
		m.wrapNext = false
		m.index()
	case 'E':
		m.x, m.wrapNext = 0, false
		m.index()
	case 'M':
		m.wrapNext = false
		if m.y == m.top {
			m.scrollDown(1)
		} else if m.y > 0 {
			m.y--
		}
	case 'c':
		m.clearScreen()
		m.pen, m.autowrap, m.hidden = pen{}, true, false
		m.top, m.bottom = 0, m.rows-1
		m.x, m.y, m.wrapNext = 0, 0, false
	default:
		if s[1] < 0x20 {
			return 1 // a lone ESC
		}
	}
	return 2
}

// osc passes shell-integration marks on to the page, after the output
// before them. Other OSC strings (the window title…) are dropped.
func (m *lineScreen) osc(payload string) {
	// OSC 8 ; params ; URI: the text written until the next OSC 8 links
	// there (ls --hyperlink, gcc, cargo, gh…). An empty URI ends it.
	if strings.HasPrefix(payload, "8;") {
		uri := ""
		if parts := strings.SplitN(payload, ";", 3); len(parts) == 3 {
			uri = parts[2]
		}
		if len(uri) > 2048 || strings.ContainsAny(uri, "\x1b\x07") {
			uri = ""
		}
		m.pen.link = uri
		return
	}
	// OSC 52 ; targets ; base64: a program copying to the clipboard
	// (tmux, Neovim, a remote shell). Writing only; "?" (asking what's on
	// the clipboard) is never answered.
	if strings.HasPrefix(payload, "52;") {
		if parts := strings.SplitN(payload, ";", 3); len(parts) == 3 && parts[2] != "?" && len(parts[2]) <= 1<<20 {
			m.flush()
			m.send(kindMark, "52;"+parts[2])
		}
		return
	}
	// OSC 9 ; 4 ; state ; percent: progress (winget, PowerShell 7.4+,
	// cargo…), shown in the status bar.
	if strings.HasPrefix(payload, "9;4;") || payload == "9;4" {
		m.send(kindMark, payload)
		return
	}
	if strings.HasPrefix(payload, "133;D") || strings.HasPrefix(payload, "7;") || strings.HasPrefix(payload, "9;9;") {
		m.flush()
		m.send(kindMark, payload)
	}
}

// param returns the i-th numeric parameter, or def if it's missing or 0.
func param(params string, i, def int) int {
	for ; i > 0; i-- {
		j := strings.IndexByte(params, ';')
		if j < 0 {
			return def
		}
		params = params[j+1:]
	}
	if j := strings.IndexAny(params, ";:"); j >= 0 {
		params = params[:j]
	}
	n, err := strconv.Atoi(params)
	if err != nil || n <= 0 {
		return def
	}
	return min(n, 1<<16)
}

func (m *lineScreen) csi(params, inter string, final byte) {
	if inter != "" {
		return // cursor style (CSI … SP q) and the like
	}
	if params != "" && params[0] >= 0x3c {
		if params[0] == '?' && (final == 'h' || final == 'l') {
			for _, p := range strings.Split(params[1:], ";") {
				switch p {
				case "25":
					m.hidden = final == 'l'
					m.lostCursor = m.lostCursor && m.hidden
				case "7":
					m.autowrap = final == 'h'
				}
			}
		}
		return
	}
	n := param(params, 0, 1)
	switch final {
	case 'A':
		m.up(n)
	case 'B':
		m.down(n)
	case 'e':
		m.y, m.wrapNext = min(m.y+n, m.rows-1), false
	case 'C', 'a':
		m.moveX(m.x + n)
	case 'D':
		m.moveX(m.x - n)
	case 'E':
		m.down(n)
		m.x = 0
	case 'F':
		m.up(n)
		m.x = 0
	case 'G', '`':
		m.moveX(n - 1)
	case 'H', 'f':
		m.y = min(n-1, m.rows-1)
		m.moveX(param(params, 1, 1) - 1)
	case 'd':
		m.y = min(n-1, m.rows-1)
		m.wrapNext = false
	case 'J':
		m.eraseDisplay(param(params, 0, 0))
	case 'K':
		m.eraseLine(param(params, 0, 0))
	case 'X':
		m.eraseChars(n)
	case 'P':
		m.deleteChars(n)
	case '@':
		m.insertChars(n)
	case 'L':
		m.insertLines(n)
	case 'M':
		m.deleteLines(n)
	case 'S':
		m.scrollUp(min(n, m.rows))
	case 'T':
		m.scrollDown(min(n, m.rows))
	case 'I':
		m.tab(n)
	case 'Z':
		for ; n > 0 && m.x > 0 && !m.wrapNext; n-- {
			m.x = (m.x - 1) / 8 * 8
		}
	case 'b':
		if m.lastW > 0 {
			for n = min(n, m.cols*m.rows); n > 0; n-- {
				m.print(m.last.s, m.lastW)
			}
		}
	case 'm':
		m.pen = m.pen.sgr(params)
	case 'r':
		t, b := param(params, 0, 1), param(params, 1, m.rows)
		if b > m.rows {
			b = m.rows
		}
		if b > t {
			m.top, m.bottom = t-1, b-1
			m.x, m.y, m.wrapNext = 0, 0, false
		}
	case 's':
		m.saved = savedCursor{m.x, m.y, m.pen}
	case 'u':
		m.x, m.y, m.pen, m.wrapNext = min(m.saved.x, m.cols-1), min(m.saved.y, m.rows-1), m.saved.pen, false
	}
}

func (m *lineScreen) moveX(x int) { m.x, m.wrapNext = max(0, min(x, m.cols-1)), false }

// up and down move the cursor, stopping at the scrolling region's top
// (bottom) if it starts below (above) it.
func (m *lineScreen) up(n int) {
	lo := 0
	if m.y >= m.top {
		lo = m.top
	}
	m.y, m.wrapNext = max(lo, m.y-min(n, m.rows)), false
}

func (m *lineScreen) down(n int) {
	hi := m.rows - 1
	if m.y <= m.bottom {
		hi = m.bottom
	}
	m.y, m.wrapNext = min(hi, m.y+min(n, m.rows)), false
}

// tab moves to the next tab stop (every 8 columns), n times. It does
// nothing when the next character would wrap.
func (m *lineScreen) tab(n int) {
	for ; n > 0 && m.x < m.cols-1 && !m.wrapNext; n-- {
		m.x = min((m.x/8+1)*8, m.cols-1)
	}
}

// ── writing ──────────────────────────────────────────────────

func (m *lineScreen) print(cl string, w int) {
	if w == 0 {
		m.zeroWidth(cl)
		return
	}
	if m.zw != "" {
		cl, m.zw = m.zw+cl, ""
	}
	m.lostCursor = false
	w = min(w, 2)
	if m.wrapNext {
		if m.autowrap {
			m.wrapLine()
		} else {
			m.wrapNext = false
		}
	}
	if w == 2 && m.x == m.cols-1 && m.cols > 1 {
		if !m.autowrap {
			return
		}
		// A wide character doesn't fit in the last column: it's left
		// blank and the character goes on the next row.
		if m.x < len(m.lines[m.cursorRow()].cells) {
			m.setCell(m.x, cell{})
		}
		m.wrapLine()
	}
	c := cell{s: cl, pen: m.pen}
	if w == 2 {
		c.wide = 1
	}
	m.setCell(m.x, c)
	if w == 2 {
		m.setCell(m.x+1, cell{pen: m.pen, wide: 2})
	}
	m.last, m.lastW = c, w
	if m.x+w >= m.cols {
		m.x, m.wrapNext = m.cols-1, true
	} else {
		m.x += w
	}
}

// zeroWidth joins a combining mark or other zero-width character to the
// character before the cursor, or to the next one printed.
func (m *lineScreen) zeroWidth(cl string) {
	x := m.x - 1
	if m.wrapNext {
		x = m.x
	}
	i := m.cursorRow()
	r := m.lines[i]
	if x >= 0 && x < len(r.cells) && r.cells[x].wide == 2 {
		x--
	}
	if x >= 0 && x < len(r.cells) && r.cells[x].s != "" {
		r.cells[x].s += cl
		m.touch(i)
		return
	}
	if len(m.zw) < 64 {
		m.zw += cl
	}
}

func (m *lineScreen) setCell(x int, c cell) {
	i := m.cursorRow()
	r := m.lines[i]
	if x < len(r.cells) {
		old := r.cells[x]
		if old == c {
			return
		}
		if old.wide == 1 && c.wide != 1 && x+1 < len(r.cells) && r.cells[x+1].wide == 2 {
			r.cells[x+1] = cell{}
		}
		if old.wide == 2 && c.wide != 2 && x > 0 && r.cells[x-1].wide == 1 {
			r.cells[x-1] = cell{}
		}
		r.cells[x] = c
	} else {
		for len(r.cells) < x {
			r.cells = append(r.cells, cell{})
		}
		r.cells = append(r.cells, c)
	}
	m.touch(i)
}

func (m *lineScreen) setCont(i int, cont bool) {
	if r := m.lines[i]; r.cont != cont {
		r.cont = cont
		m.touch(i)
	}
}

// wrapLine moves to the start of the next row, which continues this line.
func (m *lineScreen) wrapLine() {
	m.x, m.wrapNext = 0, false
	m.index()
	i := m.cursorRow()
	if r := m.lines[i]; !r.cont {
		r.cont = true
		m.touch(i)
	}
}

// lineFeed moves down a row. The row it lands on starts a line of its
// own (as in xterm.js: ConPTY often goes back over rows to reprint them).
func (m *lineScreen) lineFeed() {
	m.wrapNext = false
	y := m.y
	m.index()
	if m.y != y {
		i := m.cursorRow()
		if r := m.lines[i]; r.cont {
			r.cont = false
			m.touch(i)
		}
	}
}

// index moves down a row, scrolling at the bottom of the scrolling region.
func (m *lineScreen) index() {
	switch {
	case m.y == m.bottom:
		m.scrollUp(1)
	case m.y < m.rows-1:
		m.y++
	}
}

// scrollUp scrolls the scrolling region up n rows. With the region at the
// top of the screen the top rows go above it, the way the whole screen
// scrolls; otherwise they're gone.
func (m *lineScreen) scrollUp(n int) {
	for n = min(n, m.bottom-m.top+1); n > 0; n-- {
		vp := m.vpTop()
		if m.top == 0 {
			m.insertRow(vp + m.bottom + 1)
		} else {
			m.deleteRow(vp + m.top)
			m.insertRow(vp + m.bottom)
		}
	}
}

func (m *lineScreen) scrollDown(n int) {
	for n = min(n, m.bottom-m.top+1); n > 0; n-- {
		vp := m.vpTop()
		m.deleteRow(vp + m.bottom)
		m.insertRow(vp + m.top)
	}
}

func (m *lineScreen) insertLines(n int) {
	if m.y < m.top || m.y > m.bottom {
		return
	}
	for n = min(n, m.bottom-m.y+1); n > 0; n-- {
		vp := m.vpTop()
		m.deleteRow(vp + m.bottom)
		m.insertRow(vp + m.y)
	}
	m.x, m.wrapNext = 0, false
}

func (m *lineScreen) deleteLines(n int) {
	if m.y < m.top || m.y > m.bottom {
		return
	}
	for n = min(n, m.bottom-m.y+1); n > 0; n-- {
		vp := m.vpTop()
		m.deleteRow(vp + m.y)
		m.insertRow(vp + m.bottom)
	}
	m.x, m.wrapNext = 0, false
}

func (m *lineScreen) insertRow(at int) {
	m.lines = append(m.lines, nil)
	copy(m.lines[at+1:], m.lines[at:])
	m.lines[at] = &screenRow{}
	if m.floor >= at {
		m.floor++
	}
	if m.touched >= at {
		m.touched++
	}
	if m.sentCursor >= at {
		m.sentCursor++
	}
	m.changed = min(m.changed, at)
}

func (m *lineScreen) deleteRow(at int) {
	copy(m.lines[at:], m.lines[at+1:])
	m.lines[len(m.lines)-1] = nil
	m.lines = m.lines[:len(m.lines)-1]
	if m.floor > at {
		m.floor--
	}
	if m.touched > at {
		m.touched--
	}
	if m.sentCursor > at {
		m.sentCursor--
	}
	m.changed = min(m.changed, at)
}

func (m *lineScreen) clearRow(y int) {
	i := m.vpTop() + y
	if r := m.lines[i]; len(r.cells) > 0 || r.cont {
		r.cells, r.cont = r.cells[:0], false
		m.touch(i)
	}
}

// eraseX is where erasing starts: past the last column when the next
// character would wrap (so a full row followed by ESC [K keeps its last
// character, as ConPTY's output needs).
func (m *lineScreen) eraseX() int {
	if m.wrapNext {
		return m.cols
	}
	return m.x
}

// eraseLine is EL. Like the other erases it leaves a pending wrap alone.
func (m *lineScreen) eraseLine(mode int) {
	i := m.cursorRow()
	r := m.lines[i]
	x := m.eraseX()
	switch mode {
	case 0:
		if x < len(r.cells) {
			r.cells = r.cells[:x]
			if x > 0 && r.cells[x-1].wide == 1 {
				r.cells[x-1] = cell{}
			}
			m.touch(i)
		}
		if x == 0 && r.cont {
			r.cont = false
			m.touch(i)
		}
	case 1:
		m.blankCells(r, i, 0, x+1)
	case 2:
		m.clearRow(m.y)
	}
}

// blankCells blanks cells [from, to) of row r (lines[i]).
func (m *lineScreen) blankCells(r *screenRow, i, from, to int) {
	to = min(to, len(r.cells))
	if from >= to {
		return
	}
	for j := from; j < to; j++ {
		r.cells[j] = cell{}
	}
	if from > 0 && r.cells[from-1].wide == 1 {
		r.cells[from-1] = cell{}
	}
	if to < len(r.cells) && r.cells[to].wide == 2 {
		r.cells[to] = cell{}
	}
	m.touch(i)
}

func (m *lineScreen) eraseChars(n int) {
	i := m.cursorRow()
	m.blankCells(m.lines[i], i, m.x, m.x+n)
	m.wrapNext = false
}

func (m *lineScreen) deleteChars(n int) {
	m.wrapNext = false
	i := m.cursorRow()
	r := m.lines[i]
	if m.x >= len(r.cells) {
		return
	}
	n = min(n, len(r.cells)-m.x)
	r.cells = append(r.cells[:m.x], r.cells[m.x+n:]...)
	if m.x > 0 && r.cells[m.x-1].wide == 1 { // its right half went
		r.cells[m.x-1] = cell{}
	}
	if m.x < len(r.cells) && r.cells[m.x].wide == 2 { // its left half went
		r.cells[m.x] = cell{}
	}
	m.touch(i)
}

func (m *lineScreen) insertChars(n int) {
	m.wrapNext = false
	i := m.cursorRow()
	r := m.lines[i]
	if m.x >= len(r.cells) {
		return
	}
	split := m.x > 0 && r.cells[m.x-1].wide == 1 // inserting inside a wide character
	if split {
		r.cells[m.x-1] = cell{}
	}
	n = min(n, m.cols)
	r.cells = append(r.cells[:m.x], append(make([]cell, n), r.cells[m.x:]...)...)
	if split && m.x+n < len(r.cells) {
		r.cells[m.x+n] = cell{} // its right half, moved along
	}
	if len(r.cells) > m.cols {
		r.cells = r.cells[:m.cols]
		if r.cells[m.cols-1].wide == 1 { // its right half fell off the row
			r.cells[m.cols-1] = cell{}
		}
	}
	m.touch(i)
}

func (m *lineScreen) eraseDisplay(mode int) {
	switch mode {
	case 0:
		m.eraseLine(0)
		for y := m.y + 1; y < m.rows; y++ {
			m.clearRow(y)
		}
	case 1:
		for y := 0; y < m.y; y++ {
			m.clearRow(y)
		}
		m.eraseLine(1)
		// What's left of this row doesn't continue the one above, and
		// if all of it went, the next row doesn't continue it.
		i := m.cursorRow()
		m.setCont(i, false)
		if m.eraseX()+1 >= m.cols && m.y+1 < m.rows {
			m.setCont(i+1, false)
		}
	case 2:
		m.clearScreen()
	}
}

// clearScreen starts a fresh screen (clear, cls, ESC [2J). The page
// keeps what it has: in the line view, cleared output is history.
func (m *lineScreen) clearScreen() {
	m.flush()
	if len(m.sent[len(m.sent)-1]) > 0 {
		m.send(kindOutput, "\n")
	}
	m.sent = [][]cell{nil}
	m.lines = blankRows(m.rows)
	m.floor, m.touched, m.changed = untouched, untouched, 0
}

// ── size ─────────────────────────────────────────────────────

// setSize follows the terminal's size. The lines being tracked (from
// floor down) are laid out again at the new width, as terminals do;
// rows above them stay as they are.
func (m *lineScreen) setSize(cols, rows int) {
	cols, rows = max(cols, 1), max(rows, 1)
	if cols == m.cols && rows == m.rows {
		return
	}
	m.flush()
	cur := m.cursorRow()
	start := m.floor
	oldY := m.y
	last := m.lastRow(cur)
	var laid []*screenRow
	newCur, newX, wrapNext := 0, 0, false
	for i := start; i <= last; {
		j := i + 1
		for j <= last && m.lines[j].cont {
			j++
		}
		var cells []cell
		at := -1
		for k := i; k < j; k++ {
			if k == cur {
				at = len(cells) + m.x
				if m.wrapNext {
					at++
				}
			}
			cells = append(cells, m.lines[k].cells...)
		}
		lineRows, row, x, wn := layout(finish(cells, at), cols, at)
		if at >= 0 {
			newCur, newX, wrapNext = len(laid)+row, x, wn
		}
		laid = append(laid, lineRows...)
		i = j
	}
	m.lines = append(m.lines[:start], laid...)
	m.cols, m.rows = cols, rows
	// Keep the cursor on the same screen row if it fits.
	y := min(oldY, rows-1)
	if below := len(laid) - 1 - newCur; below > rows-1-y {
		y = max(0, rows-1-below)
	}
	curAbs := start + newCur
	if want := curAbs + rows - y; len(m.lines) > want {
		m.lines = m.lines[:want]
	} else {
		for len(m.lines) < want {
			m.lines = append(m.lines, &screenRow{})
		}
	}
	if short := y - curAbs; short > 0 { // not enough rows above to fill the screen
		m.lines = append(blankRows(short), m.lines...)
		m.floor += short
	}
	m.x, m.y, m.wrapNext = min(newX, cols-1), y, wrapNext
	m.changed = 0
	m.top, m.bottom = 0, rows-1
	m.saved.x, m.saved.y = min(m.saved.x, cols-1), min(m.saved.y, rows-1)
}

// layout lays a line's cells out in rows of the given width, and says
// where offset `at` ends up (row, column, and whether it's past the end
// of a full row).
func layout(cells []cell, cols, at int) (rows []*screenRow, row, x int, wrapNext bool) {
	r := &screenRow{}
	rows = []*screenRow{r}
	col := 0
	for i := 0; i <= len(cells); i++ {
		if i == at {
			row, x = len(rows)-1, col
			if col >= cols {
				x, wrapNext = cols-1, true
			}
		}
		if i == len(cells) {
			break
		}
		c := cells[i]
		if c.wide == 2 {
			continue // added with its left half
		}
		w := 1
		if c.wide == 1 {
			w = 2
		}
		if col+w > cols && col > 0 {
			r = &screenRow{cont: true}
			rows = append(rows, r)
			col = 0
		}
		r.cells = append(r.cells, c)
		if w == 2 {
			r.cells = append(r.cells, cell{pen: c.pen, wide: 2})
		}
		col += w
	}
	return
}

// rebase lines the screen up with ConPTY's after ConPTY repainted it
// (after a resize, or a full-screen program exiting); s is the repaint
// played on a scratch screen. The repaint itself isn't shown, since the
// page has those lines already: the rows move to where ConPTY has them
// (found by their text) and the cursor goes where the repaint left it.
// If the rows can't be matched up (ConPTY laid a line out differently),
// the lines above the cursor's are left as the page has them, so a
// program's redraw can't take back the wrong ones.
func (m *lineScreen) rebase(s *lineScreen, shown bool) {
	m.flush()
	d, ok := m.offsetFrom(s)
	if !ok {
		m.freeze(m.logicalStart(m.cursorRow()))
		d = s.y - m.y
	}
	if vp := m.vpTop(); d > 0 && m.floor < vp {
		// Rows go in at the top of the screen: what's above it is done.
		if m.lines[vp].cont {
			m.freeze(m.logicalStart(m.cursorRow()))
		} else {
			m.freeze(vp)
		}
	}
	for ; d > 0; d-- { // ConPTY has more rows above these than we do
		vp := m.vpTop()
		m.deleteRow(len(m.lines) - 1)
		m.insertRow(vp)
	}
	for ; d < 0; d++ { // fewer
		m.lines = append(m.lines, &screenRow{})
	}
	m.x, m.y, m.wrapNext = min(s.x, m.cols-1), min(s.y, m.rows-1), s.wrapNext
	if shown {
		m.hidden = false
	}
	// With the cursor hidden ConPTY leaves it wherever the repaint
	// ended; until the program writes, it says nothing about the lines.
	m.lostCursor = m.hidden
}

// offsetFrom finds how many rows further down ConPTY's screen (s) has
// the rows being tracked, by their text. ok is false if no offset puts
// every one of them on a row with the same text.
func (m *lineScreen) offsetFrom(s *lineScreen) (d int, ok bool) {
	if s.rows != m.rows || s.cols != m.cols {
		return 0, false
	}
	vp := m.vpTop()
	first := max(m.floor, vp) - vp
	ours := make([]string, m.rows)
	theirs := make([]string, m.rows)
	for y := 0; y < m.rows; y++ {
		ours[y], theirs[y] = rowText(m.row(y)), rowText(s.row(y))
	}
	best := 0
	for off := -(m.rows - 1); off < m.rows; off++ {
		matched, bad := 0, false
		for y := first; y < m.rows && !bad; y++ {
			switch sy := y + off; {
			case sy < 0: // goes above the screen
			case sy >= m.rows:
				bad = ours[y] != ""
			case ours[y] != theirs[sy]:
				bad = true
			case ours[y] != "":
				matched++
			}
		}
		if !bad && (matched > best || matched == best && matched > 0 && abs(off) < abs(d)) {
			best, d = matched, off
		}
	}
	return d, best > 0
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// rowText is a row's text without colours or trailing blanks.
func rowText(r *screenRow) string {
	var b strings.Builder
	for _, c := range r.cells {
		switch {
		case c.wide == 2:
		case c.s == "":
			b.WriteByte(' ')
		default:
			b.WriteString(c.s)
		}
	}
	return strings.TrimRight(b.String(), " ")
}

// ── output ───────────────────────────────────────────────────

func (m *lineScreen) logicalStart(i int) int {
	for i > 0 && i < len(m.lines) && m.lines[i].cont {
		i--
	}
	return i
}

// lastRow is the last row with something on it, or the cursor's row.
func (m *lineScreen) lastRow(cur int) int {
	for i := len(m.lines) - 1; i > cur; i-- {
		if r := m.lines[i]; r.cont || len(finish(r.cells, -1)) > 0 {
			return i
		}
	}
	return cur
}

// finish trims a line's trailing blanks, keeping those before the
// cursor (at, or -1) so a prompt keeps its space.
func finish(line []cell, at int) []cell {
	n := len(line)
	for n > 0 && line[n-1].blank() {
		n--
	}
	if at > n {
		for len(line) < at {
			line = append(line, cell{})
		}
		n = at
	}
	return line[:n]
}

// render returns the lines from floor down, as the page should show
// them: the first `keep` as sent, then the lines from row `from`.
func (m *lineScreen) render(cur, from, keep int) [][]cell {
	last := max(m.lastRow(cur), from)
	out := append(make([][]cell, 0, keep+last-from+1), m.sent[:keep]...)
	var line []cell
	at := -1
	for i := from; i <= last; i++ {
		r := m.lines[i]
		if i > from && !r.cont {
			out = append(out, finish(line, at))
			line, at = nil, -1
		}
		if i == cur {
			at = len(line) + m.x
			if m.wrapNext {
				at++
			}
		}
		line = append(line, r.cells...)
	}
	return append(out, finish(line, at))
}

// shownRow is the cursor's row, or -1 if it says nothing about the
// lines (see lostCursor): the cursor's line is shown up to the cursor,
// so a prompt keeps its trailing space, and no line ends before it.
func (m *lineScreen) shownRow() int {
	if m.lostCursor {
		return -1
	}
	return m.cursorRow()
}

// flush sends the page what changed since the last flush.
func (m *lineScreen) flush() {
	cur := m.shownRow()
	thaw := m.touched
	if cur >= 0 || m.floor >= len(m.lines) {
		thaw = min(thaw, m.cursorRow())
	}
	from, keep := m.floor, 0
	if s := m.logicalStart(thaw); s < m.floor {
		m.floor, from = s, s // the program went back above the lines being tracked
	} else if c := m.logicalStart(max(0, min(m.cursorRow(), m.changed, m.sentCursor)-1)); c > m.floor {
		// Only lines from row c on can have changed (a row that stops or
		// starts continuing the one above changes that one's line too).
		for i := m.floor; i < c; i++ {
			if i == m.floor || !m.lines[i].cont {
				keep++
			}
		}
		if keep < len(m.sent) {
			from = c
		} else {
			keep = 0
		}
	}
	m.touched, m.changed = untouched, untouched
	now := m.render(cur, from, keep)
	m.sendDiff(now, keep)
	m.sent = now
	m.trim()
	m.sentCursor = m.cursorRow()
	if m.hidden != m.sentHidden {
		m.sentHidden = m.hidden
		if m.hidden {
			m.send(kindCursor, "hidden")
		} else {
			m.send(kindCursor, "shown")
		}
	}
}

// sendDiff sends what turns the page's lines (m.sent) into now, whose
// first `same` are unchanged: new text at the end if that's all it is,
// else a rewind to the first line that changed and everything from
// there.
func (m *lineScreen) sendDiff(now [][]cell, same int) {
	last, nowLast := len(m.sent)-1, len(now)-1
	k := same // lines known to be as sent
	for k < last && k < nowLast && cellsEqual(m.sent[k], now[k]) {
		k++
	}
	var b strings.Builder
	rewind := -1
	switch {
	case k < last:
		rewind = last - k // a finished line changed, or there are fewer lines
	case cellsEqual(m.sent[last], now[last]):
		k++
		for _, l := range now[k:] {
			b.WriteByte('\n')
			writeCells(&b, l)
		}
	case hasPrefix(now[last], m.sent[last]):
		writeCells(&b, now[last][len(m.sent[last]):])
		k++
		for _, l := range now[k:] {
			b.WriteByte('\n')
			writeCells(&b, l)
		}
	default:
		rewind = 0
	}
	if rewind >= 0 {
		m.send(kindRewind, strconv.Itoa(rewind))
		for i, l := range now[k:] {
			if i > 0 {
				b.WriteByte('\n')
			}
			writeCells(&b, l)
		}
	}
	if b.Len() > 0 {
		m.send(kindOutput, b.String())
	}
}

// trim forgets rows that can't change any more: those above the screen,
// except the start of a line that runs onto it (up to maxKept rows).
func (m *lineScreen) trim() {
	vp := m.vpTop()
	keep := vp
	for keep > 0 && m.lines[keep].cont && vp-keep < maxKept {
		keep--
	}
	if keep > m.floor && m.floor < len(m.lines) {
		drop := 0
		for i := m.floor; i < keep; i++ {
			if i == m.floor || !m.lines[i].cont {
				drop++
			}
		}
		if m.lines[keep].cont { // cut inside a long line: its start goes
			drop--
			head := 0
			for i := max(m.floor, m.logicalStart(keep)); i < keep; i++ {
				head += len(m.lines[i].cells)
			}
			m.sent[drop] = m.sent[drop][min(head, len(m.sent[drop])):]
		}
		m.sent = m.sent[min(drop, len(m.sent)-1):]
		m.floor = keep
	}
	if d := min(m.floor, vp); d > 0 {
		n := copy(m.lines, m.lines[d:])
		clear(m.lines[n:])
		m.lines = m.lines[:n]
		m.floor -= d
	}
}

// freeze makes the page's lines above row start final. Call it just
// after flush, when m.sent matches the rows.
func (m *lineScreen) freeze(start int) {
	if start <= m.floor || m.floor >= len(m.lines) {
		if m.floor >= len(m.lines) {
			m.floor = start
		}
		return
	}
	drop := 0
	for i := m.floor; i < start; i++ {
		if i == m.floor || !m.lines[i].cont {
			drop++
		}
	}
	m.sent = m.sent[min(drop, len(m.sent)-1):]
	m.floor = start
}

func cellsEqual(a, b []cell) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func hasPrefix(s, prefix []cell) bool {
	return len(s) >= len(prefix) && cellsEqual(s[:len(prefix)], prefix)
}

// writeCells writes cells as text with colour codes. It starts and ends
// with the default style, so every piece stands on its own.
func writeCells(b *strings.Builder, cells []cell) {
	var p pen
	for _, c := range cells {
		if c.wide == 2 {
			continue
		}
		// OSC 8 ends with ST (ESC \), not BEL: the page drops BELs.
		if c.pen.link != p.link {
			if p.link != "" {
				b.WriteString("\x1b]8;;\x1b\\")
			}
			if c.pen.link != "" {
				b.WriteString("\x1b]8;;" + c.pen.link + "\x1b\\")
			}
		}
		if c.pen != p {
			writeSGR(b, c.pen)
			p = c.pen
		}
		if c.s == "" {
			b.WriteByte(' ')
		} else {
			b.WriteString(c.s)
		}
	}
	if p.link != "" {
		b.WriteString("\x1b]8;;\x1b\\")
	}
	if p != (pen{}) {
		b.WriteString("\x1b[0m")
	}
}

func writeSGR(b *strings.Builder, p pen) {
	b.WriteString("\x1b[0")
	for i, code := range attrCodes {
		if p.attrs&(1<<i) != 0 {
			b.WriteString(code)
		}
	}
	writeColor(b, p.fg, 30, 90, "38")
	writeColor(b, p.bg, 40, 100, "48")
	b.WriteByte('m')
}

func writeColor(b *strings.Builder, c uint32, base, bright int, ext string) {
	v := int(c & 0xffffff)
	switch c &^ 0xffffff {
	case colorIndexed:
		b.WriteByte(';')
		switch {
		case v < 8:
			b.WriteString(strconv.Itoa(base + v))
		case v < 16:
			b.WriteString(strconv.Itoa(bright + v - 8))
		default:
			b.WriteString(ext + ";5;" + strconv.Itoa(v))
		}
	case colorRGB:
		b.WriteString(";" + ext + ";2;" + strconv.Itoa(v>>16) + ";" + strconv.Itoa(v>>8&0xff) + ";" + strconv.Itoa(v&0xff))
	}
}

// sgr applies an SGR sequence's parameters (ESC [ params m).
func (p pen) sgr(params string) pen {
	// A reset clears colours and styles, not an open hyperlink.
	if params == "" {
		return pen{link: p.link}
	}
	f := strings.Split(params, ";")
	for i := 0; i < len(f); i++ {
		if strings.IndexByte(f[i], ':') >= 0 { // 38:2::r:g:b, 38:5:n, 4:0
			sub := strings.Split(f[i], ":")
			switch sub[0] {
			case "38", "48":
				if c, ok := colonColor(sub[1:]); ok {
					if sub[0] == "38" {
						p.fg = c
					} else {
						p.bg = c
					}
				}
			case "4":
				if sub[1] == "0" {
					p.attrs &^= attrUnderline
				} else {
					p.attrs |= attrUnderline
				}
			}
			continue
		}
		n, _ := strconv.Atoi(f[i])
		switch {
		case n == 0:
			p = pen{link: p.link}
		case n == 1:
			p.attrs |= attrBold
		case n == 2:
			p.attrs |= attrDim
		case n == 3:
			p.attrs |= attrItalic
		case n == 4:
			p.attrs |= attrUnderline
		case n == 7:
			p.attrs |= attrInverse
		case n == 8:
			p.attrs |= attrHidden
		case n == 9:
			p.attrs |= attrStrike
		case n == 21 || n == 22:
			p.attrs &^= attrBold | attrDim
		case n == 23:
			p.attrs &^= attrItalic
		case n == 24:
			p.attrs &^= attrUnderline
		case n == 27:
			p.attrs &^= attrInverse
		case n == 28:
			p.attrs &^= attrHidden
		case n == 29:
			p.attrs &^= attrStrike
		case n >= 30 && n <= 37:
			p.fg = colorIndexed | uint32(n-30)
		case n == 39:
			p.fg = 0
		case n >= 40 && n <= 47:
			p.bg = colorIndexed | uint32(n-40)
		case n == 49:
			p.bg = 0
		case n >= 90 && n <= 97:
			p.fg = colorIndexed | uint32(n-90+8)
		case n >= 100 && n <= 107:
			p.bg = colorIndexed | uint32(n-100+8)
		case n == 38 || n == 48:
			c, used, ok := semicolonColor(f[i+1:])
			if ok {
				if n == 38 {
					p.fg = c
				} else {
					p.bg = c
				}
			}
			i += used
		}
	}
	return p
}

func semicolonColor(f []string) (c uint32, used int, ok bool) {
	switch {
	case len(f) >= 2 && f[0] == "5":
		if n, err := strconv.Atoi(f[1]); err == nil && n >= 0 && n <= 255 {
			return colorIndexed | uint32(n), 2, true
		}
		return 0, 2, false
	case len(f) >= 4 && f[0] == "2":
		return colorRGB | rgb(f[1:4]), 4, true
	}
	return 0, 0, false
}

func colonColor(sub []string) (uint32, bool) {
	switch {
	case len(sub) >= 2 && sub[0] == "5":
		if n, err := strconv.Atoi(sub[1]); err == nil && n >= 0 && n <= 255 {
			return colorIndexed | uint32(n), true
		}
	case len(sub) >= 4 && sub[0] == "2":
		return colorRGB | rgb(sub[len(sub)-3:]), true // 38:2::r:g:b has a colour-space id first
	}
	return 0, false
}

func rgb(f []string) uint32 {
	var v uint32
	for _, s := range f {
		n, _ := strconv.Atoi(s)
		v = v<<8 | uint32(max(0, min(n, 255)))
	}
	return v
}
