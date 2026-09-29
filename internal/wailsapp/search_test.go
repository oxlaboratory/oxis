package wailsapp

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func writeTree(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range files {
		p := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func search(t *testing.T, dir, query string, opts SearchOptions) SearchResult {
	t.Helper()
	re, err := searchPattern(query, opts)
	if err != nil {
		t.Fatal(err)
	}
	return searchTree(dir, "root", re, searchMaxResults, func() bool { return false })
}

func TestSearchFindsLinesAndSkipsFolders(t *testing.T) {
	dir := writeTree(t, map[string]string{
		"src/cart.ts":             "export function total() {\r\n  return subtotal(items);\r\n}\n",
		"src/deep/b.go":           "// Total count\nfunc total() {}\n",
		"node_modules/x/index.js": "total total total",
		".git/config":             "total",
		"img.png":                 "\x89PNG\x00total",
	})
	res := search(t, dir, "total", SearchOptions{})
	var got []string
	for _, m := range res.Matches {
		got = append(got, m.Path+":"+strconv.Itoa(m.Line)+":"+strconv.Itoa(m.Col)+":"+m.Text[m.At:m.At+m.Len])
	}
	want := []string{
		"root/src/cart.ts:1:16:total",
		"root/src/cart.ts:2:12:total",
		"root/src/deep/b.go:1:3:Total",
		"root/src/deep/b.go:2:5:total",
	}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("got  %v\nwant %v", got, want)
	}
	if res.Files != 2 {
		t.Errorf("searched %d files, want 2 (node_modules, .git and binaries skipped)", res.Files)
	}
}

func TestSearchOptions(t *testing.T) {
	dir := writeTree(t, map[string]string{"a.txt": "Total total subtotal\n"})
	count := func(q string, o SearchOptions) int { return len(search(t, dir, q, o).Matches) }
	if n := count("total", SearchOptions{}); n != 3 {
		t.Errorf("any case: %d, want 3", n)
	}
	if n := count("total", SearchOptions{CaseSensitive: true}); n != 2 {
		t.Errorf("case sensitive: %d, want 2", n)
	}
	if n := count("total", SearchOptions{WholeWord: true}); n != 2 {
		t.Errorf("whole word: %d, want 2", n)
	}
	if n := count("sub.otal", SearchOptions{}); n != 0 {
		t.Errorf("a plain query is literal: %d, want 0", n)
	}
	if n := count("sub.otal", SearchOptions{Regex: true}); n != 1 {
		t.Errorf("regex: %d, want 1", n)
	}
	if _, err := searchPattern("(", SearchOptions{Regex: true}); err == nil {
		t.Error("a broken regex should be an error")
	}
}

// Columns are counted as JavaScript does (UTF-16), and a long line is
// cut down around its match.
func TestSearchColumnsAndLongLines(t *testing.T) {
	long := strings.Repeat("x", 1000) + "needle" + strings.Repeat("y", 1000)
	dir := writeTree(t, map[string]string{"a.txt": "é😀 needle\n" + long + "\n"})
	res := search(t, dir, "needle", SearchOptions{})
	if len(res.Matches) != 2 {
		t.Fatalf("got %d matches", len(res.Matches))
	}
	if m := res.Matches[0]; m.Col != 4 || m.Len != 6 {
		t.Errorf("col %d len %d, want 4 and 6 (é is 1, 😀 is 2 in UTF-16)", m.Col, m.Len)
	}
	m := res.Matches[1]
	if m.Col != 1000 || len(m.Text) > searchLineWindow*2 || m.Text[m.At:m.At+m.Len] != "needle" {
		t.Errorf("long line: col %d, text %d bytes, at %d", m.Col, len(m.Text), m.At)
	}
}
