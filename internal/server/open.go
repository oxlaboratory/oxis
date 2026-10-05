package server

import (
	"crypto/subtle"
	"io"
	"net/http"
	"strings"
	"sync"
)

// "Open in OXIS" from Explorer starts oxis.exe with a folder. When OXIS
// is already running, that new process hands the folder to it here
// (POST /open, the folder as the body) and exits, so the folder opens
// as a tab in the window you have instead of a second window.
//
// Only another OXIS process can do that: the request needs the token
// this instance wrote to a file in the user's own ~/.oxis, and a web
// page can't send it (a browser adds an Origin header; that's refused).

var (
	openMu    sync.Mutex
	openToken string
	openFn    func(folder string)
)

// OnOpenFolder sets what a handed-over folder does, and the token a
// request must carry.
func OnOpenFolder(token string, fn func(folder string)) {
	openMu.Lock()
	defer openMu.Unlock()
	openToken, openFn = token, fn
}

func handleOpen(w http.ResponseWriter, r *http.Request) {
	openMu.Lock()
	token, fn := openToken, openFn
	openMu.Unlock()
	if r.Method != http.MethodPost || !isLocalhost(r) || r.Header.Get("Origin") != "" || token == "" || fn == nil ||
		subtle.ConstantTimeCompare([]byte(r.Header.Get("X-OXIS-Token")), []byte(token)) != 1 {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 4096))
	folder := strings.TrimSpace(string(body))
	if err != nil || folder == "" {
		http.Error(w, "no folder", http.StatusBadRequest)
		return
	}
	fn(folder)
	w.WriteHeader(http.StatusNoContent)
}
