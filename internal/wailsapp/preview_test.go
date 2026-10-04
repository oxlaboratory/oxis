package wailsapp

import (
	"io"
	"net/http"
	"net/url"
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
	must(os.WriteFile(filepath.Join(dir, "package.json"), []byte("{}"), 0o644)) // the project's root
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

// A page in a subfolder can use the project's shared files with ../,
// and without a project, one level up (but no further).
func TestPreviewClimbsToTheProject(t *testing.T) {
	get := func(u string) (int, string) {
		t.Helper()
		resp, err := http.Get(u)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b)
	}
	resolve := func(page, ref string) string {
		t.Helper()
		base, err := url.Parse(page)
		if err != nil {
			t.Fatal(err)
		}
		r, _ := url.Parse(ref)
		return base.ResolveReference(r).String()
	}
	a := &App{}

	proj := t.TempDir()
	os.MkdirAll(filepath.Join(proj, "css"), 0o755)
	os.MkdirAll(filepath.Join(proj, "pages", "deep"), 0o755)
	os.WriteFile(filepath.Join(proj, ".oxis-connector.json"), []byte("{}"), 0o644)
	os.WriteFile(filepath.Join(proj, "css", "main.css"), []byte("body{color:red}"), 0o644)
	page, err := a.PreviewURL(filepath.Join(proj, "pages", "deep", "about.html"), "<link rel=stylesheet href=../../css/main.css>")
	if err != nil {
		t.Fatal(err)
	}
	if code, body := get(page); code != 200 || !strings.Contains(body, "main.css") {
		t.Errorf("page: %d %q", code, body)
	}
	if code, body := get(resolve(page, "../../css/main.css")); code != 200 || body != "body{color:red}" {
		t.Errorf("../../css/main.css from pages/deep/: %d %q", code, body)
	}

	// No project: the page's folder and the one above it.
	loose := t.TempDir()
	os.MkdirAll(filepath.Join(loose, "site", "pages"), 0o755)
	os.MkdirAll(filepath.Join(loose, "site", "css"), 0o755)
	os.WriteFile(filepath.Join(loose, "site", "css", "main.css"), []byte("h1{}"), 0o644)
	os.WriteFile(filepath.Join(loose, "secret.txt"), []byte("outside"), 0o644)
	page, err = a.PreviewURL(filepath.Join(loose, "site", "pages", "index.html"), "<p>hi</p>")
	if err != nil {
		t.Fatal(err)
	}
	if code, body := get(resolve(page, "../css/main.css")); code != 200 || body != "h1{}" {
		t.Errorf("../css/main.css without a project: %d %q", code, body)
	}
	if code, body := get(resolve(page, "../../secret.txt")); code == 200 && strings.Contains(body, "outside") {
		t.Error("two levels up was served")
	}
}

func TestReadImage(t *testing.T) {
	dir := t.TempDir()
	png := filepath.Join(dir, "a.PNG")
	os.WriteFile(png, []byte{0x89, 'P', 'N', 'G'}, 0o644)
	a := &App{}
	got, err := a.ReadImage(png)
	if err != nil || got != "data:image/png;base64,iVBORw==" {
		t.Errorf("png: %q %v", got, err)
	}
	txt := filepath.Join(dir, "a.txt")
	os.WriteFile(txt, []byte("x"), 0o644)
	if _, err := a.ReadImage(txt); err == nil {
		t.Error("read a text file as an image")
	}
}
