/**
 * luaRuntime.ts — OXIS Lua execution environment
 *
 * Runs real Lua 5.3 via fengari (a pure-JS Lua VM) — this is a genuine
 * interpreter, not a regex-based JS transpiler. Earlier versions of
 * this file *were* a transpiler (pattern-replace Lua syntax into JS,
 * then `new Function(...)` it) that silently mishandled a lot of real
 * Lua — that's why installed plugins would register successfully but
 * do nothing (or the wrong thing) when actually invoked.
 *
 * fengari-interop (the "call arbitrary JS objects/functions from Lua"
 * bridge fengari ships with) has its own sharp edge worth documenting:
 * its generic `__call` metamethod treats the FIRST Lua argument as a
 * JS `this` for `Function.prototype.apply`, unconditionally — that's
 * correct for Lua's `obj:method(a, b)` colon-call convention (which
 * really does pass `obj` as an implicit first arg), but plugins here
 * use plain dot-calls (`oxis.command("name", fn, "desc")`), which Lua
 * passes as three REAL arguments with no implicit self at all. Run
 * through `__call`, that shifts everything: the JS function ends up
 * receiving (fn, "desc") as its first two arguments and drops the
 * name string entirely. Confirmed by direct testing — not a guess.
 *
 * The fix is to not use fengari-interop's generic object bridge for
 * the `oxis` API surface at all. Instead, buildOxisTable() constructs
 * the `oxis` table by hand with lua_pushcfunction — real Lua C
 * functions that read arguments directly off the Lua stack. That's
 * the same mechanism Lua's own standard library uses, so there's no
 * calling-convention mismatch to work around.
 *
 * Each plugin gets its own lua_State, kept alive for the plugin's
 * lifetime (not just during the initial load) so that command
 * handlers — real Lua functions, registered via oxis.command() and
 * held by a registry ref — can be invoked later, whenever the user
 * actually runs the command. dispose() closes that state; call it
 * when a plugin is unloaded/reloaded/disabled, or its Lua functions
 * (and the memory fengari allocated for them) leak for the rest of
 * the session.
 */

import { lua, lauxlib, lualib, to_luastring } from "fengari";

// fengari's LuaState type isn't exported in a convenient form — treat
// it as opaque outside this file.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LuaState = any;

export type LuaJSValue = string | number | boolean | undefined | LuaJSValue[] | { [k: string]: LuaJSValue };

/** What a Lua plugin can call into OXIS with. Implemented by pluginAPI.ts —
 *  this file only handles the Lua<->JS boundary, not what any of these
 *  calls actually DO inside OXIS. */
export interface OxisBindings {
  command(name: string, invoke: (args: string[], rest: string) => void, desc: string | undefined): void;
  task(name: string, cmd: string, desc: string | undefined): void;
  echo(text: string): void;
  // Typed as returning a promise (not void) because it genuinely does
  // — buildLuaAPI's real implementation (runScript) always has, this
  // just wasn't reflected here before. Lua itself never sees this
  // promise (oxis.run has no callback argument, fire-and-forget by
  // design), but luaRuntime.ts's own binding needs to .catch() it —
  // see its doc comment for why that's not optional.
  run(cmd: string): Promise<{ ok: boolean }>;
  theme(name: string): void;
  cwd(): string;
  getOption(key: string): LuaJSValue;
  setOption(key: string, value: LuaJSValue): void;
  autocmd(event: string, invoke: () => void): void;
  keymap(mode: string, combo: string, invoke: () => void): void;
  pluginEnable(name: string): void;
  pluginDisable(name: string): void;
  workspace(path: string): void;
  dashboard(config: LuaJSValue): void;
  newTerminal(): void;
  /** oxis.workflow("name", { steps = {...}, env = {...} }, "desc") —
   *  see workflowRunner.ts. `def` is the raw Lua table (validated and
   *  converted to a real WorkflowDef by the implementation, not here —
   *  this layer only moves values across the Lua<->JS boundary). */
  workflow(name: string, def: LuaJSValue, desc: string | undefined): void;
  /** "windows" or "unix" — lets a plugin branch its oxis.run()/
   *  oxis.task() shell scripts per platform (PowerShell vs bash)
   *  without needing an async permission-gated call just to find out.
   *  See README § Core System APIs. */
  platform: string;

  // ── Core System APIs — see README § Core System APIs ─────────
  // All async (real file/process/network I/O can't be synchronous),
  // so the Lua side is callback-style: oxis.fs.read(path, function(err, content) ... end).
  // Each rejects with a permission-gate error if the plugin hasn't
  // been granted that namespace — see permissions.ts.
  fsRead(path: string): Promise<string>;
  fsWrite(path: string, content: string): Promise<void>;
  fsList(path: string): Promise<LuaJSValue[]>;
  fsStat(path: string): Promise<LuaJSValue>;
  fsMkdir(path: string): Promise<void>;
  fsRemove(path: string): Promise<void>;
  processList(): Promise<LuaJSValue[]>;
  processKill(pid: number): Promise<void>;
  netRequest(opts: LuaJSValue): Promise<LuaJSValue>;
  systemInfo(): Promise<LuaJSValue>;
}

export interface LoadedLuaPlugin {
  /** Close this plugin's lua_State. Always call this on unload/reload/disable. */
  dispose(): void;
}

export type LuaLoadResult =
  | { ok: true; plugin: LoadedLuaPlugin }
  | { ok: false; error: string };

// ── Lua value <-> JS value marshaling (plain data only — functions
// are handled separately via registry refs, see makeInvoker below) ──

function luaToJS(L: LuaState, idx: number): LuaJSValue {
  idx = lua.lua_absindex(L, idx);
  const t = lua.lua_type(L, idx);
  switch (t) {
    case lua.LUA_TNIL:
    case lua.LUA_TNONE:
      return undefined;
    case lua.LUA_TBOOLEAN:
      return lua.lua_toboolean(L, idx);
    case lua.LUA_TNUMBER:
      return lua.lua_tonumber(L, idx);
    case lua.LUA_TSTRING:
      return lua.lua_tojsstring(L, idx);
    case lua.LUA_TTABLE: {
      const arr: LuaJSValue[] = [];
      const obj: { [k: string]: LuaJSValue } = {};
      let isArray = true;
      let n = 0;
      lua.lua_pushnil(L);
      while (lua.lua_next(L, idx) !== 0) {
        const keyType = lua.lua_type(L, -2);
        const value = luaToJS(L, -1);
        if (keyType === lua.LUA_TNUMBER) {
          const kn = lua.lua_tonumber(L, -2);
          if (Number.isInteger(kn) && kn === ++n) {
            arr.push(value);
          } else {
            isArray = false;
            obj[String(kn)] = value;
          }
        } else {
          isArray = false;
          obj[lua.lua_tojsstring(L, -2)] = value;
        }
        lua.lua_pop(L, 1); // pop value, keep key for lua_next
      }
      return isArray ? arr : obj;
    }
    default:
      return undefined; // functions/userdata: not plain data, not converted
  }
}

function pushLuaValue(L: LuaState, v: LuaJSValue): void {
  if (v === undefined || v === null) { lua.lua_pushnil(L); return; }
  if (typeof v === "string")  { lua.lua_pushstring(L, to_luastring(v)); return; }
  if (typeof v === "number")  { lua.lua_pushnumber(L, v); return; }
  if (typeof v === "boolean") { lua.lua_pushboolean(L, v); return; }
  if (Array.isArray(v)) {
    lua.lua_createtable(L, v.length, 0);
    v.forEach((item, i) => { pushLuaValue(L, item); lua.lua_rawseti(L, -2, i + 1); });
    return;
  }
  lua.lua_newtable(L);
  for (const [k, val] of Object.entries(v)) {
    pushLuaValue(L, val);
    lua.lua_setfield(L, -2, to_luastring(k));
  }
}

function argString(L: LuaState, i: number): string | undefined {
  return lua.lua_isstring(L, i) ? lua.lua_tojsstring(L, i) : undefined;
}

/** Wraps a Lua function value already ON TOP OF THE STACK at `idx` into a
 *  plain JS closure that, when called, invokes it via lua_pcall. Pops
 *  nothing itself — caller owns the stack. The function is kept alive
 *  in the Lua registry (luaL_ref) for as long as the closure exists;
 *  there's no explicit unref, since these live for the plugin's whole
 *  lifetime and get reclaimed wholesale when dispose() closes the state. */
function makeInvoker(L: LuaState, valueIdx: number): () => void {
  lua.lua_pushvalue(L, valueIdx);
  const ref = lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX);
  return () => {
    lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, ref);
    const status = lua.lua_pcall(L, 0, 0, 0);
    if (status !== lua.LUA_OK) {
      const err = lua.lua_tojsstring(L, -1);
      lua.lua_pop(L, 1);
      throw new Error(err);
    }
  };
}

/** Like makeInvoker, but the returned closure can pass arguments back
 *  into Lua (used for async callback-style bindings — see
 *  buildOxisTable's fs/process/net/system tables). `closedRef` guards
 *  against calling back into a lua_State that's already been
 *  dispose()'d by the time the async operation finishes (e.g. the
 *  plugin was disabled/reloaded mid-request) — fengari doesn't crash
 *  on this, but it's not meaningful to run Lua on a state whose owner
 *  considers it gone, and it can wedge should the state be reused. */
function makeInvokerWithArgs(L: LuaState, valueIdx: number, closedRef: { closed: boolean }): (...args: LuaJSValue[]) => void {
  lua.lua_pushvalue(L, valueIdx);
  const ref = lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX);
  return (...args: LuaJSValue[]) => {
    if (closedRef.closed) return;
    lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, ref);
    for (const a of args) pushLuaValue(L, a);
    const status = lua.lua_pcall(L, args.length, 0, 0);
    if (status !== lua.LUA_OK) {
      const err = lua.lua_tojsstring(L, -1);
      lua.lua_pop(L, 1);
      console.warn("[oxis:lua] async callback error:", err);
    }
  };
}

function buildOxisTable(L: LuaState, b: OxisBindings, closedRef: { closed: boolean }): void {
  lua.lua_newtable(L);
  const setfn = (name: string, cfn: (L: LuaState) => number) => {
    lua.lua_pushcfunction(L, cfn);
    lua.lua_setfield(L, -2, to_luastring(name));
  };

  // oxis.platform — a plain string, not a function (no () needed on
  // the Lua side: `if oxis.platform == "windows" then ... end`).
  pushLuaValue(L, b.platform);
  lua.lua_setfield(L, -2, to_luastring("platform"));

  setfn("command", (L) => {
    const name = lua.lua_tojsstring(L, 1);
    // Was makeInvoker (zero-arg) — every Lua plugin command was
    // silently unable to receive arguments at all, forcing plugins
    // that needed input to fall back to shell Read-Host/read prompts
    // instead of `'command arg1 arg2` like TypeScript-registered
    // commands ('market install <n>, 'plugin enable <n>) already
    // support. Real fix: forward (args, rest) as (Lua table, Lua
    // string) — invoke() -> function(args, rest) on the Lua side.
    const invoke = makeInvokerWithArgs(L, 2, closedRef);
    b.command(name, (args, rest) => invoke(args, rest), argString(L, 3));
    return 0;
  });

  setfn("task", (L) => {
    const name = lua.lua_tojsstring(L, 1);
    const cmd = lua.lua_tojsstring(L, 2);
    b.task(name, cmd, argString(L, 3));
    return 0;
  });

  setfn("echo", (L) => { b.echo(lua.lua_tojsstring(L, 1)); return 0; });
  // oxis.run() is fire-and-forget from Lua's side — no callback
  // argument, unlike fs/process/net/system — so there's no Lua-visible
  // way to report a failure back. The .catch() here isn't decorative:
  // without it, a permission denial (or any other rejection) becomes
  // an "unhandled promise rejection" at best; b.run() itself now
  // guarantees it never throws synchronously (see runScript's own doc
  // comment), so this closes the loop on both sides of that boundary.
  setfn("run",  (L) => {
    b.run(lua.lua_tojsstring(L, 1)).catch((e) => {
      console.warn("[oxis:lua] oxis.run() failed:", e instanceof Error ? e.message : e);
    });
    return 0;
  });
  setfn("theme", (L) => { b.theme(lua.lua_tojsstring(L, 1)); return 0; });
  setfn("cwd", (L) => { pushLuaValue(L, b.cwd()); return 1; });
  setfn("newTerminal", () => { b.newTerminal(); return 0; });
  setfn("workspace", (L) => { b.workspace(lua.lua_tojsstring(L, 1)); return 0; });
  setfn("dashboard", (L) => { b.dashboard(luaToJS(L, 1)); return 0; });
  setfn("workflow", (L) => {
    const name = lua.lua_tojsstring(L, 1);
    const def = luaToJS(L, 2);
    b.workflow(name, def, argString(L, 3));
    return 0;
  });

  // option(key) -> value   |   option(key, value) -> (sets it)
  setfn("option", (L) => {
    const nargs = lua.lua_gettop(L);
    const key = lua.lua_tojsstring(L, 1);
    if (nargs < 2) {
      pushLuaValue(L, b.getOption(key));
      return 1;
    }
    b.setOption(key, luaToJS(L, 2));
    return 0;
  });

  setfn("autocmd", (L) => {
    const event = lua.lua_tojsstring(L, 1);
    const invoke = makeInvoker(L, 2);
    b.autocmd(event, invoke);
    return 0;
  });

  setfn("keymap", (L) => {
    const mode = lua.lua_tojsstring(L, 1);
    const combo = lua.lua_tojsstring(L, 2);
    const invoke = makeInvoker(L, 3);
    b.keymap(mode, combo, invoke);
    return 0;
  });

  // nested oxis.plugin.enable/disable
  lua.lua_newtable(L);
  lua.lua_pushcfunction(L, (L: LuaState) => { b.pluginEnable(lua.lua_tojsstring(L, 1)); return 0; });
  lua.lua_setfield(L, -2, to_luastring("enable"));
  lua.lua_pushcfunction(L, (L: LuaState) => { b.pluginDisable(lua.lua_tojsstring(L, 1)); return 0; });
  lua.lua_setfield(L, -2, to_luastring("disable"));
  lua.lua_setfield(L, -2, to_luastring("plugin"));

  // ── oxis.fs.* / oxis.process.* / oxis.net.* / oxis.system.* ──
  // Callback style: oxis.fs.read(path, function(err, content) ... end)
  // `err` is nil on success, a string on failure (including a denied
  // permission — see permissions.ts).
  const asyncCb = (promise: Promise<LuaJSValue>, cb: (...a: LuaJSValue[]) => void) => {
    promise.then((v) => cb(undefined, v)).catch((e) => cb(e instanceof Error ? e.message : String(e)));
  };

  lua.lua_newtable(L); // oxis.fs
  lua.lua_pushcfunction(L, (L: LuaState) => {
    const path = lua.lua_tojsstring(L, 1);
    asyncCb(b.fsRead(path), makeInvokerWithArgs(L, 2, closedRef));
    return 0;
  });
  lua.lua_setfield(L, -2, to_luastring("read"));
  lua.lua_pushcfunction(L, (L: LuaState) => {
    const path = lua.lua_tojsstring(L, 1);
    const content = lua.lua_tojsstring(L, 2);
    asyncCb(b.fsWrite(path, content).then(() => undefined), makeInvokerWithArgs(L, 3, closedRef));
    return 0;
  });
  lua.lua_setfield(L, -2, to_luastring("write"));
  lua.lua_pushcfunction(L, (L: LuaState) => {
    const path = lua.lua_tojsstring(L, 1);
    asyncCb(b.fsList(path), makeInvokerWithArgs(L, 2, closedRef));
    return 0;
  });
  lua.lua_setfield(L, -2, to_luastring("list"));
  lua.lua_pushcfunction(L, (L: LuaState) => {
    const path = lua.lua_tojsstring(L, 1);
    asyncCb(b.fsStat(path), makeInvokerWithArgs(L, 2, closedRef));
    return 0;
  });
  lua.lua_setfield(L, -2, to_luastring("stat"));
  lua.lua_pushcfunction(L, (L: LuaState) => {
    const path = lua.lua_tojsstring(L, 1);
    asyncCb(b.fsMkdir(path).then(() => undefined), makeInvokerWithArgs(L, 2, closedRef));
    return 0;
  });
  lua.lua_setfield(L, -2, to_luastring("mkdir"));
  lua.lua_pushcfunction(L, (L: LuaState) => {
    const path = lua.lua_tojsstring(L, 1);
    asyncCb(b.fsRemove(path).then(() => undefined), makeInvokerWithArgs(L, 2, closedRef));
    return 0;
  });
  lua.lua_setfield(L, -2, to_luastring("remove"));
  lua.lua_setfield(L, -2, to_luastring("fs"));

  lua.lua_newtable(L); // oxis.process
  lua.lua_pushcfunction(L, (L: LuaState) => {
    asyncCb(b.processList(), makeInvokerWithArgs(L, 1, closedRef));
    return 0;
  });
  lua.lua_setfield(L, -2, to_luastring("list"));
  lua.lua_pushcfunction(L, (L: LuaState) => {
    const pid = lua.lua_tonumber(L, 1);
    asyncCb(b.processKill(pid).then(() => undefined), makeInvokerWithArgs(L, 2, closedRef));
    return 0;
  });
  lua.lua_setfield(L, -2, to_luastring("kill"));
  lua.lua_setfield(L, -2, to_luastring("process"));

  lua.lua_newtable(L); // oxis.net
  lua.lua_pushcfunction(L, (L: LuaState) => {
    const opts = luaToJS(L, 1);
    asyncCb(b.netRequest(opts), makeInvokerWithArgs(L, 2, closedRef));
    return 0;
  });
  lua.lua_setfield(L, -2, to_luastring("request"));
  lua.lua_setfield(L, -2, to_luastring("net"));

  lua.lua_newtable(L); // oxis.system
  lua.lua_pushcfunction(L, (L: LuaState) => {
    asyncCb(b.systemInfo(), makeInvokerWithArgs(L, 1, closedRef));
    return 0;
  });
  lua.lua_setfield(L, -2, to_luastring("info"));
  lua.lua_setfield(L, -2, to_luastring("system"));

  lua.lua_setglobal(L, to_luastring("oxis"));
}

/** Loads and runs Lua source (its top-level body — this is where
 *  oxis.command()/oxis.task()/etc calls actually register things) in
 *  a fresh, dedicated lua_State. On success, the returned plugin's
 *  registered command closures stay callable for as long as it isn't
 *  disposed. On failure, the state is already closed — nothing to
 *  clean up. */
export function loadLuaPlugin(source: string, bindings: OxisBindings): LuaLoadResult {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const closedRef = { closed: false };
  buildOxisTable(L, bindings, closedRef);

  const status = lauxlib.luaL_dostring(L, to_luastring(source));
  if (status !== lua.LUA_OK) {
    const err = lua.lua_tojsstring(L, -1);
    closedRef.closed = true;
    lua.lua_close(L);
    return { ok: false, error: err };
  }

  return {
    ok: true,
    plugin: { dispose: () => { closedRef.closed = true; lua.lua_close(L); } },
  };
}

/** Compiles (but never runs) a plugin's Lua source — catches syntax
 *  errors with zero side effects, unlike loadLuaPlugin() which is a
 *  real execution (registers commands, can run arbitrary top-level
 *  code). Used by 'plugin validate, which is specifically supposed to
 *  be safe to run on an already-loaded, currently-in-use plugin
 *  without duplicating its registered commands or re-triggering
 *  whatever it does at load time. luaL_loadstring alone (no
 *  luaL_openlibs, no lua_pcall) compiles the chunk onto the stack and
 *  reports a syntax error if there is one, without ever executing a
 *  single instruction of it. */
export function checkLuaSyntax(source: string): { ok: true } | { ok: false; error: string } {
  const L = lauxlib.luaL_newstate();
  const status = lauxlib.luaL_loadstring(L, to_luastring(source));
  if (status !== lua.LUA_OK) {
    const err = lua.lua_tojsstring(L, -1);
    lua.lua_close(L);
    return { ok: false, error: err };
  }
  lua.lua_close(L);
  return { ok: true };
}

/** True — a real Lua VM is always available now (fengari is a pure-JS
 *  dependency, bundled at build time, not loaded at runtime). Kept as
 *  a function (not a constant) since pluginManager.ts checks it as
 *  one; some earlier code paths guarded on this before falling back
 *  to the old transpiler, which no longer exists. */
export function isAvailable(): boolean {
  return true;
}