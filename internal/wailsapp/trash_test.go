package wailsapp

import (
	"os"
	"path/filepath"
	"testing"
)

func TestTrashPath(t *testing.T) {
	if os.Getenv("OXIS_TEST_TRASH") == "" {
		t.Skip("moves a temp file to the real Recycle Bin/Trash; set OXIS_TEST_TRASH=1 to run")
	}
	dir := t.TempDir()
	p := filepath.Join(dir, "oxis-trash-test.txt")
	if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	a := &App{}
	if err := a.TrashPath(p); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Fatalf("still there: %v", err)
	}
	if err := a.TrashPath(p); err == nil {
		t.Fatal("trashing a missing path should fail")
	}
}
