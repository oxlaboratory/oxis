//go:build !windows

package wailsapp

import (
	"bufio"
	"os"
	"runtime"
	"strings"
)

// osName describes the running system, e.g. "Ubuntu 24.04.1 LTS (Linux
// 6.8.0-45-generic)", from os-release and the kernel release.
func osName() string {
	name := runtime.GOOS
	if f, err := os.Open("/etc/os-release"); err == nil {
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			if v, ok := strings.CutPrefix(sc.Text(), "PRETTY_NAME="); ok {
				if v = strings.Trim(v, `"'`); v != "" {
					name = v
				}
				break
			}
		}
		f.Close()
	}
	if b, err := os.ReadFile("/proc/sys/kernel/osrelease"); err == nil {
		name += " (Linux " + strings.TrimSpace(string(b)) + ")"
	}
	return name
}
