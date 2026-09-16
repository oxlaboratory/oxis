// Package wailsapp runs OXIS as a native, frameless, borderless desktop
// window using Wails v2. This is the only runtime mode OXIS has —
// there is no browser/app-mode fallback.
package wailsapp

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/oxis/oxis/internal/server"
	"github.com/oxis/oxis/internal/update"
	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// App is bound to the frontend as window.go.wailsapp.App.* (the JS
// binding namespace mirrors this Go package's name, "wailsapp" — NOT
// "main", even though cmd/oxi/main.go's own package is main; only the
// package the bound *struct* is declared in matters to Wails here).
// Used by the custom titlebar for window controls
// (minimise/maximise/close) and by the PTY client to find its
// WebSocket port.
type App struct {
	ctx     context.Context
	ptyPort int
}

func NewApp() *App { return &App{} }

// Version is this build's version string (e.g. "1.2.1"), set at build
// time via -ldflags "-X .../wailsapp.Version=..." — see VERSION in
// scripts/build-go.js. Left at its dev default for `go run`/unlinked
// builds; CheckForUpdate below still works fine against that (it just
// never reports "0.0.0-dev" as newer than anything).
var Version = "0.0.0-dev"

// CheckForUpdate backs 'update and the frontend's own background
// check-once-per-run on shell startup — compares this build against
// OXIS's latest gitlab.com/oxidelab/oxis release (see internal/update).
// The frontend calls this directly rather than Go pushing a
// Wails EventsEmit, since a plain request/response call is the only
// Go->frontend channel this app already uses anywhere (see native.ts)
// — no new event-bridge wiring needed for an occasional check.
func (a *App) CheckForUpdate() update.Info { return update.Check(Version) }

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// WindowMinimise / WindowClose back the custom titlebar's window
// controls (dragging is handled separately — see the NOTE below).
// There's no maximise control at all: the window is a fixed size
// (Width == MinWidth == MaxWidth, DisableResize — see Run below), so
// there's nothing to toggle into. window.go bindings like these are
// populated as soon as Wails' own runtime script runs against the
// window's document — which now happens exactly once, since the
// frontend is served directly as this window's AssetServer.Assets
// (see Run below) and the window never navigates away from it after
// that. Earlier builds routed the window through a bootstrap page
// that redirected to a separate HTTP server, which raced that same
// injection on a second document and is what made these controls
// (and dragging) intermittently do nothing — see server.Listen's
// doc comment for the full history.
func (a *App) WindowMinimise() { wailsRuntime.WindowMinimise(a.ctx) }
func (a *App) WindowClose()    { wailsRuntime.Quit(a.ctx) }

// OpenURL opens a URL in the user's actual default system browser via
// Wails' own runtime call — not by shelling out to Start-Process/
// xdg-open, which is fragile across platforms and unnecessary when
// Wails already provides the right primitive. Backs the Ctrl+Shift+M
// "open OXIS Market" hotkey and 'market subscribe's Stripe Checkout
// handoff (see native.ts's openUrl()).
func (a *App) OpenURL(url string) { wailsRuntime.BrowserOpenURL(a.ctx, url) }

// NOTE: there's deliberately no WindowStartDrag anywhere in this
// project — Go or JS. Checked against Wails v2's Go runtime package
// (pkg/runtime), its JS runtime docs, and its internal Frontend
// interface (which defines every real window method on both sides):
// no such function exists in any of them. Dragging works purely via
// the native `--wails-draggable` CSS hit-testing mechanism (see
// Titlebar.tsx and .wails-titlebar/.wails-drag in index.css) — no Go
// or JS call is needed at all. An earlier version of this file (and
// of Titlebar.tsx) called window.runtime.WindowStartDrag() as a
// fallback on every mousedown — that function doesn't exist, so it
// silently retried 10 times and did nothing, every single click.

// GetPTYPort returns the loopback port the local server (PTY +
// frontend — see server.Listen) is listening on. The native window's
// ptyClient can't just connect to `ws://${location.host}/ws`, because
// inside the native window, location.host is Wails' own AssetServer
// origin, not this server's — this is how it finds the right one. A
// plain browser tab open to http://127.0.0.1:<port> never calls this;
// it's same-origin with the WebSocket already (see native.ts's
// isNativeApp / ptyClient.ts's wsURL).
func (a *App) GetPTYPort() int { return a.ptyPort }

// pluginsDir returns (creating if needed) the real on-disk folder
// user/market-installed Lua plugins live in — next to the executable,
// not the process's working directory, since that varies by how the
// user launched OXIS but the executable's own location doesn't.
//
// Before this, 'plugin new and 'market install only ever wrote plugin
// source into localStorage (inside the WebView2 profile) — nothing
// ever touched the real filesystem, which is why a plugin created or
// installed that way was genuinely nowhere to be found in Explorer:
// it never existed as a file. This is the actual fix for that, not
// just a better error message.
func pluginsDir() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(filepath.Dir(exe), "plugins")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

// pluginFilePath resolves a plugin name to its file, rejecting
// anything that isn't a plain name — no path separators, no "..".
// Plugin names come from user input ('plugin new <n>, 'market install)
// and get used to build a filesystem path, so this is the boundary
// that keeps that from ever writing outside pluginsDir().
func pluginFilePath(name string) (string, error) {
	if name == "" || name != filepath.Base(name) || strings.Contains(name, "..") {
		return "", fmt.Errorf("invalid plugin name: %q", name)
	}
	dir, err := pluginsDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, name+".lua"), nil
}

// ListPlugins returns the names (without ".lua") of every plugin file
// on disk in pluginsDir().
func (a *App) ListPlugins() ([]string, error) {
	dir, err := pluginsDir()
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".lua" {
			continue
		}
		names = append(names, strings.TrimSuffix(e.Name(), ".lua"))
	}
	return names, nil
}

// ReadPluginFile / WritePluginFile / DeletePluginFile back
// 'plugin new, 'market install, and 'plugin delete — real files in
// pluginsDir(), not localStorage.
func (a *App) ReadPluginFile(name string) (string, error) {
	path, err := pluginFilePath(name)
	if err != nil {
		return "", err
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func (a *App) WritePluginFile(name string, source string) error {
	path, err := pluginFilePath(name)
	if err != nil {
		return err
	}
	return os.WriteFile(path, []byte(source), 0o644)
}

func (a *App) DeletePluginFile(name string) error {
	path, err := pluginFilePath(name)
	if err != nil {
		return err
	}
	return os.Remove(path)
}

// maxEditableSize caps what the built-in editor will load — large
// files (logs, binaries) shouldn't get pulled whole into a <textarea>.
const maxEditableSize = 8 * 1024 * 1024 // 8MB

// ReadFile backs the built-in editor ('edit <file>). Relative paths
// resolve against the OXIS process's own working directory (typically
// wherever the app was launched from) — not the PTY shell's current
// directory, which Go has no reliable cross-platform way to observe
// from outside the shell process. Pass an absolute path if you've cd'd
// elsewhere in the terminal.
func (a *App) ReadFile(path string) (string, error) {
	full := resolvePath(path)
	info, err := os.Stat(full)
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		return "", os.ErrInvalid
	}
	if info.Size() > maxEditableSize {
		return "", &os.PathError{Op: "read", Path: full, Err: os.ErrInvalid}
	}
	b, err := os.ReadFile(full)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// WriteFile backs the editor's save (Ctrl+S). Same path-resolution
// rule as ReadFile.
func (a *App) WriteFile(path string, content string) error {
	full := resolvePath(path)
	if dir := filepath.Dir(full); dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	return os.WriteFile(full, []byte(content), 0o644)
}

func resolvePath(path string) string {
	if filepath.IsAbs(path) {
		return filepath.Clean(path)
	}
	wd, err := os.Getwd()
	if err != nil {
		return filepath.Clean(path)
	}
	return filepath.Join(wd, path)
}

// ═══════════════════════════════════════════════════════════════
// Core System APIs — backs oxis.fs.*, oxis.process.*, oxis.system.*
// (see README § Core System APIs). Every one of these is meant to sit
// behind plugin permissions on the frontend (permissions.ts) before a
// plugin can reach it at all; the Go side here doesn't itself enforce
// that — permission checks are a frontend/UX concern (which plugin is
// asking, what it already declared), the same boundary ReadFile/
// WriteFile already crossed for the editor.
// ═══════════════════════════════════════════════════════════════

// FileEntry is one row of a ListDir result.
type FileEntry struct {
	Name    string `json:"name"`
	IsDir   bool   `json:"isDir"`
	Size    int64  `json:"size"`
	ModTime int64  `json:"modTime"` // unix seconds
}

// ListDir backs oxis.fs.list(path) — a plugin-facing directory listing
// that doesn't require shelling out to `ls`/`Get-ChildItem`.
func (a *App) ListDir(path string) ([]FileEntry, error) {
	full := resolvePath(path)
	entries, err := os.ReadDir(full)
	if err != nil {
		return nil, err
	}
	out := make([]FileEntry, 0, len(entries))
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, FileEntry{
			Name:    e.Name(),
			IsDir:   e.IsDir(),
			Size:    info.Size(),
			ModTime: info.ModTime().Unix(),
		})
	}
	return out, nil
}

// StatPath backs oxis.fs.stat(path) — existence + basic metadata
// without a full directory read.
type StatResult struct {
	Exists  bool  `json:"exists"`
	IsDir   bool  `json:"isDir"`
	Size    int64 `json:"size"`
	ModTime int64 `json:"modTime"`
}

func (a *App) StatPath(path string) (StatResult, error) {
	info, err := os.Stat(resolvePath(path))
	if os.IsNotExist(err) {
		return StatResult{Exists: false}, nil
	}
	if err != nil {
		return StatResult{}, err
	}
	return StatResult{Exists: true, IsDir: info.IsDir(), Size: info.Size(), ModTime: info.ModTime().Unix()}, nil
}

// MakeDir / DeletePath back oxis.fs.mkdir / oxis.fs.remove.
func (a *App) MakeDir(path string) error { return os.MkdirAll(resolvePath(path), 0o755) }
func (a *App) DeletePath(path string) error {
	full := resolvePath(path)
	// Refuse to delete a drive root / the working directory itself —
	// oxis.fs.remove is meant for plugin-managed files, not "rm -rf /".
	if full == filepath.Dir(full) {
		return fmt.Errorf("refusing to delete root path: %s", full)
	}
	return os.RemoveAll(full)
}

// SystemInfo backs oxis.system.info() — the pieces sysmon.lua/
// system_health.lua currently get by shelling out to platform-specific
// commands, exposed as one first-class call instead.
type SystemInfo struct {
	OS           string `json:"os"`
	Arch         string `json:"arch"`
	NumCPU       int    `json:"numCPU"`
	GoVersion    string `json:"goVersion"`
	AllocMB      uint64 `json:"allocMB"` // OXIS process's own heap, not total system memory
	NumGoroutine int    `json:"numGoroutine"`
}

func (a *App) SystemInfo() SystemInfo {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return SystemInfo{
		OS: runtime.GOOS, Arch: runtime.GOARCH, NumCPU: runtime.NumCPU(),
		GoVersion: runtime.Version(), AllocMB: m.Alloc / 1024 / 1024,
		NumGoroutine: runtime.NumGoroutine(),
	}
}

// ProcessInfo is one row of a ListProcesses result.
type ProcessInfo struct {
	PID  int    `json:"pid"`
	Name string `json:"name"`
}

// ListProcesses backs oxis.process.list() — shells out to the
// platform's own process listing (there's no cross-platform stdlib
// way to enumerate processes) and parses just PID + name. Real
// process *control* beyond that (spawn/signal) is deliberately not
// exposed yet — see README § Core System APIs, still [planned] for
// anything beyond listing.
func (a *App) ListProcesses() ([]ProcessInfo, error) {
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("tasklist", "/FO", "CSV", "/NH")
	} else {
		cmd = exec.Command("ps", "-eo", "pid,comm", "--no-headers")
	}
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	result := make([]ProcessInfo, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if runtime.GOOS == "windows" {
			fields := strings.Split(line, "\",\"")
			if len(fields) < 2 {
				continue
			}
			name := strings.Trim(fields[0], "\"")
			pidStr := strings.Trim(fields[1], "\"")
			var pid int
			fmt.Sscanf(pidStr, "%d", &pid)
			result = append(result, ProcessInfo{PID: pid, Name: name})
		} else {
			var pid int
			var name string
			if _, err := fmt.Sscanf(line, "%d %s", &pid, &name); err == nil {
				result = append(result, ProcessInfo{PID: pid, Name: name})
			}
		}
	}
	return result, nil
}

// KillProcess backs oxis.process.kill(pid).
func (a *App) KillProcess(pid int) error {
	if runtime.GOOS == "windows" {
		return exec.Command("taskkill", "/PID", fmt.Sprintf("%d", pid), "/F").Run()
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return proc.Kill()
}

// Run starts OXIS as a native Wails window. It blocks until the window
// is closed.
//
// The frontend is served directly as this window's AssetServer.Assets
// — Wails' standard embedded-filesystem path — so window.go/window.runtime
// are injected into the one and only document this window ever loads.
// A second, real HTTP server (server.Listen) carries the PTY WebSocket
// (which Wails' own AssetServer can't do — see its doc comment) and,
// as a bonus, the same frontend build again, on a real port — so
// http://127.0.0.1:1420 also works from an ordinary browser, entirely
// independent of this native window.
func Run() error {
	app := NewApp()

	ptyPort, err := server.Listen(1420)
	if err != nil {
		return err
	}
	app.ptyPort = ptyPort

	distFS, err := server.FrontendFS()
	if err != nil {
		return err
	}

	// Window size is locked: Width/Height == Min == Max and
	// DisableResize is true, so the OS gives no resize handles/cursors
	// and there's no maximise control in the titlebar at all (see
	// Titlebar.tsx) — nothing to expand into. Intentional, not a bug.
	const winWidth, winHeight = 940, 600

	return wails.Run(&options.App{
		Title:            "OXIS",
		Width:            winWidth,
		Height:           winHeight,
		MinWidth:         winWidth,
		MinHeight:        winHeight,
		MaxWidth:         winWidth,
		MaxHeight:        winHeight,
		Frameless:        true,
		DisableResize:    true,
		BackgroundColour: &options.RGBA{R: 12, G: 10, B: 18, A: 255},
		AssetServer: &assetserver.Options{
			Assets: distFS,
		},
		OnStartup: app.startup,
		Bind: []interface{}{
			app,
		},
	})
}