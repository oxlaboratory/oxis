package pty

import (
	"regexp"
	"strings"
	"testing"
)

// OSC 8 hyperlinks reach the page around the text they link, survive a
// colour reset inside them, and end where the program ends them.
func TestHyperlinks(t *testing.T) {
	in := "see \x1b]8;;https://oxis.space\x07\x1b[1moxis\x1b[0m.space\x1b]8;;\x07 now\r\n" +
		"\x1b]8;id=1;file:///C:/dev/a.ts\x1b\\a.ts\x1b]8;;\x1b\\\r\n$ "
	p := pump(t, 80, 24, &RepaintGuard{}, true, in)
	got := p.styled()
	for _, want := range []string{
		"\x1b]8;;https://oxis.space\x1b\\",
		"\x1b]8;;file:///C:/dev/a.ts\x1b\\",
		".space\x1b]8;;\x1b\\",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in %q", want, got)
		}
	}
	// The link spans "oxis.space": the reset after "oxis" didn't end it.
	i := strings.Index(got, "https://oxis.space\x1b\\")
	j := strings.Index(got, ".space\x1b]8;;\x1b\\") + len(".space")
	if i < 0 || j < i || !strings.Contains(got[i:j], ".space") {
		t.Errorf("link doesn't cover oxis.space: %q", got)
	}
	if text := linkTestRe.ReplaceAllString(p.text(), ""); !strings.HasPrefix(text, "see oxis.space now\na.ts\n") {
		t.Errorf("text %q", text)
	}
}

var linkTestRe = regexp.MustCompile(`\x1b\]8;[^\x1b]*\x1b\\`)
