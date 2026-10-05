package wailsapp

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"github.com/oxis/oxis/internal/server"
)

// "Open in OXIS": oxis.exe started with a folder (Explorer's folder menu,
// or `oxis C:\dev\api`) opens a terminal tab there. If this same OXIS
// is already running, the new process hands the folder to it and quits
// (server/open.go), so it opens in the window you have.

// folderArg is the first command-line argument that names a folder.
func folderArg(args []string) string {
	for _, a := range args {
		a = strings.Trim(strings.TrimSpace(a), `"`)
		if a == "" || strings.HasPrefix(a, "-") {
			continue
		}
		if st, err := os.Stat(a); err == nil && st.IsDir() {
			if abs, err := filepath.Abs(a); err == nil {
				return abs
			}
			return a
		}
	}
	return ""
}

type instanceInfo struct {
	Port  int    `json:"port"`
	Token string `json:"token"`
}

// instanceFile is where this OXIS (this exe: copies elsewhere, a test
// or dev build, have their own) says how to reach it.
func instanceFile() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	sum := sha256.Sum256([]byte(strings.ToLower(exe)))
	return filepath.Join(home, ".oxis", "instance-"+hex.EncodeToString(sum[:6])+".json")
}

// handOff gives folder to a running OXIS; true if it took it.
func handOff(folder string) bool {
	path := instanceFile()
	b, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	var info instanceInfo
	if json.Unmarshal(b, &info) != nil || info.Port == 0 || info.Token == "" {
		return false
	}
	req, err := http.NewRequest(http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/open", info.Port), strings.NewReader(folder))
	if err != nil {
		return false
	}
	req.Header.Set("X-OXIS-Token", info.Token)
	res, err := (&http.Client{Timeout: 3 * time.Second}).Do(req)
	if err != nil {
		return false // not running any more: start as usual
	}
	res.Body.Close()
	return res.StatusCode == http.StatusNoContent
}

// publishInstance makes this OXIS reachable for handOff: a fresh token,
// written where only this user can read it. The returned func removes it.
func publishInstance(port int, open func(folder string)) func() {
	path := instanceFile()
	if path == "" {
		return func() {}
	}
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		return func() {}
	}
	token := hex.EncodeToString(raw)
	server.OnOpenFolder(token, open)
	b, _ := json.Marshal(instanceInfo{Port: port, Token: token})
	_ = os.MkdirAll(filepath.Dir(path), 0o700)
	if os.WriteFile(path, b, 0o600) != nil {
		return func() {}
	}
	return func() {
		// Only ours: a newer instance may have written its own since.
		if cur, err := os.ReadFile(path); err == nil && string(cur) == string(b) {
			_ = os.Remove(path)
		}
	}
}

// The folder this process was started with, until the page asks.
var (
	startMu     sync.Mutex
	startFolder string
)

// StartFolder is the folder OXIS was started with ("Open in OXIS"), once;
// "" otherwise.
func (a *App) StartFolder() string {
	startMu.Lock()
	defer startMu.Unlock()
	f := startFolder
	startFolder = ""
	return f
}

// openFolder: a folder handed over by another launch becomes a tab, and
// the window comes to the front.
func (a *App) openFolder(ctx context.Context, folder string) {
	if ctx == nil {
		return
	}
	wailsRuntime.EventsEmit(ctx, "open_folder", folder)
	wailsRuntime.WindowUnminimise(ctx)
	wailsRuntime.WindowShow(ctx)
}
