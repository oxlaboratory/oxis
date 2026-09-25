/**
 * luaRuntime.ts — runs plugin Lua (5.3) with fengari.
 *
 * The `oxis` table is built by hand from lua_pushcfunction functions
 * that read their arguments straight off the Lua stack. fengari-interop's
 * generic bridge isn't used: its __call treats the first argument as
 * `this`, which breaks plain dot calls like oxis.command("name", fn).
 *
 * Each plugin gets its own lua_State, kept alive while the plugin is
 * loaded so its command handlers can run later. dispose() closes it.
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
  // Returns a promise; Lua never sees it, but the binding catches it.
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

  // ── Core system APIs — async, callback-style on the Lua side:
  // oxis.fs.read(path, function(err, content) ... end). Each rejects if
  // the plugin lacks the permission (permissions.ts).
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
      // lua_next doesn't iterate in key order (fengari returns
      // {10, 20, 30} as 3, 2, 1), so collect every entry first and treat
      // the table as an array only if its keys are exactly 1..n. An empty
      // table becomes [].
      const entries: { key: string | number; isNumber: boolean; value: LuaJSValue }[] = [];
      let maxIntKey = 0;
      let intKeyCount = 0;
      lua.lua_pushnil(L);
      while (lua.lua_next(L, idx) !== 0) {
        const keyType = lua.lua_type(L, -2);
        const value = luaToJS(L, -1);
        if (keyType === lua.LUA_TNUMBER) {
          const kn = lua.lua_tonumber(L, -2);
          if (Number.isInteger(kn) && kn >= 1) {
            intKeyCount++;
            if (kn > maxIntKey) maxIntKey = kn;
          }
          entries.push({ key: kn, isNumber: true, value });
        } else {
          entries.push({ key: lua.lua_tojsstring(L, -2), isNumber: false, value });
        }
        lua.lua_pop(L, 1); // pop value, keep key for lua_next
      }
      const isArray = intKeyCount === entries.length && maxIntKey === entries.length;
      if (isArray) {
        const arr: LuaJSValue[] = new Array(maxIntKey);
        for (const e of entries) arr[(e.key as number) - 1] = e.value;
        return arr;
      }
      const obj: { [k: string]: LuaJSValue } = {};
      for (const e of entries) obj[e.isNumber ? String(e.key) : (e.key as string)] = e.value;
      return obj;
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

/** Wraps the Lua function at `idx` in a JS closure that calls it with
 *  lua_pcall. The function stays referenced in the registry until the
 *  state is closed. */
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

/** Like makeInvoker, but passes arguments to Lua (async callbacks).
 *  Does nothing once the plugin's state has been disposed. */
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
    // Handlers receive (args, rest): a table of words and the raw text.
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
  // oxis.run() has no Lua callback, so log failures (a denied
  // permission, for example) here.
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

/** Runs Lua source in a new lua_State (its top level registers the
 *  commands, tasks, etc.). On failure the state is already closed. */
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

/** Compiles Lua source without running it, to report syntax errors
 *  with no side effects ('plugin validate). */
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

/** Always true: fengari is bundled. */
export function isAvailable(): boolean {
  return true;
}