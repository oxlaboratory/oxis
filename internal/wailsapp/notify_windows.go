//go:build windows

package wailsapp

import (
	"os"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

// A desktop notification through the notification area: a tray icon is
// added for as long as the notification shows, carrying it (Windows 10
// and 11 show it as a toast). No PowerShell, no WinRT.

var (
	shell32Notify       = syscall.NewLazyDLL("shell32.dll")
	procShellNotifyIcon = shell32Notify.NewProc("Shell_NotifyIconW")
	procExtractIcon     = shell32Notify.NewProc("ExtractIconW")
)

const (
	nimAdd       = 0
	nimDelete    = 2
	nifIcon      = 0x2
	nifTip       = 0x4
	nifInfo      = 0x10
	niifUser     = 0x4
	niifLargeIco = 0x20
)

type notifyIconData struct {
	cbSize           uint32
	hWnd             uintptr
	uID              uint32
	uFlags           uint32
	uCallbackMessage uint32
	hIcon            uintptr
	szTip            [128]uint16
	dwState          uint32
	dwStateMask      uint32
	szInfo           [256]uint16
	uTimeout         uint32
	szInfoTitle      [64]uint16
	dwInfoFlags      uint32
	guidItem         [16]byte
	hBalloonIcon     uintptr
}

func copyUTF16(dst []uint16, s string) {
	u, _ := syscall.UTF16FromString(s)
	if len(u) > len(dst) {
		u = append(u[:len(dst)-1], 0)
	}
	copy(dst, u)
}

var (
	notifyMu   sync.Mutex
	notifySeq  uint32
	notifyIcon uintptr
)

// showNotification shows title and body as a desktop notification and
// removes its tray icon once it has had time to be read.
func showNotification(title, body string) bool {
	hwnd := mainWindow()
	if hwnd == 0 {
		return false
	}
	notifyMu.Lock()
	if notifyIcon == 0 {
		if exe, err := os.Executable(); err == nil {
			p, _ := syscall.UTF16PtrFromString(exe)
			notifyIcon, _, _ = procExtractIcon.Call(0, uintptr(unsafe.Pointer(p)), 0)
			if notifyIcon <= 1 { // 1: not an icon file
				notifyIcon = 0
			}
		}
	}
	notifySeq++
	id := 0x4F00 + notifySeq%64
	notifyMu.Unlock()

	nid := notifyIconData{hWnd: hwnd, uID: id, uFlags: nifIcon | nifTip | nifInfo, hIcon: notifyIcon,
		dwInfoFlags: niifUser | niifLargeIco, uTimeout: 10000}
	nid.cbSize = uint32(unsafe.Sizeof(nid))
	copyUTF16(nid.szTip[:], "OXIS")
	copyUTF16(nid.szInfoTitle[:], title)
	copyUTF16(nid.szInfo[:], body)
	if r, _, _ := procShellNotifyIcon.Call(nimAdd, uintptr(unsafe.Pointer(&nid))); r == 0 {
		return false
	}
	go func() {
		time.Sleep(12 * time.Second)
		del := notifyIconData{hWnd: hwnd, uID: id}
		del.cbSize = uint32(unsafe.Sizeof(del))
		procShellNotifyIcon.Call(nimDelete, uintptr(unsafe.Pointer(&del)))
	}()
	return true
}
