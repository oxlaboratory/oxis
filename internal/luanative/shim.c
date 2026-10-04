//go:build cgo

#include <stdlib.h>
#include <string.h>
#include "shim.h"

/* Go side (bridge.go). */
extern int goOxisCall(int sid, lua_State *L, int post);
extern int goOxisHandle(int sid, lua_State *L, int hid, char *name, int post);
extern void goOxisHandleGC(int sid, int hid);

#ifdef _WIN32
/* ── Windows: the Lua API from lua54.dll ─────────────────────────────
 * One pointer per function used below; the macros after the struct
 * send every call through it. */
#include <stdio.h>
#include <windows.h>

static struct {
	lua_State *(*lua_newstate)(lua_Alloc, void *);
	void (*lua_close)(lua_State *);
	void (*luaL_openlibs)(lua_State *);
	void (*lua_sethook)(lua_State *, lua_Hook, int, int);
	int (*lua_gettop)(lua_State *);
	void (*lua_settop)(lua_State *, int);
	int (*lua_type)(lua_State *, int);
	int (*lua_absindex)(lua_State *, int);
	int (*lua_checkstack)(lua_State *, int);
	int (*lua_toboolean)(lua_State *, int);
	int (*lua_isinteger)(lua_State *, int);
	lua_Integer (*lua_tointegerx)(lua_State *, int, int *);
	lua_Number (*lua_tonumberx)(lua_State *, int, int *);
	const char *(*lua_tolstring)(lua_State *, int, size_t *);
	const char *(*luaL_tolstring)(lua_State *, int, size_t *);
	void (*lua_pushnil)(lua_State *);
	void (*lua_pushboolean)(lua_State *, int);
	void (*lua_pushinteger)(lua_State *, lua_Integer);
	void (*lua_pushnumber)(lua_State *, lua_Number);
	const char *(*lua_pushlstring)(lua_State *, const char *, size_t);
	const char *(*lua_pushstring)(lua_State *, const char *);
	void (*lua_pushvalue)(lua_State *, int);
	void (*lua_pushcclosure)(lua_State *, lua_CFunction, int);
	void (*lua_createtable)(lua_State *, int, int);
	void (*lua_rawseti)(lua_State *, int, lua_Integer);
	int (*lua_rawgeti)(lua_State *, int, lua_Integer);
	void (*lua_rawset)(lua_State *, int);
	int (*lua_next)(lua_State *, int);
	int (*lua_setmetatable)(lua_State *, int);
	int (*lua_error)(lua_State *);
	int (*luaL_error)(lua_State *, const char *, ...);
	int (*luaL_ref)(lua_State *, int);
	void (*luaL_unref)(lua_State *, int, int);
	int (*luaL_loadbufferx)(lua_State *, const char *, size_t, const char *, const char *);
	int (*lua_pcallk)(lua_State *, int, int, int, lua_KContext, lua_KFunction);
	void (*lua_rotate)(lua_State *, int, int);
} ox_api;

static HMODULE ox_dll;
static char ox_err[512];

#define BIND(name) do { \
	*(FARPROC *)&ox_api.name = GetProcAddress(ox_dll, #name); \
	if (!ox_api.name) { snprintf(ox_err, sizeof ox_err, "lua54.dll has no %s", #name); return ox_err; } \
} while (0)

const char *ox_load(const char *path) {
	if (ox_dll) return NULL;
	wchar_t wpath[MAX_PATH * 2];
	if (!MultiByteToWideChar(CP_UTF8, 0, path, -1, wpath, MAX_PATH * 2)) return "bad path to lua54.dll";
	/* The folder is searched for the DLL's own dependencies too. */
	ox_dll = LoadLibraryExW(wpath, NULL, LOAD_WITH_ALTERED_SEARCH_PATH);
	if (!ox_dll) {
		snprintf(ox_err, sizeof ox_err, "couldn't load %s (error %lu)", path, GetLastError());
		return ox_err;
	}
	BIND(lua_newstate); BIND(lua_close); BIND(luaL_openlibs); BIND(lua_sethook);
	BIND(lua_gettop); BIND(lua_settop); BIND(lua_type); BIND(lua_absindex); BIND(lua_checkstack);
	BIND(lua_toboolean); BIND(lua_isinteger); BIND(lua_tointegerx); BIND(lua_tonumberx);
	BIND(lua_tolstring); BIND(luaL_tolstring);
	BIND(lua_pushnil); BIND(lua_pushboolean); BIND(lua_pushinteger); BIND(lua_pushnumber);
	BIND(lua_pushlstring); BIND(lua_pushstring); BIND(lua_pushvalue); BIND(lua_pushcclosure);
	BIND(lua_createtable); BIND(lua_rawseti); BIND(lua_rawgeti); BIND(lua_rawset); BIND(lua_next);
	BIND(lua_setmetatable); BIND(lua_error); BIND(luaL_error); BIND(luaL_ref); BIND(luaL_unref);
	BIND(luaL_loadbufferx); BIND(lua_pcallk); BIND(lua_rotate);
	return NULL;
}

/* From here on every call goes through the table. */
#define lua_newstate     (ox_api.lua_newstate)
#define lua_close        (ox_api.lua_close)
#define luaL_openlibs    (ox_api.luaL_openlibs)
#define lua_sethook      (ox_api.lua_sethook)
#define lua_gettop       (ox_api.lua_gettop)
#define lua_settop       (ox_api.lua_settop)
#define lua_type         (ox_api.lua_type)
#define lua_absindex     (ox_api.lua_absindex)
#define lua_checkstack   (ox_api.lua_checkstack)
#define lua_toboolean    (ox_api.lua_toboolean)
#define lua_isinteger    (ox_api.lua_isinteger)
#define lua_tointegerx   (ox_api.lua_tointegerx)
#define lua_tonumberx    (ox_api.lua_tonumberx)
#define lua_tolstring    (ox_api.lua_tolstring)
#define luaL_tolstring   (ox_api.luaL_tolstring)
#define lua_pushnil      (ox_api.lua_pushnil)
#define lua_pushboolean  (ox_api.lua_pushboolean)
#define lua_pushinteger  (ox_api.lua_pushinteger)
#define lua_pushnumber   (ox_api.lua_pushnumber)
#define lua_pushlstring  (ox_api.lua_pushlstring)
#define lua_pushstring   (ox_api.lua_pushstring)
#define lua_pushvalue    (ox_api.lua_pushvalue)
#define lua_pushcclosure (ox_api.lua_pushcclosure)
#define lua_createtable  (ox_api.lua_createtable)
#define lua_rawseti      (ox_api.lua_rawseti)
#define lua_rawgeti      (ox_api.lua_rawgeti)
#define lua_rawset       (ox_api.lua_rawset)
#define lua_next         (ox_api.lua_next)
#define lua_setmetatable (ox_api.lua_setmetatable)
#define lua_error        (ox_api.lua_error)
#define luaL_error       (ox_api.luaL_error)
#define luaL_ref         (ox_api.luaL_ref)
#define luaL_unref       (ox_api.luaL_unref)
#define luaL_loadbufferx (ox_api.luaL_loadbufferx)
#define lua_pcallk       (ox_api.lua_pcallk)
#define lua_rotate       (ox_api.lua_rotate)

#else
const char *ox_load(const char *path) { (void)path; return NULL; }
#endif

const char *ox_version(void) { return LUA_RELEASE; }

/* ── states ───────────────────────────────────────────────────────── */

#define STATE(L) (*(ox_state **)lua_getextraspace(L))

/* Counts what the state holds and refuses more than its limit (Lua then
 * raises "not enough memory" in the plugin, not in OXIS). */
static void *ox_alloc(void *ud, void *ptr, size_t osize, size_t nsize) {
	ox_state *s = (ox_state *)ud;
	size_t old = ptr ? osize : 0;
	if (nsize == 0) {
		s->used -= old;
		free(ptr);
		return NULL;
	}
	if (nsize > old && s->used - old + nsize > s->limit) return NULL;
	void *p = realloc(ptr, nsize);
	if (p) s->used = s->used - old + nsize;
	return p;
}

/* Every few thousand instructions: stop if asked to (a plugin being
 * unloaded mid-loop). */
static void ox_hook(lua_State *L, lua_Debug *ar) {
	(void)ar;
	if (STATE(L)->interrupt) luaL_error(L, "stopped: the plugin was unloaded or reloaded");
}

lua_State *ox_newstate(int sid, size_t limit) {
	ox_state *s = (ox_state *)calloc(1, sizeof(ox_state));
	if (!s) return NULL;
	s->sid = sid;
	s->limit = limit;
	lua_State *L = lua_newstate(ox_alloc, s);
	if (!L) { free(s); return NULL; }
	STATE(L) = s;
	luaL_openlibs(L);
	lua_sethook(L, ox_hook, LUA_MASKCOUNT, 4000);
	return L;
}

void ox_close(lua_State *L) {
	ox_state *s = STATE(L);
	lua_close(L);
	free(s);
}

void ox_interrupt(lua_State *L) { STATE(L)->interrupt = 1; }
size_t ox_memory(lua_State *L) { return STATE(L)->used; }

/* ── stack ────────────────────────────────────────────────────────── */

int ox_gettop(lua_State *L) { return lua_gettop(L); }
void ox_settop(lua_State *L, int idx) { lua_settop(L, idx); }
int ox_type(lua_State *L, int idx) { return lua_type(L, idx); }
int ox_absindex(lua_State *L, int idx) { return lua_absindex(L, idx); }
int ox_checkstack(lua_State *L, int n) { return lua_checkstack(L, n); }
int ox_toboolean(lua_State *L, int idx) { return lua_toboolean(L, idx); }
int ox_isinteger(lua_State *L, int idx) { return lua_isinteger(L, idx); }
long long ox_tointeger(lua_State *L, int idx) { return (long long)lua_tointegerx(L, idx, NULL); }
double ox_tonumber(lua_State *L, int idx) { return (double)lua_tonumberx(L, idx, NULL); }
const char *ox_tostring(lua_State *L, int idx, size_t *len) {
	if (lua_type(L, idx) != LUA_TSTRING) { *len = 0; return ""; }
	return lua_tolstring(L, idx, len);
}

/* luaL_tolstring can call __tostring, which can raise: run it protected. */
static int ox_tostr_k(lua_State *L) {
	luaL_tolstring(L, 1, NULL);
	return 1;
}
const char *ox_tostr(lua_State *L, int idx, size_t *len) {
	idx = lua_absindex(L, idx);
	lua_pushcclosure(L, ox_tostr_k, 0);
	lua_pushvalue(L, idx);
	if (lua_pcallk(L, 1, 1, 0, 0, NULL) != LUA_OK) {
		lua_settop(L, lua_gettop(L) - 1);
		lua_pushlstring(L, "?", 1);
	}
	return lua_tolstring(L, -1, len);
}

void ox_pushnil(lua_State *L) { lua_pushnil(L); }
void ox_pushboolean(lua_State *L, int b) { lua_pushboolean(L, b); }
void ox_pushinteger(lua_State *L, long long n) { lua_pushinteger(L, (lua_Integer)n); }
void ox_pushnumber(lua_State *L, double n) { lua_pushnumber(L, (lua_Number)n); }
void ox_pushstring(lua_State *L, const char *s, size_t len) { lua_pushlstring(L, s, len); }
void ox_pushvalue(lua_State *L, int idx) { lua_pushvalue(L, idx); }
void ox_createtable(lua_State *L, int narr, int nrec) { lua_createtable(L, narr, nrec); }
void ox_rawseti(lua_State *L, int idx, long long n) { lua_rawseti(L, idx, (lua_Integer)n); }
void ox_rawsetfield(lua_State *L, int idx, const char *key, size_t len) {
	idx = lua_absindex(L, idx);
	lua_pushlstring(L, key, len);
	lua_rotate(L, -2, 1); /* key under the value */
	lua_rawset(L, idx);
}
int ox_next(lua_State *L, int idx) { return lua_next(L, idx); }

int ox_ref(lua_State *L) { return luaL_ref(L, LUA_REGISTRYINDEX); }
void ox_unref(lua_State *L, int ref) { luaL_unref(L, LUA_REGISTRYINDEX, ref); }
void ox_getref(lua_State *L, int ref) { lua_rawgeti(L, LUA_REGISTRYINDEX, ref); }

int ox_load_chunk(lua_State *L, const char *src, size_t len, const char *name) {
	return luaL_loadbufferx(L, src, len, name, "t"); /* text only: no binary chunks */
}

int ox_pcall(lua_State *L, int nargs, int nresults) {
	return lua_pcallk(L, nargs, nresults, 0, 0, NULL);
}

/* ── the bridge ───────────────────────────────────────────────────── */

/* call(fn, ...) / post(fn, ...): Go reads the arguments, pushes the
 * results and returns how many, or -1 with an error message on top,
 * raised here (in C) as a Lua error. */
static int ox_bridge(lua_State *L) {
	int post = (int)lua_tointegerx(L, lua_upvalueindex(1), NULL);
	int n = goOxisCall(STATE(L)->sid, L, post);
	if (n < 0) return lua_error(L);
	return n;
}

void ox_push_bridge(lua_State *L, int post) {
	lua_pushinteger(L, post);
	lua_pushcclosure(L, ox_bridge, 1);
}

static int ox_handle_method(lua_State *L) {
	int hid = (int)lua_tointegerx(L, lua_upvalueindex(1), NULL);
	const char *name = lua_tolstring(L, lua_upvalueindex(2), NULL);
	int post = lua_toboolean(L, lua_upvalueindex(3));
	int n = goOxisHandle(STATE(L)->sid, L, hid, (char *)name, post);
	if (n < 0) return lua_error(L);
	return n;
}

void ox_push_handle_method(lua_State *L, int hid, const char *name, int post) {
	lua_pushinteger(L, hid);
	lua_pushstring(L, name);
	lua_pushboolean(L, post);
	lua_pushcclosure(L, ox_handle_method, 3);
}

static int ox_handle_gc(lua_State *L) {
	goOxisHandleGC(STATE(L)->sid, (int)lua_tointegerx(L, lua_upvalueindex(1), NULL));
	return 0;
}

void ox_set_handle_gc(lua_State *L, int hid) {
	lua_createtable(L, 0, 1);
	lua_pushinteger(L, hid);
	lua_pushcclosure(L, ox_handle_gc, 1);
	ox_rawsetfield(L, -2, "__gc", 4);
	lua_setmetatable(L, -2);
}
