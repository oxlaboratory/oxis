/**
 * luaRuntime.ts — runs plugin Lua. Real Lua 5.4 in OXIS when it's there
 * (nativeLua.ts, internal/luanative); otherwise, or with 'config set
 * luaEngine fengari, Lua 5.3 in the page with fengari, here.
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
import { loadNative, engineSetting } from "./nativeLua";

// fengari's LuaState type isn't exported in a convenient form — treat
// it as opaque outside this file.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LuaState = any;

export type LuaJSValue = string | number | boolean | undefined | LuaJSValue[] | { [k: string]: LuaJSValue };

/** A Lua function a plugin passed in, callable from JS later. */
export type LuaCallback = (...args: LuaJSValue[]) => void;

/** Named Lua callbacks from a table like { stdout = fn, exit = fn }.
 *  release() lets Lua collect them once the stream has ended. */
export interface LuaCallbacks {
  fns: Record<string, LuaCallback | undefined>;
  release(): void;
}

/** What oxis.process.spawn / fs.watch / net.stream return: a table of
 *  methods, callable as h.kill() or h:kill(). */
export type LuaHandle = Record<string, (...args: LuaJSValue[]) => LuaJSValue | void>;

/** What a Lua plugin can call into OXIS with. Implemented by pluginAPI.ts —
 *  this file only handles the Lua<->JS boundary, not what any of these
 *  calls actually DO inside OXIS. */
export interface OxisBindings {
  command(name: string, invoke: (args: string[], rest: string, raw: string) => void, desc: string | undefined): void;
  task(name: string, cmd: string, desc: string | undefined): void;
  /** kind: "ok", "err", "warn", "dim" or "accent" (default: plain). */
  echo(text: string, kind?: string): void;
  // Returns a promise; Lua never sees it, but the binding catches it.
  run(cmd: string): Promise<{ ok: boolean }>;
  /** Quotes text as one argument for the platform's shell. */
  quote(text: string): string;
  theme(name: string): void;
  cwd(): string;
  getOption(key: string): LuaJSValue;
  setOption(key: string, value: LuaJSValue): void;
  autocmd(event: string, invoke: (payload?: LuaJSValue) => void): void;
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
  /** oxis.fs.search(root, query [, { regex, caseSensitive, wholeWord, max }], fn(err, result)):
   *  the editor's Search in files (skips dependency and build folders). */
  fsSearch(root: string, query: string, opts: LuaJSValue): Promise<LuaJSValue>;
  processList(): Promise<LuaJSValue[]>;
  processKill(pid: number): Promise<void>;
  netRequest(opts: LuaJSValue): Promise<LuaJSValue>;
  systemInfo(): Promise<LuaJSValue>;

  // ── Streams: output that arrives over time (streams.ts) ──
  /** oxis.process.spawn(opts, { stdout, stderr, exit }) */
  processSpawn(opts: LuaJSValue, on: LuaCallbacks): LuaHandle;
  /** oxis.fs.watch(path, fn(change), opts) */
  fsWatch(path: string, opts: LuaJSValue, on: LuaCallbacks): LuaHandle;
  /** oxis.net.stream(opts, { response, data, line, event, done }) */
  netStream(opts: LuaJSValue, on: LuaCallbacks): LuaHandle;

  jsonEncode(value: LuaJSValue): string;
  jsonDecode(text: string): LuaJSValue;

  // ── oxis.editor: the file open in the editor ──
  editorCurrent(): LuaJSValue;
  editorOpen(path: string, line: number | undefined): void;
  editorSetText(text: string): boolean;
  editorInsert(text: string): boolean;
  editorReplaceLines(first: number, last: number, text: string): boolean;
  editorSelect(line: number, col: number, toLine: number | undefined, toCol: number | undefined): boolean;
  editorSave(): Promise<LuaJSValue>;
  editorOn(event: string, cb: LuaCallback): void;

  // ── Asking and timing ──
  /** oxis.ask(question, fn(answer) [, { label = "…", cancel = fn }]): the
   *  next line typed is the answer (promptCapture.ts); Ctrl+C cancels. */
  ask(question: string, onAnswer: LuaCallback, label: string | undefined, onCancel: LuaCallback | undefined): void;
  /** oxis.after(seconds, fn): once, later. */
  after(seconds: number, fn: LuaCallback): LuaHandle;
  /** oxis.every(seconds, fn [, { foreground = true, stop = fn }]): again
   *  and again until h:stop(); a foreground one also stops on Ctrl+C. */
  every(seconds: number, fn: LuaCallback, foreground: boolean, onStop: LuaCallback | undefined): LuaHandle;
  /** oxis.line(text [, kind]): a line that can be rewritten in place
   *  with l:set(text [, kind]), for animations and progress. */
  line(text: string, kind: string | undefined): LuaHandle;
  /** oxis.input(text): puts text in the prompt, ready to edit or run. */
  input(text: string): void;
  /** oxis.store.get/set: the plugin's own values, kept between runs. */
  storeGet(key: string): LuaJSValue;
  storeSet(key: string, value: LuaJSValue): void;

  /** Throws unless the plugin may use the namespace (prompting for a
   *  plugin without a manifest): native Lua's io, os and C modules. */
  requirePermission?(ns: string): void | Promise<void>;

  /** A Lua callback raised an error (shown to the user). */
  reportError?(message: string): void;
  /** The plugin is being unloaded: stop what it started. */
  dispose?(): void;
}

export interface LoadedLuaPlugin {
  /** Close this plugin's lua_State. Always call this on unload/reload/disable. */
  dispose(): void;
  /** What it runs on: "native" (Lua 5.4) or "fengari" (Lua 5.3). */
  readonly engine?: "native" | "fengari";
}

/** Whether the plugin's file ran without an error. */
export type LuaReady = { ok: true } | { ok: false; error: string };

/** `ready` settles once the file has run: at once on fengari, after a
 *  round trip on native Lua. `ok: false` here is a failure known at
 *  once (fengari); with native Lua a failure shows in `ready`. */
export type LuaLoadResult = (
  | { ok: true; plugin: LoadedLuaPlugin }
  | { ok: false; error: string }
) & { ready: Promise<LuaReady> };

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
  // Whole numbers become Lua integers, so "status " .. 200 reads "200",
  // not "200.0" (fengari's integers are 32-bit; bigger ones stay floats).
  if (typeof v === "number")  {
    if (Number.isInteger(v) && v >= -0x80000000 && v <= 0x7fffffff) lua.lua_pushinteger(L, v);
    else lua.lua_pushnumber(L, v);
    return;
  }
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
interface StateRef { closed: boolean; report?: (message: string) => void }

function makeInvokerWithArgs(L: LuaState, valueIdx: number, closedRef: StateRef): (...args: LuaJSValue[]) => void {
  return makeCallback(L, valueIdx, closedRef).call;
}

/** A Lua function turned into a JS callback that can be released (its
 *  registry reference dropped) when it's no longer needed. */
function makeCallback(L: LuaState, valueIdx: number, state: StateRef): { call: LuaCallback; release: () => void } {
  lua.lua_pushvalue(L, valueIdx);
  const ref = lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX);
  let released = false;
  return {
    call: (...args: LuaJSValue[]) => {
      if (state.closed || released) return;
      lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, ref);
      for (const a of args) pushLuaValue(L, a);
      const status = lua.lua_pcall(L, args.length, 0, 0);
      if (status !== lua.LUA_OK) {
        const err = lua.lua_tojsstring(L, -1);
        lua.lua_pop(L, 1);
        console.warn("[oxis:lua] callback error:", err);
        state.report?.(err);
      }
    },
    release: () => {
      if (state.closed || released) return;
      released = true;
      lauxlib.luaL_unref(L, lua.LUA_REGISTRYINDEX, ref);
    },
  };
}

/** Callbacks from the value at idx: a table of named functions, or (when
 *  `single` is given) one function, which becomes that name. */
function callbacksAt(L: LuaState, idx: number, names: string[], state: StateRef, single?: string): LuaCallbacks {
  const fns: Record<string, LuaCallback | undefined> = {};
  const releases: (() => void)[] = [];
  const t = lua.lua_type(L, idx);
  if (t === lua.LUA_TFUNCTION && single) {
    const c = makeCallback(L, idx, state);
    fns[single] = c.call;
    releases.push(c.release);
  } else if (t === lua.LUA_TTABLE) {
    for (const name of names) {
      lua.lua_getfield(L, idx, to_luastring(name));
      if (lua.lua_type(L, -1) === lua.LUA_TFUNCTION) {
        const c = makeCallback(L, lua.lua_gettop(L), state);
        fns[name] = c.call;
        releases.push(c.release);
      }
      lua.lua_pop(L, 1);
    }
  }
  return { fns, release: () => releases.forEach((r) => r()) };
}

/** Pushes a handle: a table of methods. A leading table argument (the
 *  handle itself, from h:method()) is skipped, so h.kill() and h:kill()
 *  both work. */
function pushHandle(L: LuaState, handle: LuaHandle): void {
  lua.lua_newtable(L);
  for (const [name, fn] of Object.entries(handle)) {
    lua.lua_pushcfunction(L, (L: LuaState) => {
      const n = lua.lua_gettop(L);
      const first = n >= 1 && lua.lua_type(L, 1) === lua.LUA_TTABLE ? 2 : 1;
      const args: LuaJSValue[] = [];
      for (let i = first; i <= n; i++) args.push(luaToJS(L, i));
      pushLuaValue(L, fn(...args) ?? undefined);
      return 1;
    });
    lua.lua_setfield(L, -2, to_luastring(name));
  }
}

function argNumber(L: LuaState, i: number): number | undefined {
  return lua.lua_type(L, i) === lua.LUA_TNUMBER ? lua.lua_tonumber(L, i) : undefined;
}

function buildOxisTable(L: LuaState, b: OxisBindings, closedRef: StateRef): void {
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
    // Handlers receive (args, rest, raw): a table of words, the words
    // joined, and the text exactly as typed (quotes, backslashes, tabs).
    const invoke = makeInvokerWithArgs(L, 2, closedRef);
    b.command(name, (args, rest, raw) => invoke(args, rest, raw), argString(L, 3));
    return 0;
  });

  setfn("task", (L) => {
    const name = lua.lua_tojsstring(L, 1);
    const cmd = lua.lua_tojsstring(L, 2);
    b.task(name, cmd, argString(L, 3));
    return 0;
  });

  setfn("echo", (L) => { b.echo(lua.lua_tojsstring(L, 1), argString(L, 2)); return 0; });
  setfn("line", (L) => { pushHandle(L, b.line(argString(L, 1) ?? "", argString(L, 2))); return 1; });
  // oxis.run() has no Lua callback, so log failures (a denied
  // permission, for example) here.
  setfn("run",  (L) => {
    b.run(lua.lua_tojsstring(L, 1)).catch((e) => {
      console.warn("[oxis:lua] oxis.run() failed:", e instanceof Error ? e.message : e);
    });
    return 0;
  });
  setfn("quote", (L) => { pushLuaValue(L, b.quote(argString(L, 1) ?? "")); return 1; });
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

  // The handler gets the event's details as a table ({ path = ... }
  // for the editor events).
  setfn("autocmd", (L) => {
    const event = lua.lua_tojsstring(L, 1);
    const invoke = makeInvokerWithArgs(L, 2, closedRef);
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
  lua.lua_pushcfunction(L, (L: LuaState) => {
    const root = lua.lua_tojsstring(L, 1);
    const query = argString(L, 2) ?? "";
    const optsAt = lua.lua_type(L, 3) === lua.LUA_TTABLE ? 3 : 0;
    asyncCb(b.fsSearch(root, query, optsAt ? luaToJS(L, optsAt) : {}), makeInvokerWithArgs(L, optsAt ? 4 : 3, closedRef));
    return 0;
  });
  lua.lua_setfield(L, -2, to_luastring("search"));

  // oxis.fs.watch(path, fn [, opts]), (path, opts, fn), or
  // (path, { change = fn, ready = fn } [, opts])
  lua.lua_pushcfunction(L, (L: LuaState) => {
    const path = lua.lua_tojsstring(L, 1);
    let cbIdx = 3, optsIdx = 2;
    if (lua.lua_type(L, 2) === lua.LUA_TFUNCTION) { cbIdx = 2; optsIdx = 3; }
    else if (lua.lua_type(L, 2) === lua.LUA_TTABLE) {
      lua.lua_getfield(L, 2, to_luastring("change"));
      if (lua.lua_type(L, -1) === lua.LUA_TFUNCTION) { cbIdx = 2; optsIdx = 3; }
      lua.lua_pop(L, 1);
    }
    pushHandle(L, b.fsWatch(path, luaToJS(L, optsIdx), callbacksAt(L, cbIdx, ["change", "ready"], closedRef, "change")));
    return 1;
  });
  lua.lua_setfield(L, -2, to_luastring("watch"));
  lua.lua_setfield(L, -2, to_luastring("fs"));

  lua.lua_newtable(L); // oxis.process
  lua.lua_pushcfunction(L, (L: LuaState) => {
    asyncCb(b.processList(), makeInvokerWithArgs(L, 1, closedRef));
    return 0;
  });
  lua.lua_setfield(L, -2, to_luastring("list"));
  // oxis.process.spawn(opts, { stdout, stderr, exit }); the callbacks
  // may also sit in opts itself.
  lua.lua_pushcfunction(L, (L: LuaState) => {
    const opts = luaToJS(L, 1);
    const cbIdx = lua.lua_type(L, 2) === lua.LUA_TTABLE ? 2 : 1;
    pushHandle(L, b.processSpawn(opts, callbacksAt(L, cbIdx, ["start", "stdout", "stderr", "exit"], closedRef)));
    return 1;
  });
  lua.lua_setfield(L, -2, to_luastring("spawn"));
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
  // oxis.net.stream(opts, { response, data, line, event, done })
  lua.lua_pushcfunction(L, (L: LuaState) => {
    const opts = luaToJS(L, 1);
    const cbIdx = lua.lua_type(L, 2) === lua.LUA_TTABLE ? 2 : 1;
    pushHandle(L, b.netStream(opts, callbacksAt(L, cbIdx, ["response", "data", "line", "event", "done"], closedRef)));
    return 1;
  });
  lua.lua_setfield(L, -2, to_luastring("stream"));
  lua.lua_setfield(L, -2, to_luastring("net"));

  lua.lua_newtable(L); // oxis.json
  setfn("encode", (L) => { pushLuaValue(L, b.jsonEncode(luaToJS(L, 1))); return 1; });
  setfn("decode", (L) => { pushLuaValue(L, b.jsonDecode(argString(L, 1) ?? "")); return 1; });
  lua.lua_setfield(L, -2, to_luastring("json"));

  lua.lua_newtable(L); // oxis.editor
  setfn("current", (L) => { pushLuaValue(L, b.editorCurrent()); return 1; });
  setfn("open", (L) => { b.editorOpen(lua.lua_tojsstring(L, 1), argNumber(L, 2)); return 0; });
  setfn("setText", (L) => { pushLuaValue(L, b.editorSetText(argString(L, 1) ?? "")); return 1; });
  setfn("insert", (L) => { pushLuaValue(L, b.editorInsert(argString(L, 1) ?? "")); return 1; });
  setfn("replaceLines", (L) => {
    pushLuaValue(L, b.editorReplaceLines(lua.lua_tonumber(L, 1), lua.lua_tonumber(L, 2), argString(L, 3) ?? ""));
    return 1;
  });
  setfn("select", (L) => {
    pushLuaValue(L, b.editorSelect(lua.lua_tonumber(L, 1), argNumber(L, 2) ?? 1, argNumber(L, 3), argNumber(L, 4)));
    return 1;
  });
  setfn("save", (L) => {
    const cb = lua.lua_type(L, 1) === lua.LUA_TFUNCTION ? makeInvokerWithArgs(L, 1, closedRef) : () => {};
    asyncCb(b.editorSave(), cb);
    return 0;
  });
  setfn("on", (L) => { b.editorOn(lua.lua_tojsstring(L, 1), makeInvokerWithArgs(L, 2, closedRef)); return 0; });
  lua.lua_setfield(L, -2, to_luastring("editor"));

  // oxis.ask("Roll again?", function(answer) … end [, { label = "dice", cancel = fn }])
  // Each callback is released once it has run (or been cancelled).
  setfn("ask", (L) => {
    const question = argString(L, 1) ?? "";
    const answer = makeCallback(L, 2, closedRef);
    let label: string | undefined;
    let cancel: { call: LuaCallback; release: () => void } | undefined;
    if (lua.lua_type(L, 3) === lua.LUA_TTABLE) {
      lua.lua_getfield(L, 3, to_luastring("label"));
      label = argString(L, -1);
      lua.lua_pop(L, 1);
      lua.lua_getfield(L, 3, to_luastring("cancel"));
      if (lua.lua_type(L, -1) === lua.LUA_TFUNCTION) cancel = makeCallback(L, lua.lua_gettop(L), closedRef);
      lua.lua_pop(L, 1);
    }
    const release = () => { answer.release(); cancel?.release(); };
    b.ask(question, (...a) => { answer.call(...a); release(); }, label, (...a) => { cancel?.call(...a); release(); });
    return 0;
  });
  setfn("after", (L) => {
    const fn = makeCallback(L, 2, closedRef);
    pushHandle(L, b.after(argNumber(L, 1) ?? 0, (...a) => { fn.call(...a); fn.release(); }));
    return 1;
  });
  setfn("every", (L) => {
    const fn = makeCallback(L, 2, closedRef);
    let foreground = false;
    let stop: { call: LuaCallback; release: () => void } | undefined;
    if (lua.lua_type(L, 3) === lua.LUA_TTABLE) {
      lua.lua_getfield(L, 3, to_luastring("foreground"));
      foreground = lua.lua_toboolean(L, -1);
      lua.lua_pop(L, 1);
      lua.lua_getfield(L, 3, to_luastring("stop"));
      if (lua.lua_type(L, -1) === lua.LUA_TFUNCTION) stop = makeCallback(L, lua.lua_gettop(L), closedRef);
      lua.lua_pop(L, 1);
    }
    pushHandle(L, b.every(argNumber(L, 1) ?? 1, fn.call, foreground, (...a) => { stop?.call(...a); fn.release(); stop?.release(); }));
    return 1;
  });

  setfn("input", (L) => { b.input(argString(L, 1) ?? ""); return 0; });

  lua.lua_newtable(L); // oxis.store
  setfn("get", (L) => { pushLuaValue(L, b.storeGet(argString(L, 1) ?? "")); return 1; });
  setfn("set", (L) => { b.storeSet(argString(L, 1) ?? "", luaToJS(L, 2)); return 0; });
  lua.lua_setfield(L, -2, to_luastring("store"));

  lua.lua_newtable(L); // oxis.system
  lua.lua_pushcfunction(L, (L: LuaState) => {
    asyncCb(b.systemInfo(), makeInvokerWithArgs(L, 1, closedRef));
    return 0;
  });
  lua.lua_setfield(L, -2, to_luastring("info"));
  lua.lua_setfield(L, -2, to_luastring("system"));

  lua.lua_setglobal(L, to_luastring("oxis"));
}

/** Runs Lua source (its top level registers the commands, tasks,
 *  etc.): on native Lua unless that's switched off or missing. `chunk`
 *  names it in error messages. */
export function loadLuaPlugin(source: string, bindings: OxisBindings, chunk = "plugin"): LuaLoadResult {
  if (engineSetting() === "fengari") return loadFengari(source, bindings);
  return loadNative(source, bindings, chunk, () => loadFengari(source, bindings));
}

/** Runs Lua source in a new fengari lua_State. On failure the state is
 *  already closed. */
function loadFengari(source: string, bindings: OxisBindings): LuaLoadResult {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  // A JS error thrown under a Lua call (a denied permission, a bad
  // argument) becomes an ordinary Lua error: pcall can catch it, and it
  // can't escape and leave the state half-unwound.
  lua.lua_atnativeerror(L, (L: LuaState) => {
    const e = lua.lua_touserdata(L, 1) as unknown;
    lua.lua_pushstring(L, to_luastring(e instanceof Error ? e.message : String(e)));
    return 1;
  });
  const closedRef: StateRef = { closed: false, report: bindings.reportError };
  buildOxisTable(L, bindings, closedRef);

  const status = lauxlib.luaL_dostring(L, to_luastring(source));
  if (status !== lua.LUA_OK) {
    const err = lua.lua_tojsstring(L, -1);
    try { bindings.dispose?.(); } catch { /* best effort */ }
    closedRef.closed = true;
    lua.lua_close(L);
    return { ok: false, error: err, ready: Promise.resolve({ ok: false, error: err }) };
  }

  return {
    ok: true,
    ready: Promise.resolve({ ok: true }),
    plugin: {
      engine: "fengari",
      dispose: () => {
        try { bindings.dispose?.(); } finally {
          closedRef.closed = true;
          lua.lua_close(L);
        }
      },
    },
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