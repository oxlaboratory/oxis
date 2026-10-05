package wailsapp

import "testing"

func TestParseHotkey(t *testing.T) {
	for spec, want := range map[string][2]uint32{
		"Win+`":          {modWin, 0xC0},
		"ctrl+alt+t":     {modCtrl | modAlt, 'T'},
		"Alt+Space":      {modAlt, 0x20},
		"Ctrl+Shift+F12": {modCtrl | modShift, 0x7B},
		"Ctrl + 1":       {modCtrl, '1'},
		"Ctrl++":         {modCtrl, 0xBB},
	} {
		mods, vk, err := parseHotkey(spec)
		if err != nil || mods != want[0] || vk != want[1] {
			t.Errorf("%q: %x %x %v, want %x %x", spec, mods, vk, err, want[0], want[1])
		}
	}
	for _, bad := range []string{"T", "`", "Hyper+T", "Ctrl+F25", "Ctrl+F1x", "Ctrl+PgUp", "Ctrl+"} {
		if _, _, err := parseHotkey(bad); err == nil {
			t.Errorf("%q: no error", bad)
		}
	}
}
