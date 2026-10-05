package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestOpenFolderHandOver(t *testing.T) {
	var got []string
	OnOpenFolder("secret-token", func(folder string) { got = append(got, folder) })
	defer OnOpenFolder("", nil)

	try := func(method, token, origin, remote, body string) int {
		r := httptest.NewRequest(method, "/open", strings.NewReader(body))
		r.Host = remote
		if token != "" {
			r.Header.Set("X-OXIS-Token", token)
		}
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		w := httptest.NewRecorder()
		handleOpen(w, r)
		return w.Code
	}
	local := "127.0.0.1:1420"
	if c := try(http.MethodPost, "secret-token", "", local, `C:\dev\api`); c != http.StatusNoContent {
		t.Fatalf("good request: %d", c)
	}
	for name, c := range map[string]int{
		"wrong token":      try(http.MethodPost, "nope", "", local, `C:\x`),
		"no token":         try(http.MethodPost, "", "", local, `C:\x`),
		"from a web page":  try(http.MethodPost, "secret-token", "https://evil.example", local, `C:\x`),
		"DNS rebinding":    try(http.MethodPost, "secret-token", "", "evil.example:1420", `C:\x`),
		"GET":              try(http.MethodGet, "secret-token", "", local, ""),
	} {
		if c != http.StatusForbidden {
			t.Errorf("%s: %d, want 403", name, c)
		}
	}
	if len(got) != 1 || got[0] != `C:\dev\api` {
		t.Errorf("folders handed over: %q", got)
	}
}
