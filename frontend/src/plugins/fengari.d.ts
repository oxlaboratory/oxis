/**
 * fengari.d.ts — loose types for the parts of fengari this project uses
 * (the package ships none).
 */
declare module "fengari" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type LuaState = any;

  export const lua: {
    LUA_OK: number;
    LUA_TNIL: number;
    LUA_TNONE: number;
    LUA_TBOOLEAN: number;
    LUA_TNUMBER: number;
    LUA_TSTRING: number;
    LUA_TTABLE: number;
    LUA_TFUNCTION: number;
    LUA_REGISTRYINDEX: number;
    lua_absindex(L: LuaState, idx: number): number;
    lua_type(L: LuaState, idx: number): number;
    lua_toboolean(L: LuaState, idx: number): boolean;
    lua_tonumber(L: LuaState, idx: number): number;
    lua_tojsstring(L: LuaState, idx: number): string;
    lua_isstring(L: LuaState, idx: number): boolean;
    lua_pushnil(L: LuaState): void;
    lua_pushstring(L: LuaState, s: Uint8Array): void;
    lua_pushnumber(L: LuaState, n: number): void;
    lua_pushboolean(L: LuaState, b: boolean): void;
    lua_pushvalue(L: LuaState, idx: number): void;
    lua_pushcfunction(L: LuaState, fn: (L: LuaState) => number): void;
    lua_newtable(L: LuaState): void;
    lua_createtable(L: LuaState, narr: number, nrec: number): void;
    lua_setfield(L: LuaState, idx: number, k: Uint8Array): void;
    lua_setglobal(L: LuaState, name: Uint8Array): void;
    lua_rawseti(L: LuaState, idx: number, n: number): void;
    lua_rawgeti(L: LuaState, idx: number, n: number): number;
    lua_next(L: LuaState, idx: number): number;
    lua_pop(L: LuaState, n: number): void;
    lua_gettop(L: LuaState): number;
    lua_pcall(L: LuaState, nargs: number, nresults: number, msgh: number): number;
    lua_close(L: LuaState): void;
  };

  export const lauxlib: {
    luaL_newstate(): LuaState;
    luaL_ref(L: LuaState, t: number): number;
    luaL_unref(L: LuaState, t: number, ref: number): void;
    luaL_dostring(L: LuaState, s: Uint8Array): number;
    /** Compiles a chunk WITHOUT running it (pushes it as a callable
     *  Lua function on success) — see checkLuaSyntax in luaRuntime.ts
     *  for why that distinction matters. Returns LUA_OK on success. */
    luaL_loadstring(L: LuaState, s: Uint8Array): number;
    luaL_requiref(L: LuaState, name: Uint8Array, fn: (L: LuaState) => number, glb: number): void;
  };

  export const lualib: {
    luaL_openlibs(L: LuaState): void;
  };

  export function to_luastring(s: string): Uint8Array;
}

declare module "fengari-interop" {
  import type { LuaState } from "fengari";
  export function push(L: LuaState, v: unknown): void;
  export function pushjs(L: LuaState, v: unknown): void;
  export function tojs(L: LuaState, idx: number): unknown;
  export function checkjs(L: LuaState, idx: number): unknown;
  export function testjs(L: LuaState, idx: number): unknown;
  export function luaopen_js(L: LuaState): number;
}