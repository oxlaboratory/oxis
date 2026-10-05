package wailsapp

import (
	"fmt"
	"strings"
)

// Modifier bits, as RegisterHotKey takes them.
const (
	modAlt   = 0x1
	modCtrl  = 0x2
	modShift = 0x4
	modWin   = 0x8
)

// parseHotkey reads "Win+`", "Ctrl+Alt+T", "Alt+Space", "Ctrl+F12" into
// modifier bits and a Windows virtual-key code.
func parseHotkey(spec string) (mods, vk uint32, err error) {
	parts := strings.Split(spec, "+")
	key := strings.TrimSpace(parts[len(parts)-1])
	if key == "" && len(parts) > 1 { // "Ctrl++"
		key = "+"
		parts = parts[:len(parts)-1]
	}
	for _, m := range parts[:len(parts)-1] {
		switch strings.ToLower(strings.TrimSpace(m)) {
		case "ctrl", "control":
			mods |= modCtrl
		case "alt":
			mods |= modAlt
		case "shift":
			mods |= modShift
		case "win", "super", "meta", "cmd":
			mods |= modWin
		default:
			return 0, 0, fmt.Errorf("unknown modifier %q", m)
		}
	}
	if mods == 0 {
		return 0, 0, fmt.Errorf("%q needs a modifier (Ctrl, Alt, Shift or Win)", spec)
	}
	upper := strings.ToUpper(key)
	switch {
	case len(upper) == 1 && (upper[0] >= 'A' && upper[0] <= 'Z' || upper[0] >= '0' && upper[0] <= '9'):
		vk = uint32(upper[0])
	case upper == "`" || upper == "~":
		vk = 0xC0 // VK_OEM_3
	case upper == "SPACE":
		vk = 0x20
	case upper == "ENTER" || upper == "RETURN":
		vk = 0x0D
	case upper == "+" || upper == "=":
		vk = 0xBB // VK_OEM_PLUS
	case upper == "-":
		vk = 0xBD // VK_OEM_MINUS
	case len(upper) >= 2 && upper[0] == 'F':
		var n int
		if _, e := fmt.Sscanf(upper[1:], "%d", &n); e == nil && n >= 1 && n <= 24 && fmt.Sprint(n) == upper[1:] {
			vk = 0x70 + uint32(n-1)
		}
	}
	if vk == 0 {
		return 0, 0, fmt.Errorf("unknown key %q", key)
	}
	return mods, vk, nil
}

// SetSummonKey makes a key OXIS's from anywhere: pressed, it brings the
// window to the front, or tucks it away when it's already there. ""
// turns it off. The answer is "" or why the key couldn't be had.
func (a *App) SetSummonKey(spec string) string {
	if err := setSummonKey(strings.TrimSpace(spec), a.toggleWindow); err != nil {
		return err.Error()
	}
	return ""
}
