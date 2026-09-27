package wailsapp

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPreviewServer(t *testing.T) {
	dir := t.TempDir()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.MkdirAll(filepath.Join(dir, "js"), 0o755))
	must(os.WriteFile(filepath.Join(dir, "index.html"), []byte("on disk"), 0o644))
	must(os.WriteFile(filepath.Join(dir, "js", "app.js"), []byte("export const x = 1;"), 0o644))
	must(os.WriteFile(filepath.Join(filepath.Dir(dir), "secret.txt"), []byte("outside"), 0o644))

	a := &App{}
	u, err := a.PreviewURL(filepath.Join(dir, "index.html"), "unsaved edit")
	must(err)
	get := func(url string, hdr ...string) (int, string, string) {
		t.Helper()
		req, _ := http.NewRequest(http.MethodGet, url, nil)
		for i := 0; i+1 < len(hdr); i += 2 {
			req.Header.Set(hdr[i], hdr[i+1])
		}
		resp, err := http.DefaultClient.Do(req)
		must(err)
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, resp.Header.Get("Content-Type"), string(b)
	}
	base := strings.TrimSuffix(u, "index.html")

	if code, _, body := get(u); code != 200 || body != "unsaved edit" {
		t.Errorf("page: %d %q, want the editor's text", code, body)
	}
	if code, ct, body := get(base + "js/app.js"); code != 200 || !strings.HasPrefix(ct, "text/javascript") || body != "export const x = 1;" {
		t.Errorf("module: %d %q %q", code, ct, body)
	}
	for _, p := range []string{"../secret.txt", "..%2fsecret.txt", "js/../../secret.txt"} {
		if code, _, body := get(base + p); code == 200 && strings.Contains(body, "outside") {
			t.Errorf("%s escaped the folder", p)
		}
	}
	if code, _, _ := get(base+"js/app.js", "Service-Worker", "script"); code != 404 {
		t.Errorf("service worker script served: %d", code)
	}
	// http://127.0.0.1:<port>/<token>/index.html
	parts := strings.Split(strings.TrimPrefix(u, "http://"), "/")
	if len(parts) != 3 || len(parts[1]) != 32 {
		t.Fatalf("unexpected preview URL %s", u)
	}
	if code, _, _ := get("http://" + parts[0] + "/" + strings.Repeat("0", 32) + "/index.html"); code != 404 {
		t.Errorf("wrong token answered %d", code)
	}
	// Same folder, same token: a second file keeps the first's override.
	u2, err := a.PreviewURL(filepath.Join(dir, "README.md.oxis-preview.html"), "<p>readme</p>")
	must(err)
	if !strings.HasPrefix(u2, base) {
		t.Errorf("second file in the same folder got another base: %s vs %s", u2, base)
	}
}
