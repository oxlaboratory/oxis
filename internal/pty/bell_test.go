package pty

import (
	"io"
	"testing"
)

// A BEL on its own reaches the page as a "bell" mark; one ending an OSC
// doesn't.
func TestBell(t *testing.T) {
	var marks []string
	send := func(kind, data string) {
		if kind == kindMark {
			marks = append(marks, data)
		}
	}
	in := "done\x07\x1b]0;title\x07x\r\n"
	if err := pumpOutput(&chunkReader{chunks: []string{in}}, newTermSize(80, 24), send, &RepaintGuard{}, true); err != io.EOF {
		t.Fatal(err)
	}
	if len(marks) != 1 || marks[0] != "bell" {
		t.Errorf("marks %q", marks)
	}
}
