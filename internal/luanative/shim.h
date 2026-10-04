/*
 * shim.h — the C side of internal/luanative.
 *
 * Go calls Lua through the ox_* functions here, never the Lua API
 * directly: on Windows the API comes from lua54.dll through function
 * pointers (so Lua C modules share the same Lua), and the wrappers are
 * also where anything that could raise a Lua error is kept away from Go
 * (a Lua error is a longjmp, which must never cross a Go frame).
 */
#ifndef OXIS_LUA_SHIM_H
#define OXIS_LUA_SHIM_H

#include <stddef.h>
#include "lua.h"
#include "lauxlib.h"
#include "lualib.h"

/* Per-state record, reached through lua_getextraspace. */
typedef struct {
	int sid;                /* the bridge's id for this state */
	volatile int interrupt; /* set to stop the code running in it */
	size_t used, limit;     /* bytes allocated, and the cap */
} ox_state;

/* Windows: loads lua54.dll from path and binds the API. Returns NULL,
 * or what went wrong. Elsewhere Lua is linked in and this does nothing. */
const char *ox_load(const char *path);
const char *ox_version(void);

lua_State *ox_newstate(int sid, size_t limit);
void ox_close(lua_State *L);
void ox_interrupt(lua_State *L);
size_t ox_memory(lua_State *L);

int ox_gettop(lua_State *L);
void ox_settop(lua_State *L, int idx);
int ox_type(lua_State *L, int idx);
int ox_absindex(lua_State *L, int idx);
int ox_checkstack(lua_State *L, int n);
int ox_toboolean(lua_State *L, int idx);
int ox_isinteger(lua_State *L, int idx);
long long ox_tointeger(lua_State *L, int idx);
double ox_tonumber(lua_State *L, int idx);
/* Only for values that are strings (a number would be converted in
 * place, which breaks lua_next). */
const char *ox_tostring(lua_State *L, int idx, size_t *len);
/* tostring() of any value, pushed. */
const char *ox_tostr(lua_State *L, int idx, size_t *len);

void ox_pushnil(lua_State *L);
void ox_pushboolean(lua_State *L, int b);
void ox_pushinteger(lua_State *L, long long n);
void ox_pushnumber(lua_State *L, double n);
void ox_pushstring(lua_State *L, const char *s, size_t len);
void ox_pushvalue(lua_State *L, int idx);
void ox_createtable(lua_State *L, int narr, int nrec);
void ox_rawseti(lua_State *L, int idx, long long n);
/* t[key] = top, raw; pops the value. */
void ox_rawsetfield(lua_State *L, int idx, const char *key, size_t len);
int ox_next(lua_State *L, int idx);

int ox_ref(lua_State *L);          /* pops the top into the registry */
void ox_unref(lua_State *L, int ref);
void ox_getref(lua_State *L, int ref);

/* Loads a chunk (compile only); 0, or an error message on top. */
int ox_load_chunk(lua_State *L, const char *src, size_t len, const char *name);
/* Calls the function under nargs arguments; 0, or an error message on top. */
int ox_pcall(lua_State *L, int nargs, int nresults);

/* The bridge functions, for the prelude: call (waits for an answer) and
 * post (doesn't). */
void ox_push_bridge(lua_State *L, int post);
/* A method of a JS handle: calls handle `hid`'s `name`. */
void ox_push_handle_method(lua_State *L, int hid, const char *name, int post);
/* Gives the table on top a __gc that tells JS the handle is gone. */
void ox_set_handle_gc(lua_State *L, int hid);

#endif
