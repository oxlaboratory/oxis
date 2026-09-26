// Package wailsapp runs OXIS as a native, frameless desktop window
// using Wails v2.
package wailsapp

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/oxis/oxis/internal/server"
	"github.com/oxis/oxis/internal/update"
	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// App is bound to the frontend as window.go.wailsapp.App.* (the JS
// namespace follows this package's name, not cmd/oxi's "main").
type App struct {
	ctx     context.Context
	ptyPort int
}

func NewApp() *App { return &App{} }

// Version is set at build time via
// -ldflags "-X github.com/oxis/oxis/internal/wailsapp.Version=...".
var Version = "0.0.0-dev"

// CheckForUpdate compares this build against the latest GitHub release
// for this OS (see internal/update).
func (a *App) CheckForUpdate() update.Info { return update.Check(runtime.GOOS) }

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	cleanupSelfUpdateBackup()
}

// cleanupSelfUpdateBackup deletes the previous executable once a
// self-updated build has started successfully (see PerformUpdate).
// Reaching startup is the confirmation that the new build works.
func cleanupSelfUpdateBackup() {
	if backupPath := os.Getenv(selfUpdateBackupEnv); backupPath != "" {
		_ = os.Remove(backupPath)
	}
}

// WindowMinimise / WindowClose back the custom titlebar. Dragging uses
// the --wails-draggable CSS property; no Go/JS call is involved.
func (a *App) WindowMinimise() { wailsRuntime.WindowMinimise(a.ctx) }
func (a *App) WindowClose()    { wailsRuntime.Quit(a.ctx) }

// OpenURL opens a URL in the user's default browser.
func (a *App) OpenURL(url string) { wailsRuntime.BrowserOpenURL(a.ctx, url) }

// WriteClipboard writes text to the OS clipboard: Wails' own clipboard
// first, then the platform fallback (Win32, or pbcopy/xclip/xsel/
// wl-copy).
func (a *App) WriteClipboard(text string) error {
	if a.ctx != nil {
		if err := wailsRuntime.ClipboardSetText(a.ctx, text); err == nil {
			return nil
		}
	}
	return writeClipboardNative(text)
}

// ReadClipboard returns the OS clipboard's text (for Paste menu items;
// the WebView won't read the clipboard without a user gesture).
func (a *App) ReadClipboard() (string, error) {
	return wailsRuntime.ClipboardGetText(a.ctx)
}

// GetPTYPort returns the port of the local PTY/frontend server. Inside
// the native window location.host is the Wails asset origin, so the
// frontend needs this to find the WebSocket.
func (a *App) GetPTYPort() int { return a.ptyPort }

// pluginsDir returns (creating if needed) the folder user and
// market-installed Lua plugins live in, under AppDirPath.
func pluginsDir() (string, error) {
	dir, err := AppDirPath()
	if err != nil {
		return "", err
	}
	dir = filepath.Join(dir, "plugins")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

var (
	appDirOnce   sync.Once
	appDirCached string
	appDirErr    error
)

// AppDirPath is where OXIS keeps its data (workspaces, plugins, created
// documents, window.json). Normally that's the executable's own folder
// (portable install). If that folder isn't writable — e.g. an MSI
// install under Program Files — it falls back to ~/Downloads/OXIS.
func AppDirPath() (string, error) {
	appDirOnce.Do(func() {
		exe, err := os.Executable()
		if err != nil {
			appDirErr = err
			return
		}
		exeDir := filepath.Dir(exe)
		if isWritableDir(exeDir) {
			appDirCached = exeDir
			return
		}
		appDirCached, appDirErr = fallbackDataDir()
	})
	return appDirCached, appDirErr
}

// isWritableDir does a real write test; permission bits aren't reliable
// on Windows (UAC virtualization, ACLs).
func isWritableDir(dir string) bool {
	f, err := os.CreateTemp(dir, ".oxis-write-test-*")
	if err != nil {
		return false
	}
	name := f.Name()
	f.Close()
	os.Remove(name)
	return true
}

func fallbackDataDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, "Downloads", "OXIS")
	_, statErr := os.Stat(dir)
	firstRun := os.IsNotExist(statErr)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	if firstRun {
		go cloneSourceInBackground(dir)
	}
	return dir, nil
}

// cloneSourceInBackground gives installed users a copy of the source
// next to their data. Best effort: skipped silently without git or
// network.
func cloneSourceInBackground(dataDir string) {
	if _, err := exec.LookPath("git"); err != nil {
		return
	}
	target := filepath.Join(dataDir, "source")
	if _, err := os.Stat(target); err == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "clone", "--depth", "1",
		"https://github.com/oxlaboratory/oxis.git", target)
	hideWindow(cmd)
	_ = cmd.Run()
}

// AppDir exposes AppDirPath to the frontend.
func (a *App) AppDir() (string, error) { return AppDirPath() }

// UserConfigDir returns ~/.oxis (creating it and its themes folder),
// which holds config.lua and user theme JSON files. It lives in the
// home directory so it survives reinstalls and is shared by every copy
// of OXIS on the machine.
func (a *App) UserConfigDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, ".oxis")
	if err := os.MkdirAll(filepath.Join(dir, "themes"), 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

// pluginFilePath maps a plugin name to its file, rejecting anything
// that isn't a plain name so user input can't escape pluginsDir.
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

// ListPlugins returns the names (without ".lua") of the plugin files on disk.
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

// maxEditableSize caps what the built-in editor will load.
const maxEditableSize = 8 * 1024 * 1024

// ReadFile backs the built-in editor. Relative paths resolve against
// AppDirPath (see resolvePath).
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
		return "", &os.PathError{Op: "read", Path: full, Err: fmt.Errorf("file is larger than %d MB", maxEditableSize>>20)}
	}
	b, err := os.ReadFile(full)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// WriteFile backs the editor's save, creating parent folders as needed.
func (a *App) WriteFile(path string, content string) error {
	full := resolvePath(path)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return err
	}
	return os.WriteFile(full, []byte(content), 0o644)
}

// resolvePath anchors relative paths to AppDirPath rather than the
// process working directory, which depends on how OXIS was launched.
// A bare leading "/" or "\" means the root of the app's drive on
// Windows, matching the 'edit docs.
func resolvePath(path string) string {
	if filepath.IsAbs(path) {
		return filepath.Clean(path)
	}
	anchor, err := AppDirPath()
	if err != nil {
		wd, wdErr := os.Getwd()
		if wdErr != nil {
			return filepath.Clean(path)
		}
		anchor = wd
	}
	if len(path) > 0 && (path[0] == '/' || path[0] == '\\') {
		if vol := filepath.VolumeName(anchor); vol != "" {
			return filepath.Clean(vol + path)
		}
		return filepath.Clean(path)
	}
	return filepath.Join(anchor, path)
}

// WriteTempScript writes content to a fresh file in the OS temp dir and
// returns its absolute path. oxis.run() uses it to run multi-line
// scripts as one file instead of pasting them line by line.
func (a *App) WriteTempScript(ext string, content string) (string, error) {
	if ext == "" {
		ext = ".txt"
	}
	if ext[0] != '.' {
		ext = "." + ext
	}
	f, err := os.CreateTemp("", "oxis-run-*"+ext)
	if err != nil {
		return "", err
	}
	defer f.Close()
	// Windows PowerShell 5.1 reads a .ps1 without a BOM as ANSI, which
	// garbles any non-ASCII text in the script.
	if strings.EqualFold(ext, ".ps1") {
		content = "\ufeff" + content
	}
	if _, err := f.WriteString(content); err != nil {
		os.Remove(f.Name())
		return "", err
	}
	return f.Name(), nil
}

// ── Core system APIs: oxis.fs.*, oxis.process.*, oxis.system.* ──
// Plugin permissions are enforced on the frontend (permissions.ts).

// FileEntry is one row of a ListDir result.
type FileEntry struct {
	Name    string `json:"name"`
	IsDir   bool   `json:"isDir"`
	Size    int64  `json:"size"`
	ModTime int64  `json:"modTime"` // unix seconds
}

func (a *App) ListDir(path string) ([]FileEntry, error) {
	entries, err := os.ReadDir(resolvePath(path))
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

func (a *App) MakeDir(path string) error { return os.MkdirAll(resolvePath(path), 0o755) }

// MovePath renames a file or directory and refuses to overwrite. Path
// safety (staying inside a project) is the caller's job.
func (a *App) MovePath(src string, dst string) error {
	resolvedSrc := resolvePath(src)
	resolvedDst := resolvePath(dst)
	if _, err := os.Stat(resolvedSrc); err != nil {
		return fmt.Errorf("source doesn't exist: %s", resolvedSrc)
	}
	if _, err := os.Stat(resolvedDst); err == nil {
		return fmt.Errorf("destination already exists: %s", resolvedDst)
	}
	return os.Rename(resolvedSrc, resolvedDst)
}

func (a *App) DeletePath(path string) error {
	full := resolvePath(path)
	if full == filepath.Dir(full) {
		return fmt.Errorf("refusing to delete root path: %s", full)
	}
	return os.RemoveAll(full)
}

// RunCommandResult is a captured external command result. A non-zero
// exit is a normal result, not an error.
type RunCommandResult struct {
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	ExitCode int    `json:"exitCode"`
}

// runCommandTimeout is long enough for a slow git push.
const runCommandTimeout = 3 * time.Minute

// runningCommands maps a frontend-generated request ID to its cancel
// func so CancelCommand can stop an in-flight RunCommand.
var runningCommands sync.Map

// RunCommand runs an external command (argv, never a shell string) in
// dir and captures its output.
func (a *App) RunCommand(requestID string, dir string, name string, args []string) (RunCommandResult, error) {
	resolvedDir := resolvePath(dir)
	if info, err := os.Stat(resolvedDir); err != nil || !info.IsDir() {
		return RunCommandResult{}, fmt.Errorf("not a directory: %s", resolvedDir)
	}
	ctx, cancel := context.WithTimeout(context.Background(), runCommandTimeout)
	defer cancel()
	if requestID != "" {
		runningCommands.Store(requestID, cancel)
		defer runningCommands.Delete(requestID)
	}
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = resolvedDir
	// There's no terminal to answer a prompt on: git fails with an
	// authentication error instead of waiting for one (credential
	// helpers with their own window still work).
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	hideWindow(cmd)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		switch ctx.Err() {
		case context.Canceled:
			return RunCommandResult{}, fmt.Errorf("%s was cancelled", name)
		case context.DeadlineExceeded:
			return RunCommandResult{}, fmt.Errorf("%s timed out after %s", name, runCommandTimeout)
		}
		if exitErr, ok := err.(*exec.ExitError); ok {
			return RunCommandResult{Stdout: stdout.String(), Stderr: stderr.String(), ExitCode: exitErr.ExitCode()}, nil
		}
		return RunCommandResult{}, fmt.Errorf("couldn't run %s: %w", name, err)
	}
	return RunCommandResult{Stdout: stdout.String(), Stderr: stderr.String()}, nil
}

// CancelCommand stops an in-flight RunCommand. false means it had
// already finished.
func (a *App) CancelCommand(requestID string) bool {
	if v, ok := runningCommands.Load(requestID); ok {
		v.(context.CancelFunc)()
		return true
	}
	return false
}

// SystemInfo backs oxis.system.info().
type SystemInfo struct {
	OS           string `json:"os"`
	Arch         string `json:"arch"`
	NumCPU       int    `json:"numCPU"`
	GoVersion    string `json:"goVersion"`
	AllocMB      uint64 `json:"allocMB"` // OXIS's own heap, not system memory
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

type ProcessInfo struct {
	PID  int    `json:"pid"`
	Name string `json:"name"`
}

// ListProcesses backs oxis.process.list().
func (a *App) ListProcesses() ([]ProcessInfo, error) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("tasklist", "/FO", "CSV", "/NH")
	default:
		// -A/-o work on both Linux procps and BSD/macOS ps; --no-headers
		// is GNU-only, so skip the header line ourselves instead.
		cmd = exec.Command("ps", "-A", "-o", "pid=,comm=")
	}
	hideWindow(cmd)
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
		var pid int
		if runtime.GOOS == "windows" {
			fields := strings.Split(line, "\",\"")
			if len(fields) < 2 {
				continue
			}
			if _, err := fmt.Sscanf(strings.Trim(fields[1], "\""), "%d", &pid); err != nil {
				continue
			}
			result = append(result, ProcessInfo{PID: pid, Name: strings.Trim(fields[0], "\"")})
			continue
		}
		pidStr, name, ok := strings.Cut(line, " ")
		if !ok {
			continue
		}
		if _, err := fmt.Sscanf(pidStr, "%d", &pid); err != nil {
			continue
		}
		result = append(result, ProcessInfo{PID: pid, Name: strings.TrimSpace(name)})
	}
	return result, nil
}

// KillProcess backs oxis.process.kill(pid).
func (a *App) KillProcess(pid int) error {
	if runtime.GOOS == "windows" {
		cmd := exec.Command("taskkill", "/PID", fmt.Sprintf("%d", pid), "/F")
		hideWindow(cmd)
		return cmd.Run()
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return proc.Kill()
}

// Run starts OXIS as a native window and blocks until it closes.
//
// The frontend is served as the window's embedded assets. A separate
// loopback HTTP server (server.Listen) carries the PTY WebSocket and
// also serves the same frontend at http://127.0.0.1:1420 for browsers.
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

	// Saved by 'oxis resize (window.json); defaults to 940x600.
	winWidth, winHeight := loadWindowSize()

	return wails.Run(&options.App{
		Title:     "OXIS",
		Width:     winWidth,
		Height:    winHeight,
		MinWidth:  minWinWidth,
		MinHeight: minWinHeight,
		MaxWidth:  maxWinWidth,
		MaxHeight: maxWinHeight,
		Frameless: true,
		// No drag handles on Windows/macOS; the size comes from 'oxis
		// resize. GTK ignores programmatic resizes of a non-resizable
		// window, so Linux keeps it resizable.
		DisableResize:    runtime.GOOS != "linux",
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
