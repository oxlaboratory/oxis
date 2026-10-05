package pty

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestRecordCast(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", "demo.cast")
	var rec recorder
	if err := rec.Start(path, 100, 30, "bash"); err != nil {
		t.Fatal(err)
	}
	if err := rec.Start(path, 100, 30, ""); err == nil {
		t.Error("a second Start while recording should fail")
	}
	check := []byte("✓ ok") // ✓ is 3 bytes
	rec.Output([]byte("$ ls\r\n"))
	rec.Output(check[:2]) // half of ✓: held back
	rec.Output(check[2:]) // the rest
	rec.Resize(80, 24)
	if _, secs, n, err := rec.Stop(); err != nil || secs < 0 || n == 0 {
		t.Fatalf("stop: %v %v %v", secs, n, err)
	}
	if _, _, _, err := rec.Stop(); err == nil {
		t.Error("a second Stop should say it wasn't recording")
	}

	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Scan()
	var h castHeader
	if err := json.Unmarshal(sc.Bytes(), &h); err != nil || h.Version != 2 || h.Width != 100 || h.Height != 30 || h.Title != "bash" {
		t.Fatalf("header %+v %v", h, err)
	}
	var events [][]any
	for sc.Scan() {
		var e []any
		if err := json.Unmarshal(sc.Bytes(), &e); err != nil {
			t.Fatalf("event %q: %v", sc.Text(), err)
		}
		events = append(events, e)
	}
	got := []string{}
	for _, e := range events {
		got = append(got, e[1].(string)+":"+e[2].(string))
	}
	want := []string{"o:$ ls\r\n", "o:✓ ok", "r:80x24"}
	if len(got) != len(want) {
		t.Fatalf("events %q, want %q", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("event %d: %q, want %q", i, got[i], want[i])
		}
	}
}

func TestRecordNeedsFullPath(t *testing.T) {
	var rec recorder
	if err := rec.Start("relative.cast", 80, 24, ""); err == nil {
		t.Error("a relative path should be refused")
	}
}
