package pty

import (
	"io"
	"testing"
)

// OSC 52 writes reach the page as a mark; a query ("?") never does.
func TestClipboardWrites(t *testing.T) {
	var marks []string
	send := func(kind, data string) {
		if kind == kindMark {
			marks = append(marks, data)
		}
	}
	in := "a\x1b]52;c;aGVsbG8=\x07b\x1b]52;c;?\x07c\r\n"
	if err := pumpOutput(&chunkReader{chunks: []string{in}}, newTermSize(80, 24), send, &RepaintGuard{}, true); err != io.EOF {
		t.Fatal(err)
	}
	if len(marks) != 1 || marks[0] != "52;aGVsbG8=" {
		t.Errorf("marks %q", marks)
	}
}
