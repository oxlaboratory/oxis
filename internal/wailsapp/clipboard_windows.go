//go:build windows

package wailsapp

import (
	"syscall"
	"time"
	"unsafe"
)

var (
	user32Clip   = syscall.NewLazyDLL("user32.dll")
	kernel32Clip = syscall.NewLazyDLL("kernel32.dll")

	procOpenClipboard    = user32Clip.NewProc("OpenClipboard")
	procCloseClipboard   = user32Clip.NewProc("CloseClipboard")
	procEmptyClipboard   = user32Clip.NewProc("EmptyClipboard")
	procSetClipboardData = user32Clip.NewProc("SetClipboardData")

	procGlobalAlloc   = kernel32Clip.NewProc("GlobalAlloc")
	procGlobalFree    = kernel32Clip.NewProc("GlobalFree")
	procGlobalLock    = kernel32Clip.NewProc("GlobalLock")
	procGlobalUnlock  = kernel32Clip.NewProc("GlobalUnlock")
	procRtlMoveMemory = kernel32Clip.NewProc("RtlMoveMemory")
)

const (
	cfUnicodeText = 13     // CF_UNICODETEXT
	gmemMoveable  = 0x0002 // GMEM_MOVEABLE
)

// writeClipboardNative writes to the Windows clipboard with raw Win32
// calls (no cgo). It's the fallback when the WebView's
// navigator.clipboard is rejected (permissions or focus).
func writeClipboardNative(text string) error {
	// Another program can hold the clipboard briefly; retry a few times.
	var err error
	opened := false
	for i := 0; i < 5 && !opened; i++ {
		var r uintptr
		r, _, err = procOpenClipboard.Call(0)
		opened = r != 0
		if !opened {
			time.Sleep(20 * time.Millisecond)
		}
	}
	if !opened {
		return err
	}
	defer procCloseClipboard.Call()

	if r, _, err := procEmptyClipboard.Call(); r == 0 {
		return err
	}

	utf16, err := syscall.UTF16FromString(text)
	if err != nil {
		return err
	}
	size := uintptr(len(utf16)) * 2 // bytes, including the terminating NUL

	hMem, _, err := procGlobalAlloc.Call(gmemMoveable, size)
	if hMem == 0 {
		return err
	}
	ptr, _, err := procGlobalLock.Call(hMem)
	if ptr == 0 {
		procGlobalFree.Call(hMem)
		return err
	}
	procRtlMoveMemory.Call(ptr, uintptr(unsafe.Pointer(&utf16[0])), size)
	procGlobalUnlock.Call(hMem)

	if r, _, err := procSetClipboardData.Call(cfUnicodeText, hMem); r == 0 {
		procGlobalFree.Call(hMem)
		return err
	}
	// The system owns hMem now; it must not be freed here.
	return nil
}
