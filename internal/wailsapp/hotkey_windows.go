//go:build windows

package wailsapp

import (
	"errors"
	"runtime"
	"sync"
	"syscall"
	"unsafe"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

var (
	procRegisterHotKey      = user32Flash.NewProc("RegisterHotKey")
	procUnregisterHotKey    = user32Flash.NewProc("UnregisterHotKey")
	procGetMessageW         = user32Flash.NewProc("GetMessageW")
	procPeekMessageW        = user32Flash.NewProc("PeekMessageW")
	procPostThreadMessageW  = user32Flash.NewProc("PostThreadMessageW")
	procSetForegroundWindow = user32Flash.NewProc("SetForegroundWindow")
	procGetCurrentThreadId  = syscall.NewLazyDLL("kernel32.dll").NewProc("GetCurrentThreadId")
)

const (
	modNoRepeat = 0x4000
	wmHotkey    = 0x0312
	wmQuit      = 0x0012
)

type winMsg struct {
	hwnd    uintptr
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	pt      [2]int32
	private uint32
}

var (
	summonMu     sync.Mutex
	summonThread uintptr       // the thread holding the key, 0 for none
	summonDone   chan struct{} // closed once that thread has let it go
)

// setSummonKey holds the key on a thread of its own (a hotkey belongs to
// the thread that registered it, and arrives in its message queue).
func setSummonKey(spec string, fn func()) error {
	summonMu.Lock()
	defer summonMu.Unlock()
	if summonThread != 0 {
		procPostThreadMessageW.Call(summonThread, wmQuit, 0, 0)
		<-summonDone // or the key is still "taken", by us
		summonThread = 0
	}
	if spec == "" {
		return nil
	}
	mods, vk, err := parseHotkey(spec)
	if err != nil {
		return err
	}
	type started struct {
		tid uintptr
		err error
	}
	ready := make(chan started, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		tid, _, _ := procGetCurrentThreadId.Call()
		if ok, _, _ := procRegisterHotKey.Call(0, 1, uintptr(mods|modNoRepeat), uintptr(vk)); ok == 0 {
			ready <- started{err: errors.New(spec + " is taken by another program")}
			return
		}
		defer procUnregisterHotKey.Call(0, 1)
		// The thread's message queue, made now: a quit posted before it
		// exists would be lost, and the next setSummonKey would wait on.
		var m winMsg
		procPeekMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0, 0)
		ready <- started{tid: tid}
		for {
			r, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
			if int32(r) <= 0 {
				return
			}
			if m.message == wmHotkey {
				fn()
			}
		}
	}()
	s := <-ready
	summonThread, summonDone = s.tid, done
	return s.err
}

// toggleWindow: to the front, or away when it's already there. The
// hotkey's thread is allowed to take the foreground.
func (a *App) toggleWindow() {
	if a.ctx == nil {
		return
	}
	hwnd := mainWindow()
	if fg, _, _ := procGetForegroundWindow.Call(); hwnd != 0 && fg == hwnd {
		wailsRuntime.WindowMinimise(a.ctx)
		return
	}
	wailsRuntime.WindowUnminimise(a.ctx)
	wailsRuntime.WindowShow(a.ctx)
	if hwnd = mainWindow(); hwnd != 0 {
		procSetForegroundWindow.Call(hwnd)
	}
	wailsRuntime.EventsEmit(a.ctx, "summoned")
}
