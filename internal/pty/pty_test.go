package pty

import "testing"

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
