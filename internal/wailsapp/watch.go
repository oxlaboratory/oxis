package wailsapp

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"
)

// WatchOptions is what oxis.fs.watch passes in.
type WatchOptions struct {
	Path       string   `json:"path"`
	Recursive  bool     `json:"recursive"`
	Ignore     []string `json:"ignore"`     // file or folder names skipped anywhere below Path
	DebounceMs int      `json:"debounceMs"` // changes are gathered this long, then reported once per path
}

const (
	watchDefaultDebounce = 100 * time.Millisecond
	watchMaxDirs         = 20000
)

// watchDefaultIgnore applies when the plugin passes no ignore list.
var watchDefaultIgnore = []string{".git", "node_modules"}

// WatchStart backs oxis.fs.watch: "change" events ({path, op} with op
// create, write, remove or rename) for a file, or a folder and (with
// Recursive) everything below it. Bursts are gathered for DebounceMs and
// reported once per path, so an editor's save (often a write, a rename
// and a chmod) is one change. StreamClose stops watching. The plugin's
// "fs" permission is checked before this is called (pluginAPI.ts).
func (a *App) WatchStart(id string, o WatchOptions) error {
	root := resolvePath(o.Path)
	info, err := os.Stat(root)
	if err != nil {
		return fmt.Errorf("can't watch %s: %w", root, errors.Unwrap(err))
	}
	ignore := map[string]bool{}
	names := o.Ignore
	if names == nil {
		names = watchDefaultIgnore
	}
	for _, n := range names {
		ignore[n] = true
	}
	debounce := watchDefaultDebounce
	if o.DebounceMs > 0 {
		debounce = min(time.Duration(o.DebounceMs)*time.Millisecond, 10*time.Second)
	}

	w, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	// A single file is watched through its folder: editors often save by
	// writing a new file and renaming it over the old one.
	target := ""
	dir := root
	if !info.IsDir() {
		target, dir = root, filepath.Dir(root)
	}
	dirs := 0
	add := func(d string) error {
		if dirs >= watchMaxDirs {
			return fmt.Errorf("more than %d folders under %s; watch a smaller folder or add names to ignore", watchMaxDirs, root)
		}
		dirs++
		return w.Add(d)
	}
	if err := addWatchTree(dir, target == "" && o.Recursive, ignore, add, nil); err != nil {
		w.Close()
		return err
	}

	ctx, err := streams.open(id)
	if err != nil {
		w.Close()
		return err
	}
	go func() {
		defer w.Close()
		pending := map[string]string{}
		var flush <-chan time.Time
		for {
			select {
			case <-ctx.Done():
				streams.finish(StreamEvent{ID: id})
				return
			case err, ok := <-w.Errors:
				if !ok {
					streams.finish(StreamEvent{ID: id, Error: "the watcher stopped"})
					return
				}
				streams.push(StreamEvent{ID: id, Type: "error", Error: err.Error()})
			case ev, ok := <-w.Events:
				if !ok {
					streams.finish(StreamEvent{ID: id, Error: "the watcher stopped"})
					return
				}
				if target != "" && ev.Name != target {
					continue
				}
				if target == "" && ignoredPath(root, ev.Name, ignore) {
					continue
				}
				op := watchOp(ev.Op)
				if op == "" {
					continue
				}
				pending[ev.Name] = mergeWatchOp(pending[ev.Name], op)
				// A folder created below a recursive watch is watched too,
				// and what's already in it (a folder moved in, or files
				// written before the watch was added) is reported.
				if target == "" && o.Recursive && ev.Has(fsnotify.Create) {
					if fi, err := os.Lstat(ev.Name); err == nil && fi.IsDir() {
						_ = addWatchTree(ev.Name, true, ignore, add, func(p string) {
							if _, seen := pending[p]; !seen {
								pending[p] = "create"
							}
						})
					}
				}
				if flush == nil {
					flush = time.After(debounce)
				}
			case <-flush:
				flush = nil
				paths := make([]string, 0, len(pending))
				for p := range pending {
					paths = append(paths, p)
				}
				sort.Strings(paths)
				for _, p := range paths {
					if pending[p] != "" && !streams.push(StreamEvent{ID: id, Type: "change", Path: p, Op: pending[p]}) {
						break
					}
				}
				pending = map[string]string{}
			}
		}
	}()
	return nil
}

// addWatchTree watches dir and, if recursive, every folder below it
// (skipping ignored names and symlinked folders). found, if set, gets
// every path below dir.
func addWatchTree(dir string, recursive bool, ignore map[string]bool, add func(string) error, found func(string)) error {
	if !recursive {
		return add(dir)
	}
	return filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if p == dir {
				return err
			}
			return nil // unreadable folder below: skip it
		}
		if p != dir && ignore[d.Name()] {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if p != dir && found != nil {
			found(p)
		}
		if d.IsDir() {
			return add(p)
		}
		return nil
	})
}

// ignoredPath: any part of path below root is an ignored name.
func ignoredPath(root, path string, ignore map[string]bool) bool {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return false
	}
	for _, part := range strings.Split(rel, string(filepath.Separator)) {
		if ignore[part] {
			return true
		}
	}
	return false
}

// watchOp names an fsnotify operation; permission changes aren't
// reported.
func watchOp(op fsnotify.Op) string {
	switch {
	case op.Has(fsnotify.Create):
		return "create"
	case op.Has(fsnotify.Remove):
		return "remove"
	case op.Has(fsnotify.Rename):
		return "rename"
	case op.Has(fsnotify.Write):
		return "write"
	}
	return ""
}

// mergeWatchOp combines two changes to one path within a debounce
// window into what a plugin should hear: a file created and then
// written was created; removed (or renamed away) and created again was
// replaced, which is a write (an editor's atomic save); created and
// removed again is nothing.
func mergeWatchOp(prev, next string) string {
	switch {
	case prev == "":
		return next
	case prev == "create" && next == "write":
		return "create"
	case prev == "create" && (next == "remove" || next == "rename"):
		return ""
	case (prev == "remove" || prev == "rename") && next == "create":
		return "write"
	}
	return next
}
