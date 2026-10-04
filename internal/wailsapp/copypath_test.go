package wailsapp

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCopyPath(t *testing.T) {
	dir := t.TempDir()
	a := &App{}
	src := filepath.Join(dir, "site")
	os.MkdirAll(filepath.Join(src, "css"), 0o755)
	os.WriteFile(filepath.Join(src, "index.html"), []byte("<h1>hi</h1>"), 0o644)
	os.WriteFile(filepath.Join(src, "css", "main.css"), []byte("h1{}"), 0o644)

	dst := filepath.Join(dir, "site copy")
	if err := a.CopyPath(src, dst); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dst, "css", "main.css")); string(b) != "h1{}" {
		t.Fatalf("nested file not copied: %q", b)
	}
	if err := a.CopyPath(filepath.Join(src, "index.html"), filepath.Join(dir, "index copy.html")); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "index copy.html")); string(b) != "<h1>hi</h1>" {
		t.Fatalf("file not copied: %q", b)
	}

	if err := a.CopyPath(src, dst); err == nil {
		t.Fatal("copying onto something that exists should fail")
	}
	if err := a.CopyPath(src, filepath.Join(src, "css", "again")); err == nil {
		t.Fatal("copying a folder into itself should fail")
	}
	if err := a.CopyPath(filepath.Join(dir, "missing"), filepath.Join(dir, "x")); err == nil {
		t.Fatal("copying something missing should fail")
	}
	// A sibling whose name starts with the folder's isn't inside it.
	if err := a.CopyPath(src, filepath.Join(dir, "site2")); err != nil {
		t.Fatal(err)
	}
}
