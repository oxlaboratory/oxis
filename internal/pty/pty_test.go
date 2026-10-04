package pty

import (
	"io"
	"os"
	"slices"
	"strings"
	"testing"
	"time"
)

// TestMain gives the output pump long timeouts: most tests here feed it
// output instantly and check how it's parsed, which mustn't depend on
// the machine keeping up (a busy CI runner can stall a goroutine for
// longer than repaintQuiet). Tests of the timeouts use realTimers.
func TestMain(m *testing.M) {
	heldFlushDelay, repaintQuiet, repaintWait = 5*time.Second, 5*time.Second, time.Minute
	os.Exit(m.Run())
}

// realTimers puts the pump's real timeouts back for one test.
func realTimers(t *testing.T) {
	held, quiet, wait := heldFlushDelay, repaintQuiet, repaintWait
	heldFlushDelay, repaintQuiet, repaintWait = 30*time.Millisecond, 20*time.Millisecond, 250*time.Millisecond
	t.Cleanup(func() { heldFlushDelay, repaintQuiet, repaintWait = held, quiet, wait })
}

func TestSplitIncompleteUTF8(t *testing.T) {
	emoji := []byte("hi 🎉")
	for cut := len(emoji) - 3; cut < len(emoji); cut++ {
		complete, pending := splitIncompleteUTF8(emoji[:cut])
		if string(complete) != "hi " {
			t.Errorf("cut %d: complete = %q", cut, complete)
		}
		if string(append(append([]byte{}, pending...), emoji[cut:]...)) != "🎉" {
			t.Errorf("cut %d: pending %q doesn't rejoin", cut, pending)
		}
	}
	if c, p := splitIncompleteUTF8(emoji); string(c) != "hi 🎉" || p != nil {
		t.Errorf("full input split as %q / %q", c, p)
	}
}

// chunkReader hands out its chunks one per Read (a long one over
// several).
type chunkReader struct{ chunks []string }

func (r *chunkReader) Read(p []byte) (int, error) {
	if len(r.chunks) == 0 {
		return 0, io.EOF
	}
	n := copy(p, r.chunks[0])
	if r.chunks[0] = r.chunks[0][n:]; r.chunks[0] == "" {
		r.chunks = r.chunks[1:]
	}
	return n, nil
}

func TestShellEnvDisablesPagers(t *testing.T) {
	t.Setenv("GIT_PAGER", "less -R")
	t.Setenv("OXIS_TEST_KEEP", "1")
	got := map[string][]string{}
	for _, kv := range shellEnv("TERM=xterm-256color") {
		k, v, _ := strings.Cut(kv, "=")
		got[strings.ToUpper(k)] = append(got[strings.ToUpper(k)], v)
	}
	for k, want := range map[string]string{"PAGER": "cat", "GIT_PAGER": "cat", "TERM": "xterm-256color", "OXIS_TEST_KEEP": "1"} {
		if v := got[k]; len(v) != 1 || v[0] != want {
			t.Errorf("%s = %q, want exactly [%q]", k, v, want)
		}
	}
}

func TestShellKind(t *testing.T) {
	cases := map[string]string{
		`"C:\Program Files\PowerShell\7\pwsh.exe" -NoLogo -NoExit`:                               "pwsh",
		`"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoExit -Command x`: "powershell",
		"cmd.exe": "cmd",
		"bash":    "bash",
		"zsh":     "zsh",
		"fish":    "fish",
		"dash":    "sh",
	}
	for in, want := range cases {
		if got := shellKind(in); got != want {
			t.Errorf("shellKind(%q) = %q, want %q", in, got, want)
		}
	}
}

// What ConPTY sent around a full-screen program (from an OXIS_PTY_TRACE
// of one): the command's echo, the alternate screen with a drawing,
// leaving it, the repaint of the main screen, then the next prompt.
const fullScreenSession = "PS demo> node tui.js\r\n" +
	"\x1b[?1049h\x1b[?25l\x1b[H\x1b[K\r\n\x1b[2;4H\x1b[32mTUI\x1b[m\x1b[K\x1b[?25h" +
	"\x1b[?1049l\x1b[?25l\x1b[HPS demo> node tui.js\x1b[K\r\n\x1b[K\r\n\x1b[K\x1b[2;1H\x1b[?25h" +
	"PS demo> "

func TestFullScreenPrograms(t *testing.T) {
	for cut := 1; cut < len(fullScreenSession); cut++ {
		p := pump(t, 80, 24, &RepaintGuard{}, true, fullScreenSession[:cut], fullScreenSession[cut:])
		want := []string{
			"screen-start:",
			"screen:\x1b[?1049h\x1b[?25l\x1b[H\x1b[K\r\n\x1b[2;4H\x1b[32mTUI\x1b[m\x1b[K\x1b[?25h\x1b[?1049l",
			"screen-end:",
		}
		if got := p.screenMessages(); strings.Join(got, "|") != strings.Join(want, "|") {
			t.Errorf("cut %d: screen got %q\nwant %q", cut, got, want)
		}
		if got := p.text(); got != "PS demo> node tui.js\nPS demo> " {
			t.Errorf("cut %d: line view got %q", cut, got)
		}
	}
}

func TestFullScreenWithoutRepaint(t *testing.T) {
	// A real PTY (Linux, macOS) doesn't repaint: what follows is new.
	p := pump(t, 80, 24, nil, false, "\x1b[?1049hdraw\x1b[?1049l", "$ ")
	if p.text() != "$ " {
		t.Errorf("got %q", p.text())
	}
}

func TestRepaintAfterExitAndResize(t *testing.T) {
	// Leaving the program repaints once; the terminal going back to its
	// own size repaints again (from a trace). Neither may show twice.
	session := "PS demo> old line\r\n\x1b[?1049hdraw\x1b[?1049l" +
		"\x1b[?25l\x1b[HPS demo> old line\x1b[K\r\n\x1b[K\x1b[2;1H\x1b[?25h" +
		"\x1b[?25l\x1b[HPS demo> old line\x1b[K\r\n\x1b[K\x1b[2;1H\x1b[?25h" +
		"PS demo> "
	for cut := 1; cut < len(session); cut++ {
		p := pump(t, 80, 24, &RepaintGuard{}, true, session[:cut], session[cut:])
		if got := p.text(); got != "PS demo> old line\nPS demo> " {
			t.Errorf("cut %d: line view got %q", cut, got)
		}
	}
}

func TestRepaintAfterResize(t *testing.T) {
	var guard RepaintGuard
	guard.Arm() // the window was just resized
	p := pump(t, 80, 24, &guard, true, "PS demo> ",
		"\x1b[?25l\x1b[HPS demo> \x1b[K\r\n\x1b[K\x1b[1;10H\x1b[?25h", "dir\r\nnew output\r\n")
	if got := p.text(); got != "PS demo> dir\nnew output\n" {
		t.Errorf("got %q", got)
	}

	// Without a resize, the same bytes are ordinary output.
	p = pump(t, 80, 24, &RepaintGuard{}, true, "\x1b[Hhello\r\n")
	if got := p.text(); got != "hello\n" {
		t.Errorf("unarmed: got %q", got)
	}
}

func TestRepaintWithSizeReport(t *testing.T) {
	// From a trace: ConPTY reports the new size before repainting.
	repaint := "\x1b[?25l\x1b[8;29;62t\x1b[HPS demo> 1..2\x1b[K\r\nbefore 1\x1b[K\r\nbefore 2\x1b[K\r\n" +
		"PS demo>\x1b[K\r\n\x1b[K\r\n\x1b[K\x1b[4;10H\x1b[?25h"
	for cut := 1; cut < len(repaint); cut++ {
		var guard RepaintGuard
		guard.Arm()
		p := pump(t, 62, 29, &guard, true, "PS demo> 1..2\r\nbefore 1\r\nbefore 2\r\nPS demo> ",
			repaint[:cut], repaint[cut:], "\"after\"\r\nafter\r\n")
		if got, want := p.text(), "PS demo> 1..2\nbefore 1\nbefore 2\nPS demo> \"after\"\nafter\n"; got != want {
			t.Fatalf("cut %d: got %q\nwant %q", cut, got, want)
		}
	}
}

func TestRepaintAfterInputModeSwitches(t *testing.T) {
	// From a trace: when Git Bash's console is set up again, ConPTY
	// switches input modes before it repaints. The repaint mustn't show
	// the old screen again (after 'clear, that's output the page hid).
	repaint := "\x1b[?9001h\x1b[?1004h\x1b[?2004h\x1b[?25l\x1b[Hold line\x1b[K\r\nacme $\x1b[K\r\n\x1b[K\x1b[2;8H\x1b[?25h"
	for cut := 1; cut < len(repaint); cut++ {
		var guard RepaintGuard
		guard.Arm()
		// Played as output, the repaint would take lines back (a rewind)
		// and send them again, bringing back what the page had cleared.
		var sent []string
		p := &page{t: t}
		send := func(kind, data string) { sent = append(sent, kind); p.send(kind, data) }
		chunks := []string{"old line\r\nacme $ ", repaint[:cut], repaint[cut:], "ls\r\nfile\r\n"}
		if err := pumpOutput(&chunkReader{chunks: chunks}, newTermSize(80, 24), send, &guard, true); err != io.EOF {
			t.Fatalf("pumpOutput: %v", err)
		}
		if got, want := p.text(), "old line\nacme $ ls\nfile\n"; got != want {
			t.Fatalf("cut %d: got %q\nwant %q", cut, got, want)
		}
		if slices.Contains(sent, kindRewind) {
			t.Fatalf("cut %d: the repaint was sent as output (%v)", cut, sent)
		}
	}
}

func TestLosesKeyAfterResize(t *testing.T) {
	for cmd, want := range map[string]bool{
		`"C:\Program Files\Git\bin\bash.exe" -i`:                         true,
		`C:\msys64\usr\bin\zsh.exe`:                                     true,
		`fish`:                                                          true,
		`"C:\Program Files\PowerShell\7\pwsh.exe" -NoLogo`:               false,
		`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoExit`: false,
		`cmd.exe`: false,
	} {
		if got := losesKeyAfterResize(cmd); got != want {
			t.Errorf("%s: got %v, want %v", cmd, got, want)
		}
	}
	// The tap is two complete win32-input-mode key events (Shift down, up).
	if !strings.HasPrefix(shiftTap, "\x1b[16;42;0;1;") || strings.Count(shiftTap, "_") != 2 {
		t.Errorf("shiftTap = %q", shiftTap)
	}
}

func TestLoneEscapeIsAKeyEvent(t *testing.T) {
	if got := consoleInput("\x1b"); got != escKey {
		t.Errorf("lone ESC: got %q", got)
	}
	// Alt+x, arrows and pastes are complete sequences: left alone.
	for _, in := range []string{"\x1bx", "\x1b[A", "a", ":wq\r", "\x1b\x1b"} {
		if got := consoleInput(in); got != in {
			t.Errorf("%q changed to %q", in, got)
		}
	}
}

func TestRepaintEndingWithoutACursorJump(t *testing.T) {
	// From a trace: the cursor was already on the right row, so the
	// repaint ends by moving it right and showing it. What follows (the
	// echo of the next command) is output, not repaint.
	for _, split := range []bool{false, true} {
		var guard RepaintGuard
		guard.Arm()
		repaint := "\x1b[?25l\x1b[HPS demo> old\x1b[K\r\nPS demo>\x1b[K\x1b[1C\x1b[?25h"
		chunks := []string{"PS demo> old\r\nPS demo> ", repaint, `"x"`, "\r\nx\r\nPS demo> "}
		if split {
			chunks = []string{"PS demo> old\r\nPS demo> ", repaint + `"x"`, "\r\nx\r\nPS demo> "}
		}
		p := pump(t, 62, 29, &guard, true, chunks...)
		if got, want := p.text(), "PS demo> old\nPS demo> \"x\"\nx\nPS demo> "; got != want {
			t.Errorf("split %v: got %q\nwant %q", split, got, want)
		}
	}
}

// slowReader is a chunkReader that waits before each chunk.
type slowReader struct {
	chunkReader
	wait time.Duration
}

func (r *slowReader) Read(p []byte) (int, error) {
	time.Sleep(r.wait)
	return r.chunkReader.Read(p)
}

func TestRepaintWithTheCursorHidden(t *testing.T) {
	// A menu hid the cursor, so the repaint doesn't end by showing it:
	// it ends when the output stops.
	realTimers(t)
	var guard RepaintGuard
	guard.Arm()
	p := &page{t: t}
	r := &slowReader{chunkReader{chunks: []string{
		"? Pick\r\n❯ one\r\n  two",
		"\x1b[?25l\x1b[H? Pick\x1b[K\r\n❯ one\x1b[K\r\n  two\x1b[K",
		"\x1b[1;1H\x1b[K\r\n\x1b[K\r\n\x1b[K\x1b[1;1H? Pick\r\n  one\r\n❯ two",
	}}, 3 * repaintQuiet}
	_ = pumpOutput(r, newTermSize(40, 10), p.send, &guard, true)
	if got, want := p.text(), "? Pick\n  one\n❯ two"; got != want {
		t.Errorf("got %q\nwant %q", got, want)
	}
}

// stepReader hands out its chunks one per Read, first running the step
// that goes with each (a resize, say) and waiting a little.
type stepReader struct {
	chunks []string
	steps  map[int]func()
	n      int
}

func (r *stepReader) Read(p []byte) (int, error) {
	time.Sleep(3 * repaintQuiet)
	if r.n == len(r.chunks) {
		return 0, io.EOF
	}
	if step := r.steps[r.n]; step != nil {
		step()
	}
	r.n++
	return copy(p, r.chunks[r.n-1]), nil
}

func TestResizeWhileAMenuIsUp(t *testing.T) {
	// The window narrows while a menu (cursor hidden) waits for a key:
	// ConPTY repaints, then the program redraws the menu. It must replace
	// the menu, not add a second one.
	realTimers(t)
	var guard RepaintGuard
	size := newTermSize(80, 10)
	p := &page{t: t}
	r := &stepReader{chunks: []string{
		"$ node select.js\r\n\x1b[?25l? Pick\r\n❯ one\r\n  two",
		"\x1b[H$ node select.js\x1b[K\r\n? Pick\x1b[K\r\n❯ one\x1b[K\r\n  two\x1b[K\r\n\x1b[K\r\n\x1b[K\r\n\x1b[K\r\n\x1b[K\r\n\x1b[K\r\n\x1b[K",
		"\x1b[2;1H\x1b[K\r\n\x1b[K\r\n\x1b[K\x1b[2;1H? Pick\r\n  one\r\n❯ two",
		"\x1b[2;1H\x1b[K\r\n\x1b[K\r\n\x1b[K\x1b[2;1H✔ Pick · two\r\n\x1b[?25h$ ",
	}, steps: map[int]func(){1: func() { size.set(40, 10); guard.Arm() }}}
	_ = pumpOutput(r, size, p.send, &guard, true)
	if got, want := p.text(), "$ node select.js\n✔ Pick · two\n$ "; got != want {
		t.Errorf("got %q\nwant %q", got, want)
	}
}

func TestLeaveScreenByHand(t *testing.T) {
	// A program went full screen and died without switching back; the
	// user leaves the view, and the shell's next output is lines again.
	var guard RepaintGuard
	p := &page{t: t}
	sp := &screenSplitter{size: newTermSize(80, 24), send: p.send, guard: &guard}
	sp.write("\x1b[?1049hcrashed")
	guard.LeaveScreen()
	sp.write("PS demo> ")
	want := "screen-start:|screen:\x1b[?1049hcrashed|screen-end:"
	if got := strings.Join(p.screenMessages(), "|"); got != want {
		t.Errorf("got %q", got)
	}
	if p.text() != "PS demo> " {
		t.Errorf("line view got %q", p.text())
	}
}
