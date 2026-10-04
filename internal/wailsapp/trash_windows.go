//go:build windows

package wailsapp

import (
	"fmt"
	"syscall"
	"unsafe"
)

var procSHFileOperationW = syscall.NewLazyDLL("shell32.dll").NewProc("SHFileOperationW")

// SHFILEOPSTRUCTW (natural alignment on 64-bit Windows).
type shFileOpStruct struct {
	hwnd                  uintptr
	wFunc                 uint32
	pFrom                 *uint16
	pTo                   *uint16
	fFlags                uint16
	fAnyOperationsAborted int32
	hNameMappings         uintptr
	lpszProgressTitle     *uint16
}

const (
	foDelete          = 0x3
	fofSilent         = 0x4
	fofNoConfirmation = 0x10
	fofAllowUndo      = 0x40
	fofNoErrorUI      = 0x400
)

// moveToTrash sends full (an absolute path) to the Recycle Bin.
func moveToTrash(full string) error {
	from, err := syscall.UTF16FromString(full)
	if err != nil {
		return err
	}
	from = append(from, 0) // pFrom is a list, ended by an empty string
	op := shFileOpStruct{
		wFunc:  foDelete,
		pFrom:  &from[0],
		fFlags: fofAllowUndo | fofNoConfirmation | fofSilent | fofNoErrorUI,
	}
	r, _, _ := procSHFileOperationW.Call(uintptr(unsafe.Pointer(&op)))
	if r != 0 {
		return fmt.Errorf("couldn't move %s to the Recycle Bin (error 0x%x)", full, r)
	}
	if op.fAnyOperationsAborted != 0 {
		return fmt.Errorf("moving %s to the Recycle Bin was cancelled", full)
	}
	return nil
}
