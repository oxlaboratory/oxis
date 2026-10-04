//go:build cgo

package luanative

/*
#cgo CFLAGS: -I${SRCDIR}/../../third_party/lua/src -DLUA_COMPAT_5_3 -O2
#cgo linux CFLAGS: -DLUA_USE_LINUX
#cgo darwin CFLAGS: -DLUA_USE_MACOSX
#cgo linux LDFLAGS: -Wl,-E -ldl -lm
#cgo darwin LDFLAGS: -rdynamic
#include <stdlib.h>
#include "shim.h"
*/
import "C"

import (
	"errors"
	"sync"
	"unsafe"
)

// Lua's value types (lua.h).
const (
	tNone          = -1
	tNil           = 0
	tBoolean       = 1
	tLightUserdata = 2
	tNumber        = 3
	tString        = 4
	tTable         = 5
	tFunction      = 6
	tUserdata      = 7
	tThread        = 8
)

// memoryLimit caps what one plugin's Lua may allocate.
const memoryLimit = 512 << 20

var (
	loadOnce sync.Once
	loadErr  error
)

// load makes the Lua library ready: on Windows it writes out and loads
// lua54.dll (dll_windows.go); elsewhere Lua is linked in.
func load() error {
	loadOnce.Do(func() {
		path, err := libraryPath()
		if err != nil {
			loadErr = err
			return
		}
		cpath := C.CString(path)
		defer C.free(unsafe.Pointer(cpath))
		if msg := C.ox_load(cpath); msg != nil {
			loadErr = errors.New(C.GoString(msg))
		}
	})
	return loadErr
}

// Available reports whether plugins can run on native Lua, and if not,
// why.
func Available() (bool, string) {
	if err := load(); err != nil {
		return false, err.Error()
	}
	return true, ""
}

// Version is the Lua release, e.g. "Lua 5.4.9".
func Version() string { return C.GoString(C.ox_version()) }

type luaState = *C.lua_State

func newState(gid int) luaState {
	return C.ox_newstate(C.int(gid), C.size_t(memoryLimit))
}

func closeState(L luaState)     { C.ox_close(L) }
func interrupt(L luaState)      { C.ox_interrupt(L) }
func memoryUsed(L luaState) int { return int(C.ox_memory(L)) }

func gettop(L luaState) int             { return int(C.ox_gettop(L)) }
func settop(L luaState, i int)          { C.ox_settop(L, C.int(i)) }
func typeOf(L luaState, i int) int      { return int(C.ox_type(L, C.int(i))) }
func absindex(L luaState, i int) int    { return int(C.ox_absindex(L, C.int(i))) }
func checkstack(L luaState, n int) bool { return C.ox_checkstack(L, C.int(n)) != 0 }
func toboolean(L luaState, i int) bool  { return C.ox_toboolean(L, C.int(i)) != 0 }
func isinteger(L luaState, i int) bool  { return C.ox_isinteger(L, C.int(i)) != 0 }
func tointeger(L luaState, i int) int64 { return int64(C.ox_tointeger(L, C.int(i))) }
func tonumber(L luaState, i int) float64 {
	return float64(C.ox_tonumber(L, C.int(i)))
}

// tostring reads a string value (only call it on strings).
func tostring(L luaState, i int) string {
	var n C.size_t
	p := C.ox_tostring(L, C.int(i), &n)
	return C.GoStringN(p, C.int(n))
}

// tostr is Lua's tostring() of any value; it leaves nothing on the stack.
func tostr(L luaState, i int) string {
	var n C.size_t
	p := C.ox_tostr(L, C.int(i), &n)
	s := C.GoStringN(p, C.int(n))
	settop(L, gettop(L)-1)
	return s
}

func pushnil(L luaState)              { C.ox_pushnil(L) }
func pushvalue(L luaState, i int)     { C.ox_pushvalue(L, C.int(i)) }
func pushinteger(L luaState, n int64) { C.ox_pushinteger(L, C.longlong(n)) }
func pushnumber(L luaState, n float64) {
	C.ox_pushnumber(L, C.double(n))
}
func pushboolean(L luaState, b bool) {
	v := 0
	if b {
		v = 1
	}
	C.ox_pushboolean(L, C.int(v))
}
func pushstring(L luaState, s string) {
	if s == "" {
		C.ox_pushstring(L, nil, 0)
		return
	}
	p := C.CString(s)
	C.ox_pushstring(L, p, C.size_t(len(s)))
	C.free(unsafe.Pointer(p))
}

func createtable(L luaState, narr, nrec int) { C.ox_createtable(L, C.int(narr), C.int(nrec)) }
func rawseti(L luaState, i int, n int64)     { C.ox_rawseti(L, C.int(i), C.longlong(n)) }
func rawsetfield(L luaState, i int, key string) {
	p := C.CString(key)
	C.ox_rawsetfield(L, C.int(i), p, C.size_t(len(key)))
	C.free(unsafe.Pointer(p))
}
func next(L luaState, i int) bool { return C.ox_next(L, C.int(i)) != 0 }

func ref(L luaState) int        { return int(C.ox_ref(L)) }
func unref(L luaState, r int)   { C.ox_unref(L, C.int(r)) }
func getref(L luaState, r int)  { C.ox_getref(L, C.int(r)) }

// loadChunk compiles Lua text (binary chunks are refused) and leaves
// the function, or the error, on top.
func loadChunk(L luaState, src, name string) error {
	csrc := C.CString(src)
	defer C.free(unsafe.Pointer(csrc))
	cname := C.CString(name)
	defer C.free(unsafe.Pointer(cname))
	if C.ox_load_chunk(L, csrc, C.size_t(len(src)), cname) != 0 {
		msg := tostr(L, -1)
		settop(L, gettop(L)-1)
		return errors.New(msg)
	}
	return nil
}

// pcall calls the function under nargs arguments, leaving nresults.
func pcall(L luaState, nargs, nresults int) error {
	if C.ox_pcall(L, C.int(nargs), C.int(nresults)) != 0 {
		msg := tostr(L, -1)
		settop(L, gettop(L)-1)
		return errors.New(msg)
	}
	return nil
}

func pushBridge(L luaState, post bool) {
	v := 0
	if post {
		v = 1
	}
	C.ox_push_bridge(L, C.int(v))
}

func pushHandleMethod(L luaState, hid int, name string, post bool) {
	p := C.CString(name)
	v := 0
	if post {
		v = 1
	}
	C.ox_push_handle_method(L, C.int(hid), p, C.int(v))
	C.free(unsafe.Pointer(p))
}

func setHandleGC(L luaState, hid int) { C.ox_set_handle_gc(L, C.int(hid)) }

//export goOxisCall
func goOxisCall(gid C.int, L *C.lua_State, post C.int) C.int {
	return C.int(bridgeCall(int(gid), L, post != 0))
}

//export goOxisHandle
func goOxisHandle(gid C.int, L *C.lua_State, hid C.int, name *C.char, post C.int) C.int {
	return C.int(handleCall(int(gid), L, int(hid), C.GoString(name), post != 0))
}

//export goOxisHandleGC
func goOxisHandleGC(gid C.int, hid C.int) {
	handleGone(int(gid), int(hid))
}
