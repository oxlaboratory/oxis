//go:build cgo

package luanative

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// The bridge between plugins' Lua states and the page.
//
// The page opens a WebSocket (/lua on the local server) and, per
// plugin, sends "open" with its source. Each state lives on a goroutine
// of its own, so a busy plugin never holds up the page or another
// plugin. When Lua calls an oxis.* function, the call goes to the page,
// which runs the same JS binding the fengari runtime does; Lua
// functions passed along go as references ({"$fn": n}) the page can
// invoke later (a command run, a timer, a stream's output).
//
// Page → Go:
//
//	{t:"open",   sid, source, chunk, platform}
//	{t:"invoke", sid, ref, args}       call a Lua function
//	{t:"release",sid, refs}            the page is done with them
//	{t:"ret",    sid, id, ok, value|error}
//	{t:"close",  sid}
//	{t:"check",  rid, source, chunk}   compile only (syntax check)
//
// Go → page:
//
//	{t:"hello",  available, engine, error}
//	{t:"call",   sid, id, fn, args, posts}  answer with ret
//	{t:"post",   sid, posts}                [[fn, args], …], in order
//	{t:"opened", sid, ok, error}
//	{t:"error",  sid, message}              a callback raised an error
//	{t:"closed", sid}
//	{t:"checked",rid, ok, error}

//go:embed prelude.lua
var prelude string

type inMsg struct {
	T        string            `json:"t"`
	Sid      int               `json:"sid"`
	Rid      int               `json:"rid"`
	ID       int               `json:"id"`
	Ref      int               `json:"ref"`
	Refs     []int             `json:"refs"`
	Args     []json.RawMessage `json:"args"`
	Source   string            `json:"source"`
	Chunk    string            `json:"chunk"`
	Platform string            `json:"platform"`
	OK       bool              `json:"ok"`
	Value    json.RawMessage   `json:"value"`
	Error    string            `json:"error"`
}

// Session is one page's connection.
type Session struct {
	conn   *websocket.Conn
	wmu    sync.Mutex
	mu     sync.Mutex
	states map[int]*state // by the page's sid
	done   chan struct{}
}

type reply struct {
	id    int
	ok    bool
	value json.RawMessage
	err   string
}

type state struct {
	s     *Session
	sid   int // the page's id
	gid   int // ours, unique across sessions (C knows it)
	L     luaState
	box   mailbox
	reply chan reply
	stop  chan struct{} // closed when the state is closing
	once  sync.Once

	// Only touched on the state's goroutine.
	posts     []any
	firstPost time.Time
	callID    int
	refs      map[int]bool
	hids      map[int]bool
	closed    bool
}

var (
	statesMu sync.Mutex
	byGID    = map[int]*state{}
	lastGID  int
)

func lookup(gid int) *state {
	statesMu.Lock()
	defer statesMu.Unlock()
	return byGID[gid]
}

// HandleSession serves one page's /lua WebSocket until it closes.
func HandleSession(conn *websocket.Conn) {
	s := &Session{conn: conn, states: map[int]*state{}, done: make(chan struct{})}
	defer s.shutdown()
	ok, why := Available()
	s.send(map[string]any{"t": "hello", "available": ok, "engine": Version(), "error": why, "cmodules": ok})
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var m inMsg
		if err := json.Unmarshal(data, &m); err != nil {
			continue
		}
		s.handle(&m)
	}
}

func (s *Session) send(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		log.Printf("[oxis:lua] can't send %T: %v", v, err)
		return
	}
	s.wmu.Lock()
	defer s.wmu.Unlock()
	_ = s.conn.WriteMessage(websocket.TextMessage, b)
}

func (s *Session) state(sid int) *state {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.states[sid]
}

func (s *Session) handle(m *inMsg) {
	switch m.T {
	case "open":
		s.open(m)
	case "invoke":
		if st := s.state(m.Sid); st != nil {
			ref, args := m.Ref, m.Args
			st.box.put(func() { st.invoke(ref, args) })
		}
	case "release":
		if st := s.state(m.Sid); st != nil {
			refs := m.Refs
			st.box.put(func() {
				for _, r := range refs {
					if st.refs[r] {
						delete(st.refs, r)
						unref(st.L, r)
					}
				}
			})
		}
	case "ret":
		if st := s.state(m.Sid); st != nil {
			select {
			case st.reply <- reply{m.ID, m.OK, m.Value, m.Error}:
			default:
			}
		}
	case "close":
		if st := s.state(m.Sid); st != nil {
			st.close()
		}
	case "check":
		go s.check(m.Rid, m.Source, m.Chunk)
	}
}

// check compiles source without running it.
func (s *Session) check(rid int, source, chunk string) {
	res := map[string]any{"t": "checked", "rid": rid, "ok": true}
	if err := load(); err != nil {
		res["ok"], res["error"] = false, err.Error()
	} else if L := newState(0); L == nil {
		res["ok"], res["error"] = false, "out of memory"
	} else {
		if err := loadChunk(L, source, chunkName(chunk)); err != nil {
			res["ok"], res["error"] = false, err.Error()
		}
		closeState(L)
	}
	s.send(res)
}

func chunkName(c string) string {
	if c == "" {
		return "=plugin"
	}
	if strings.HasPrefix(c, "=") || strings.HasPrefix(c, "@") {
		return c
	}
	return "=" + c
}

func (s *Session) shutdown() {
	close(s.done)
	s.mu.Lock()
	all := make([]*state, 0, len(s.states))
	for _, st := range s.states {
		all = append(all, st)
	}
	s.mu.Unlock()
	for _, st := range all {
		st.close()
	}
}

// open starts a state for a plugin and runs it.
func (s *Session) open(m *inMsg) {
	if err := load(); err != nil {
		s.send(map[string]any{"t": "opened", "sid": m.Sid, "ok": false, "error": err.Error()})
		return
	}
	statesMu.Lock()
	lastGID++
	gid := lastGID
	statesMu.Unlock()
	st := &state{
		s: s, sid: m.Sid, gid: gid,
		reply: make(chan reply, 4), stop: make(chan struct{}),
		refs: map[int]bool{}, hids: map[int]bool{},
	}
	st.box.init()
	s.mu.Lock()
	if old := s.states[m.Sid]; old != nil {
		old.close()
	}
	s.states[m.Sid] = st
	s.mu.Unlock()
	statesMu.Lock()
	byGID[gid] = st
	statesMu.Unlock()

	source, chunk, platform := m.Source, chunkName(m.Chunk), m.Platform
	go st.run(func() {
		err := st.start(source, chunk, platform)
		st.flush()
		res := map[string]any{"t": "opened", "sid": st.sid, "ok": err == nil}
		if err != nil {
			res["error"] = err.Error()
		}
		s.send(res)
		if err != nil {
			st.close()
		}
	})
}

// run is the state's goroutine: everything that touches its Lua runs
// here, one thing at a time.
func (st *state) run(first func()) {
	first()
	for {
		f, ok := st.box.take(st.stop)
		if !ok {
			break
		}
		f()
		st.flush()
	}
	st.finish()
}

// finish closes the Lua state (on its goroutine).
func (st *state) finish() {
	st.box.mu.Lock()
	if st.L != nil {
		st.closed = true
		closeState(st.L)
		st.L = nil
	}
	st.box.mu.Unlock()
	statesMu.Lock()
	delete(byGID, st.gid)
	statesMu.Unlock()
	st.s.mu.Lock()
	if st.s.states[st.sid] == st {
		delete(st.s.states, st.sid)
	}
	st.s.mu.Unlock()
	st.s.send(map[string]any{"t": "closed", "sid": st.sid})
}

// close stops the state: what's running is interrupted, a call waiting
// for the page gives up, and the state closes once it's free.
func (st *state) close() {
	st.once.Do(func() {
		close(st.stop)
		st.box.mu.Lock()
		if st.L != nil && !st.closed {
			interrupt(st.L)
		}
		st.box.mu.Unlock()
	})
}

func (st *state) start(source, chunk, platform string) error {
	L := newState(st.gid)
	if L == nil {
		return errors.New("out of memory")
	}
	st.box.mu.Lock()
	st.L = L
	st.box.mu.Unlock()
	path, cpath := searchPaths()
	if err := loadChunk(L, prelude, "=oxis"); err != nil {
		return fmt.Errorf("prelude: %w", err)
	}
	pushBridge(L, false)
	pushBridge(L, true)
	pushstring(L, platform)
	pushstring(L, path)
	pushstring(L, cpath)
	if err := pcall(L, 5, 0); err != nil {
		return fmt.Errorf("prelude: %w", err)
	}
	if err := loadChunk(L, source, chunk); err != nil {
		return err
	}
	return pcall(L, 0, 0)
}

// invoke calls a Lua function the page holds a reference to.
func (st *state) invoke(r int, args []json.RawMessage) {
	if st.closed || !st.refs[r] {
		return
	}
	L := st.L
	top := gettop(L)
	getref(L, r)
	if typeOf(L, -1) != tFunction {
		settop(L, top)
		return
	}
	for _, a := range args {
		st.pushJSON(L, a)
	}
	if err := pcall(L, len(args), 0); err != nil {
		st.flush()
		st.s.send(map[string]any{"t": "error", "sid": st.sid, "message": err.Error()})
	}
	settop(L, top)
}

// ── calls from Lua ───────────────────────────────────────────────────

var errStopped = errors.New("stopped: the plugin was unloaded or reloaded")

// bridgeCall is call(fn, …) or post(fn, …) from the prelude. It returns
// how many results it pushed, or -1 with an error message pushed.
func bridgeCall(gid int, L luaState, post bool) int {
	st := lookup(gid)
	if st == nil {
		pushstring(L, "this plugin has been closed")
		return -1
	}
	n := gettop(L)
	if n < 1 || typeOf(L, 1) != tString {
		pushstring(L, "bad bridge call")
		return -1
	}
	fn := tostring(L, 1)
	switch fn {
	case "$json.encode":
		v := st.toGo(L, 2, 0, true)
		b, err := jsonMarshal(v)
		if err != nil {
			pushstring(L, "oxis.json.encode: "+err.Error())
			return -1
		}
		pushstring(L, string(b))
		return 1
	case "$json.decode":
		src := ""
		if typeOf(L, 2) == tString {
			src = tostring(L, 2)
		}
		var probe any
		if err := json.Unmarshal([]byte(src), &probe); err != nil {
			pushstring(L, "oxis.json.decode: "+err.Error())
			return -1
		}
		st.pushPlain(L, json.RawMessage(src))
		return 1
	}
	args := make([]any, 0, n-1)
	for i := 2; i <= n; i++ {
		args = append(args, st.toGo(L, i, 0, false))
	}
	return st.dispatch(L, fn, args, post)
}

// handleCall is a method of a JS handle (h:stop(), line:set(…)).
func handleCall(gid int, L luaState, hid int, name string, post bool) int {
	st := lookup(gid)
	if st == nil {
		pushstring(L, "this plugin has been closed")
		return -1
	}
	n := gettop(L)
	first := 1
	if n >= 1 && typeOf(L, 1) == tTable { // h:method() passes h first
		first = 2
	}
	args := []any{hid, name}
	for i := first; i <= n; i++ {
		args = append(args, st.toGo(L, i, 0, false))
	}
	return st.dispatch(L, "$h", args, post)
}

func handleGone(gid, hid int) {
	if st := lookup(gid); st != nil && !st.closed && st.hids[hid] {
		delete(st.hids, hid)
		st.queue("$hfree", []any{hid})
	}
}

func (st *state) dispatch(L luaState, fn string, args []any, post bool) int {
	if post {
		st.queue(fn, args)
		return 0
	}
	v, err := st.call(fn, args)
	if err != nil {
		pushstring(L, err.Error())
		return -1
	}
	st.pushJSON(L, v)
	return 1
}

// queue adds a call that needs no answer to the next batch.
func (st *state) queue(fn string, args []any) {
	if len(st.posts) == 0 {
		st.firstPost = time.Now()
	}
	st.posts = append(st.posts, []any{fn, args})
	// A plugin busy for a while still shows what it printed.
	if len(st.posts) >= 256 || time.Since(st.firstPost) > 16*time.Millisecond {
		st.flush()
	}
}

func (st *state) flush() {
	if len(st.posts) == 0 {
		return
	}
	st.s.send(map[string]any{"t": "post", "sid": st.sid, "posts": st.posts})
	st.posts = nil
}

// call sends a call (after what's queued) and waits for the answer.
func (st *state) call(fn string, args []any) (json.RawMessage, error) {
	st.callID++
	id := st.callID
	msg := map[string]any{"t": "call", "sid": st.sid, "id": id, "fn": fn, "args": args}
	if len(st.posts) > 0 {
		msg["posts"] = st.posts
		st.posts = nil
	}
	st.s.send(msg)
	for {
		select {
		case r := <-st.reply:
			if r.id != id {
				continue
			}
			if !r.ok {
				return nil, errors.New(r.err)
			}
			return r.value, nil
		case <-st.stop:
			return nil, errStopped
		case <-st.s.done:
			return nil, errors.New("OXIS's page closed")
		}
	}
}

// ── values ───────────────────────────────────────────────────────────

// toGo reads the Lua value at i as plain data, the way luaRuntime's
// luaToJS does: a table is an array if its keys are exactly 1..n (an
// empty one is []), otherwise an object. A function becomes a
// reference the page can call ({"$fn": n}), unless dropFuncs.
func (st *state) toGo(L luaState, i, depth int, dropFuncs bool) any {
	switch typeOf(L, i) {
	case tBoolean:
		return toboolean(L, i)
	case tNumber:
		if isinteger(L, i) {
			return tointeger(L, i)
		}
		f := tonumber(L, i)
		if math.IsNaN(f) || math.IsInf(f, 0) {
			return nil
		}
		return f
	case tString:
		return tostring(L, i)
	case tFunction:
		if dropFuncs {
			return omitted{}
		}
		pushvalue(L, i)
		r := ref(L)
		st.refs[r] = true
		return map[string]any{"$fn": r}
	case tTable:
		if depth > 64 || !checkstack(L, 4) {
			return nil
		}
		i = absindex(L, i)
		type entry struct {
			key   any
			value any
		}
		var entries []entry
		ints, maxInt := 0, int64(0)
		pushnil(L)
		for next(L, i) {
			v := st.toGo(L, -1, depth+1, dropFuncs)
			switch typeOf(L, -2) {
			case tNumber:
				if isinteger(L, -2) {
					k := tointeger(L, -2)
					if k >= 1 {
						ints++
						if k > maxInt {
							maxInt = k
						}
					}
					entries = append(entries, entry{k, v})
				} else {
					entries = append(entries, entry{tonumber(L, -2), v})
				}
			case tString:
				entries = append(entries, entry{tostring(L, -2), v})
			}
			settop(L, gettop(L)-1)
		}
		if ints == len(entries) && maxInt == int64(len(entries)) {
			arr := make([]any, len(entries))
			for _, e := range entries {
				if _, gone := e.value.(omitted); !gone {
					arr[e.key.(int64)-1] = e.value
				}
			}
			return arr
		}
		obj := make(map[string]any, len(entries))
		for _, e := range entries {
			if _, gone := e.value.(omitted); gone {
				continue // as JSON.stringify leaves out a function
			}
			switch k := e.key.(type) {
			case string:
				obj[k] = e.value
			case int64:
				obj[fmt.Sprint(k)] = e.value
			case float64:
				obj[fmt.Sprint(k)] = e.value
			}
		}
		return obj
	}
	return nil
}

// omitted is a function oxis.json.encode leaves out.
type omitted struct{}

func (omitted) MarshalJSON() ([]byte, error) { return []byte("null"), nil }

// pushJSON pushes a value from the page: JSON, where {"$fn": n} is a
// Lua function back and {"$h": id, "m": [...], "post": [...]} a JS
// handle, which becomes a table of methods.
func (st *state) pushJSON(L luaState, raw json.RawMessage) { st.pushRaw(L, raw, false) }

// pushPlain pushes JSON as plain data: no references (oxis.json.decode).
func (st *state) pushPlain(L luaState, raw json.RawMessage) { st.pushRaw(L, raw, true) }

func (st *state) pushRaw(L luaState, raw json.RawMessage, plain bool) {
	if len(raw) == 0 {
		pushnil(L)
		return
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		pushnil(L)
		return
	}
	st.push(L, v, 0, plain)
}

func (st *state) push(L luaState, v any, depth int, plain bool) {
	if depth > 64 || !checkstack(L, 4) {
		pushnil(L)
		return
	}
	switch x := v.(type) {
	case nil:
		pushnil(L)
	case bool:
		pushboolean(L, x)
	case json.Number:
		// Whole numbers become Lua integers, so "status " .. 200 reads
		// "200", not "200.0".
		if n, err := x.Int64(); err == nil {
			pushinteger(L, n)
		} else if f, err := x.Float64(); err == nil {
			if f == math.Trunc(f) && math.Abs(f) < 1<<53 {
				pushinteger(L, int64(f))
			} else {
				pushnumber(L, f)
			}
		} else {
			pushnil(L)
		}
	case string:
		pushstring(L, x)
	case []any:
		createtable(L, len(x), 0)
		for k, item := range x {
			st.push(L, item, depth+1, plain)
			rawseti(L, -2, int64(k+1))
		}
	case map[string]any:
		// Only references this state handed out (data from elsewhere, a
		// web page's JSON say, can't reach into the registry).
		if r, ok := x["$fn"].(json.Number); ok && len(x) == 1 && !plain {
			if n, err := r.Int64(); err == nil && st.refs[int(n)] {
				getref(L, int(n))
				return
			}
		}
		if h, ok := x["$h"].(json.Number); ok && !plain {
			hid64, _ := h.Int64()
			st.pushHandle(L, int(hid64), x)
			return
		}
		createtable(L, 0, len(x))
		for k, item := range x {
			st.push(L, item, depth+1, plain)
			rawsetfield(L, -2, k)
		}
	default:
		pushnil(L)
	}
}

func (st *state) pushHandle(L luaState, hid int, desc map[string]any) {
	posts := map[string]bool{}
	if p, ok := desc["post"].([]any); ok {
		for _, n := range p {
			if s, ok := n.(string); ok {
				posts[s] = true
			}
		}
	}
	methods, _ := desc["m"].([]any)
	createtable(L, 0, len(methods))
	for _, m := range methods {
		name, ok := m.(string)
		if !ok {
			continue
		}
		pushHandleMethod(L, hid, name, posts[name])
		rawsetfield(L, -2, name)
	}
	st.hids[hid] = true
	setHandleGC(L, hid)
}

// jsonMarshal is JSON.stringify: no HTML escaping, no trailing newline.
func jsonMarshal(v any) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(b.Bytes(), "\n"), nil
}

// ── mailbox ──────────────────────────────────────────────────────────

// mailbox is an unbounded queue of work for a state's goroutine: the
// reader never blocks on a busy plugin (and so never holds up the
// answer that plugin is waiting for).
type mailbox struct {
	mu     sync.Mutex
	q      []func()
	signal chan struct{}
}

func (b *mailbox) init() { b.signal = make(chan struct{}, 1) }

func (b *mailbox) put(f func()) {
	b.mu.Lock()
	b.q = append(b.q, f)
	b.mu.Unlock()
	select {
	case b.signal <- struct{}{}:
	default:
	}
}

// take waits for the next piece of work; false once stop is closed.
func (b *mailbox) take(stop chan struct{}) (func(), bool) {
	for {
		select {
		case <-stop:
			return nil, false
		default:
		}
		b.mu.Lock()
		if len(b.q) > 0 {
			f := b.q[0]
			b.q[0] = nil
			b.q = b.q[1:]
			b.mu.Unlock()
			return f, true
		}
		b.mu.Unlock()
		select {
		case <-b.signal:
		case <-stop:
			return nil, false
		}
	}
}
