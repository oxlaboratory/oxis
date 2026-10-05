package pty

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
	"unicode/utf8"
)

// 'record: a tab's session saved as an asciinema cast (v2), which
// `asciinema play`, asciinema.org and the web player all play. The
// shell's raw output is written as it arrives, with when; what you type
// isn't (it's in the output when the shell echoes it, and passwords
// aren't).

// A recording stops by itself past this size.
const maxCastBytes = 64 << 20

type recorder struct {
	mu    sync.Mutex
	f     *os.File
	path  string
	start time.Time
	carry []byte // the start of a character cut off at the end of a read
	bytes int64
}

type castHeader struct {
	Version   int               `json:"version"`
	Width     int               `json:"width"`
	Height    int               `json:"height"`
	Timestamp int64             `json:"timestamp"`
	Title     string            `json:"title,omitempty"`
	Env       map[string]string `json:"env,omitempty"`
}

// Start begins writing a cast to path (folders made as needed).
func (r *recorder) Start(path string, cols, rows int, title string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.f != nil {
		return fmt.Errorf("already recording to %s", r.path)
	}
	if path == "" || !filepath.IsAbs(path) {
		return errors.New("a recording needs a full path")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	h, _ := json.Marshal(castHeader{Version: 2, Width: cols, Height: rows, Timestamp: time.Now().Unix(), Title: title,
		Env: map[string]string{"TERM": "xterm-256color"}})
	if _, err := f.Write(append(h, '\n')); err != nil {
		f.Close()
		return err
	}
	r.f, r.path, r.start, r.carry, r.bytes = f, path, time.Now(), nil, int64(len(h)+1)
	return nil
}

// Recording says whether a cast is being written.
func (r *recorder) Recording() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.f != nil
}

func (r *recorder) event(kind, data string) {
	line, _ := json.Marshal([]any{roundMs(time.Since(r.start).Seconds()), kind, data})
	n, err := r.f.Write(append(line, '\n'))
	r.bytes += int64(n)
	if err != nil || r.bytes > maxCastBytes {
		r.f.Close()
		r.f = nil
	}
}

func roundMs(s float64) float64 { return float64(int64(s*1e6+0.5)) / 1e6 }

// Output records what the shell wrote. Casts are JSON, so the text must
// be whole UTF-8 characters: one cut off at the end waits for the rest.
func (r *recorder) Output(b []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.f == nil || len(b) == 0 {
		return
	}
	data := append(r.carry, b...)
	r.carry = nil
	// Up to 3 bytes of an unfinished character at the end.
	for k := 1; k <= 3 && k <= len(data); k++ {
		c := data[len(data)-k]
		if c < 0x80 {
			break
		}
		if c >= 0xC0 { // a start byte: is its character complete?
			if !utf8.FullRune(data[len(data)-k:]) {
				r.carry = append([]byte(nil), data[len(data)-k:]...)
				data = data[:len(data)-k]
			}
			break
		}
	}
	if len(data) > 0 {
		r.event("o", string(data))
	}
}

// Resize records the terminal's new size.
func (r *recorder) Resize(cols, rows int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.f != nil {
		r.event("r", fmt.Sprintf("%dx%d", cols, rows))
	}
}

// Stop finishes the cast: where it is, how long and how big.
func (r *recorder) Stop() (path string, seconds float64, size int64, err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.f == nil {
		if r.path != "" {
			return r.path, 0, r.bytes, errors.New("the recording had already stopped (too big, or the disk said no)")
		}
		return "", 0, 0, errors.New("not recording")
	}
	if len(r.carry) > 0 {
		r.event("o", string(r.carry))
		r.carry = nil
	}
	seconds = time.Since(r.start).Seconds()
	err = r.f.Close()
	r.f = nil
	return r.path, seconds, r.bytes, err
}

// recordingReader passes reads through, recording them.
type recordingReader struct {
	r   io.Reader
	rec *recorder
}

func (t recordingReader) Read(p []byte) (int, error) {
	n, err := t.r.Read(p)
	if n > 0 {
		t.rec.Output(p[:n])
	}
	return n, err
}

// recordMsg handles "record-start" (Data: the path) and "record-stop",
// answering with "recording" or "recorded" (Data: JSON) or an error.
func recordMsg(rec *recorder, m inMsg, size *termSize, send func(outMsg)) {
	switch m.Type {
	case "record-start":
		cols, rows := size.get()
		if err := rec.Start(m.Data, cols, rows, m.Shell); err != nil {
			send(outMsg{Type: "record-error", Message: err.Error()})
			return
		}
		send(outMsg{Type: "recording", Data: m.Data})
	case "record-stop":
		path, secs, n, err := rec.Stop()
		if err != nil && path == "" {
			send(outMsg{Type: "record-error", Message: err.Error()})
			return
		}
		b, _ := json.Marshal(map[string]any{"path": path, "seconds": secs, "bytes": n, "error": errString(err)})
		send(outMsg{Type: "recorded", Data: string(b)})
	}
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
