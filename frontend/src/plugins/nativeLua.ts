/**
 * nativeLua.ts — plugins on real Lua 5.4 (internal/luanative), with
 * fengari as the fallback.
 *
 * The plugin's source goes to OXIS over a WebSocket (/lua on the local
 * server) and runs there, each plugin on a thread of its own, so a busy
 * plugin can't freeze the page. Every oxis.* call comes back here and
 * runs on the same bindings (pluginAPI.ts) the fengari runtime uses,
 * with the same argument handling as luaRuntime.ts's buildOxisTable.
 * Lua functions arrive as references ({"$fn": n}) and become JS
 * callbacks; JS handles (a spawned process, a timer, a line) go back as
 * {"$h": id} and become tables of methods in Lua.
 *
 * Calls that answer nothing (echo, registering a command…) come in
 * batches ("post"); the rest ("call") wait for the answer.
 */

import type { OxisBindings, LuaJSValue, LuaCallback, LuaCallbacks, LuaHandle, LoadedLuaPlugin, LuaLoadResult, LuaReady } from "./luaRuntime";
import { isNativeApp, getPtyPort } from "../native";

type Engine = "auto" | "native" | "fengari";

interface Hello { available: boolean; engine?: string; error?: string; cmodules?: boolean }

/** A callback into Lua; release() lets Lua collect the function. */
type Proxy = LuaCallback & { release(): void };

interface Plugin {
  sid: number;
  b: OxisBindings;
  handles: Map<number, LuaHandle>;
  nextHid: number;
  closed: boolean;
  opened?: (r: LuaReady) => void;
}

// Handle methods that answer nothing: sent without waiting.
const VOID_METHODS = new Set(["set", "stop", "kill", "write", "closeInput", "close", "cancel"]);

let ws: WebSocket | null = null;
let hello: Promise<Hello> | null = null;
let info: Hello = { available: false };
const plugins = new Map<number, Plugin>();
const checks = new Map<number, (r: { ok: true } | { ok: false; error: string }) => void>();
let nextSid = 1;
let nextRid = 1;

/** The 'config set luaEngine choice, read straight from where settings
 *  are kept (App.tsx's OPTIONS_KEY). */
export function engineSetting(): Engine {
  try {
    const v = JSON.parse(localStorage.getItem("oxis-plugin-options-v1") || "{}")["setting.luaEngine"];
    return v === "native" || v === "fengari" ? v : "auto";
  } catch { return "auto"; }
}

/** What runs plugins now, for 'version and 'plugin info. */
export function engineInfo(): { native: boolean; engine: string; reason?: string } {
  if (engineSetting() === "fengari") return { native: false, engine: "fengari (Lua 5.3)", reason: "luaEngine is set to fengari" };
  return info.available
    ? { native: true, engine: info.engine || "Lua 5.4" }
    : { native: false, engine: "fengari (Lua 5.3)", reason: info.error };
}

async function url(): Promise<string> {
  if (!isNativeApp()) {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}/lua`;
  }
  return `ws://127.0.0.1:${await getPtyPort()}/lua`;
}

const send = (m: unknown) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };

/** Connects once; resolves with whether native Lua is there. */
export function connect(): Promise<Hello> {
  if (hello) return hello;
  hello = new Promise<Hello>((resolve) => {
    let settled = false;
    const done = (h: Hello) => { if (!settled) { settled = true; info = h; resolve(h); } };
    url().then((u) => {
      const sock = new WebSocket(u);
      ws = sock;
      const timer = setTimeout(() => done({ available: false, error: "OXIS didn't answer" }), 5000);
      sock.onmessage = (ev) => {
        let m: Record<string, unknown>;
        try { m = JSON.parse(String(ev.data)); } catch { return; }
        if (m.t === "hello") { clearTimeout(timer); done(m as unknown as Hello); return; }
        route(m);
      };
      sock.onclose = () => {
        clearTimeout(timer);
        done({ available: false, error: "the connection to OXIS closed" });
        ws = null;
        info = { available: false, error: "the connection to OXIS closed" };
        for (const p of plugins.values()) {
          if (!p.closed) p.b.reportError?.("stopped: the connection to OXIS closed (reload the plugin to start it again)");
          p.closed = true;
          p.opened?.({ ok: false, error: "the connection to OXIS closed" });
        }
        plugins.clear();
        hello = null; // the next load tries again
      };
    }).catch(() => done({ available: false, error: "no local server (browser preview?)" }));
  });
  return hello;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ── values from Lua ──────────────────────────────────────────────────

function proxy(p: Plugin, ref: number): Proxy {
  let released = false;
  const f = ((...args: LuaJSValue[]) => {
    if (p.closed || released) return;
    send({ t: "invoke", sid: p.sid, ref, args });
  }) as Proxy;
  f.release = () => {
    if (p.closed || released) return;
    released = true;
    send({ t: "release", sid: p.sid, refs: [ref] });
  };
  return f;
}

/** Turns {"$fn": n} into callbacks, anywhere in a value. */
function revive(p: Plugin, v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => revive(p, x));
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.$fn === "number" && Object.keys(o).length === 1) return proxy(p, o.$fn);
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) out[k] = revive(p, x);
    return out;
  }
  return v;
}

/** A handle for Lua: kept here, sent as its id and method names. */
function handle(p: Plugin, h: LuaHandle): LuaJSValue {
  const hid = p.nextHid++;
  p.handles.set(hid, h);
  const names = Object.keys(h);
  return { $h: hid, m: names, post: names.filter((n) => VOID_METHODS.has(n)) };
}

/** Named callbacks ({ stdout = fn, exit = fn }) for a stream. */
function callbacks(cbs: unknown): LuaCallbacks {
  const fns: Record<string, LuaCallback | undefined> = {};
  const all: Proxy[] = [];
  if (cbs && typeof cbs === "object") {
    for (const [k, f] of Object.entries(cbs as Record<string, unknown>)) {
      if (typeof f === "function") { fns[k] = f as Proxy; all.push(f as Proxy); }
    }
  }
  return { fns, release: () => all.forEach((f) => f.release()) };
}

const fnOf = (v: unknown): Proxy | undefined => (typeof v === "function" ? (v as Proxy) : undefined);

/** Callback style: cb(nil, value) or cb(err), then the callback's let go. */
function later(work: () => Promise<LuaJSValue> | LuaJSValue, cb: unknown): void {
  const f = fnOf(cb);
  Promise.resolve().then(work).then(
    (v) => { f?.(undefined, v); f?.release(); },
    (e) => { f?.(message(e)); f?.release(); },
  );
}

const S = (v: unknown) => (v === undefined || v === null ? undefined : String(v));
const N = (v: unknown) => (typeof v === "number" ? v : undefined);
const V = (v: unknown) => v as LuaJSValue;

type Fn = (p: Plugin, a: unknown[]) => unknown;

// One entry per bridge call; see prelude.lua for the Lua side of each.
const CALLS: Record<string, Fn> = {
  command: ({ b }, [name, f, desc]) => b.command(S(name) ?? "", (args, rest, raw) => fnOf(f)?.(args, rest, raw), S(desc)),
  task: ({ b }, [name, cmd, desc]) => b.task(S(name) ?? "", S(cmd) ?? "", S(desc)),
  echo: ({ b }, [text, kind]) => b.echo(S(text) ?? "", S(kind)),
  line: (p, [text, kind]) => handle(p, p.b.line(S(text) ?? "", S(kind))),
  run: ({ b }, [cmd]) => { b.run(S(cmd) ?? "").catch((e) => console.warn("[oxis:lua] oxis.run() failed:", message(e))); },
  quote: ({ b }, [text]) => b.quote(S(text) ?? ""),
  theme: ({ b }, [name]) => b.theme(S(name) ?? ""),
  cwd: ({ b }) => b.cwd(),
  newTerminal: ({ b }) => b.newTerminal(),
  workspace: ({ b }, [path]) => b.workspace(S(path) ?? ""),
  dashboard: ({ b }, [config]) => b.dashboard(V(config)),
  workflow: ({ b }, [name, def, desc]) => b.workflow(S(name) ?? "", V(def), S(desc)),
  getOption: ({ b }, [key]) => b.getOption(S(key) ?? ""),
  setOption: ({ b }, [key, value]) => b.setOption(S(key) ?? "", V(value)),
  autocmd: ({ b }, [event, f]) => b.autocmd(S(event) ?? "", (payload) => fnOf(f)?.(payload)),
  keymap: ({ b }, [mode, combo, f]) => b.keymap(S(mode) ?? "", S(combo) ?? "", () => fnOf(f)?.()),
  pluginEnable: ({ b }, [name]) => b.pluginEnable(S(name) ?? ""),
  pluginDisable: ({ b }, [name]) => b.pluginDisable(S(name) ?? ""),

  fsRead: ({ b }, [path, cb]) => later(() => b.fsRead(S(path) ?? ""), cb),
  fsWrite: ({ b }, [path, content, cb]) => later(() => b.fsWrite(S(path) ?? "", S(content) ?? "").then(() => undefined), cb),
  fsList: ({ b }, [path, cb]) => later(() => b.fsList(S(path) ?? ""), cb),
  fsStat: ({ b }, [path, cb]) => later(() => b.fsStat(S(path) ?? ""), cb),
  fsMkdir: ({ b }, [path, cb]) => later(() => b.fsMkdir(S(path) ?? "").then(() => undefined), cb),
  fsRemove: ({ b }, [path, cb]) => later(() => b.fsRemove(S(path) ?? "").then(() => undefined), cb),
  fsSearch: ({ b }, [root, query, opts, cb]) => later(() => b.fsSearch(S(root) ?? "", S(query) ?? "", V(opts) ?? {}), cb),
  fsWatch: (p, [path, opts, cbs]) => handle(p, p.b.fsWatch(S(path) ?? "", V(opts), callbacks(cbs))),
  processList: ({ b }, [cb]) => later(() => b.processList(), cb),
  processSpawn: (p, [opts, cbs]) => handle(p, p.b.processSpawn(V(opts), callbacks(cbs))),
  processKill: ({ b }, [pid, cb]) => later(() => b.processKill(N(pid) ?? 0).then(() => undefined), cb),
  netRequest: ({ b }, [opts, cb]) => later(() => b.netRequest(V(opts)), cb),
  netStream: (p, [opts, cbs]) => handle(p, p.b.netStream(V(opts), callbacks(cbs))),
  systemInfo: ({ b }, [cb]) => later(() => b.systemInfo(), cb),

  editorCurrent: ({ b }) => b.editorCurrent(),
  editorOpen: ({ b }, [path, line]) => b.editorOpen(S(path) ?? "", N(line)),
  editorSetText: ({ b }, [text]) => b.editorSetText(S(text) ?? ""),
  editorInsert: ({ b }, [text]) => b.editorInsert(S(text) ?? ""),
  editorReplaceLines: ({ b }, [first, last, text]) => b.editorReplaceLines(N(first) ?? 1, N(last) ?? 1, S(text) ?? ""),
  editorSelect: ({ b }, [line, col, toLine, toCol]) => b.editorSelect(N(line) ?? 1, N(col) ?? 1, N(toLine), N(toCol)),
  editorSave: ({ b }, [cb]) => later(() => b.editorSave(), cb),
  editorOn: ({ b }, [event, cb]) => { const f = fnOf(cb); if (f) b.editorOn(S(event) ?? "", f); },

  ask: ({ b }, [question, answer, label, cancel]) => {
    const a = fnOf(answer), c = fnOf(cancel);
    const release = () => { a?.release(); c?.release(); };
    b.ask(S(question) ?? "", (...x) => { a?.(...x); release(); }, S(label), (...x) => { c?.(...x); release(); });
  },
  after: (p, [seconds, f]) => {
    const fn = fnOf(f);
    return handle(p, p.b.after(N(seconds) ?? 0, (...x) => { fn?.(...x); fn?.release(); }));
  },
  every: (p, [seconds, f, foreground, stop]) => {
    const fn = fnOf(f), st = fnOf(stop);
    return handle(p, p.b.every(N(seconds) ?? 1, (...x) => fn?.(...x), foreground === true, (...x) => { st?.(...x); fn?.release(); st?.release(); }));
  },
  input: ({ b }, [text]) => b.input(S(text) ?? ""),
  storeGet: ({ b }, [key]) => b.storeGet(S(key) ?? ""),
  storeSet: ({ b }, [key, value]) => b.storeSet(S(key) ?? "", V(value)),

  // Lua's own libraries behind the plugin's permissions (prelude.lua).
  // Waits for the answer when the prompt asks (the Lua side is blocked
  // in a sync call meanwhile).
  $perm: async ({ b }, [ns]) => { await b.requirePermission?.(String(ns)); return true; },
  $h: (p, [hid, method, ...args]) => {
    const h = p.handles.get(Number(hid));
    const m = h?.[String(method)];
    if (!m) throw new Error(`this handle has no ${String(method)}()`);
    return m(...(args as LuaJSValue[])) ?? undefined;
  },
  $hfree: (p, [hid]) => { p.handles.delete(Number(hid)); },
};

function runCall(p: Plugin, fn: string, args: unknown[]): unknown {
  const f = CALLS[fn];
  if (!f) throw new Error(`OXIS has no ${fn}`);
  return f(p, revive(p, args) as unknown[]);
}

function runPosts(p: Plugin, posts: unknown): void {
  if (!Array.isArray(posts)) return;
  for (const item of posts) {
    const [fn, args] = item as [string, unknown[]];
    try { runCall(p, fn, args ?? []); }
    catch (e) { p.b.reportError?.(message(e)); }
  }
}

function route(m: Record<string, unknown>): void {
  if (m.t === "checked") {
    const done = checks.get(Number(m.rid));
    checks.delete(Number(m.rid));
    done?.(m.ok ? { ok: true } : { ok: false, error: String(m.error ?? "") });
    return;
  }
  const p = plugins.get(Number(m.sid));
  if (!p) return;
  switch (m.t) {
    case "post":
      runPosts(p, m.posts);
      break;
    case "call": {
      runPosts(p, m.posts);
      const reply = (ok: boolean, value: unknown, error?: string) =>
        send({ t: "ret", sid: p.sid, id: m.id, ok, value: value ?? null, error });
      try {
        const v = runCall(p, String(m.fn), (m.args as unknown[]) ?? []);
        if (v instanceof Promise) v.then((x) => reply(true, x), (e) => reply(false, null, message(e)));
        else reply(true, v);
      } catch (e) {
        reply(false, null, message(e));
      }
      break;
    }
    case "opened":
      p.opened?.(m.ok ? { ok: true } : { ok: false, error: String(m.error ?? "") });
      p.opened = undefined;
      break;
    case "error":
      p.b.reportError?.(String(m.message ?? ""));
      break;
    case "closed":
      p.closed = true;
      p.handles.clear();
      plugins.delete(p.sid);
      break;
  }
}

/**
 * Loads a plugin on native Lua, or (no native Lua in this build, or the
 * connection failed) on fengari through `fallback`. Returns at once:
 * `ready` says when the plugin's file has run, and whether it worked.
 */
export function loadNative(source: string, bindings: OxisBindings, chunk: string, fallback: () => LuaLoadResult): LuaLoadResult {
  let inner: LoadedLuaPlugin | null = null;
  let p: Plugin | null = null;
  let disposed = false;
  let engine: "native" | "fengari" = "native";
  const plugin: LoadedLuaPlugin = {
    get engine() { return engine; },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (inner) { inner.dispose(); return; }
      try { bindings.dispose?.(); } catch { /* best effort */ }
      if (p) { send({ t: "close", sid: p.sid }); p.closed = true; p.handles.clear(); }
    },
  };
  const ready = connect().then((h): Promise<LuaReady> | LuaReady => {
    if (disposed) return { ok: false, error: "unloaded before it started" };
    if (!h.available) {
      engine = "fengari";
      const r = fallback();
      if (r.ok) inner = r.plugin;
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    }
    const sid = nextSid++;
    const rec: Plugin = { sid, b: bindings, handles: new Map(), nextHid: 1, closed: false };
    p = rec;
    plugins.set(sid, rec);
    return new Promise<LuaReady>((resolve) => {
      rec.opened = resolve;
      send({ t: "open", sid, source, chunk, platform: bindings.platform });
    }).then((r) => {
      if (!r.ok) {
        // The state is closed on the Go side; let JS go of what it started.
        disposed = true;
        try { bindings.dispose?.(); } catch { /* best effort */ }
      }
      return r;
    });
  });
  return { ok: true, plugin, ready };
}

/** Compiles Lua 5.4 source without running it (syntax errors), or null
 *  when native Lua isn't there. */
export async function checkNative(source: string, chunk = "check"): Promise<{ ok: true } | { ok: false; error: string } | null> {
  if (engineSetting() === "fengari") return null;
  const h = await connect();
  if (!h.available) return null;
  const rid = nextRid++;
  return new Promise((resolve) => {
    checks.set(rid, resolve);
    send({ t: "check", rid, source, chunk });
  });
}
