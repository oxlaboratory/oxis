package pty

import (
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
)

// page plays the line view's messages the way the page does: output
// adds text (a line ends at "\n"), a rewind takes back the unfinished
// line and N finished ones before it.
type page struct {
	t       *testing.T
	lines   []string
	partial string
	cursor  string
	screen  []string
}

func (p *page) send(kind, data string) {
	switch kind {
	case kindOutput:
		parts := strings.Split(p.partial+data, "\n")
		p.lines = append(p.lines, parts[:len(parts)-1]...)
		p.partial = parts[len(parts)-1]
	case kindRewind:
		n, err := strconv.Atoi(data)
		if err != nil || n < 0 || n > len(p.lines) {
			p.t.Fatalf("rewind %q with %d lines", data, len(p.lines))
		}
		p.lines, p.partial = p.lines[:len(p.lines)-n], ""
	case kindCursor:
		p.cursor = data
	default:
		p.screen = append(p.screen, kind+":"+data)
	}
}

// screenMessages is the full-screen messages, consecutive "screen" ones
// joined.
func (p *page) screenMessages() []string {
	var out []string
	for _, m := range p.screen {
		if n := len(out); n > 0 && strings.HasPrefix(m, kindScreen+":") && strings.HasPrefix(out[n-1], kindScreen+":") {
			out[n-1] += strings.TrimPrefix(m, kindScreen+":")
			continue
		}
		out = append(out, m)
	}
	return out
}

func (p *page) styled() string {
	return strings.Join(append(append([]string{}, p.lines...), p.partial), "\n")
}

var sgrTestRe = regexp.MustCompile(`\x1b\[[0-9;]*m`)

// text is the page without colour codes.
func (p *page) text() string { return sgrTestRe.ReplaceAllString(p.styled(), "") }

// shown is the page as it looks: each run of text with the style it's
// in (text can arrive in pieces, each setting its own colours).
func (p *page) shown() string {
	var b strings.Builder
	for _, line := range append(append([]string{}, p.lines...), p.partial) {
		style, cur := "", ""
		for line != "" {
			loc := sgrTestRe.FindStringIndex(line)
			if loc != nil && loc[0] == 0 {
				if style = line[:loc[1]]; style == "\x1b[0m" || style == "\x1b[m" {
					style = ""
				}
				line = line[loc[1]:]
				continue
			}
			n := len(line)
			if loc != nil {
				n = loc[0]
			}
			if style != cur {
				b.WriteString("<" + style + ">")
				cur = style
			}
			b.WriteString(line[:n])
			line = line[n:]
		}
		b.WriteByte('\n')
	}
	return b.String()
}

// pump plays the chunks through pumpOutput, as reads.
func pump(t *testing.T, cols, rows int, guard *RepaintGuard, repaints bool, chunks ...string) *page {
	t.Helper()
	p := &page{t: t}
	if err := pumpOutput(&chunkReader{chunks: chunks}, newTermSize(cols, rows), p.send, guard, repaints); err != io.EOF {
		t.Fatalf("pumpOutput: %v", err)
	}
	return p
}

// everyCut plays s cut in two at every point and fails unless the page
// always ends up the same, which it returns.
func everyCut(t *testing.T, cols, rows int, s string) *page {
	t.Helper()
	want := pump(t, cols, rows, &RepaintGuard{}, true, s)
	for cut := 1; cut < len(s); cut++ {
		if got := pump(t, cols, rows, &RepaintGuard{}, true, s[:cut], s[cut:]); got.shown() != want.shown() {
			t.Fatalf("cut at %d (%q | %q):\n got %q\nwant %q", cut, s[:cut], s[cut:], got.shown(), want.shown())
		}
	}
	return want
}

func TestLinesPlainOutput(t *testing.T) {
	p := everyCut(t, 80, 24, "hello\r\nworld\r\n$ ")
	if p.text() != "hello\nworld\n$ " {
		t.Errorf("got %q", p.text())
	}
}

// menuFrame is an arrow-key menu as inquirer, clack and prompts draw it.
func menuFrame(sel int) string {
	var b strings.Builder
	b.WriteString("? Pick a framework\r\n")
	for i, o := range []string{"React", "Vue", "Svelte"} {
		if i == sel {
			b.WriteString("\x1b[36m❯ " + o + "\x1b[0m\r\n")
		} else {
			b.WriteString("  " + o + "\r\n")
		}
	}
	return b.String()
}

func TestMenuRedrawnInPlace(t *testing.T) {
	// On a real PTY the program's own cursor-up and erase arrive as sent.
	const back = "\x1b[4A\x1b[0J"
	start := "$ npm create app\r\n\x1b[?25l" + menuFrame(0)
	p := pump(t, 80, 24, nil, false, start, back+menuFrame(1))
	if want := "$ npm create app\n? Pick a framework\n  React\n❯ Vue\n  Svelte\n"; p.text() != want {
		t.Errorf("after one move:\n got %q\nwant %q", p.text(), want)
	}
	if p.cursor != "hidden" {
		t.Errorf("cursor = %q, want hidden", p.cursor)
	}
	session := start + back + menuFrame(1) + back + menuFrame(2) + back +
		"\x1b[32m✔\x1b[0m Pick a framework · Svelte\r\n\x1b[?25h$ "
	p = everyCut(t, 80, 24, session)
	if want := "$ npm create app\n✔ Pick a framework · Svelte\n$ "; p.text() != want {
		t.Errorf("done:\n got %q\nwant %q", p.text(), want)
	}
	if p.cursor == "hidden" {
		t.Errorf("cursor still hidden")
	}
}

func TestConPTYMenuRedraw(t *testing.T) {
	// ConPTY turns the program's cursor-up into jumps to absolute rows,
	// clears every row below, and leaves out moves of a hidden cursor
	// (from an OXIS_PTY_TRACE of the menu above).
	const rows = 12
	clear := "\x1b[2;1H" + strings.Repeat("\x1b[K\r\n", rows-2) + "\x1b[K\x1b[100C"
	session := "PS demo> node select.js\r\n\x1b[?25l" +
		"? Pick a framework\x1b[36m\r\n❯ React\x1b[m\r\n  Vue\r\n  Svelte" +
		clear + "\x1b[2;1H? Pick a framework\r\n  React\x1b[36m\r\n❯ Vue\x1b[m\r\n  Svelte" +
		clear + "\x1b[32m\x1b[2;1H✔ \x1b[mPick a framework · Vue\r\n\x1b[?25hPS demo> "
	p := everyCut(t, 100, rows, session)
	if want := "PS demo> node select.js\n✔ Pick a framework · Vue\nPS demo> "; p.text() != want {
		t.Errorf("got %q\nwant %q", p.text(), want)
	}
}

func TestProgressOnOneLine(t *testing.T) {
	p := everyCut(t, 80, 24, "Downloading 10%\rDownloading 55%\rDownloading 100%\r\n"+
		"⠋ working\r\x1b[K⠙ working\r\x1b[Kdone\r\n$ ")
	if want := "Downloading 100%\ndone\n$ "; p.text() != want {
		t.Errorf("got %q", p.text())
	}
}

func TestProgressBars(t *testing.T) {
	// Several bars, redrawn together (docker pull, cargo, pnpm).
	bars := func(a, b, c int) string {
		return fmt.Sprintf("\x1b[2Klayer a %d%%\r\n\x1b[2Klayer b %d%%\r\n\x1b[2Klayer c %d%%\r\n", a, b, c)
	}
	session := "$ pull\r\n" + bars(0, 0, 0) + "\x1b[3A" + bars(40, 10, 0) + "\x1b[3A" + bars(100, 70, 5) + "$ "
	p := everyCut(t, 80, 24, session)
	if want := "$ pull\nlayer a 100%\nlayer b 70%\nlayer c 5%\n$ "; p.text() != want {
		t.Errorf("got %q", p.text())
	}
}

func TestCellUpdates(t *testing.T) {
	// ConPTY sends only the cells that changed: a spinner in a task list.
	session := "task one  ⠋\r\ntask two  ⠋\r\n\x1b[1;11H⠙\x1b[2;11H✔\x1b[3;1H"
	p := everyCut(t, 80, 24, session)
	if want := "task one  ⠙\ntask two  ✔\n"; p.text() != want {
		t.Errorf("got %q", p.text())
	}
}

func TestLongLineStaysOneLine(t *testing.T) {
	p := everyCut(t, 10, 24, "0123456789abcdefghij-end\r\n$ ")
	if want := "0123456789abcdefghij-end\n$ "; p.text() != want {
		t.Errorf("got %q", p.text())
	}
	// Wide characters wrap early rather than split.
	p = everyCut(t, 5, 24, "abcd漢字\r\n")
	if want := "abcd漢字\n"; p.text() != want {
		t.Errorf("wide: got %q", p.text())
	}
}

// conptyWrapScroll is what ConPTY (50 columns, cursor on the bottom
// row) sent for a 123-character line followed by "after": at the wrap
// it scrolls, goes back to the last column of the row above and
// prints that character again.
const conptyWrapScroll = "3 \r\n" +
	"abcdefghi-abcdefghi-abcdefghi-abcdefghi-abcdefghi-abcdefghi-abcdefghi-abcdefghi-abcdefghi-abcdefghi-" +
	"\r\n\x1b[4;50H-abcdefghi-abcdefghi-END\r\nafter\r\n"

func TestConPTYWrapAtBottom(t *testing.T) {
	p := everyCut(t, 50, 5, "\r\n\r\n\r\n"+conptyWrapScroll)
	if want := "\n\n\n3\n" + strings.Repeat("abcdefghi-", 12) + "END\nafter\n"; p.text() != want {
		t.Errorf("got %q\nwant %q", p.text(), want)
	}
}

func TestColoursStandAlone(t *testing.T) {
	// A colour carries across lines until it's reset; each line the page
	// gets sets its own colours and resets them at the end.
	p := everyCut(t, 80, 24, "\x1b[31mred\r\nstill red\x1b[0m plain \x1b[1;38;5;208mx\x1b[38;2;1;2;3my\r\n")
	want := "\x1b[0;31mred\x1b[0m\n\x1b[0;31mstill red\x1b[0m plain \x1b[0;1;38;5;208mx\x1b[0;1;38;2;1;2;3my\x1b[0m\n"
	if p.styled() != want {
		t.Errorf("got %q\nwant %q", p.styled(), want)
	}
}

func TestClearKeepsHistory(t *testing.T) {
	// The line view keeps what was cleared, as history.
	p := everyCut(t, 80, 24, "one\r\ntwo\r\n$ clear\r\n\x1b[H\x1b[2J\x1b[3J$ ls\r\nfile\r\n$ ")
	if want := "one\ntwo\n$ clear\n$ ls\nfile\n$ "; p.text() != want {
		t.Errorf("got %q", p.text())
	}
}

func TestScrollingPastTheScreen(t *testing.T) {
	var b strings.Builder
	for i := 1; i <= 50; i++ {
		fmt.Fprintf(&b, "line %d\r\n", i)
	}
	b.WriteString("$ ")
	p := pump(t, 80, 5, nil, false, b.String())
	if len(p.lines) != 50 || p.lines[0] != "line 1" || p.lines[49] != "line 50" || p.partial != "$ " {
		t.Errorf("got %d lines, first %q, last %q, partial %q", len(p.lines), p.lines[0], p.lines[len(p.lines)-1], p.partial)
	}
}

func TestScrollRegionWithStatusLine(t *testing.T) {
	// apt keeps a progress line on the bottom row and scrolls the rest.
	var b strings.Builder
	b.WriteString("$ apt install x\r\n\x1b7\x1b[0;4r\x1b8\x1b[1A\x1b[1B")
	for i := 1; i <= 6; i++ {
		fmt.Fprintf(&b, "Unpacking %d\r\n\x1b7\x1b[5;0H\x1b[2KProgress: [%3d%%]\x1b8", i, i*10)
	}
	b.WriteString("\x1b7\x1b[0;5r\x1b8\x1b7\x1b[5;0H\x1b[2K\x1b8$ ")
	p := everyCut(t, 40, 5, b.String())
	want := "$ apt install x\nUnpacking 1\nUnpacking 2\nUnpacking 3\nUnpacking 4\nUnpacking 5\nUnpacking 6\n$ "
	if p.text() != want {
		t.Errorf("got %q\nwant %q", p.text(), want)
	}
}

func TestInvisibleMarkersKept(t *testing.T) {
	// OXIS's cwd and exit-status markers are zero-width characters.
	const answer = "\u2063OXISCWD\u2063C:\\demo\u2063OXISCWD\u2063"
	p := everyCut(t, 80, 24, answer+"\r\nPS demo> ")
	if want := answer + "\nPS demo> "; p.text() != want {
		t.Errorf("got %q", p.text())
	}
}

func TestResizeLaysOutTheCursorLine(t *testing.T) {
	p := &page{t: t}
	m := newLineScreen(20, 5, p.send)
	m.write(`PS C:\a\long\path> `)
	m.flush()
	m.setSize(10, 5)
	m.write("dir\r\nout\r\n")
	m.flush()
	if want := "PS C:\\a\\long\\path> dir\nout\n"; p.text() != want {
		t.Errorf("got %q", p.text())
	}
}

func TestFlood(t *testing.T) {
	var b strings.Builder
	const n = 100_000
	for i := 0; i < n; i++ {
		fmt.Fprintf(&b, "line %d: \x1b[32mok\x1b[0m some output text\r\n", i)
	}
	start := time.Now()
	p := pump(t, 120, 40, &RepaintGuard{}, true, b.String())
	t.Logf("%d lines (%d KB) in %v", n, b.Len()/1024, time.Since(start))
	if len(p.lines) != n || p.text()[:len("line 0: ok")] != "line 0: ok" {
		t.Fatalf("got %d lines", len(p.lines))
	}
}

// The random test's seed and length (longer runs use other values).
var (
	randomSeed   int64 = 1
	randomRounds       = 300
)

func TestRandomOutputKeepsThePageInStep(t *testing.T) {
	// Whatever a program does, after every flush the page's last lines
	// are what the screen says it sent, and those are the screen's lines
	// (rendering only what changed gives the same as rendering it all).
	rng := rand.New(rand.NewSource(randomSeed))
	ops := []func(m *lineScreen) string{
		func(*lineScreen) string { return "word" + strconv.Itoa(rng.Intn(100)) + " " },
		func(*lineScreen) string { return strings.Repeat("w", rng.Intn(40)) },
		func(*lineScreen) string { return "\r\n" },
		func(*lineScreen) string { return "\r\n" },
		func(*lineScreen) string { return "\r" },
		func(*lineScreen) string { return "\b\t漢" },
		func(*lineScreen) string { return "\x1b[31mred\x1b[0m" },
		func(*lineScreen) string { return fmt.Sprintf("\x1b[%dA", rng.Intn(4)+1) },
		func(*lineScreen) string { return fmt.Sprintf("\x1b[%dB", rng.Intn(4)+1) },
		func(*lineScreen) string { return fmt.Sprintf("\x1b[%d;%dH", rng.Intn(10)+1, rng.Intn(20)+1) },
		func(*lineScreen) string {
			return []string{"\x1b[K", "\x1b[1K", "\x1b[2K", "\x1b[J", "\x1b[1J", "\x1b[3X"}[rng.Intn(6)]
		},
		func(*lineScreen) string {
			return []string{"\x1b[L", "\x1b[2M", "\x1b[S", "\x1b[T", "\x1bM", "\x1b[2P", "\x1b[@"}[rng.Intn(7)]
		},
		func(*lineScreen) string {
			return []string{"\x1b[2;6r", "\x1b[r", "\x1b7", "\x1b8", "\x1b[?7l", "\x1b[?7h"}[rng.Intn(6)]
		},
		func(*lineScreen) string {
			if rng.Intn(8) == 0 {
				return "\x1b[2J"
			}
			return ""
		},
		func(m *lineScreen) string {
			if rng.Intn(6) == 0 {
				m.setSize(8+rng.Intn(20), 4+rng.Intn(8))
			}
			return ""
		},
		func(m *lineScreen) string {
			if rng.Intn(6) == 0 {
				// A repaint: our rows, maybe moved, maybe not quite ours.
				s := newLineScreen(m.cols, m.rows, func(string, string) {})
				off := rng.Intn(5) - 2
				for y := 0; y < m.rows; y++ {
					if sy := y + off; sy >= 0 && sy < m.rows {
						s.write(fmt.Sprintf("\x1b[%d;1H%s", sy+1, rowText(m.row(y))))
					}
				}
				if rng.Intn(4) == 0 {
					s.write("\x1b[1;1Hdifferent")
				}
				s.write(fmt.Sprintf("\x1b[%d;%dH", rng.Intn(m.rows)+1, rng.Intn(m.cols)+1))
				m.rebase(s, rng.Intn(2) == 0)
			}
			return ""
		},
	}
	for round := 0; round < randomRounds; round++ {
		p := &page{t: t}
		m := newLineScreen(16, 8, p.send)
		var log strings.Builder
		for step := 0; step < 150; step++ {
			s := ops[rng.Intn(len(ops))](m)
			fmt.Fprintf(&log, "%q ", s)
			m.write(s)
			if rng.Intn(3) == 0 {
				m.flush()
				checkInStep(t, p, m, log.String())
			}
		}
		m.flush()
		checkInStep(t, p, m, log.String())
	}
}

func checkInStep(t *testing.T, p *page, m *lineScreen, log string) {
	t.Helper()
	if full := m.render(m.shownRow(), m.floor, 0); len(full) != len(m.sent) {
		t.Fatalf("%d lines sent, %d on the screen\nafter %s", len(m.sent), len(full), log)
	} else {
		for i := range full {
			if !cellsEqual(full[i], m.sent[i]) {
				t.Fatalf("line %d sent as %q, is %q\nafter %s", i, cellText(m.sent[i]), cellText(full[i]), log)
			}
		}
	}
	all := append(append([]string{}, p.lines...), p.partial)
	if len(all) < len(m.sent) {
		t.Fatalf("page has %d lines, screen sent %d\nafter %s", len(all), len(m.sent), log)
	}
	tail := all[len(all)-len(m.sent):]
	for i, l := range m.sent {
		if got := sgrTestRe.ReplaceAllString(tail[i], ""); got != cellText(l) {
			t.Fatalf("page line %q, sent %q\nafter %s", got, cellText(l), log)
		}
	}
}

func cellText(cells []cell) string {
	var b strings.Builder
	writeCells(&b, cells)
	return sgrTestRe.ReplaceAllString(b.String(), "")
}

// TestScreensMatchXterm plays random output (cursor moves, erases,
// scrolling regions, inserts and deletes, wide characters, wrapping)
// and checks the screen against what xterm.js shows for it, recorded in
// testdata/xterm_screens.json ($OXIS_XTERM_SCREENS for another file).
func TestScreensMatchXterm(t *testing.T) {
	path := os.Getenv("OXIS_XTERM_SCREENS")
	if path == "" {
		path = "testdata/xterm_screens.json"
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Cols, Rows int
		Stream     string
		Screen     struct {
			Rows    []string
			Wrapped []bool
			X, Y    int
		}
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	failed := 0
	for i, c := range cases {
		m := newLineScreen(c.Cols, c.Rows, func(string, string) {})
		m.write(c.Stream)
		x := m.x
		if m.wrapNext {
			x = m.cols // xterm.js's way of saying the next character wraps
		}
		var diffs []string
		if x != c.Screen.X || m.y != c.Screen.Y {
			diffs = append(diffs, fmt.Sprintf("cursor %d,%d, xterm.js %d,%d", x, m.y, c.Screen.X, c.Screen.Y))
		}
		for y := 0; y < c.Rows; y++ {
			r := m.row(y)
			if got := strings.TrimRight(cellText(r.cells), " "); got != c.Screen.Rows[y] {
				diffs = append(diffs, fmt.Sprintf("row %d %q, xterm.js %q", y, got, c.Screen.Rows[y]))
			} else if r.cont != c.Screen.Wrapped[y] {
				diffs = append(diffs, fmt.Sprintf("row %d continued %v, xterm.js %v", y, r.cont, c.Screen.Wrapped[y]))
			}
		}
		if len(diffs) > 0 {
			if failed++; failed <= 5 {
				t.Errorf("case %d (%dx%d) %q:\n  %s", i, c.Cols, c.Rows, c.Stream, strings.Join(diffs, "\n  "))
			}
		}
	}
	if failed > 0 {
		t.Errorf("%d of %d screens differ", failed, len(cases))
	}
}
