//go:build windows

package wailsapp

import (
	"runtime"
	"syscall"
	"unsafe"
)

// The taskbar button's progress (ITaskbarList3), as Windows Terminal
// shows a program's OSC 9;4: green with a percentage, a moving bar,
// red for an error, yellow when paused.

var (
	ole32              = syscall.NewLazyDLL("ole32.dll")
	procCoInitializeEx = ole32.NewProc("CoInitializeEx")
	procCoUninitialize = ole32.NewProc("CoUninitialize")
	procCoCreateInst   = ole32.NewProc("CoCreateInstance")
)

type guid struct {
	d1     uint32
	d2, d3 uint16
	d4     [8]byte
}

var (
	clsidTaskbarList = guid{0x56FDF344, 0xFD6D, 0x11d0, [8]byte{0x95, 0x8A, 0x00, 0x60, 0x97, 0xC9, 0xA0, 0x90}}
	iidTaskbarList3  = guid{0xEA1AFB91, 0x9E28, 0x4B86, [8]byte{0x90, 0xE9, 0x9E, 0x9F, 0x8A, 0x5E, 0xEF, 0xAF}}
)

// ITaskbarList3's methods, by their place in its vtable.
const (
	vtRelease          = 2
	vtHrInit           = 3
	vtSetProgressValue = 9
	vtSetProgressState = 10
)

// OSC 9;4 states → TBPF flags: none, normal, error, indeterminate, paused.
var tbpf = [...]uintptr{0x0, 0x2, 0x4, 0x1, 0x8}

// comObject is a COM interface pointer: its first word is the vtable.
type comObject struct{ vtbl *[16]uintptr }

func comCall(obj *comObject, index int, args ...uintptr) uintptr {
	r, _, _ := syscall.SyscallN(obj.vtbl[index], append([]uintptr{uintptr(unsafe.Pointer(obj))}, args...)...)
	return r
}

// taskbarProgress sets the button's progress: state as OSC 9;4 numbers
// it (0 clears), pct 0–100.
func taskbarProgress(state, pct int) bool {
	if state < 0 || state >= len(tbpf) {
		return false
	}
	hwnd := mainWindow()
	if hwnd == 0 {
		return false
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	hr, _, _ := procCoInitializeEx.Call(0, 2) // COINIT_APARTMENTTHREADED
	if int32(hr) >= 0 {
		defer procCoUninitialize.Call()
	}
	var tb *comObject
	const clsctxInprocServer = 1
	if r, _, _ := procCoCreateInst.Call(uintptr(unsafe.Pointer(&clsidTaskbarList)), 0, clsctxInprocServer,
		uintptr(unsafe.Pointer(&iidTaskbarList3)), uintptr(unsafe.Pointer(&tb))); int32(r) < 0 || tb == nil {
		return false
	}
	defer comCall(tb, vtRelease)
	if int32(comCall(tb, vtHrInit)) < 0 {
		return false
	}
	comCall(tb, vtSetProgressState, hwnd, tbpf[state])
	if state == 1 || state == 2 || state == 4 {
		comCall(tb, vtSetProgressValue, hwnd, uintptr(max(0, min(100, pct))), 100)
	}
	return true
}
