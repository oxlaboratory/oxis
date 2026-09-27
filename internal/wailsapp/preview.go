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
// images and fonts resolve against the page's own folder. A README's
// relative images work the same way.
//
// It listens on its own random loopback port, so previewed pages are a
// different origin from the OXIS window and its local server, and each
// folder is reachable only under a random 128-bit token. The editor's
// unsaved text is served in place of the file on disk.
type previewFolder struct {
	dir       string
	overrides map[string]string // slash path inside dir -> content
}

var preview struct {
	mu      sync.Mutex
	port    int
	byToken map[string]*previewFolder
	byDir   map[string]string // folder -> token
}

// PreviewURL serves content as the file at servePath (which doesn't
// have to exist: a rendered README is served next to the .md) and
// returns the URL that loads it with its folder around it.
func (a *App) PreviewURL(servePath, content string) (string, error) {
	abs, err := filepath.Abs(servePath)
	if err != nil {
		return "", err
	}
	dir, name := filepath.Split(abs)
	dir = filepath.Clean(dir)
	if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
		return "", fmt.Errorf("can't preview %s: its folder isn't readable", servePath)
	}

	preview.mu.Lock()
	defer preview.mu.Unlock()
	if preview.port == 0 {
		if err := startPreviewServer(); err != nil {
			return "", err
		}
	}
	key := strings.ToLower(dir)
	token, ok := preview.byDir[key]
	if !ok {
		b := make([]byte, 16)
		if _, err := rand.Read(b); err != nil {
			return "", err
		}
		token = hex.EncodeToString(b)
		preview.byDir[key] = token
		preview.byToken[token] = &previewFolder{dir: dir, overrides: map[string]string{}}
	}
	preview.byToken[token].overrides[name] = content
	return fmt.Sprintf("http://127.0.0.1:%d/%s/%s", preview.port, token, url.PathEscape(name)), nil
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
