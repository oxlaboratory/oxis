package wailsapp

import (
	"runtime"
	"testing"
)

func TestParseProcessList(t *testing.T) {
	win := parseProcessList(true, `"System Idle Process","0","Services","0","8 K"
"chrome.exe","4242","Console","1","1,234,567 K"
"Code.exe","77","Console","1","98.304 K"
garbage`)
	if len(win) != 3 {
		t.Fatalf("windows: %d processes, want 3: %+v", len(win), win)
	}
	if win[1].PID != 4242 || win[1].Name != "chrome.exe" || win[1].MemMB != 1205.6 || win[1].CPU != -1 {
		t.Errorf("windows: %+v", win[1])
	}
	if win[2].MemMB != 96 { // a "." thousands separator (German locale)
		t.Errorf("windows dotted: %+v", win[2])
	}

	unix := parseProcessList(false, `    1  11264  0.0 systemd
 4321 204800 12.5 node
 99 2048 0.3 Web Content`)
	if len(unix) != 3 || unix[1].PID != 4321 || unix[1].MemMB != 200 || unix[1].CPU != 12.5 || unix[2].Name != "Web Content" {
		t.Errorf("unix: %+v", unix)
	}
}

func TestSystemInfoNumbers(t *testing.T) {
	a := &App{}
	info := a.SystemInfo()
	if info.MemTotalMB == 0 || info.MemUsedMB == 0 || info.MemUsedMB > info.MemTotalMB {
		t.Errorf("memory: %d used of %d MB", info.MemUsedMB, info.MemTotalMB)
	}
	if info.CPUPercent < 0 || info.CPUPercent > 100 {
		t.Errorf("cpu: %v%%", info.CPUPercent)
	}
	if info.UptimeSec == 0 {
		t.Error("uptime: 0")
	}
	if len(info.Disks) == 0 || info.Disks[0].TotalGB <= 0 || info.Disks[0].FreeGB > info.Disks[0].TotalGB {
		t.Errorf("disks: %+v", info.Disks)
	}
	if runtime.GOOS != "windows" && len(info.Load) != 3 {
		t.Errorf("load: %v", info.Load)
	}
}
