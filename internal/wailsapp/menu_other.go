//go:build !darwin

package wailsapp

import "github.com/wailsapp/wails/v2/pkg/options"

// platformOptions: nothing to add outside macOS.
func platformOptions(*options.App, *App) {}
