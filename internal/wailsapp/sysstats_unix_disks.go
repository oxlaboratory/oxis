//go:build !windows

package wailsapp

import (
	"os"
	"syscall"
)

// disks: / and the home folder's filesystem when it's a different one.
func disks() []DiskInfo {
	var out []DiskInfo
	seen := map[uint64]bool{}
	add := func(path string) {
		var st syscall.Statfs_t
		if syscall.Statfs(path, &st) != nil || st.Blocks == 0 {
			return
		}
		total := st.Blocks * uint64(st.Bsize)
		if seen[total] {
			return
		}
		seen[total] = true
		out = append(out, DiskInfo{Mount: path, TotalGB: gb(total), FreeGB: gb(st.Bavail * uint64(st.Bsize))})
	}
	add("/")
	if home, err := os.UserHomeDir(); err == nil {
		add(home)
	}
	return out
}
