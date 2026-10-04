package wailsapp

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// The editor's live preview loads pages from here, so a page renders the
// way it does on a real server: relative stylesheets, ES modules,
// images and fonts resolve, including ones that climb out of the page's
// own folder (<link href="../css/main.css">), because the page's whole
// project is served (previewRoot). A README's relative images work the
// same way.
//
// It listens on its own random loopback port, so previewed pages are a
// different origin from the OXIS window and its local server, and each
// project is reachable only under a random 128-bit token. The editor's
// unsaved text is served in place of the file on disk.
type previewFolder struct {
	dir       string            // the project root (previewRoot)
	overrides map[string]string // slash path inside dir -> content
}

var preview struct {
	mu      sync.Mutex
	port    int
	byToken map[string]*previewFolder
	byDir   map[string]string // folder -> token
}

// projectMarkers are what make a folder a project's root for the preview.
var projectMarkers = []string{".git", "package.json", "go.mod", "Cargo.toml", "pyproject.toml", "composer.json", ".oxis-connector.json"}

// previewRoot is the folder a page in dir is served from: the nearest
// folder up (dir itself included) that holds a project marker, so a page
// in a subfolder can use the project's shared stylesheets and scripts.
// Without a project it's dir's parent (one level of ../). Never the home
// folder, anything above it or a drive root, even when one of those
// holds a marker (a home folder that is itself a git repository): a
// previewed page's scripts can read anything served to it.
func previewRoot(dir string) string {
	home, _ := os.UserHomeDir()
	atOrAboveHome := func(d string) bool {
		if home == "" {
			return false
		}
		h, c := strings.ToLower(filepath.Clean(home)), strings.ToLower(filepath.Clean(d))
		return h == c || strings.HasPrefix(h, strings.TrimSuffix(c, string(filepath.Separator))+string(filepath.Separator))
	}
	d := dir
	for i := 0; i < 12 && !atOrAboveHome(d); i++ {
		for _, m := range projectMarkers {
			if _, err := os.Stat(filepath.Join(d, m)); err == nil {
				return d
			}
		}
		parent := filepath.Dir(d)
		if parent == d {
			break
		}
		d = parent
	}
	parent := filepath.Dir(dir)
	if parent == dir || filepath.Dir(parent) == parent || atOrAboveHome(parent) {
		return dir
	}
	return parent
}

// PreviewURL serves content as the file at servePath (which doesn't
// have to exist: a rendered README is served next to the .md) and
// returns the URL that loads it with its project around it.
func (a *App) PreviewURL(servePath, content string) (string, error) {
	abs, err := filepath.Abs(servePath)
	if err != nil {
		return "", err
	}
	dir := filepath.Dir(abs)
	if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
		return "", fmt.Errorf("can't preview %s: its folder isn't readable", servePath)
	}
	root := previewRoot(dir)
	rel, err := filepath.Rel(root, abs)
	if err != nil {
		return "", err
	}
	name := filepath.ToSlash(rel)
	segments := strings.Split(name, "/")
	for i, seg := range segments {
		segments[i] = url.PathEscape(seg)
	}

	preview.mu.Lock()
	defer preview.mu.Unlock()
	if preview.port == 0 {
		if err := startPreviewServer(); err != nil {
			return "", err
		}
	}
	key := strings.ToLower(root)
	token, ok := preview.byDir[key]
	if !ok {
		b := make([]byte, 16)
		if _, err := rand.Read(b); err != nil {
			return "", err
		}
		token = hex.EncodeToString(b)
		preview.byDir[key] = token
		preview.byToken[token] = &previewFolder{dir: root, overrides: map[string]string{}}
	}
	preview.byToken[token].overrides[name] = content
	return fmt.Sprintf("http://127.0.0.1:%d/%s/%s", preview.port, token, strings.Join(segments, "/")), nil
}

// webTypes are fixed rather than looked up: on Windows the mime package
// reads the registry, which can map .js to text/plain, and browsers
// refuse to run module scripts served that way.
var webTypes = map[string]string{
	".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8", ".json": "application/json", ".map": "application/json",
	".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".wasm": "application/wasm",
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
	".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon",
	".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
	".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".txt": "text/plain; charset=utf-8",
	".md": "text/plain; charset=utf-8",
}

// startPreviewServer must be called with preview.mu held.
func startPreviewServer() error {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("couldn't start the preview server: %w", err)
	}
	preview.port = ln.Addr().(*net.TCPAddr).Port
	preview.byToken = map[string]*previewFolder{}
	preview.byDir = map[string]string{}
	srv := &http.Server{Handler: http.HandlerFunc(servePreview), ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = srv.Serve(ln) }()
	return nil
}

func servePreview(w http.ResponseWriter, r *http.Request) {
	host, _, err := net.SplitHostPort(r.Host)
	if err != nil || (host != "127.0.0.1" && host != "localhost") {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// A page's service worker would cache old copies and outlive the
	// preview; refusing its script makes registration fail quietly.
	if r.Header.Get("Service-Worker") == "script" {
		http.Error(w, "service workers are off in the OXIS preview", http.StatusNotFound)
		return
	}
	token, rest, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, "/"), "/")

	preview.mu.Lock()
	folder := preview.byToken[token]
	var override string
	var hasOverride bool
	var dir string
	if folder != nil {
		dir = folder.dir
		override, hasOverride = folder.overrides[rest]
	}
	preview.mu.Unlock()
	if folder == nil {
		http.NotFound(w, r)
		return
	}

	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if hasOverride {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(override))
		return
	}
	clean := path.Clean("/" + rest)
	if clean == "/" {
		clean = "/index.html"
	}
	full := filepath.Join(dir, filepath.FromSlash(clean))
	if rel, err := filepath.Rel(dir, full); err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		http.NotFound(w, r)
		return
	}
	fi, err := os.Stat(full)
	if err == nil && fi.IsDir() {
		full = filepath.Join(full, "index.html")
		fi, err = os.Stat(full)
	}
	if err != nil {
		http.NotFound(w, r)
		return
	}
	ext := strings.ToLower(filepath.Ext(full))
	if ct, ok := webTypes[ext]; ok {
		w.Header().Set("Content-Type", ct)
	} else if ct := mime.TypeByExtension(ext); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	f, err := os.Open(full)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	http.ServeContent(w, r, fi.Name(), fi.ModTime(), f)
}
