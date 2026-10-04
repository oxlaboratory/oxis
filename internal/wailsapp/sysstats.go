package wailsapp

import (
	"strconv"
	"strings"
	"sync"
	"time"
)

// Live numbers for oxis.system.info(): memory, CPU, uptime and disks,
// read from the OS (sysstats_windows.go, sysstats_other.go) with no extra
// dependencies.

// DiskInfo is one disk (a fixed drive on Windows, a mounted filesystem
// elsewhere).
type DiskInfo struct {
	Mount   string  `json:"mount"`
	TotalGB float64 `json:"totalGB"`
	FreeGB  float64 `json:"freeGB"`
}

func gb(bytes uint64) float64 { return float64(bytes*100/(1<<30)) / 100 }

// CPU use is the busy share of time between two samples of the system's
// idle and total counters: since the previous call, or over a short
// pause the first time.
var cpuSample struct {
	sync.Mutex
	idle, total uint64
	at          time.Time
}

func cpuPercent() float64 {
	cpuSample.Lock()
	defer cpuSample.Unlock()
	idle, total, ok := cpuTimes()
	if !ok {
		return 0
	}
	if cpuSample.total == 0 || time.Since(cpuSample.at) > time.Minute {
		time.Sleep(150 * time.Millisecond)
		cpuSample.idle, cpuSample.total = idle, total
		idle, total, ok = cpuTimes()
		if !ok {
			return 0
		}
	}
	dIdle, dTotal := idle-cpuSample.idle, total-cpuSample.total
	cpuSample.idle, cpuSample.total, cpuSample.at = idle, total, time.Now()
	if dTotal == 0 || dIdle > dTotal {
		return 0
	}
	return float64((dTotal-dIdle)*1000/dTotal) / 10
}

// parseProcessList reads `tasklist /FO CSV /NH` (Windows) or
// `ps -A -o pid=,rss=,pcpu=,comm=` (elsewhere).
func parseProcessList(windows bool, out string) []ProcessInfo {
	lines := strings.Split(strings.TrimSpace(out), "\n")
	result := make([]ProcessInfo, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if windows {
			// "name","pid","session","#","12,345 K" — the thousands
			// separator depends on the locale, so keep only digits.
			fields := strings.Split(strings.Trim(line, "\""), "\",\"")
			if len(fields) < 2 {
				continue
			}
			pid, err := strconv.Atoi(fields[1])
			if err != nil {
				continue
			}
			p := ProcessInfo{PID: pid, Name: fields[0], CPU: -1}
			if len(fields) >= 5 {
				digits := strings.Map(func(r rune) rune {
					if r >= '0' && r <= '9' {
						return r
					}
					return -1
				}, fields[4])
				if kb, err := strconv.ParseFloat(digits, 64); err == nil {
					p.MemMB = float64(int(kb/1024*10)) / 10
				}
			}
			result = append(result, p)
			continue
		}
		f := strings.Fields(line)
		if len(f) < 4 {
			continue
		}
		pid, err := strconv.Atoi(f[0])
		if err != nil {
			continue
		}
		rss, _ := strconv.ParseFloat(f[1], 64)
		cpu, _ := strconv.ParseFloat(f[2], 64)
		result = append(result, ProcessInfo{
			PID: pid, Name: strings.Join(f[3:], " "),
			MemMB: float64(int(rss/1024*10)) / 10, CPU: cpu,
		})
	}
	return result
}
