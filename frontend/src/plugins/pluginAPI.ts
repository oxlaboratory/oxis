/**
 * pluginAPI.ts — what each oxis.* call does (luaRuntime.ts handles the
 * Lua/JS boundary).
 *
 * oxis.command(name, fn, description), oxis.task(name, cmd, description),
 * oxis.run, echo, cwd, theme, option, keymap, autocmd, plugin.enable/
 * disable, workspace, dashboard, workflow, newTerminal, and the fs,
 * process, net, system, json and editor tables. process.spawn, fs.watch
 * and net.stream deliver their results over time (streams.ts); what a
 * plugin starts is stopped when it's unloaded.
 *
 * Commands and tasks should have a description (it powers 'help). One
 * without gets UNDOCUMENTED_SENTINEL, which pluginManager replaces with
 * a generated description and a warning.
 */

import { registry } from "../terminal/commandRegistry";
import { keybinds } from "../terminal/keybinds";
import { themeManager } from "../terminal/themeManager";
import { events } from "../terminal/events";
import { isWindows } from "../terminal/terminal";
import type { OxisBindings, LuaJSValue, LuaCallbacks, LuaHandle } from "./luaRuntime";
import {
  readFile, writeFile, listDir, statPath, makeDir, deletePath, searchFiles,
  systemInfo as nativeSystemInfo, listProcesses, killProcess, isNativeApp,
  writeTempScript,
  nativeHttpRequest,
  processStart, processWrite, processCloseInput, watchStart, httpStreamStart,
} from "../native";
import { openStream, closeStream, newStreamId, LineSplitter, SSEParser } from "./streams";
import { editorBridge, offsetToLineCol, lineColToOffset, lineRange } from "../terminal/editorBridge";
import { requirePermission, requireShellPermission, type PermissionNamespace } from "./permissions";
import { scriptRunTracker, type RunResult } from "../terminal/scriptRunTracker";
import { workflowRunner } from "./workflowRunner";
import { setTaskCommand } from "./taskCommands";
import { promptCapture, foregroundJobs } from "../terminal/promptCapture";

// Exported so pluginManager can recognise it without duplicating the
// exact string (and so it can't accidentally collide with a real
// plugin author's description).
export const UNDOCUMENTED_SENTINEL = "\u0000undocumented\u0000";

export interface APIContext {
  /** Send raw input to active PTY */
  sendToShell: (cmd: string) => void;
  /** Print a line to the active terminal */
  print: (text: string, kind?: import("../terminal/terminal").LineKind) => void;
  /** Print a line that can be rewritten later: returns its updater
   *  (oxis.line). A kind left out keeps the line's colour. */
  printLive?: (text: string, kind?: import("../terminal/terminal").LineKind) => (text: string, kind?: import("../terminal/terminal").LineKind) => void;
  /** Get current working directory (best-effort) */
  getCwd: () => string;
  /** Open a new terminal tab */
  newTerminal: () => void;
  /** Open a file in the editor (optionally at a line) */
  openEditor?: (path: string, line?: number) => void;
  /** Get/set runtime options */
  getOption: (key: string) => LuaJSValue;
  setOption: (key: string, value: LuaJSValue) => void;
  /** Plugin name (set per-plugin) */
  pluginName: string;
  /** Skip the shell permission prompt: built-in plugins and the user's
   *  own workspace, task, workflow and config files. */
  isTrusted?: boolean;
}

/** `a && b && c` → `a; if ($?) { b; if ($?) { c } }` for Windows
 *  PowerShell 5.1, which has no `&&` (PowerShell 7 accepts both). Only
 *  `&&` outside quotes is rewritten. */
export function toPowerShellChain(cmd: string): string {
  const parts: string[] = [];
  let quote = "", start = 0;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) { if (c === quote) quote = ""; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "&" && cmd[i + 1] === "&") { parts.push(cmd.slice(start, i).trim()); start = i + 2; i++; }
  }
  if (parts.length === 0) return cmd;
  parts.push(cmd.slice(start).trim());
  return parts.reduceRight((rest, part) => rest ? `${part}; if ($?) { ${rest} }` : part, "");
}

/** Quotes text as a single argument: PowerShell single quotes on
 *  Windows (which also treats curly quotes as quotes), POSIX single
 *  quotes elsewhere. */
export function shellQuote(text: string, windows = isWindows()): string {
  return windows
    ? `'${text.replace(/['\u2018\u2019\u201A\u201B]/g, q => q + q)}'`
    : `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * oxis.run(): runs a command in the shared shell and resolves when it
 * has finished (scriptRunTracker), so workflows can await it and a
 * second command can't be typed into a prompt the first is still
 * showing.
 *
 * Multi-line scripts are written to a temp file (.ps1 on Windows, .sh
 * run with bash elsewhere) and run as one line; typed line by line,
 * later lines would be read as the answer to any prompt (Read-Host,
 * read) earlier in the script.
 */
export function runScript(ctx: APIContext, cmd: string): Promise<{ ok: boolean; exitCode: number | null }> {
  // Not an async function, so turn a synchronous permission denial into
  // a rejection explicitly (the Lua binding only handles rejections).
  try {
    requireShellPermission(ctx.pluginName, !!ctx.isTrusted);
  } catch (e) {
    return Promise.reject(e);
  }
  const windows = isWindows();
  const send = (line: string) => ctx.sendToShell(line);
  const done = (r: RunResult) => ({ ok: !r.cancelled && !r.timedOut && r.exitCode === 0, exitCode: r.exitCode });

  if (!cmd.includes("\n") || !isNativeApp()) {
    return scriptRunTracker.runAndAwait(send, windows ? toPowerShellChain(cmd) : cmd).then(done);
  }

  // The script deletes itself as it starts (PowerShell has parsed it all
  // by then, and bash keeps reading from its open handle), so running it
  // is the last command and its exit status is the one reported.
  const selfDelete = windows
    ? "Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue\n"
    : "rm -f -- \"$0\"\n";
  return writeTempScript(windows ? ".ps1" : ".sh", selfDelete + cmd)
    .then((path) => {
      const p = shellQuote(path, windows);
      return scriptRunTracker.runAndAwait(send, windows ? `& ${p}` : `bash ${p}`);
    })
    // Couldn't write the temp file: send it as-is rather than do nothing.
    .catch(() => scriptRunTracker.runAndAwait(send, cmd))
    .then(done);
}

/** autocmd names that don't match an internal event name directly. */
const AUTOCMD_ALIASES: Record<string, string> = {
  shell_open: "shell_started",
  terminal_open: "shell_started",
  shell_exit: "shell_exited",
  terminal_close: "shell_exited",
};

/** Colours a plugin may give its oxis.echo lines. */
const ECHO_KINDS = new Set(["ok", "err", "warn", "dim", "accent", "info"]);
type LineKind = import("../terminal/terminal").LineKind;

/** oxis.editor.on() names → internal events. */
const EDITOR_EVENTS: Record<string, string> = {
  open: "editor_opened",
  change: "editor_changed",
  save: "editor_saved",
  close: "editor_closed",
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A relative path is taken relative to the shell's current directory. */
function fromCwd(path: string, cwd: string): string {
  if (!cwd || /^([a-zA-Z]:)?[\\/]/.test(path) || /^~/.test(path)) return path;
  const sep = cwd.includes("\\") ? "\\" : "/";
  return cwd.replace(/[\\/]+$/, "") + sep + path;
}

/** Plain data for Lua (drops functions, keeps nested tables). */
const toLua = (v: unknown) => v as LuaJSValue;

export function buildLuaAPI(ctx: APIContext): OxisBindings {
  const options: Record<string, LuaJSValue> = {};
  // Trusted code (built-ins, the user's own config, workspace, task and
  // workflow files) never gets a permission prompt.
  const need = (ns: PermissionNamespace) => { if (!ctx.isTrusted) requirePermission(ctx.pluginName, ns); };
  const nativeOnly = (what: string) => {
    if (!isNativeApp()) throw new Error(`${what} needs the native OXIS app`);
  };
  // What this plugin started or subscribed to; undone when it unloads.
  const cleanups = new Set<() => void>();
  const track = (undo: () => void) => { cleanups.add(undo); return () => { cleanups.delete(undo); }; };
  const buffer = () => { need("editor"); return editorBridge.active(); };
  let asking = false;
  // oxis.store: this plugin's own values, in localStorage.
  const storeKey = `oxis-plugin-store:${ctx.pluginName}`;
  const readStore = (): Record<string, LuaJSValue> => {
    try { return JSON.parse(localStorage.getItem(storeKey) || "{}") as Record<string, LuaJSValue>; } catch { return {}; }
  };

  return {
    platform: isWindows() ? "windows" : "unix",

    // oxis.command("name", fn, "what it does")
    command: (name, invoke, description) => {
      // OXIS's own commands can't be replaced by a plugin ('help, 'edit…).
      const existing = registry.get(name);
      if (existing && !existing.fromPlugin && existing.category !== "task") {
        ctx.print(`  ⚠  ${ctx.pluginName}: '${name} is an OXIS command, so the plugin's '${name} wasn't added`, "warn");
        return;
      }
      const hasDesc = typeof description === "string" && description.trim().length > 0;
      registry.register({
        name,
        description: hasDesc ? description!.trim() : UNDOCUMENTED_SENTINEL,
        category: "plugin",
        fromPlugin: ctx.pluginName,
        handler: (args, rest, raw) => {
          try { invoke(args, rest, raw); } catch (e) { ctx.print(`  ✗  ${name}: ${e}`, "err"); }
        },
      });
    },

    // oxis.task("name", "cmd", "what it does") — same documentation
    // handling as oxis.command().
    task: (name, cmd, description) => {
      setTaskCommand(name, cmd);
      const hasDesc = typeof description === "string" && description.trim().length > 0;
      registry.register({
        name: `task:${name}`,
        description: hasDesc ? description!.trim() : UNDOCUMENTED_SENTINEL,
        category: "task",
        fromPlugin: ctx.pluginName,
        // Tasks run through runScript like oxis.run(), so they get
        // the same permission check; a denial becomes a message.
        handler: () => { void runScript(ctx, cmd).catch((e) => ctx.print(`  ✗  ${name}: ${e instanceof Error ? e.message : e}`, "err")); },
      });
    },

    // oxis.echo(text [, kind]): kind colours the line like OXIS's own
    // messages — "ok", "err", "warn", "dim" or "accent".
    echo: (text, kind) => ctx.print(`  ${text}`, ECHO_KINDS.has(kind ?? "") ? kind as LineKind : "info"),
    line: (text, kind) => {
      const k = (v: LuaJSValue | undefined) => ECHO_KINDS.has(String(v ?? "")) ? v as LineKind : undefined;
      const first = k(kind) ?? "info";
      const update = ctx.printLive?.(`  ${text}`, first);
      if (!update) ctx.print(`  ${text}`, first);
      let last = text;
      return {
        set: (t, kd) => { last = String(t ?? ""); update?.(`  ${last}`, k(kd)); },
        text: () => last,
      };
    },
    run: (cmd) => runScript(ctx, cmd),
    quote: (text) => shellQuote(text),
    theme: (name) => { themeManager.apply(name); },
    cwd: () => ctx.getCwd(),
    newTerminal: () => { need("terminal"); ctx.newTerminal(); },

    // oxis.option("key") -> value   |   oxis.option("key", value) -> sets it
    getOption: (key) => (options[key] ?? ctx.getOption(key)),
    setOption: (key, value) => { options[key] = value; ctx.setOption(key, value); },

    // oxis.autocmd("WorkspaceLoaded", fn) — PascalCase Lua names map to
    // the internal snake_case events, plus a few friendlier aliases.
    autocmd: (event, invoke) => {
      const snake = event.replace(/([A-Z])/g, "_$1").toLowerCase().replace(/^_/, "");
      const mapped = AUTOCMD_ALIASES[snake] ?? snake;
      cleanups.add(events.on(mapped, (payload) => { try { invoke(toLua(payload)); } catch { /* noop */ } }));
    },

    // Mode is "normal" / "insert" / "visual" (editor modes; the bind
    // only fires in that mode) or "" / "global" for always.
    keymap: (mode, combo, invoke) => {
      const ctrl  = combo.includes("<C-");
      const alt   = combo.includes("<A-");
      const shift = combo.includes("<S-");
      const key   = combo.replace(/<[CAS]-/g, "").replace(/>/g, "");
      const scoped = mode && mode !== "global" ? mode : undefined;
      keybinds.register({
        key, ctrl, alt, shift, mode: scoped,
        description: `[${ctx.pluginName}] Lua keymap${scoped ? ` (${scoped})` : ""}`,
        handler: (e) => { e.preventDefault(); try { invoke(); } catch { /* noop */ } },
        fromLua: true,
      });
    },

    pluginEnable:  (name) => events.emit("plugin_enable_request",  { name }),
    pluginDisable: (name) => events.emit("plugin_disable_request", { name }),

    // Permission-gated: these change what the user sees or which
    // configuration is active.
    workspace: (path) => { need("workspace"); events.emit("workspace_loaded", { path }); },
    dashboard: (config) => events.emit("dashboard_config", { config }),
    workflow: (name, def, description) => {
      const warnings = workflowRunner.register(name, def, description);
      for (const w of warnings) ctx.print(`  ⚠  workflow ${name}: ${w}`, "dim");
    },

    // ── Core system APIs — each checks its permission first. fs,
    // process and system need the native app. ──
    fsRead: async (path) => {
      need("fs");
      if (!isNativeApp()) throw new Error("oxis.fs needs the native OXIS app (no filesystem access in browser mode)");
      return readFile(path);
    },
    fsWrite: async (path, content) => {
      need("fs");
      if (!isNativeApp()) throw new Error("oxis.fs needs the native OXIS app (no filesystem access in browser mode)");
      await writeFile(path, content);
    },
    fsList: async (path) => {
      need("fs");
      if (!isNativeApp()) throw new Error("oxis.fs needs the native OXIS app (no filesystem access in browser mode)");
      const entries = await listDir(path);
      return entries as unknown as LuaJSValue[];
    },
    fsStat: async (path) => {
      need("fs");
      if (!isNativeApp()) throw new Error("oxis.fs needs the native OXIS app (no filesystem access in browser mode)");
      const s = await statPath(path);
      return s as unknown as LuaJSValue;
    },
    fsMkdir: async (path) => {
      need("fs");
      if (!isNativeApp()) throw new Error("oxis.fs needs the native OXIS app (no filesystem access in browser mode)");
      await makeDir(path);
    },
    fsRemove: async (path) => {
      need("fs");
      if (!isNativeApp()) throw new Error("oxis.fs needs the native OXIS app (no filesystem access in browser mode)");
      await deletePath(path);
    },

    fsSearch: async (root, query, opts) => {
      need("fs");
      if (!isNativeApp()) throw new Error("oxis.fs needs the native OXIS app (no filesystem access in browser mode)");
      const o = (opts ?? {}) as { regex?: boolean; caseSensitive?: boolean; wholeWord?: boolean; max?: number };
      const result = await searchFiles(fromCwd(root, ctx.getCwd()), query, {
        regex: !!o.regex, caseSensitive: !!o.caseSensitive, wholeWord: !!o.wholeWord, maxResults: o.max,
      });
      if (result.error) throw new Error(result.error);
      return result as unknown as LuaJSValue;
    },

    processList: async () => {
      need("process");
      if (!isNativeApp()) throw new Error("oxis.process needs the native OXIS app");
      const list = await listProcesses();
      return list as unknown as LuaJSValue[];
    },
    processKill: async (pid) => {
      need("process");
      if (!isNativeApp()) throw new Error("oxis.process needs the native OXIS app");
      await killProcess(pid);
    },

    // oxis.net.request({ url=..., method="GET", headers={...}, body=..., timeout=60 })
    // In the desktop app OXIS makes the request itself (no CORS, so local
    // and self-hosted APIs work); in a browser tab it's a plain fetch().
    netRequest: async (opts) => {
      need("net");
      const o = (opts ?? {}) as { url?: string; method?: string; headers?: Record<string, string>; body?: string; timeout?: number };
      if (!o.url) throw new Error("oxis.net.request requires { url = ... }");
      // An empty Lua table arrives as [], not {}.
      if (Array.isArray(o.headers)) o.headers = {};
      const timeout = typeof o.timeout === "number" && o.timeout > 0 ? o.timeout : 60;
      const native = await nativeHttpRequest({
        url: o.url, method: o.method || "GET", headers: o.headers ?? {}, body: o.body ?? "", timeoutSeconds: timeout,
      });
      if (native) return native as unknown as LuaJSValue;
      const started = performance.now();
      const res = await fetch(o.url, { method: o.method || "GET", headers: o.headers, body: o.body, signal: AbortSignal.timeout(timeout * 1000) });
      const body = await res.text();
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => { headers[k] = v; });
      return { status: res.status, ok: res.ok, body, headers, ms: Math.round((performance.now() - started) * 10) / 10 } as unknown as LuaJSValue;
    },

    // oxis.ask: the question is printed, and the next line typed is the
    // answer (the prompt's label says who's asking). Ctrl+C cancels.
    ask: (question, onAnswer, label, onCancel) => {
      if (question) ctx.print(`  ${question}`, "accent");
      if (!asking) { asking = true; track(() => promptCapture.release(ctx.pluginName)); }
      promptCapture.set({
        owner: ctx.pluginName,
        label: (label || ctx.pluginName).slice(0, 24),
        onLine: (line) => { try { onAnswer(line); } catch (e) { ctx.print(`  ✗  ${ctx.pluginName}: ${message(e)}`, "err"); } },
        onCancel: () => { ctx.print("  ■  cancelled", "dim"); onCancel?.(); },
      });
    },
    after: (seconds, fn) => {
      const t = setTimeout(() => { untrack(); fn(); }, Math.max(0, seconds) * 1000);
      const untrack = track(() => clearTimeout(t));
      return { stop: () => { clearTimeout(t); untrack(); } };
    },
    every: (seconds, fn, foreground, onStop) => {
      let stopped = false;
      // Down to 30 ms, fast enough for animation frames.
      const t = setInterval(() => { if (!stopped) fn(); }, Math.max(0.03, seconds) * 1000);
      const stop = () => {
        if (stopped) return;
        stopped = true;
        clearInterval(t);
        untrack();
        unforeground();
        onStop?.();
      };
      const untrack = track(stop);
      const unforeground = foreground ? foregroundJobs.add(ctx.pluginName, stop) : () => {};
      return { stop };
    },
    // oxis.input("git commit -m ''"): puts text in the prompt to edit.
    input: (text) => events.emit("focus_prompt", { text: String(text ?? "") }),
    storeGet: (key) => readStore()[key],
    storeSet: (key, value) => {
      const all = readStore();
      if (value === undefined) delete all[key];
      else all[key] = value;
      try { localStorage.setItem(storeKey, JSON.stringify(all)); } catch { /* storage full or off */ }
    },

    systemInfo: async () => {
      need("system");
      if (!isNativeApp()) throw new Error("oxis.system needs the native OXIS app");
      const info = await nativeSystemInfo();
      return info as unknown as LuaJSValue;
    },

    // oxis.process.spawn({ cmd = "npm", args = {"run", "dev"} | shell = "…",
    //   cwd, env, lines = true }, { stdout = fn, stderr = fn, exit = fn(code, err) })
    // Runs a program, not the shell tab: needs the "shell" permission,
    // like oxis.run(). The cwd defaults to the shell's current folder.
    processSpawn: (opts, on) => spawnProcess(ctx, opts, on, track, nativeOnly),

    // oxis.fs.watch(path, fn({ path, op }), { recursive, ignore, debounce })
    fsWatch: (path, opts, on) => {
      need("fs");
      nativeOnly("oxis.fs.watch");
      const o = (opts ?? {}) as { recursive?: boolean; ignore?: LuaJSValue[]; debounce?: number };
      const id = newStreamId("watch");
      const target = fromCwd(path, ctx.getCwd());
      let active = true;
      const untrack = track(() => closeStream(id));
      const done = () => { active = false; untrack(); on.release(); };
      openStream(id, (ev) => {
        if (ev.type === "change") on.fns.change?.({ path: ev.path, op: ev.op });
        else if (ev.type === "error") ctx.print(`  ⚠  ${ctx.pluginName}: watching ${target}: ${ev.error}`, "dim");
        else if (ev.type === "end") done();
      }, () => watchStart(id, {
        path: target,
        recursive: o.recursive !== false,
        ignore: Array.isArray(o.ignore) ? o.ignore.map(String) : null,
        debounceMs: typeof o.debounce === "number" ? o.debounce : 0,
      })).then(() => { if (active) on.fns.ready?.(); }).catch((e) => {
        ctx.print(`  ✗  ${ctx.pluginName}: oxis.fs.watch: ${message(e)}`, "err");
        done();
      });
      return { close: () => { closeStream(id); }, active: () => active };
    },

    // oxis.net.stream({ url, method, headers, body, timeout, idle, sse },
    //   { response = fn(status, headers), data = fn(text), line = fn(line),
    //     event = fn({ event, data, id }), done = fn(err, { status, ok, headers }) })
    netStream: (opts, on) => streamRequest(ctx, opts, on, track, need),

    jsonEncode: (value) => JSON.stringify(value ?? null),
    jsonDecode: (text) => {
      try { return JSON.parse(text) as LuaJSValue; }
      catch (e) { throw new Error(`oxis.json.decode: ${message(e)}`); }
    },

    // ── oxis.editor: lines and columns are 1-based ──
    editorCurrent: () => {
      const b = buffer();
      if (!b) return undefined;
      const text = b.getText();
      const sel = b.getSelection();
      const from = offsetToLineCol(text, sel.start);
      const to = offsetToLineCol(text, sel.end);
      return {
        path: b.path, language: b.language, text, dirty: b.isDirty(),
        lines: text.split("\n").length,
        line: to.line, col: to.col,
        selection: text.slice(sel.start, sel.end),
        selectionStart: { line: from.line, col: from.col },
        selectionEnd: { line: to.line, col: to.col },
      };
    },
    editorOpen: (path, line) => {
      need("editor");
      if (!ctx.openEditor) throw new Error("oxis.editor.open isn't available here");
      ctx.openEditor(fromCwd(path, ctx.getCwd()), line);
    },
    editorSetText: (text) => {
      const b = buffer();
      if (!b) return false;
      b.replace(0, b.getText().length, text);
      return true;
    },
    editorInsert: (text) => {
      const b = buffer();
      if (!b) return false;
      const sel = b.getSelection();
      b.replace(sel.start, sel.end, text);
      return true;
    },
    editorReplaceLines: (first, last, text) => {
      const b = buffer();
      if (!b) return false;
      const full = b.getText();
      const r = lineRange(full, first, last);
      // Replacing whole lines keeps the line break after them.
      const keepBreak = r.end > r.start && full[r.end - 1] === "\n" && !text.endsWith("\n");
      b.replace(r.start, r.end, keepBreak ? text + "\n" : text);
      return true;
    },
    editorSelect: (line, col, toLine, toCol) => {
      const b = buffer();
      if (!b) return false;
      const text = b.getText();
      const start = lineColToOffset(text, line, col);
      const end = toLine === undefined ? start : lineColToOffset(text, toLine, toCol ?? 1);
      b.setSelection(Math.min(start, end), Math.max(start, end));
      return true;
    },
    editorSave: async () => {
      const b = buffer();
      if (!b) throw new Error("no file is open in the editor");
      if (!await b.save()) throw new Error(`couldn't save ${b.path}`);
      return b.path;
    },
    editorOn: (event, cb) => {
      need("editor");
      const internal = EDITOR_EVENTS[event];
      if (!internal) throw new Error(`oxis.editor.on: unknown event "${event}" (use ${Object.keys(EDITOR_EVENTS).join(", ")})`);
      cleanups.add(events.on(internal, (payload) => cb(toLua(payload))));
    },

    requirePermission: (ns) => need(ns as PermissionNamespace),
    reportError: (msg) => ctx.print(`  ✗  ${ctx.pluginName}: ${msg}`, "err"),
    dispose: () => {
      for (const undo of [...cleanups]) { try { undo(); } catch { /* keep going */ } }
      cleanups.clear();
    },
  };
}

type Track = (undo: () => void) => () => void;

function spawnProcess(ctx: APIContext, opts: LuaJSValue, on: LuaCallbacks, track: Track, nativeOnly: (what: string) => void): LuaHandle {
  requireShellPermission(ctx.pluginName, !!ctx.isTrusted);
  nativeOnly("oxis.process.spawn");
  const o = (opts ?? {}) as {
    cmd?: string; args?: LuaJSValue[]; shell?: string; cwd?: string;
    env?: Record<string, LuaJSValue>; lines?: boolean;
  };
  if (!o.cmd && !o.shell) throw new Error('oxis.process.spawn needs { cmd = "program", args = {...} } or { shell = "command line" }');
  const id = newStreamId("proc");
  const { stdout, stderr, exit, start } = on.fns;
  const splitters = o.lines ? { stdout: new LineSplitter(), stderr: new LineSplitter() } : null;
  let pid: number | undefined;
  let running = true;
  // Input written before the process has started waits for it, in order.
  let input: Promise<unknown>;

  const deliver = (type: "stdout" | "stderr", text: string) => {
    const cb = type === "stdout" ? stdout : stderr;
    if (!cb) return;
    if (!splitters) { cb(text); return; }
    for (const line of splitters[type].push(text)) cb(line);
  };
  const untrack = track(() => closeStream(id));
  const finish = (code: number | undefined, err: string | undefined) => {
    if (!running) return;
    running = false;
    untrack();
    if (splitters) {
      const out = splitters.stdout.flush(), errText = splitters.stderr.flush();
      if (out !== null) stdout?.(out);
      if (errText !== null) stderr?.(errText);
    }
    try { exit?.(code, err); } finally { on.release(); }
  };

  input = openStream(id, (ev) => {
    if (ev.type === "stdout" || ev.type === "stderr") deliver(ev.type, ev.data ?? "");
    else if (ev.type === "end") finish(ev.code, ev.error || undefined);
  }, () => processStart(id, {
    cmd: o.cmd ?? "",
    args: (o.args ?? []).map(String),
    shell: o.shell ?? "",
    cwd: o.cwd ? fromCwd(o.cwd, ctx.getCwd()) : ctx.getCwd(),
    env: Object.fromEntries(Object.entries(o.env ?? {}).map(([k, v]) => [k, String(v)])),
  })).then((p) => { pid = p; if (running) start?.(p); }, (e) => finish(undefined, message(e)));

  const afterStart = (fn: () => Promise<void>) => {
    input = input.then(() => (running ? fn() : undefined)).catch(() => { /* it exited */ });
  };
  return {
    pid: () => pid,
    running: () => running,
    write: (text) => {
      if (!running) return false;
      const data = String(text ?? "");
      afterStart(() => processWrite(id, data));
      return true;
    },
    closeInput: () => { if (running) afterStart(() => processCloseInput(id)); },
    kill: () => { if (running) closeStream(id); return running; },
  };
}

function streamRequest(ctx: APIContext, opts: LuaJSValue, on: LuaCallbacks, track: Track, need: (ns: PermissionNamespace) => void): LuaHandle {
  need("net");
  const o = (opts ?? {}) as {
    url?: string; method?: string; headers?: Record<string, LuaJSValue>; body?: string;
    timeout?: number; idle?: number; sse?: boolean;
  };
  if (!o.url) throw new Error("oxis.net.stream requires { url = ... }");
  const { response, data, line, event, done } = on.fns;
  const headersIn = Array.isArray(o.headers) ? {} : Object.fromEntries(Object.entries(o.headers ?? {}).map(([k, v]) => [k, String(v)]));
  const lines = new LineSplitter();
  let sse: SSEParser | null = null;
  let status = 0;
  let headers: Record<string, string> = {};
  let finished = false;
  let cancel = () => {};
  const untrack = track(() => cancel());

  const onResponse = (st: number, hd: Record<string, string>) => {
    status = st;
    headers = hd;
    if (event && (o.sse === true || /text\/event-stream/i.test(hd["content-type"] ?? ""))) sse = new SSEParser();
    response?.(st, hd);
  };
  const onData = (text: string) => {
    data?.(text);
    if (line) for (const l of lines.push(text)) line(l);
    if (sse && event) for (const e of sse.push(text)) event({ ...e });
  };
  const onEnd = (err: string | undefined) => {
    if (finished) return;
    finished = true;
    untrack();
    if (line) { const rest = lines.flush(); if (rest !== null) line(rest); }
    if (sse && event) for (const e of (sse as SSEParser).end()) event({ ...e });
    try { done?.(err, { status, ok: status >= 200 && status < 300, headers }); } finally { on.release(); }
  };

  if (isNativeApp()) {
    const id = newStreamId("http");
    cancel = () => closeStream(id);
    openStream(id, (ev) => {
      if (ev.type === "response") onResponse(ev.code, ev.headers ?? {});
      else if (ev.type === "data") onData(ev.data ?? "");
      else if (ev.type === "end") onEnd(ev.error || undefined);
    }, () => httpStreamStart(id, {
      url: o.url!, method: o.method || "GET", headers: headersIn, body: o.body ?? "",
      timeoutSeconds: typeof o.timeout === "number" ? o.timeout : 0,
      idleSeconds: typeof o.idle === "number" ? o.idle : 0,
    })).catch((e) => onEnd(message(e)));
  } else {
    // Browser tab: fetch's stream (CORS applies).
    const ac = new AbortController();
    cancel = () => ac.abort();
    (async () => {
      const res = await fetch(o.url!, { method: o.method || "GET", headers: headersIn, body: o.body, signal: ac.signal });
      const hd: Record<string, string> = {};
      res.headers.forEach((v, k) => { hd[k] = v; });
      onResponse(res.status, hd);
      const reader = res.body?.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const chunk = await reader?.read();
        if (!chunk || chunk.done) break;
        onData(dec.decode(chunk.value, { stream: true }));
      }
      const tail = dec.decode();
      if (tail) onData(tail);
      onEnd(undefined);
    })().catch((e) => onEnd(ac.signal.aborted ? "cancelled" : message(e)));
  }

  return {
    cancel: () => { if (!finished) cancel(); },
    finished: () => finished,
  };
}