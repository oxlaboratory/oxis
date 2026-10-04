//go:build cgo

package luanative

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// page is a stand-in for the JS side: it answers calls with answer and
// records everything else.
type page struct {
	t      *testing.T
	conn   *websocket.Conn
	wmu    sync.Mutex
	msgs   chan map[string]any
	answer func(fn string, args []any) (any, string)
}

func newPage(t *testing.T, answer func(fn string, args []any) (any, string)) *page {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		up := websocket.Upgrader{}
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		HandleSession(c)
	}))
	t.Cleanup(srv.Close)
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	p := &page{t: t, conn: conn, msgs: make(chan map[string]any, 1000), answer: answer}
	go func() {
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				close(p.msgs)
				return
			}
			var m map[string]any
			_ = json.Unmarshal(data, &m)
			if m["t"] == "call" && p.answer != nil {
				for _, post := range asList(m["posts"]) {
					p.msgs <- map[string]any{"t": "post", "sid": m["sid"], "posts": []any{post}}
				}
				fn, _ := m["fn"].(string)
				v, errMsg := p.answer(fn, asList(m["args"]))
				ret := map[string]any{"t": "ret", "sid": m["sid"], "id": m["id"], "ok": errMsg == "", "value": v, "error": errMsg}
				p.send(ret)
			}
			p.msgs <- m
		}
	}()
	return p
}

func asList(v any) []any { l, _ := v.([]any); return l }

func (p *page) send(v any) {
	b, _ := json.Marshal(v)
	p.wmu.Lock()
	defer p.wmu.Unlock()
	if err := p.conn.WriteMessage(websocket.TextMessage, b); err != nil {
		p.t.Log(err)
	}
}

// waitFor returns the first message for which ok is true; the posts on
// the way are collected.
func (p *page) waitFor(ok func(map[string]any) bool) (map[string]any, [][]any) {
	p.t.Helper()
	var posts [][]any
	timeout := time.After(10 * time.Second)
	for {
		select {
		case m, open := <-p.msgs:
			if !open {
				p.t.Fatal("connection closed")
			}
			if m["t"] == "post" {
				for _, x := range asList(m["posts"]) {
					posts = append(posts, asList(x))
				}
			}
			if ok(m) {
				return m, posts
			}
		case <-timeout:
			p.t.Fatal("timed out")
		}
	}
}

func isT(t string, sid int) func(map[string]any) bool {
	return func(m map[string]any) bool { return m["t"] == t && (sid == 0 || m["sid"] == float64(sid)) }
}

func echoes(posts [][]any) []string {
	var out []string
	for _, p := range posts {
		if p[0] == "echo" {
			out = append(out, asList(p[1])[0].(string))
		}
	}
	return out
}

func TestBridge(t *testing.T) {
	perms := map[string]bool{"native": true}
	p := newPage(t, func(fn string, args []any) (any, string) {
		switch fn {
		case "cwd":
			return "C:/work", ""
		case "$perm":
			if perms[args[0].(string)] {
				return true, ""
			}
			return nil, "plugin test didn't declare the " + args[0].(string) + " permission"
		case "line":
			return map[string]any{"$h": 7, "m": []any{"set", "text"}, "post": []any{"set"}}, ""
		case "$h":
			return "last", ""
		}
		return nil, "unexpected " + fn
	})
	hello, _ := p.waitFor(isT("hello", 0))
	if hello["available"] != true || hello["engine"] != "Lua 5.4.9" {
		t.Fatalf("hello: %v", hello)
	}

	src := `
oxis.echo("hi")
oxis.command("greet", function(args, rest, raw) oxis.echo("ran " .. rest .. " " .. #args) end, "says hi")
print(oxis.cwd(), _VERSION, math.type(3), 7 // 2)
local enc = oxis.json.encode({ a = 1, list = { 1, 2, 3 }, f = function() end, empty = {} })
oxis.echo(enc)
local dec = oxis.json.decode('{"x": [10, 20], "n": 2.5, "fn": {"$fn": 1}}')
oxis.echo(dec.x[2] + 1 .. " " .. dec.n .. " " .. type(dec.fn))
oxis.echo(select(2, pcall(io.open, "x.txt")))
oxis.echo(select(2, pcall(os.execute, "echo hi")))
oxis.echo(select(2, pcall(os.exit)))
oxis.echo(tostring(load(string.dump(function() end))))
local l = oxis.line("frame 1")
l:set("frame 2")
oxis.echo(l:text())
oxis.echo(select(2, pcall(function() return ("x"):rep(600 * 1024 * 1024) end)))
`
	p.send(map[string]any{"t": "open", "sid": 1, "source": src, "chunk": "test", "platform": "windows"})
	opened, posts := p.waitFor(isT("opened", 1))
	if opened["ok"] != true {
		t.Fatalf("open: %v", opened)
	}
	got := echoes(posts)
	want := []string{
		"hi",
		"C:/work\tLua 5.4\tinteger\t3",
		`{"a":1,"empty":[],"list":[1,2,3]}`,
		"21 2.5 table",
		"plugin test didn't declare the fs permission",
		"plugin test didn't declare the shell permission",
		"os.exit isn't allowed in a plugin: it would close OXIS",
		"nil",
		"last",
		"not enough memory",
	}
	if len(got) != len(want) {
		t.Fatalf("echoes:\n%q\nwant\n%q", got, want)
	}
	for i := range want {
		if !strings.Contains(got[i], want[i]) {
			t.Errorf("echo %d: got %q, want %q", i, got[i], want[i])
		}
	}
	var cmdRef float64
	var sawSet bool
	for _, x := range posts {
		if x[0] == "command" {
			args := asList(x[1])
			cmdRef = args[1].(map[string]any)["$fn"].(float64)
			if args[0] != "greet" || args[2] != "says hi" {
				t.Errorf("command post: %v", x)
			}
		}
		if x[0] == "$h" {
			sawSet = asList(x[1])[1] == "set" && asList(x[1])[2] == "frame 2"
		}
	}
	if cmdRef == 0 || !sawSet {
		t.Fatalf("command ref %v, line set %v (posts %v)", cmdRef, sawSet, posts)
	}

	// The page runs the command.
	p.send(map[string]any{"t": "invoke", "sid": 1, "ref": cmdRef, "args": []any{[]any{"a", "b"}, "a b", "a  b"}})
	_, posts = p.waitFor(func(m map[string]any) bool { return m["t"] == "post" })
	if e := echoes(posts); len(e) != 1 || e[0] != "ran a b 2" {
		t.Fatalf("invoke: %v", posts)
	}

	// A callback's error goes to the page.
	p.send(map[string]any{"t": "open", "sid": 2, "source": `oxis.autocmd("X", function() error("boom") end)`, "chunk": "t2"})
	_, posts = p.waitFor(isT("opened", 2))
	ref := asList(posts[0][1])[1].(map[string]any)["$fn"].(float64)
	p.send(map[string]any{"t": "invoke", "sid": 2, "ref": ref, "args": []any{}})
	e, _ := p.waitFor(isT("error", 2))
	if !strings.Contains(e["message"].(string), "boom") {
		t.Fatalf("error: %v", e)
	}

	// A syntax error fails the open; check reports it without running.
	p.send(map[string]any{"t": "open", "sid": 3, "source": "oxis.echo(", "chunk": "bad"})
	bad, _ := p.waitFor(isT("opened", 3))
	if bad["ok"] != false || !strings.Contains(bad["error"].(string), "bad:1:") {
		t.Fatalf("bad open: %v", bad)
	}
	p.send(map[string]any{"t": "check", "rid": 9, "source": "local x <const> = 1\nreturn x", "chunk": "c"})
	chk, _ := p.waitFor(isT("checked", 0))
	if chk["ok"] != true {
		t.Fatalf("check: %v", chk)
	}
}

func TestInterruptAndClose(t *testing.T) {
	p := newPage(t, nil)
	p.waitFor(isT("hello", 0))
	p.send(map[string]any{"t": "open", "sid": 5, "source": "while true do end", "chunk": "loop"})
	time.Sleep(200 * time.Millisecond)
	start := time.Now()
	p.send(map[string]any{"t": "close", "sid": 5})
	opened, _ := p.waitFor(isT("opened", 5))
	if opened["ok"] != false || !strings.Contains(opened["error"].(string), "stopped") {
		t.Fatalf("opened: %v", opened)
	}
	p.waitFor(isT("closed", 5))
	if time.Since(start) > 2*time.Second {
		t.Fatalf("took %v to stop", time.Since(start))
	}
}

// A Lua C module, built against lua54.dll, loads into the plugin's Lua.
func TestCModule(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("the Linux build exports Lua from the binary; checked by hand")
	}
	gcc, err := exec.LookPath("gcc")
	if err != nil {
		t.Skip("no gcc to build a C module with")
	}
	dllPath, err := libraryPath()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	src := filepath.Join(dir, "hello.c")
	os.WriteFile(src, []byte(`#include "lua.h"
#include "lauxlib.h"
static int add(lua_State *L) { lua_pushinteger(L, luaL_checkinteger(L, 1) + luaL_checkinteger(L, 2)); return 1; }
__declspec(dllexport) int luaopen_hello(lua_State *L) {
	lua_createtable(L, 0, 2);
	lua_pushstring(L, "hi from C"); lua_setfield(L, -2, "greeting");
	lua_pushcfunction(L, add); lua_setfield(L, -2, "add");
	return 1;
}`), 0o644)
	inc, _ := filepath.Abs("../../third_party/lua/src")
	out, err := exec.Command(gcc, "-shared", "-O2", "-I", inc, "-o", filepath.Join(dir, "hello.dll"), src, dllPath).CombinedOutput()
	if err != nil {
		t.Fatalf("gcc: %v\n%s", err, out)
	}
	var mu sync.Mutex
	asked := ""
	p := newPage(t, func(fn string, args []any) (any, string) {
		if fn == "$perm" {
			mu.Lock()
			asked = args[0].(string)
			mu.Unlock()
			return true, ""
		}
		return nil, "unexpected " + fn
	})
	p.waitFor(isT("hello", 0))
	cpath := strings.ReplaceAll(filepath.Join(dir, "?.dll"), `\`, `\\`)
	p.send(map[string]any{"t": "open", "sid": 1, "chunk": "c", "source": `
package.cpath = "` + cpath + `;" .. package.cpath
local hello = require("hello")
oxis.echo(hello.greeting .. " " .. hello.add(40, 2))
`})
	opened, posts := p.waitFor(isT("opened", 1))
	if opened["ok"] != true {
		t.Fatalf("open: %v", opened)
	}
	if e := echoes(posts); len(e) != 1 || e[0] != "hi from C 42" {
		t.Fatalf("echoes %v", e)
	}
	mu.Lock()
	defer mu.Unlock()
	if asked != "native" {
		t.Fatalf("asked for %q, want native", asked)
	}
}
