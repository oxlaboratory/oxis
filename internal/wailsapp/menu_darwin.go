//go:build darwin

package wailsapp

import (
	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/menu/keys"
	"github.com/wailsapp/wails/v2/pkg/options"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// platformOptions: on macOS, the menus a Mac app needs. Without an Edit
// menu a Mac web view doesn't copy, paste, cut or select all with ⌘C ⌘V
// ⌘X ⌘A, and without the app menu there's no ⌘Q or ⌘H. The Edit items
// are OXIS's own, not the system's: each tells the page (the event
// "menu_edit"), so undo and redo are the editor's, and copy/paste go
// through OXIS's clipboard.
func platformOptions(o *options.App, a *App) {
	send := func(action string) menu.Callback {
		return func(*menu.CallbackData) {
			if a.ctx != nil {
				wailsRuntime.EventsEmit(a.ctx, "menu_edit", action)
			}
		}
	}
	edit := menu.NewMenu()
	edit.AddText("Undo", keys.CmdOrCtrl("z"), send("undo"))
	edit.AddText("Redo", keys.Combo("z", keys.CmdOrCtrlKey, keys.ShiftKey), send("redo"))
	edit.AddSeparator()
	edit.AddText("Cut", keys.CmdOrCtrl("x"), send("cut"))
	edit.AddText("Copy", keys.CmdOrCtrl("c"), send("copy"))
	edit.AddText("Paste", keys.CmdOrCtrl("v"), send("paste"))
	edit.AddText("Select All", keys.CmdOrCtrl("a"), send("selectAll"))

	m := menu.NewMenu()
	m.Append(menu.AppMenu())
	m.Append(menu.SubMenu("Edit", edit))
	m.Append(menu.WindowMenu())
	o.Menu = m
}
