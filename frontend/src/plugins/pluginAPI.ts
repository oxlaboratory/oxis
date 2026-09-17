/**
 * pluginAPI.ts — OXIS Lua API surface
 *
 * Implements OxisBindings (see luaRuntime.ts) — everything a Lua
 * plugin can call via oxis.*. This file owns what each call actually
 * DOES inside OXIS; luaRuntime.ts owns getting the arguments there
 * correctly across the Lua<->JS boundary.
 *
 * oxis.command(name, fn, description)   -- description is REQUIRED, see below
 * oxis.keymap(mode, key, fn)
 * oxis.theme(name)
 * oxis.run(cmd)
 * oxis.echo(text)
 * oxis.cwd()
 * oxis.option(key, value)
 * oxis.autocmd(event, fn)
 * oxis.plugin.enable(name)
 * oxis.plugin.disable(name)
 * oxis.workspace(path)
 * oxis.dashboard({ ... })
 * oxis.task(name, cmd)
 * oxis.newTerminal()
 *
 * ── Documentation requirement ───────────────────────────────
 * Every oxis.command()/oxis.task() call is supposed to pass a real,
 * non-empty third argument describing what it does — this is what
 * powers `'help <plugin>` (see App.tsx). A call without one gets
 * tagged with the UNDOCUMENTED_SENTINEL description below.
 * pluginManager.load() scans for that sentinel right after a plugin
 * finishes executing; anything still carrying it gets a short
 * auto-generated fallback description instead (rather than disabling
 * the whole plugin — see the note in pluginManager.ts on why that
 * changed), plus a loud one-time warning telling the author to add a
 * real one. "Some commands are documented" is functionally the same
 * failure mode as "none are" for 'help, so this is still enforced,
 * just no longer by taking a working plugin's commands away.
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
import { requestPermission } from "./permissions";
import { scriptRunTracker, launchSuffix } from "../terminal/scriptRunTracker";

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
}

/**
 * Backs oxis.run() — used by nearly every builtin/market Lua plugin
 * for anything beyond a single command (session_notes, ssh_manager,
 * system_health, http, fuzzy, file_ops, env_manager, benchmark,
 * project_init, clipboard, docker_compose, snippets, process_manager…
 * — see frontend/src/plugins/builtins/*.lua).
 *
 * A single-line command is sent to the PTY exactly as always:
 * ctx.sendToShell(cmd + "\r") — fast, no filesystem I/O, nothing to
 * clean up. A MULTI-line command used to be sent the exact same way —
 * one PTY write whose string just happens to contain embedded
 * newlines — and that's where "'command spills the raw PowerShell
 * into the terminal instead of running it" came from: a PTY write
 * with embedded \n characters types each line into the LIVE
 * interactive shell as its own keystroke-then-Enter, not as one
 * parsed script. Anything with control flow (if/while, a `{ ... }`
 * block spanning lines) or an interactive Read-Host prompt gets its
 * lines fed out of step with the shell's own prompt state — a
 * Read-Host prompt ends up receiving the NEXT script line as its
 * typed answer instead of real input, producing exactly the
 * reordered/garbled ">>" continuation-prompt output this was reported
 * against, for effectively every plugin with a multi-line oxis.run().
 *
 * Fix: write the whole script to a real temp .ps1 file (native OS
 * temp dir — see WriteTempScript in internal/wailsapp/app.go) and
 * tell the shell to run THAT file, then delete it — all as one
 * single-line PTY write. It's PowerShell's own script-file parser
 * reading it then, not our raw keystrokes, so control flow and
 * Read-Host inside the script behave exactly like running any other
 * .ps1: Read-Host waits for genuine keystrokes typed into the live
 * PTY session, same as if the user had run the file themselves.
 *
 * Falls back to the old single-write behavior in browser mode (no
 * native filesystem to write a temp file to) and on non-Windows —
 * every shipped plugin script is PowerShell-specific (Get-ChildItem,
 * $env:USERPROFILE, Write-Host), so there's no cross-platform script
 * to run there either way; a plain write is no worse than before.
 */
function runScript(ctx: APIContext, cmd: string): void {
  const native = isNativeApp() && isWindows();

  if (!cmd.includes("\n") || !native) {
    // Single-line command, or browser-mode/non-Windows fallback —
    // unchanged from before. Busy-tracking (below) isn't applied
    // here: every shipped Read-Host lives inside a multi-line
    // (heredoc) script, so this branch is never the one blocking on
    // interactive input, and Write-Host-based tracking only works
    // against a real PowerShell session anyway.
    ctx.sendToShell(cmd + "\r");
    return;
  }

  // Mark the shell busy from the moment we send the launch line.
  // Read-Host inside the script blocks the shell on real keystrokes
  // exactly like running the .ps1 by hand, and the marker below only
  // prints once that's genuinely finished (see scriptRunTracker.ts) —
  // that's what lets a second '-command refuse to stomp on a prompt
  // this one is still waiting on, instead of silently corrupting it.
  scriptRunTracker.begin();
  writeTempScript(".ps1", cmd)
    .then((path) => {
      // -ErrorAction SilentlyContinue on the cleanup only — a delete
      // that fails (e.g. antivirus briefly holding the file open)
      // shouldn't surface as a scary error tacked onto the script's
      // own output.
      ctx.sendToShell(
        `& "${path}"; Remove-Item "${path}" -Force -ErrorAction SilentlyContinue${launchSuffix()}\r`,
      );
    })
    .catch(() => {
      scriptRunTracker.cancel(); // never actually launched — don't leave the shell marked busy
      // Couldn't write the temp file (disk full, permissions, etc.)
      // — fall back rather than silently doing nothing.
      ctx.sendToShell(cmd + "\r");
    });
}

export function buildLuaAPI(ctx: APIContext): OxisBindings {
  const options: Record<string, LuaJSValue> = {};

  return {
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
      const hasDesc = typeof description === "string" && description.trim().length > 0;
      registry.register({
        name: `task:${name}`,
        description: hasDesc ? description!.trim() : UNDOCUMENTED_SENTINEL,
        category: "task",
        fromPlugin: ctx.pluginName,
        handler: () => ctx.sendToShell(cmd + "\r"),
      });
    },

    echo: (text) => ctx.print(`  ${text}`, "info"),
    run: (cmd) => runScript(ctx, cmd),
    theme: (name) => { themeManager.apply(name); },
    cwd: () => ctx.getCwd(),
    newTerminal: () => ctx.newTerminal(),

    // oxis.option("key") -> value   |   oxis.option("key", value) -> sets it
    getOption: (key) => (options[key] ?? ctx.getOption(key)),
    setOption: (key, value) => { options[key] = value; ctx.setOption(key, value); },

    // oxis.autocmd("TerminalOpen", fn) — maps Lua PascalCase event
    // names to internal snake_case.
    autocmd: (event, invoke) => {
      const mapped = event.replace(/([A-Z])/g, "_$1").toLowerCase().replace(/^_/, "");
      events.on(mapped, () => { try { invoke(); } catch { /* noop */ } });
    },

    // oxis.keymap("normal", "<C-t>", fn) — mode is one of "normal" /
    // "insert" / "visual" (see README § Input Modes); the bind only
    // fires while that mode is active (see keybinds.ts's activeMode,
    // set by the built-in editor). Pass "" / "global" for a bind that
    // should fire regardless of mode, same as before this existed.
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

    workspace: (path) => events.emit("workspace_loaded", { path }),
    dashboard: (config) => events.emit("dashboard_config", { config }),

    // ── Core System APIs — see README § Core System APIs ─────────
    // Every one of these is gated by requestPermission() first: a
    // plugin has to be granted "fs"/"process"/"net"/"system" before
    // it reaches the real native call at all (see permissions.ts).
    // fs/process/system additionally require the native app (real
    // Wails Go bindings) — there's no browser-mode equivalent, same
    // constraint the editor's readFile/writeFile already have.
    fsRead: async (path) => {
      if (!requestPermission(ctx.pluginName, "fs")) throw new Error("fs permission denied");
      if (!isNativeApp()) throw new Error("oxis.fs needs the native OXIS app (no filesystem access in browser mode)");
      return readFile(path);
    },
    fsWrite: async (path, content) => {
      if (!requestPermission(ctx.pluginName, "fs")) throw new Error("fs permission denied");
      if (!isNativeApp()) throw new Error("oxis.fs needs the native OXIS app (no filesystem access in browser mode)");
      await writeFile(path, content);
    },
    fsList: async (path) => {
      if (!requestPermission(ctx.pluginName, "fs")) throw new Error("fs permission denied");
      if (!isNativeApp()) throw new Error("oxis.fs needs the native OXIS app (no filesystem access in browser mode)");
      const entries = await listDir(path);
      return entries as unknown as LuaJSValue[];
    },
    fsStat: async (path) => {
      if (!requestPermission(ctx.pluginName, "fs")) throw new Error("fs permission denied");
      if (!isNativeApp()) throw new Error("oxis.fs needs the native OXIS app (no filesystem access in browser mode)");
      const s = await statPath(path);
      return s as unknown as LuaJSValue;
    },
    fsMkdir: async (path) => {
      if (!requestPermission(ctx.pluginName, "fs")) throw new Error("fs permission denied");
      if (!isNativeApp()) throw new Error("oxis.fs needs the native OXIS app (no filesystem access in browser mode)");
      await makeDir(path);
    },
    fsRemove: async (path) => {
      if (!requestPermission(ctx.pluginName, "fs")) throw new Error("fs permission denied");
      if (!isNativeApp()) throw new Error("oxis.fs needs the native OXIS app (no filesystem access in browser mode)");
      await deletePath(path);
    },

    processList: async () => {
      if (!requestPermission(ctx.pluginName, "process")) throw new Error("process permission denied");
      if (!isNativeApp()) throw new Error("oxis.process needs the native OXIS app");
      const list = await listProcesses();
      return list as unknown as LuaJSValue[];
    },
    processKill: async (pid) => {
      if (!requestPermission(ctx.pluginName, "process")) throw new Error("process permission denied");
      if (!isNativeApp()) throw new Error("oxis.process needs the native OXIS app");
      await killProcess(pid);
    },

    // oxis.net.request({ url=..., method="GET", headers={...}, body=... })
    // Plain fetch() — works in both native (webview) and browser mode.
    // Real network access, gated the same as fs/process; NOT routed
    // through any OXIS-owned proxy or given special credentials, so a
    // plugin like AI DevOps (see README § AI DevOps) has no more
    // access than any third-party plugin could ask a user to grant.
    netRequest: async (opts) => {
      if (!requestPermission(ctx.pluginName, "net")) throw new Error("net permission denied");
      const o = (opts ?? {}) as { url?: string; method?: string; headers?: Record<string, string>; body?: string };
      if (!o.url) throw new Error("oxis.net.request requires { url = ... }");
      const res = await fetch(o.url, { method: o.method || "GET", headers: o.headers, body: o.body });
      const body = await res.text();
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => { headers[k] = v; });
      return { status: res.status, ok: res.ok, body, headers } as unknown as LuaJSValue;
    },

    systemInfo: async () => {
      if (!requestPermission(ctx.pluginName, "system")) throw new Error("system permission denied");
      if (!isNativeApp()) throw new Error("oxis.system needs the native OXIS app");
      const info = await nativeSystemInfo();
      return info as unknown as LuaJSValue;
    },
  };
}