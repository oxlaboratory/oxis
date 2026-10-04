//go:build darwin

package wailsapp

import (
	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/options"
)

// platformOptions: on macOS the standard menus. Without the Edit menu a
// Mac web view doesn't copy, paste, cut or select all with ⌘C ⌘V ⌘X ⌘A,
// and without the app menu there's no ⌘Q or ⌘H.
func platformOptions(o *options.App) {
	m := menu.NewMenu()
	m.Append(menu.AppMenu())
	m.Append(menu.EditMenu())
	m.Append(menu.WindowMenu())
	o.Menu = m
}
