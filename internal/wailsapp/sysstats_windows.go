//go:build windows

package wailsapp

import (
	"syscall"
	"unsafe"
)

var (
	kernel32Stats            = syscall.NewLazyDLL("kernel32.dll")
	procGlobalMemoryStatusEx = kernel32Stats.NewProc("GlobalMemoryStatusEx")
	procGetSystemTimes       = kernel32Stats.NewProc("GetSystemTimes")
	procGetTickCount64       = kernel32Stats.NewProc("GetTickCount64")
	procGetLogicalDrives     = kernel32Stats.NewProc("GetLogicalDrives")
	procGetDriveTypeW        = kernel32Stats.NewProc("GetDriveTypeW")
	procGetDiskFreeSpaceExW  = kernel32Stats.NewProc("GetDiskFreeSpaceExW")
)

type memoryStatusEx struct {
	Length, MemoryLoad                       uint32
	TotalPhys, AvailPhys                     uint64
	TotalPageFile, AvailPageFile             uint64
	TotalVirtual, AvailVirtual, AvailExtVirt uint64
}

func memoryMB() (total, used uint64) {
	var m memoryStatusEx
	m.Length = uint32(unsafe.Sizeof(m))
	if r, _, _ := procGlobalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&m))); r == 0 {
		return 0, 0
	}
	return m.TotalPhys >> 20, (m.TotalPhys - m.AvailPhys) >> 20
}

// cpuTimes: idle and total (kernel, which includes idle, plus user) time.
func cpuTimes() (idle, total uint64, ok bool) {
	var i, k, u syscall.Filetime
	r, _, _ := procGetSystemTimes.Call(uintptr(unsafe.Pointer(&i)), uintptr(unsafe.Pointer(&k)), uintptr(unsafe.Pointer(&u)))
	if r == 0 {
		return 0, 0, false
	}
	ft := func(f syscall.Filetime) uint64 { return uint64(f.HighDateTime)<<32 | uint64(f.LowDateTime) }
	return ft(i), ft(k) + ft(u), true
}

func uptimeSeconds() uint64 {
	r, _, _ := procGetTickCount64.Call()
	return uint64(r) / 1000
}

func loadAverage() []float64 { return nil } // Windows has no load average

// disks: the fixed drives.
func disks() []DiskInfo {
	mask, _, _ := procGetLogicalDrives.Call()
	var out []DiskInfo
	for i := 0; i < 26; i++ {
		if mask&(1<<uint(i)) == 0 {
			continue
		}
		root := string(rune('A'+i)) + `:\`
		p, err := syscall.UTF16PtrFromString(root)
		if err != nil {
			continue
		}
		if t, _, _ := procGetDriveTypeW.Call(uintptr(unsafe.Pointer(p))); t != 3 { // DRIVE_FIXED
			continue
		}
		var free, total, totalFree uint64
		r, _, _ := procGetDiskFreeSpaceExW.Call(uintptr(unsafe.Pointer(p)),
			uintptr(unsafe.Pointer(&free)), uintptr(unsafe.Pointer(&total)), uintptr(unsafe.Pointer(&totalFree)))
		if r == 0 || total == 0 {
			continue
		}
		out = append(out, DiskInfo{Mount: root, TotalGB: gb(total), FreeGB: gb(free)})
	}
	return out
}
