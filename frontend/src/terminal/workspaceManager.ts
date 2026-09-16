/**
 * workspaceManager.ts — real workspace lifecycle (see README §
 * Workspace System).
 *
 * A workspace is a `.oxis/workspace.lua` file. There's no separate
 * "workspace config format" or new oxis.* API for this — a workspace
 * file runs through the exact same Lua VM and `oxis.*` bindings as a
 * plugin does (buildLuaAPI + loadLuaPlugin, see pluginManager.ts's
 * load()), just tagged with the pseudo-plugin name "__workspace__"
 * instead of a real plugin's name. That's deliberate: it means a
 * workspace file can call oxis.task(...), oxis.theme(...),
 * oxis.plugin.enable(...), oxis.command(...), etc. with zero new API
 * surface, and `'workspace close` can cleanly undo everything it did
 * with the registry's existing unregisterByPlugin().
 *
 * Requires the native app (real filesystem access) — see isNativeApp()
 * in native.ts. In browser mode, every method here fails with a clear
 * message rather than silently doing nothing.
 */

import { readFile, writeFile, statPath, isNativeApp } from "../native";
import { loadLuaPlugin, type LoadedLuaPlugin } from "../plugins/luaRuntime";
import { buildLuaAPI, type APIContext } from "../plugins/pluginAPI";
import { registry } from "./commandRegistry";
import { events } from "./events";

const WORKSPACE_PLUGIN_NAME = "__workspace__";
const WORKSPACE_REL_PATH = ".oxis/workspace.lua";

export interface WorkspaceOpResult {
  ok: boolean;
  message: string;
}

function joinPath(dir: string, rel: string): string {
  const usesBackslash = dir.includes("\\") && !dir.includes("/");
  const sep = usesBackslash ? "\\" : "/";
  const relNative = usesBackslash ? rel.replace(/\//g, "\\") : rel;
  const trimmed = dir.replace(/[\\/]+$/, "");
  return `${trimmed}${sep}${relNative}`;
}

const DEFAULT_TEMPLATE = (projectName: string) => `-- OXIS workspace config for "${projectName}"
-- Auto-loaded whenever OXIS opens (or 'workspace reload's) this
-- directory — see README § Workspace System for the full oxis.* API.
-- Everything here runs through the same Lua API a regular plugin
-- gets; 'workspace close cleanly undoes all of it.

oxis.workspace(".")   -- marks this directory as the active workspace

-- oxis.theme("midnight")             -- force a theme whenever this project opens

oxis.task("dev",   "npm run dev",   "Start the dev server")
oxis.task("build", "npm run build", "Production build")
oxis.task("test",  "npm test",      "Run the test suite")

-- oxis.plugin.enable("git")          -- auto-enable a plugin for this workspace

-- oxis.command("hello", function()
--   oxis.echo("hello from " .. "${projectName}")
-- end, "Say hello — remove me, I'm just an example")
`;

class WorkspaceManager {
  private apiCtx: APIContext | null = null;
  private disposer: LoadedLuaPlugin | null = null;
  private activeDir: string | null = null;

  /** Must be called once at startup, same as pluginManager.init(). */
  init(ctx: APIContext): void {
    this.apiCtx = ctx;
  }

  private unavailable(): WorkspaceOpResult | null {
    if (!isNativeApp()) {
      return { ok: false, message: "workspaces need real file access — only available in the native OXIS app, not browser mode (see README § Browser Mode)" };
    }
    if (!this.apiCtx) {
      return { ok: false, message: "workspace manager isn't initialised yet" };
    }
    return null;
  }

  /** True if `dir` contains a `.oxis/workspace.lua` file. Used for
   *  auto-detection on startup/directory change — see App.tsx's init
   *  effect and detectAndLoad(). */
  async detect(dir: string): Promise<boolean> {
    if (!isNativeApp()) return false;
    try {
      const stat = await statPath(joinPath(dir, WORKSPACE_REL_PATH));
      return stat.exists && !stat.isDir;
    } catch {
      return false;
    }
  }

  /** Detect + load in one step; used at startup and whenever the
   *  active shell's cwd changes (see ptyClient.ts's cwd tracking). A
   *  no-op (not an error) when there's simply no workspace here. */
  async detectAndLoad(dir: string): Promise<WorkspaceOpResult | null> {
    const found = await this.detect(dir);
    if (!found) return null;
    if (this.activeDir === dir) return null; // already loaded
    return this.load(dir);
  }

  /** `'workspace init` — create `.oxis/workspace.lua` with a starter template. */
  async initWorkspace(dir: string): Promise<WorkspaceOpResult> {
    const unavailable = this.unavailable();
    if (unavailable) return unavailable;
    const path = joinPath(dir, WORKSPACE_REL_PATH);
    const already = await statPath(path).catch(() => ({ exists: false, isDir: false, size: 0, modTime: 0 }));
    if (already.exists) {
      return { ok: false, message: `a workspace already exists at ${path} — 'workspace reload to re-run it, or 'workspace info to see its state` };
    }
    const name = dir.split(/[\\/]/).filter(Boolean).pop() || "workspace";
    try {
      await writeFile(path, DEFAULT_TEMPLATE(name));
    } catch (e) {
      return { ok: false, message: `couldn't create ${path}: ${e}` };
    }
    const loaded = await this.load(dir);
    return { ok: loaded.ok, message: `created ${path}${loaded.ok ? " and loaded it" : ` (${loaded.message})`}` };
  }

  /** `'workspace info` — human-readable dump of the active workspace. */
  info(): WorkspaceOpResult {
    if (!this.activeDir) return { ok: false, message: "no workspace loaded — try 'workspace init or open a directory that has one" };
    const tasks = registry.all().filter(c => c.category === "task" && c.fromPlugin === WORKSPACE_PLUGIN_NAME);
    const lines = [
      `workspace: ${this.activeDir}`,
      `tasks: ${tasks.length ? tasks.map(t => t.name.replace(/^task:/, "")).join(", ") : "none"}`,
    ];
    return { ok: true, message: lines.join("\n") };
  }

  /** `'workspace reload` — close, then re-run workspace.lua from disk. */
  async reload(dir?: string): Promise<WorkspaceOpResult> {
    const target = dir ?? this.activeDir;
    if (!target) return { ok: false, message: "no workspace loaded to reload — pass a directory, or 'workspace init one" };
    return this.load(target);
  }

  /** `'workspace close` — unload, undoing everything workspace.lua registered. */
  close(): WorkspaceOpResult {
    if (!this.disposer) return { ok: false, message: "no workspace is currently loaded" };
    registry.unregisterByPlugin(WORKSPACE_PLUGIN_NAME);
    try { this.disposer.dispose(); } catch { /* VM already gone */ }
    this.disposer = null;
    this.activeDir = null;
    events.emit("workspace_unloaded", {});
    return { ok: true, message: "workspace closed" };
  }

  /** Core load path shared by init/reload/detectAndLoad. */
  async load(dir: string): Promise<WorkspaceOpResult> {
    const unavailable = this.unavailable();
    if (unavailable) return unavailable;
    const path = joinPath(dir, WORKSPACE_REL_PATH);
    let source: string;
    try {
      source = await readFile(path);
    } catch {
      return { ok: false, message: `no workspace found at ${path} — try 'workspace init` };
    }

    // Unload whatever was there before (tasks/commands/etc. it
    // registered) — a reload shouldn't leave the previous run's
    // registrations dangling alongside the new ones.
    if (this.disposer) {
      registry.unregisterByPlugin(WORKSPACE_PLUGIN_NAME);
      try { this.disposer.dispose(); } catch { /* ignore */ }
      this.disposer = null;
    }

    events.emit("workspace_loading", { path: dir });
    const bindings = buildLuaAPI({ ...this.apiCtx!, pluginName: WORKSPACE_PLUGIN_NAME });
    const result = loadLuaPlugin(source, bindings);
    if (!result.ok) {
      events.emit("workspace_unloaded", {});
      return { ok: false, message: `${path} failed to load: ${result.error}` };
    }
    this.disposer = result.plugin;
    this.activeDir = dir;
    // Authoritative "workspace_loaded" with the real absolute
    // directory — separate from whatever oxis.workspace(path) inside
    // the .lua file itself passed (usually just "."), which
    // workspaceState.ts explicitly does NOT use for display.
    events.emit("workspace_loaded", { path: dir });
    return { ok: true, message: `workspace loaded from ${path}` };
  }

  getActiveDir(): string | null {
    return this.activeDir;
  }
}

export const workspaceManager = new WorkspaceManager();
