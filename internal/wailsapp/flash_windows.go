//go:build windows

package wailsapp

import (
	"os"
	"syscall"
	"unsafe"
)

var (
	user32Flash             = syscall.NewLazyDLL("user32.dll")
	procEnumWindows         = user32Flash.NewProc("EnumWindows")
	procGetWindowThreadPID  = user32Flash.NewProc("GetWindowThreadProcessId")
	procIsWindowVisible     = user32Flash.NewProc("IsWindowVisible")
	procGetWindow           = user32Flash.NewProc("GetWindow")
	procFlashWindowEx       = user32Flash.NewProc("FlashWindowEx")
	procGetForegroundWindow = user32Flash.NewProc("GetForegroundWindow")
)

type flashWInfo struct {
	cbSize    uint32
	hwnd      uintptr
	dwFlags   uint32
	uCount    uint32
	dwTimeout uint32
}

const (
	flashwTray      = 0x2
	flashwTimerNoFG = 0xC
	gwOwner         = 4
)

// mainWindow is this process's visible top-level window.
func mainWindow() uintptr {
	pid := uint32(os.Getpid())
	var found uintptr
	cb := syscall.NewCallback(func(hwnd, _ uintptr) uintptr {
		var owner uint32
		procGetWindowThreadPID.Call(hwnd, uintptr(unsafe.Pointer(&owner)))
		if owner != pid {
			return 1
		}
		if v, _, _ := procIsWindowVisible.Call(hwnd); v == 0 {
			return 1
		}
		if o, _, _ := procGetWindow.Call(hwnd, gwOwner); o != 0 {
			return 1
		}
		found = hwnd
		return 0
	})
	procEnumWindows.Call(cb, 0)
	return found
}

// flashWindow flashes the taskbar button until the window is in front
// again, unless it already is.
func flashWindow() bool {
	hwnd := mainWindow()
	if hwnd == 0 {
		return false
	}
	if fg, _, _ := procGetForegroundWindow.Call(); fg == hwnd {
		return false
	}
	info := flashWInfo{hwnd: hwnd, dwFlags: flashwTray | flashwTimerNoFG}
	info.cbSize = uint32(unsafe.Sizeof(info))
	procFlashWindowEx.Call(uintptr(unsafe.Pointer(&info)))
	return true
}
