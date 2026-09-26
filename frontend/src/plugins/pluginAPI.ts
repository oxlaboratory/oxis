/**
 * pluginAPI.ts — what each oxis.* call does (luaRuntime.ts handles the
 * Lua/JS boundary).
 *
 * oxis.command(name, fn, description), oxis.task(name, cmd, description),
 * oxis.run, echo, cwd, theme, option, keymap, autocmd, plugin.enable/
 * disable, workspace, dashboard, workflow, newTerminal, and the fs,
 * process, net and system tables.
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
import type { OxisBindings, LuaJSValue } from "./luaRuntime";
import {
  readFile, writeFile, listDir, statPath, makeDir, deletePath,
  systemInfo as nativeSystemInfo, listProcesses, killProcess, isNativeApp,
  writeTempScript,
} from "../native";
import { requirePermission, requireShellPermission, type PermissionNamespace } from "./permissions";
import { scriptRunTracker, type RunResult } from "../terminal/scriptRunTracker";
import { workflowRunner } from "./workflowRunner";
import { setTaskCommand } from "./taskCommands";

// Exported so pluginManager can recognise it without duplicating the
// exact string (and so it can't accidentally collide with a real
// plugin author's description).
export const UNDOCUMENTED_SENTINEL = "\u0000undocumented\u0000";

export interface APIContext {
  /** Send raw input to active PTY */
  sendToShell: (cmd: string) => void;
  /** Print a line to the active terminal */
  print: (text: string, kind?: import("../terminal/terminal").LineKind) => void;
  /** Get current working directory (best-effort) */
  getCwd: () => string;
  /** Open a new terminal tab */
  newTerminal: () => void;
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

export function buildLuaAPI(ctx: APIContext): OxisBindings {
  const options: Record<string, LuaJSValue> = {};
  // Trusted code (built-ins, the user's own config, workspace, task and
  // workflow files) never gets a permission prompt.
  const need = (ns: PermissionNamespace) => { if (!ctx.isTrusted) requirePermission(ctx.pluginName, ns); };

  return {
    platform: isWindows() ? "windows" : "unix",

    // oxis.command("name", fn, "what it does")
    command: (name, invoke, description) => {
      const hasDesc = typeof description === "string" && description.trim().length > 0;
      registry.register({
        name,
        description: hasDesc ? description!.trim() : UNDOCUMENTED_SENTINEL,
        category: "plugin",
        fromPlugin: ctx.pluginName,
        handler: (args, rest) => {
          try { invoke(args, rest); } catch (e) { ctx.print(`  ✗  ${name}: ${e}`, "err"); }
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

    echo: (text) => ctx.print(`  ${text}`, "info"),
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
      events.on(mapped, () => { try { invoke(); } catch { /* noop */ } });
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

    // oxis.net.request({ url=..., method="GET", headers={...}, body=... })
    // Plain fetch() with no special credentials.
    netRequest: async (opts) => {
      need("net");
      const o = (opts ?? {}) as { url?: string; method?: string; headers?: Record<string, string>; body?: string };
      if (!o.url) throw new Error("oxis.net.request requires { url = ... }");
      const res = await fetch(o.url, { method: o.method || "GET", headers: o.headers, body: o.body });
      const body = await res.text();
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => { headers[k] = v; });
      return { status: res.status, ok: res.ok, body, headers } as unknown as LuaJSValue;
    },

    systemInfo: async () => {
      need("system");
      if (!isNativeApp()) throw new Error("oxis.system needs the native OXIS app");
      const info = await nativeSystemInfo();
      return info as unknown as LuaJSValue;
    },
  };
}