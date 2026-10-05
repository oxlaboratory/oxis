package pty

import (
	"io"
	"strings"
	"testing"
)

func marksOf(t *testing.T, chunks ...string) []string {
	t.Helper()
	var marks []string
	send := func(kind, data string) {
		if kind == kindMark {
			marks = append(marks, data)
		}
	}
	if err := pumpOutput(&chunkReader{chunks: chunks}, newTermSize(80, 24), send, &RepaintGuard{}, true); err != io.EOF {
		t.Fatal(err)
	}
	return marks
}

// An inline image reaches the page whole, however it's split up and
// whichever way it ends; one sent as a download doesn't.
func TestInlineImages(t *testing.T) {
	img := strings.Repeat("iVBORw0KGgo", 3000) // ~33 KB of base64
	seq := "\x1b]1337;File=name=YS5wbmc=;inline=1;width=20:" + img
	for name, chunks := range map[string][]string{
		"one write, BEL":   {"a" + seq + "\x07b\r\n"},
		"many writes, ST":  {"a" + seq[:5000], seq[5000:20000], seq[20000:] + "\x1b\\b\r\n"},
		"ST split at ESC":  {"a" + seq + "\x1b", "\\b\r\n"},
		"tiny first write": {"a\x1b]13", "37;File=inline=1:" + img + "\x07b\r\n"},
	} {
		marks := marksOf(t, chunks...)
		if len(marks) != 1 || !strings.HasPrefix(marks[0], "1337;") || !strings.HasSuffix(marks[0], img) {
			t.Errorf("%s: %d marks", name, len(marks))
		}
	}
	if m := marksOf(t, "\x1b]1337;File=name=eC56aXA=;size=3:"+img+"\x07\r\n"); len(m) != 0 {
		t.Errorf("a download (no inline=1) shouldn't show: %d marks", len(m))
	}
}

// A clipboard write bigger than 4 KB, in several writes, still copies.
func TestBigClipboardWrite(t *testing.T) {
	data := strings.Repeat("aGVsbG8g", 2000) // 16 KB
	seq := "\x1b]52;c;" + data + "\x07"
	marks := marksOf(t, seq[:3000], seq[3000:9000], seq[9000:]+"x\r\n")
	if len(marks) != 1 || marks[0] != "52;"+data {
		t.Errorf("marks: %d", len(marks))
	}
}
