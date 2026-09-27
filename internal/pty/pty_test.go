package pty

import (
	"io"
	"strings"
	"testing"
)

func TestStripCtrl(t *testing.T) {
	cases := map[string]string{
		// Colours and styles survive; everything else goes.
		"\x1b[32mgreen\x1b[0m":               "\x1b[32mgreen\x1b[0m",
		"\x1b[1;38;5;208mx\x1b[m":            "\x1b[1;38;5;208mx\x1b[m",
		"\x1b[38:2::255:0:0mrgb":             "\x1b[38:2::255:0:0mrgb",
		"\x1b[?25l\x1b[?4mhidden":            "hidden",
		"\x1b]0;title\x07prompt> ":           "prompt> ",
		"Directory\x1b[9;1HMode\x1b[45X\r\n": "Directory\nMode\r\n",
		"\x1b[?25l\x1b[2J\x1b[m\x1b[HPS> ":   "\x1b[mPS> ",
		// npm's spinner on Windows, then its erase before the prompt.
		"done\r\n\\\r\x1b[KPS> ": "done\r\n\\\r\x1aPS> ",
		// Node readline on Linux: column 1, then erase.
		"50%\x1b[1G\x1b[0K100%": "50%\r\x1a100%",
		"a\x1b[2Kb":             "a\r\x1ab",
		// Cursor-forward draws blank cells.
		"PS C:\\>\x1b[1Cgit": "PS C:\\> git",
		"a\x1b[3Cb\x1b[Cc":   "a   b c",
		// Erase-to-end after text (not at column 1) erases nothing visible.
		"text\x1b[K\r\n": "text\r\n",
	}
	for in, want := range cases {
		if got := stripCtrl(in); got != want {
			t.Errorf("stripCtrl(%q) = %q, want %q", in, got, want)
		}
	}
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

// conptyWrapScroll is what ConPTY (50 columns, cursor on the bottom
// row) sent for a 123-character line followed by "after".
const conptyWrapScroll = "3 \r\n" +
	"abcdefghi-abcdefghi-abcdefghi-abcdefghi-abcdefghi-abcdefghi-abcdefghi-abcdefghi-abcdefghi-abcdefghi-" +
	"\r\n\x1b[4;50H-abcdefghi-abcdefghi-END\r\nafter\r\n"

var conptyWrapScrollWant = "3 \r\n" + strings.Repeat("abcdefghi-", 12) + "END\r\nafter\r\n"

func TestJoinWrappedRows(t *testing.T) {
	if got := stripCtrl(joinWrappedRows(conptyWrapScroll, 50)); got != conptyWrapScrollWant {
		t.Errorf("got %q", got)
	}
	// Colour codes between the jump and the repeated character survive.
	if got := joinWrappedRows("ab\r\n\x1b[4;10H\x1b[32mbcd", 10); got != "ab\x1b[32mcd" {
		t.Errorf("with colour: got %q", got)
	}
	// Jumps to other columns aren't wrapped rows.
	for _, s := range []string{"ab\r\n\x1b[4;5Hxy", "ab\r\n\x1b[4;1Hxy"} {
		if got := joinWrappedRows(s, 50); got != s {
			t.Errorf("joinWrappedRows(%q) = %q, want it unchanged", s, got)
		}
	}
}

// chunkReader hands out its chunks one per Read.
type chunkReader struct{ chunks []string }

func (r *chunkReader) Read(p []byte) (int, error) {
	if len(r.chunks) == 0 {
		return 0, io.EOF
	}
	n := copy(p, r.chunks[0])
	r.chunks = r.chunks[1:]
	return n, nil
}

func TestPumpOutputJoinsAcrossReads(t *testing.T) {
	// Cut the stream at every point: the result must not depend on
	// where the reads end.
	for cut := 1; cut < len(conptyWrapScroll); cut++ {
		var out strings.Builder
		r := &chunkReader{chunks: []string{conptyWrapScroll[:cut], conptyWrapScroll[cut:]}}
		if err := pumpOutput(r, func() int { return 50 }, func(_, s string) { out.WriteString(s) }, &RepaintGuard{}, true); err != io.EOF {
			t.Fatalf("cut %d: err = %v", cut, err)
		}
		if out.String() != conptyWrapScrollWant {
			t.Errorf("cut %d: got %q", cut, out.String())
		}
	}
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
		var got []string
		r := &chunkReader{chunks: []string{fullScreenSession[:cut], fullScreenSession[cut:]}}
		err := pumpOutput(r, func() int { return 80 }, func(kind, s string) {
			// Consecutive pieces of one kind are one message for this test.
			if n := len(got); n > 0 && strings.HasPrefix(got[n-1], kind+":") && kind != kindScreenStart && kind != kindScreenEnd {
				got[n-1] += s
				return
			}
			got = append(got, kind+":"+s)
		}, &RepaintGuard{}, true)
		if err != io.EOF {
			t.Fatalf("cut %d: %v", cut, err)
		}
		want := []string{
			"output:PS demo> node tui.js\r\n",
			"screen-start:",
			"screen:\x1b[?1049h\x1b[?25l\x1b[H\x1b[K\r\n\x1b[2;4H\x1b[32mTUI\x1b[m\x1b[K\x1b[?25h\x1b[?1049l",
			"screen-end:",
			"output:PS demo> ",
		}
		if strings.Join(got, "|") != strings.Join(want, "|") {
			t.Errorf("cut %d:\n got %q\nwant %q", cut, got, want)
		}
	}
}

func TestFullScreenWithoutRepaint(t *testing.T) {
	// A real PTY (Linux, macOS) doesn't repaint: what follows is new.
	var out strings.Builder
	r := &chunkReader{chunks: []string{"\x1b[?1049hdraw\x1b[?1049l", "$ "}}
	_ = pumpOutput(r, func() int { return 0 }, func(kind, s string) {
		if kind == kindOutput {
			out.WriteString(s)
		}
	}, nil, false)
	if out.String() != "$ " {
		t.Errorf("got %q", out.String())
	}
}

func TestRepaintAfterExitAndResize(t *testing.T) {
	// Leaving the program repaints once; the terminal going back to its
	// own size repaints again (from a trace). Neither may show twice.
	session := "\x1b[?1049hdraw\x1b[?1049l" +
		"\x1b[?25l\x1b[HPS demo> old line\x1b[K\r\n\x1b[K\x1b[2;1H\x1b[?25h" +
		"\x1b[?25l\x1b[HPS demo> old line\x1b[K\r\n\x1b[K\x1b[2;1H\x1b[?25h" +
		"PS demo> "
	for cut := 1; cut < len(session); cut++ {
		var out strings.Builder
		r := &chunkReader{chunks: []string{session[:cut], session[cut:]}}
		_ = pumpOutput(r, func() int { return 80 }, func(kind, s string) {
			if kind == kindOutput {
				out.WriteString(s)
			}
		}, &RepaintGuard{}, true)
		if out.String() != "PS demo> " {
			t.Errorf("cut %d: line view got %q", cut, out.String())
		}
	}
}

func TestRepaintAfterResize(t *testing.T) {
	var guard RepaintGuard
	guard.Arm() // the window was just resized
	var out strings.Builder
	r := &chunkReader{chunks: []string{"\x1b[?25l\x1b[Hold\x1b[K\r\n\x1b[3;9H\x1b[?25h", "new output\r\n"}}
	_ = pumpOutput(r, func() int { return 80 }, func(kind, s string) { out.WriteString(s) }, &guard, true)
	if out.String() != "new output\r\n" {
		t.Errorf("got %q", out.String())
	}

	// Without a resize, the same bytes are ordinary output.
	out.Reset()
	r = &chunkReader{chunks: []string{"\x1b[Hhello\r\n"}}
	_ = pumpOutput(r, func() int { return 80 }, func(kind, s string) { out.WriteString(s) }, &RepaintGuard{}, true)
	if out.String() != "hello\r\n" {
		t.Errorf("unarmed: got %q", out.String())
	}
}

func TestLeaveScreenByHand(t *testing.T) {
	// A program went full screen and died without switching back; the
	// user leaves the view, and the shell's next output is lines again.
	var guard RepaintGuard
	var got []string
	send := func(kind, s string) { got = append(got, kind+":"+s) }
	sp := &screenSplitter{cols: func() int { return 80 }, send: send, guard: &guard}
	sp.write("\x1b[?1049hcrashed")
	guard.LeaveScreen()
	sp.write("PS demo> ")
	want := "screen-start:|screen:\x1b[?1049hcrashed|screen-end:|output:PS demo> "
	if strings.Join(got, "|") != want {
		t.Errorf("got %q", got)
	}
}
