package pty

import (
	"io"
	"strings"
	"testing"
)

func TestStripCtrl(t *testing.T) {
	cases := map[string]string{
		"\x1b[32mgreen\x1b[0m":               "green",
		"\x1b]0;title\x07prompt> ":           "prompt> ",
		"Directory\x1b[9;1HMode\x1b[45X\r\n": "Directory\nMode\r\n",
		"\x1b[?25l\x1b[2J\x1b[m\x1b[HPS> ":   "PS> ",
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
		if err := pumpOutput(r, func() int { return 50 }, func(s string) { out.WriteString(s) }); err != io.EOF {
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
