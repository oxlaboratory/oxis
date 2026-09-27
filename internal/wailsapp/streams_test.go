package wailsapp

import (
	"bufio"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// collect polls until the stream's "end" event (or the deadline) and
// returns its events.
func collect(t *testing.T, session int, id string, within time.Duration) []StreamEvent {
	t.Helper()
	var got []StreamEvent
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		for _, ev := range streams.poll(session, 200*time.Millisecond) {
			if ev.ID != id {
				continue
			}
			got = append(got, ev)
			if ev.Type == "end" {
				return got
			}
		}
	}
	t.Fatalf("%s: no end event within %s; got %+v", id, within, got)
	return nil
}

func joined(evs []StreamEvent, typ string) string {
	var b strings.Builder
	for _, ev := range evs {
		if ev.Type == typ {
			b.WriteString(ev.Data)
		}
	}
	return b.String()
}

func last(evs []StreamEvent) StreamEvent { return evs[len(evs)-1] }

func TestUTF8Joiner(t *testing.T) {
	var j utf8Joiner
	in := []byte("aé日本🙂z")
	var out strings.Builder
	for i := range in { // one byte at a time: every split point
		out.WriteString(j.text(in[i : i+1]))
	}
	out.WriteString(j.flush())
	if out.String() != string(in) {
		t.Errorf("got %q", out.String())
	}
	if s := j.text([]byte{0xE6, 0x97}); s != "" {
		t.Errorf("half a character came out: %q", s)
	}
	if s := j.flush(); s != "\xE6\x97" {
		t.Errorf("flush lost the rest: %q", s)
	}
}

func TestStreamHubMergesAndLimits(t *testing.T) {
	h := newStreamHub()
	session := h.reset()
	if _, err := h.open("a"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.open("a"); err == nil {
		t.Error("the same id opened twice")
	}
	h.push(StreamEvent{ID: "a", Type: "stdout", Data: "one "})
	h.push(StreamEvent{ID: "a", Type: "stdout", Data: "two"})
	h.push(StreamEvent{ID: "a", Type: "stderr", Data: "err"})
	evs := h.poll(session, time.Second)
	if len(evs) != 2 || evs[0].Data != "one two" || evs[1].Data != "err" {
		t.Fatalf("not merged: %+v", evs)
	}

	// Past the queue limit the producer waits for a poll.
	big := strings.Repeat("x", streamQueueLimit/2)
	pushed := make(chan int)
	go func() {
		n := 0
		for i := 0; i < 4; i++ {
			if h.push(StreamEvent{ID: "a", Type: "stdout", Data: big}) {
				n++
			}
		}
		pushed <- n
	}()
	select {
	case <-pushed:
		t.Fatal("the producer never waited")
	case <-time.After(200 * time.Millisecond):
	}
	total := 0
	for total < 4*len(big) {
		for _, ev := range h.poll(session, time.Second) {
			total += len(ev.Data)
		}
	}
	if n := <-pushed; n != 4 {
		t.Errorf("pushed %d of 4", n)
	}

	// Closing releases a waiting producer; the end event still arrives.
	h.push(StreamEvent{ID: "a", Type: "stdout", Data: big})
	h.push(StreamEvent{ID: "a", Type: "stdout", Data: big})
	done := make(chan bool)
	go func() { done <- h.push(StreamEvent{ID: "a", Type: "stdout", Data: big}) }()
	time.Sleep(50 * time.Millisecond)
	h.close("a")
	if ok := <-done; ok {
		t.Error("push to a closed stream reported success")
	}
	h.finish(StreamEvent{ID: "a", Code: 7})
	var end *StreamEvent
	for _, ev := range h.poll(session, time.Second) {
		if ev.Type == "end" {
			end = &ev
		}
	}
	if end == nil || end.Code != 7 {
		t.Errorf("end event: %+v", end)
	}

	// A poll from an old session returns at once and takes nothing.
	h.open("b")
	h.push(StreamEvent{ID: "b", Type: "stdout", Data: "x"})
	newSession := h.reset()
	start := time.Now()
	if evs := h.poll(session, 5*time.Second); len(evs) != 0 || time.Since(start) > time.Second {
		t.Errorf("stale poll got %+v after %s", evs, time.Since(start))
	}
	if newSession == session {
		t.Error("reset kept the session")
	}
}

// TestHelperProcess is the child process for the process tests.
func TestHelperProcess(t *testing.T) {
	mode := os.Getenv("OXIS_TEST_HELPER")
	if mode == "" {
		t.Skip("helper for the process tests")
	}
	switch mode {
	case "echo":
		fmt.Println("hello é")
		fmt.Fprintln(os.Stderr, "to stderr")
		line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
		fmt.Print("got " + line)
		fmt.Println("cwd " + mustGetwd() + " env " + os.Getenv("OXIS_TEST_VALUE"))
		os.Exit(3)
	case "flood":
		w := bufio.NewWriter(os.Stdout)
		for i := 0; i < 200000; i++ {
			fmt.Fprintf(w, "line %d\n", i)
		}
		w.Flush()
		os.Exit(0)
	case "tree":
		// Start a grandchild, report its pid, then wait to be killed.
		child := exec.Command(os.Args[0], "-test.run=TestHelperProcess")
		child.Env = append(os.Environ(), "OXIS_TEST_HELPER=sleep")
		if err := child.Start(); err != nil {
			fmt.Println("error", err)
			os.Exit(1)
		}
		fmt.Println("grandchild", child.Process.Pid)
		time.Sleep(time.Minute)
		os.Exit(0)
	case "sleep":
		time.Sleep(time.Minute)
		os.Exit(0)
	}
}

func mustGetwd() string { d, _ := os.Getwd(); return d }

func helperOptions(mode string) ProcessOptions {
	return ProcessOptions{
		Cmd: os.Args[0], Args: []string{"-test.run=TestHelperProcess"},
		Env: map[string]string{"OXIS_TEST_HELPER": mode},
	}
}

func TestProcessStreams(t *testing.T) {
	a := &App{}
	session := a.StreamsReset()
	dir := t.TempDir()

	o := helperOptions("echo")
	o.Cwd = dir
	o.Env["OXIS_TEST_VALUE"] = "v1"
	pid, err := a.ProcessStart("p1", o)
	if err != nil || pid == 0 {
		t.Fatal(pid, err)
	}
	if err := a.ProcessWrite("p1", "input line\n"); err != nil {
		t.Fatal(err)
	}
	evs := collect(t, session, "p1", 20*time.Second)
	out := joined(evs, "stdout")
	realDir, _ := filepath.EvalSymlinks(dir)
	for _, want := range []string{"hello é\n", "got input line\n", " env v1"} {
		if !strings.Contains(out, want) {
			t.Errorf("stdout %q lacks %q", out, want)
		}
	}
	if !strings.Contains(out, "cwd "+dir) && !strings.Contains(out, "cwd "+realDir) {
		t.Errorf("stdout %q: wrong working directory (want %s)", out, dir)
	}
	if joined(evs, "stderr") != "to stderr\n" {
		t.Errorf("stderr %q", joined(evs, "stderr"))
	}
	if end := last(evs); end.Code != 3 || end.Error != "" {
		t.Errorf("end %+v", end)
	}
	if err := a.ProcessWrite("p1", "x"); err == nil {
		t.Error("wrote to a process that has exited")
	}

	// Lots of output: nothing lost, in order, despite backpressure.
	if _, err := a.ProcessStart("p2", helperOptions("flood")); err != nil {
		t.Fatal(err)
	}
	evs = collect(t, session, "p2", 60*time.Second)
	lines := strings.Split(strings.TrimSuffix(joined(evs, "stdout"), "\n"), "\n")
	if len(lines) != 200000 || lines[0] != "line 0" || lines[199999] != "line 199999" {
		t.Errorf("flood: %d lines, first %q", len(lines), lines[0])
	}

	// A command that doesn't exist fails to start and leaves no stream.
	if _, err := a.ProcessStart("p3", ProcessOptions{Cmd: "oxis-no-such-program"}); err == nil {
		t.Error("started a program that doesn't exist")
	}
	if streams.close("p3") {
		t.Error("a failed start left its stream open")
	}

	if _, err := a.ProcessStart("p4", ProcessOptions{Shell: "echo shell-ok"}); err != nil {
		t.Fatal(err)
	}
	evs = collect(t, session, "p4", 30*time.Second)
	if !strings.Contains(joined(evs, "stdout"), "shell-ok") || last(evs).Code != 0 {
		t.Errorf("shell line: %+v", evs)
	}
}

func TestProcessKillStopsTheTree(t *testing.T) {
	a := &App{}
	session := a.StreamsReset()
	if _, err := a.ProcessStart("tree", helperOptions("tree")); err != nil {
		t.Fatal(err)
	}
	// Wait for the grandchild's pid.
	grandchild := 0
	deadline := time.Now().Add(20 * time.Second)
	var seen strings.Builder
	for grandchild == 0 && time.Now().Before(deadline) {
		for _, ev := range streams.poll(session, 200*time.Millisecond) {
			if ev.ID == "tree" && ev.Type == "stdout" {
				seen.WriteString(ev.Data)
			}
		}
		if _, rest, ok := strings.Cut(seen.String(), "grandchild "); ok && strings.Contains(rest, "\n") {
			grandchild, _ = strconv.Atoi(strings.TrimSpace(strings.SplitN(rest, "\n", 2)[0]))
		}
	}
	if grandchild == 0 {
		t.Fatalf("no grandchild pid in %q", seen.String())
	}
	start := time.Now()
	if !a.StreamClose("tree") {
		t.Fatal("close: not running")
	}
	evs := collect(t, session, "tree", 10*time.Second)
	if end := last(evs); end.Error != "killed" {
		t.Errorf("end %+v", end)
	}
	if time.Since(start) > 5*time.Second {
		t.Errorf("stopping took %s", time.Since(start))
	}
	for i := 0; i < 50 && processAlive(grandchild); i++ {
		time.Sleep(100 * time.Millisecond)
	}
	if processAlive(grandchild) {
		t.Errorf("grandchild %d survived", grandchild)
		if p, err := os.FindProcess(grandchild); err == nil {
			p.Kill()
		}
	}
}

func processAlive(pid int) bool {
	if runtime.GOOS == "windows" {
		out, _ := exec.Command("tasklist", "/FI", "PID eq "+strconv.Itoa(pid), "/NH").Output()
		return strings.Contains(string(out), " "+strconv.Itoa(pid)+" ")
	}
	p, err := os.FindProcess(pid)
	return err == nil && p.Signal(syscall.Signal(0)) == nil
}

func TestProcessArgv(t *testing.T) {
	if _, _, err := processArgv(ProcessOptions{}, "linux"); err == nil {
		t.Error("empty options accepted")
	}
	if _, _, err := processArgv(ProcessOptions{Cmd: "a", Shell: "b"}, "linux"); err == nil {
		t.Error("cmd and shell together accepted")
	}
	name, args, _ := processArgv(ProcessOptions{Shell: "ls | wc -l"}, "linux")
	if name != "/bin/sh" || strings.Join(args, " ") != "-c ls | wc -l" {
		t.Errorf("unix shell: %s %q", name, args)
	}
	name, args, _ = processArgv(ProcessOptions{Shell: "Get-Date"}, "windows")
	if !strings.Contains(strings.ToLower(name), "pwsh") && name != "powershell.exe" || !strings.HasSuffix(args[len(args)-1], "Get-Date") {
		t.Errorf("windows shell: %s %q", name, args)
	}
	env := mergeEnv([]string{"Path=a", "HOME=h"}, map[string]string{"PATH": "b"}, true)
	if strings.Join(env, ";") != "HOME=h;PATH=b" {
		t.Errorf("merged env %q", env)
	}
}

func TestWatchStreams(t *testing.T) {
	a := &App{}
	session := a.StreamsReset()
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("1"), 0o644)
	os.MkdirAll(filepath.Join(dir, "node_modules", "x"), 0o755)

	if err := a.WatchStart("w", WatchOptions{Path: dir, Recursive: true, DebounceMs: 50}); err != nil {
		t.Fatal(err)
	}
	changes := map[string]string{}
	watchID := "w"
	wait := func(path string) {
		t.Helper()
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			if _, ok := changes[path]; ok {
				return
			}
			for _, ev := range streams.poll(session, 200*time.Millisecond) {
				if ev.ID == watchID && ev.Type == "change" {
					changes[ev.Path] = ev.Op
				}
			}
		}
		t.Fatalf("no change for %s; got %v", path, changes)
	}

	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("2"), 0o644)
	wait(filepath.Join(dir, "a.txt"))
	if changes[filepath.Join(dir, "a.txt")] != "write" {
		t.Errorf("a.txt: %v", changes)
	}

	sub := filepath.Join(dir, "sub")
	os.Mkdir(sub, 0o755)
	wait(sub)
	time.Sleep(100 * time.Millisecond) // the new folder is being watched
	os.WriteFile(filepath.Join(sub, "b.txt"), []byte("x"), 0o644)
	wait(filepath.Join(sub, "b.txt"))

	os.WriteFile(filepath.Join(dir, "node_modules", "x", "c.txt"), []byte("x"), 0o644)
	delete(changes, filepath.Join(dir, "a.txt"))
	os.Remove(filepath.Join(dir, "a.txt"))
	wait(filepath.Join(dir, "a.txt"))
	if changes[filepath.Join(dir, "a.txt")] != "remove" {
		t.Errorf("a.txt after remove: %v", changes)
	}
	for p := range changes {
		if strings.Contains(p, "node_modules") {
			t.Errorf("ignored folder reported: %s", p)
		}
	}

	a.StreamClose("w")
	collect(t, session, "w", 5*time.Second)

	// One file: other files in its folder aren't reported.
	file := filepath.Join(dir, "one.txt")
	os.WriteFile(file, []byte("1"), 0o644)
	watchID = "w2"
	if err := a.WatchStart("w2", WatchOptions{Path: file, DebounceMs: 50}); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(dir, "other.txt"), []byte("x"), 0o644)
	os.WriteFile(file, []byte("2"), 0o644)
	changes = map[string]string{}
	wait(file)
	for p := range changes {
		if p != file {
			t.Errorf("reported %s while watching %s", p, file)
		}
	}
	a.StreamClose("w2")
	collect(t, session, "w2", 5*time.Second)

	if err := a.WatchStart("w3", WatchOptions{Path: filepath.Join(dir, "missing")}); err == nil {
		t.Error("watched a path that doesn't exist")
	}
}

func TestMergeWatchOp(t *testing.T) {
	for _, c := range [][3]string{
		{"", "write", "write"}, {"create", "write", "create"}, {"create", "remove", ""},
		{"remove", "create", "write"}, {"rename", "create", "write"}, {"write", "remove", "remove"},
	} {
		if got := mergeWatchOp(c[0], c[1]); got != c[2] {
			t.Errorf("%s then %s = %q, want %q", c[0], c[1], got, c[2])
		}
	}
}

func TestHTTPStream(t *testing.T) {
	a := &App{}
	session := a.StreamsReset()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f := w.(http.Flusher)
		switch r.URL.Path {
		case "/sse":
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(200)
			f.Flush()
			for _, part := range []string{"data: {\"t\":\"Hel\"}\n\n", "data: {\"t\":\"lo \xE6", "\x97\xA5\"}\n\n", "data: [DONE]\n\n"} {
				w.Write([]byte(part))
				f.Flush()
				time.Sleep(30 * time.Millisecond)
			}
		case "/stall":
			w.WriteHeader(200)
			w.Write([]byte("first"))
			f.Flush()
			time.Sleep(3 * time.Second)
		case "/slow":
			for i := 0; i < 100; i++ {
				w.Write([]byte("tick\n"))
				f.Flush()
				time.Sleep(50 * time.Millisecond)
			}
		}
	}))
	defer srv.Close()

	if err := a.HTTPStreamStart("h1", HTTPRequestOptions{URL: srv.URL + "/sse"}); err != nil {
		t.Fatal(err)
	}
	evs := collect(t, session, "h1", 10*time.Second)
	if evs[0].Type != "response" || evs[0].Code != 200 || evs[0].Headers["content-type"] != "text/event-stream" {
		t.Errorf("first event %+v", evs[0])
	}
	want := "data: {\"t\":\"Hel\"}\n\ndata: {\"t\":\"lo 日\"}\n\ndata: [DONE]\n\n"
	if got := joined(evs, "data"); got != want {
		t.Errorf("data %q", got)
	}
	if end := last(evs); end.Code != 200 || end.Error != "" {
		t.Errorf("end %+v", end)
	}

	if err := a.HTTPStreamStart("h2", HTTPRequestOptions{URL: srv.URL + "/stall", IdleSeconds: 1}); err != nil {
		t.Fatal(err)
	}
	evs = collect(t, session, "h2", 10*time.Second)
	if end := last(evs); !strings.Contains(end.Error, "went quiet") || joined(evs, "data") != "first" {
		t.Errorf("idle: %+v", evs)
	}

	if err := a.HTTPStreamStart("h3", HTTPRequestOptions{URL: srv.URL + "/slow"}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	a.StreamClose("h3")
	evs = collect(t, session, "h3", 5*time.Second)
	if end := last(evs); end.Error != "cancelled" {
		t.Errorf("cancel: %+v", end)
	}

	if err := a.HTTPStreamStart("h4", HTTPRequestOptions{URL: "file:///etc/passwd"}); err == nil {
		t.Error("file URL accepted")
	}
	if err := a.HTTPStreamStart("h5", HTTPRequestOptions{URL: "http://127.0.0.1:1/"}); err != nil {
		t.Fatal(err)
	}
	if end := last(collect(t, session, "h5", 10*time.Second)); !strings.Contains(end.Error, "couldn't reach") {
		t.Errorf("unreachable: %+v", end)
	}
}
