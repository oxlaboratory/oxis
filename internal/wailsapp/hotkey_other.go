//go:build !windows

package wailsapp

import "errors"

// setSummonKey: a key from anywhere is Windows-only for now.
func setSummonKey(spec string, fn func()) error {
	if spec == "" {
		return nil
	}
	if _, _, err := parseHotkey(spec); err != nil {
		return err
	}
	return errors.New("a key from anywhere works on Windows only, for now")
}

func (a *App) toggleWindow() {}
