//go:build windows

package wailsapp

import (
	"testing"
	"unsafe"
)

// NOTIFYICONDATAW is 976 bytes on 64-bit Windows (956 on 32-bit); a
// wrong size and Shell_NotifyIconW refuses it.
func TestNotifyIconDataSize(t *testing.T) {
	want := uintptr(976)
	if unsafe.Sizeof(uintptr(0)) == 4 {
		want = 956
	}
	if got := unsafe.Sizeof(notifyIconData{}); got != want {
		t.Errorf("notifyIconData is %d bytes, want %d", got, want)
	}
}
