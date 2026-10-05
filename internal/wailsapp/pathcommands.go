package wailsapp

import (
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

// PathCommands lists the programs on PATH by the name you'd type them
// with (docker, npm, python — no .exe), for Tab on a command's first
// word. Read again at most once a minute.
func (a *App) PathCommands() []string { return pathCommands() }

var (
	pathMu    sync.Mutex
	pathCache []string
	pathAt    time.Time
	pathFor   string
)

func pathCommands() []string {
	pathMu.Lock()
	defer pathMu.Unlock()
	path := os.Getenv("PATH")
	if pathCache != nil && path == pathFor && time.Since(pathAt) < time.Minute {
		return pathCache
	}
	pathCache, pathAt, pathFor = scanPath(path), time.Now(), path
	return pathCache
}

// scanPath reads every folder on path for programs. On Windows a
// program is a .exe, .cmd, .bat or .ps1 (named without it); elsewhere a
// file anyone may run.
func scanPath(path string) []string {
	windows := runtime.GOOS == "windows"
	seen := map[string]bool{}
	for _, dir := range filepath.SplitList(path) {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			name := e.Name()
			if windows {
				ext := strings.ToLower(filepath.Ext(name))
				if ext != ".exe" && ext != ".cmd" && ext != ".bat" && ext != ".ps1" {
					continue
				}
				name = name[:len(name)-len(ext)]
			} else {
				info, err := e.Info()
				if err != nil || info.Mode()&0o111 == 0 {
					continue
				}
			}
			if name != "" && !strings.HasPrefix(name, ".") {
				seen[name] = true
			}
		}
	}
	out := make([]string, 0, len(seen))
	for n := range seen {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}
