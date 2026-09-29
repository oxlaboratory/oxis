package wailsapp

import (
	"bytes"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

// Search in files (the editor's Ctrl+Shift+F): every line under a
// folder that matches, skipping dependency and build folders, binary
// files and very large ones.

// SearchOptions says how to match.
type SearchOptions struct {
	CaseSensitive bool `json:"caseSensitive"`
	WholeWord     bool `json:"wholeWord"`
	Regex         bool `json:"regex"`
	// MaxResults caps the matches returned (0: searchMaxResults).
	MaxResults int `json:"maxResults"`
}

// SearchMatch is one match. Col and Len are in UTF-16 code units, as
// JavaScript counts: Col from the start of the line, At from the start
// of Text (the line, or the part of a long line around the match).
type SearchMatch struct {
	Path string `json:"path"`
	Line int    `json:"line"`
	Col  int    `json:"col"`
	Len  int    `json:"len"`
	Text string `json:"text"`
	At   int    `json:"at"`
}

// SearchResult is what a search found.
type SearchResult struct {
	Matches []SearchMatch `json:"matches"`
	Files   int           `json:"files"`
	// Truncated: it stopped early (too many matches, files or time).
	Truncated bool `json:"truncated"`
	// Superseded: a newer search started, so this one stopped.
	Superseded bool   `json:"superseded"`
	Error      string `json:"error,omitempty"`
}

const (
	searchMaxResults = 2000
	searchMaxFiles   = 30000
	searchMaxSize    = 1 << 20
	searchTimeLimit  = 5 * time.Second
	searchLineWindow = 200 // bytes of a long line shown around its match
)

// searchSkipDirs are folders not worth searching (dependencies, builds,
// caches).
var searchSkipDirs = map[string]bool{
	".git": true, "node_modules": true, "dist": true, "build": true, "out": true,
	"target": true, "vendor": true, "bin": true, "obj": true, "__pycache__": true,
	".venv": true, "venv": true, "coverage": true, ".next": true, ".cache": true,
}

// searchGeneration makes an earlier search stop when a newer one starts
// (the query changes as it's typed).
var searchGeneration atomic.Int64

// SearchFiles searches the files under root for query.
func (a *App) SearchFiles(root, query string, opts SearchOptions) SearchResult {
	gen := searchGeneration.Add(1)
	if query == "" {
		return SearchResult{Matches: []SearchMatch{}}
	}
	re, err := searchPattern(query, opts)
	if err != nil {
		return SearchResult{Matches: []SearchMatch{}, Error: err.Error()}
	}
	max := opts.MaxResults
	if max <= 0 || max > searchMaxResults {
		max = searchMaxResults
	}
	return searchTree(resolvePath(root), root, re, max, func() bool { return searchGeneration.Load() != gen })
}

// searchPattern compiles the query as the options say.
func searchPattern(query string, opts SearchOptions) (*regexp.Regexp, error) {
	pattern := query
	if !opts.Regex {
		pattern = regexp.QuoteMeta(query)
	}
	if opts.WholeWord {
		pattern = `\b(?:` + pattern + `)\b`
	}
	if !opts.CaseSensitive {
		pattern = `(?i)` + pattern
	}
	return regexp.Compile(pattern)
}

// searchTree walks dir (shown to the caller as shownRoot) for re.
func searchTree(dir, shownRoot string, re *regexp.Regexp, max int, superseded func() bool) SearchResult {
	res := SearchResult{Matches: []SearchMatch{}}
	deadline := time.Now().Add(searchTimeLimit)
	shownRoot = strings.TrimRight(filepath.ToSlash(shownRoot), "/")
	_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			if path != dir && searchSkipDirs[d.Name()] {
				return fs.SkipDir
			}
			return nil
		}
		if superseded() {
			res.Superseded = true
			return fs.SkipAll
		}
		if res.Files >= searchMaxFiles || time.Now().After(deadline) {
			res.Truncated = true
			return fs.SkipAll
		}
		if !d.Type().IsRegular() {
			return nil
		}
		info, err := d.Info()
		if err != nil || info.Size() > searchMaxSize {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil || bytes.IndexByte(data[:min(len(data), 8000)], 0) >= 0 {
			return nil // unreadable, or binary
		}
		res.Files++
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return nil
		}
		shown := shownRoot + "/" + filepath.ToSlash(rel)
		if searchFile(data, shown, re, &res, max) {
			res.Truncated = true
			return fs.SkipAll
		}
		return nil
	})
	return res
}

// searchFile adds data's matches to res; true when res is full.
func searchFile(data []byte, shown string, re *regexp.Regexp, res *SearchResult, max int) bool {
	if !re.Match(data) {
		return false
	}
	for n, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSuffix(line, "\r")
		for _, loc := range re.FindAllStringIndex(line, 20) {
			if loc[1] == loc[0] {
				continue // an empty match (a regex like a*) isn't worth showing
			}
			res.Matches = append(res.Matches, searchMatch(shown, n+1, line, loc[0], loc[1]))
			if len(res.Matches) >= max {
				return true
			}
		}
	}
	return false
}

// searchMatch describes the match at line[start:end].
func searchMatch(path string, lineNo int, line string, start, end int) SearchMatch {
	m := SearchMatch{Path: path, Line: lineNo, Col: utf16Len(line[:start]), Len: utf16Len(line[start:end])}
	from, to := 0, len(line)
	if len(line) > searchLineWindow*2 {
		from = max(0, start-searchLineWindow/3)
		to = min(len(line), from+searchLineWindow*2)
		for from > 0 && !utf8.RuneStart(line[from]) {
			from--
		}
		for to < len(line) && !utf8.RuneStart(line[to]) {
			to++
		}
	}
	m.Text = line[from:to]
	m.At = utf16Len(line[from:start])
	return m
}

// utf16Len is how long s is in JavaScript.
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		n += len(utf16.Encode([]rune{r}))
	}
	return n
}
