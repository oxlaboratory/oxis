//go:build !windows

package wailsapp

import (
	"bufio"
	"os"
	"strconv"
	"strings"
	"syscall"
)

func memoryMB() (total, used uint64) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, 0
	}
	defer f.Close()
	var totalKB, availKB uint64
	s := bufio.NewScanner(f)
	for s.Scan() {
		k, v, ok := strings.Cut(s.Text(), ":")
		if !ok {
			continue
		}
		n, _ := strconv.ParseUint(strings.Fields(v + " 0")[0], 10, 64)
		switch k {
		case "MemTotal":
			totalKB = n
		case "MemAvailable":
			availKB = n
		}
	}
	if totalKB == 0 || availKB > totalKB {
		return totalKB >> 10, 0
	}
	return totalKB >> 10, (totalKB - availKB) >> 10
}

// cpuTimes from the first line of /proc/stat: idle (with iowait) and the
// sum of every column.
func cpuTimes() (idle, total uint64, ok bool) {
	b, err := os.ReadFile("/proc/stat")
	if err != nil {
		return 0, 0, false
	}
	line, _, _ := strings.Cut(string(b), "\n")
	f := strings.Fields(line)
	if len(f) < 5 || f[0] != "cpu" {
		return 0, 0, false
	}
	for i, v := range f[1:] {
		n, _ := strconv.ParseUint(v, 10, 64)
		total += n
		if i == 3 || i == 4 { // idle, iowait
			idle += n
		}
	}
	return idle, total, true
}

func uptimeSeconds() uint64 {
	b, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0
	}
	v, _ := strconv.ParseFloat(strings.Fields(string(b) + " 0")[0], 64)
	return uint64(v)
}

func loadAverage() []float64 {
	b, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return nil
	}
	f := strings.Fields(string(b))
	if len(f) < 3 {
		return nil
	}
	out := make([]float64, 3)
	for i := range out {
		out[i], _ = strconv.ParseFloat(f[i], 64)
	}
	return out
}

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
