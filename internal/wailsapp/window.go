package wailsapp

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// Window size limits. The window has no drag-resize handles; its size
// is set with 'oxis resize and remembered in window.json next to the
// app's data.
const (
	defaultWinWidth  = 940
	defaultWinHeight = 600
	minWinWidth      = 640
	minWinHeight     = 400
	maxWinWidth      = 3840
	maxWinHeight     = 2160
)

const windowConfigName = "window.json"

// WindowSize is the persisted window.json shape.
type WindowSize struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}

func clampSize(w, h int) (int, int) {
	w = max(minWinWidth, min(maxWinWidth, w))
	h = max(minWinHeight, min(maxWinHeight, h))
	return w, h
}

func windowConfigPath() (string, error) {
	dir, err := AppDirPath()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, windowConfigName), nil
}

// loadWindowSize returns the saved size, or the default if there's no
// valid window.json.
func loadWindowSize() (int, int) {
	path, err := windowConfigPath()
	if err != nil {
		return defaultWinWidth, defaultWinHeight
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return defaultWinWidth, defaultWinHeight
	}
	var s WindowSize
	if json.Unmarshal(b, &s) != nil || s.Width <= 0 || s.Height <= 0 {
		return defaultWinWidth, defaultWinHeight
	}
	return clampSize(s.Width, s.Height)
}

func saveWindowSize(w, h int) error {
	path, err := windowConfigPath()
	if err != nil {
		return err
	}
	b, _ := json.MarshalIndent(WindowSize{Width: w, Height: h}, "", "  ")
	return os.WriteFile(path, append(b, '\n'), 0o644)
}

// WindowResult is what the size bindings return to the frontend.
type WindowResult struct {
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	ConfigPath string `json:"configPath"`
	Persisted  bool   `json:"persisted"`
}

// WindowGetSize reports the live window size.
func (a *App) WindowGetSize() WindowResult {
	w, h := wailsRuntime.WindowGetSize(a.ctx)
	path, _ := windowConfigPath()
	return WindowResult{Width: w, Height: h, ConfigPath: path}
}

// WindowSetSize resizes the window, re-centres it, saves the size for
// the next launch, and returns the size the OS actually applied (which
// can differ, e.g. when the requested size is larger than the screen).
func (a *App) WindowSetSize(width, height int) (WindowResult, error) {
	if width <= 0 || height <= 0 {
		return WindowResult{}, fmt.Errorf("invalid size %dx%d", width, height)
	}
	w, h := clampSize(width, height)
	wailsRuntime.WindowSetSize(a.ctx, w, h)
	wailsRuntime.WindowCenter(a.ctx)
	// Let the window manager apply the change before reading it back.
	time.Sleep(120 * time.Millisecond)
	gotW, gotH := wailsRuntime.WindowGetSize(a.ctx)

	res := WindowResult{Width: gotW, Height: gotH}
	res.ConfigPath, _ = windowConfigPath()
	// Persist what was asked for, so a window manager that ignored the
	// live resize still picks it up on the next launch.
	if err := saveWindowSize(w, h); err == nil {
		res.Persisted = true
	}
	return res, nil
}
