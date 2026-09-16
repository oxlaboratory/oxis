/**
 * pluginManager.ts — OXIS plugin manager
 *
 * Handles discovery, loading, unloading, enabling, disabling, and reloading.
 * Built-in plugins are TypeScript shortcut tables; user/market Lua
 * plugins run through a real Lua VM (see luaRuntime.ts).
 *
 * ── Documentation compliance ─────────────────────────────────
 * Every command a plugin registers (via oxis.command/oxis.task, or a
 * TS shortcut) is supposed to carry a real description — see
 * pluginAPI.ts. Right after a Lua plugin finishes executing, load()
 * scans the registry for anything it just registered that's still
 * tagged with UNDOCUMENTED_SENTINEL. It USED to disable the whole
 * plugin over this; it no longer does — a plugin silently disabled
 * over one missing description is functionally indistinguishable from
 * one that never loaded at all, which defeats the actual point (make
 * plugins show up and work in 'help). Missing descriptions now get a
 * short auto-generated fallback instead, plus a loud one-time warning
 * telling the author to add a real one — 'help still shows something
 * useful either way, and the plugin's commands actually work.
 *
 * ── Persistence ──────────────────────────────────────────────
 * User/market plugin Lua source is written to real .lua files on disk
 * (via the native Go bindings in native.ts — see pluginsDir() in
 * internal/wailsapp/app.go), not localStorage. This only works inside
 * the native window (browser mode has no filesystem access at all —
 * see isNativeApp() in native.ts); loadUserPlugins()/saveLuaPlugin()
 * are no-ops in browser mode rather than throwing, since a plugin
 * manager with no persistence is still a perfectly usable session, it
 * just won't survive a refresh.
 */

import { registry } from "../terminal/commandRegistry";
import { events } from "../terminal/events";
import { loadLuaPlugin, type LoadedLuaPlugin } from "./luaRuntime";
import { buildLuaAPI, UNDOCUMENTED_SENTINEL, type APIContext } from "./pluginAPI";
import { isNativeApp, listPluginFiles, readPluginFile, writePluginFile, deletePluginFile } from "../native";
import type { CommandHandler } from "../terminal/commandRegistry";

export type PluginCategory = "dev" | "devops" | "system" | "files" | "plugin" | string;

export interface PluginMeta {
  name: string;
  desc: string;
  category: PluginCategory;
  version?: string;
  author?: string;
  builtin: boolean;
  /** If true the plugin is currently enabled */
  enabled: boolean;
  /** Lua source (for user plugins) */
  lua?: string;
  /** TypeScript shortcut table (for built-in plugins) */
  shortcuts?: Record<string, string | ((a: string) => string)>;
}

const PERSIST_KEY = "oxis-plugins-v2";

/** Turns an undocumented command's own name into something at least
 *  minimally useful for 'help until the plugin author adds a real
 *  description — e.g. "gwip" -> "[games] gwip". */
function fallbackDescription(pluginName: string, commandName: string): string {
  return `[${pluginName}] ${commandName.replace(/^task:/, "task: ")}`;
}

class PluginManager {
  private plugins = new Map<string, PluginMeta>();
  private disposers = new Map<string, LoadedLuaPlugin>();
  private warnedUndocumented = new Set<string>();
  private apiCtx: APIContext | null = null;

  /** Must be called once at startup before loading plugins */
  init(ctx: APIContext): void {
    this.apiCtx = ctx;
  }

  register(meta: PluginMeta): void {
    this.plugins.set(meta.name, meta);
  }

  /** Load a plugin's commands into the registry */
  load(name: string): boolean {
    const p = this.plugins.get(name);
    if (!p || !p.enabled) return false;

    // TypeScript shortcut plugins — description is derived from the
    // real underlying command so 'help <plugin> shows something
    // genuinely useful (what it actually runs), not a placeholder.
    if (p.shortcuts) {
      for (const [verb, impl] of Object.entries(p.shortcuts)) {
        const handler: CommandHandler = (_args, rest) => {
          if (!this.apiCtx) return;
          const cmd = typeof impl === "function" ? impl(rest) : impl;
          if (cmd) this.apiCtx.sendToShell(cmd + "\r");
        };
        registry.register({
          name: verb,
          description: typeof impl === "string"
            ? impl
            : `[${name}] takes an argument — ${verb} <arg>`,
          category: p.category,
          fromPlugin: name,
          handler,
        });
      }
    }

    // Lua plugins — real Lua VM, see luaRuntime.ts.
    if (p.lua && this.apiCtx) {
      const bindings = buildLuaAPI({ ...this.apiCtx, pluginName: name });
      const result = loadLuaPlugin(p.lua, bindings);
      if (!result.ok) {
        console.warn(`[oxis:plugin] ${name} load error: ${result.error}`);
        this.apiCtx.print(`  ✗  plugin ${name} failed to load: ${result.error}`, "err");
        // A plugin that threw during exec has zero working commands —
        // don't leave it marked enabled, or 'plugin list shows a
        // green dot for something that does nothing.
        p.enabled = false;
        this.persist();
        return false;
      }
      this.disposers.set(name, result.plugin);

      // ── documentation compliance: warn + auto-fill, don't disable ──
      const registered = registry.all().filter(c => c.fromPlugin === name);
      const undocumented = registered.filter(c => c.description === UNDOCUMENTED_SENTINEL);
      if (undocumented.length > 0) {
        for (const c of undocumented) {
          registry.register({ ...c, description: fallbackDescription(name, c.name) });
        }
        if (!this.warnedUndocumented.has(name)) {
          this.warnedUndocumented.add(name);
          const names = undocumented.map(c => c.name.replace(/^task:/, "'task ")).join(", ");
          this.apiCtx.print(`  ⚠  plugin ${name}: auto-generated descriptions for: ${names}`, "dim");
          this.apiCtx.print(`     add a 3rd argument to oxis.command()/oxis.task() to improve 'help output`, "dim");
        }
      }
    }

    events.emit("plugin_loaded", { name });
    return true;
  }

  unload(name: string): void {
    registry.unregisterByPlugin(name);
    const loaded = this.disposers.get(name);
    if (loaded) { loaded.dispose(); this.disposers.delete(name); }
    events.emit("plugin_unloaded", { name });
  }

  enable(name: string): boolean {
    const p = this.plugins.get(name);
    if (!p) return false;
    p.enabled = true;
    this.persist();
    this.load(name);
    return true;
  }

  disable(name: string): boolean {
    const p = this.plugins.get(name);
    if (!p) return false;
    p.enabled = false;
    this.unload(name);
    this.persist();
    return true;
  }

  /** 'plugin enable all — enables every registered plugin in one shot. */
  enableAll(): { enabled: string[]; alreadyOn: string[]; failed: string[] } {
    const enabled: string[] = [];
    const alreadyOn: string[] = [];
    const failed: string[] = [];
    for (const p of this.plugins.values()) {
      if (p.enabled) { alreadyOn.push(p.name); continue; }
      this.enable(p.name);
      // enable() sets p.enabled = true optimistically, then load()
      // may immediately set it back to false (exec error) — check the
      // real final state, same reasoning as the install/enable
      // command handlers in App.tsx.
      if (p.enabled) enabled.push(p.name);
      else failed.push(p.name);
    }
    return { enabled, alreadyOn, failed };
  }

  reload(name: string): void {
    this.unload(name);
    this.load(name);
  }

  reloadAll(): void {
    for (const p of this.plugins.values()) {
      if (p.enabled) { this.unload(p.name); this.load(p.name); }
    }
  }

  /** Remove a plugin entirely: unload it, drop its metadata, and (for
   *  user/market plugins) delete its real file from disk. */
  async remove(name: string): Promise<void> {
    const p = this.plugins.get(name);
    if (!p) return;
    this.unload(name);
    this.plugins.delete(name);
    this.persist();
    if (!p.builtin && isNativeApp()) {
      try { await deletePluginFile(name); } catch { /* already gone, or browser mode */ }
    }
  }

  all(): PluginMeta[] {
    return [...this.plugins.values()];
  }

  get(name: string): PluginMeta | undefined {
    return this.plugins.get(name);
  }

  /** Persist enabled/disabled states (small, so localStorage is fine
   *  for this part regardless of native vs browser mode — it's just a
   *  set of booleans, not the plugin source itself). */
  persist(): void {
    try {
      const state = [...this.plugins.values()].map(p => ({ name: p.name, enabled: p.enabled }));
      localStorage.setItem(PERSIST_KEY, JSON.stringify(state));
    } catch { /* noop */ }
  }

  /** Restore enabled/disabled states from localStorage */
  restoreState(): void {
    try {
      const s = localStorage.getItem(PERSIST_KEY);
      if (!s) return;
      const saved: { name: string; enabled: boolean }[] = JSON.parse(s);
      for (const { name, enabled } of saved) {
        const p = this.plugins.get(name);
        if (p) p.enabled = enabled;
      }
    } catch { /* noop */ }
  }

  /** Register + persist + load a new Lua plugin in one call — used by
   *  both 'plugin new (PluginCreator) and 'market install. Writes the
   *  real .lua file to disk (native window only; returns false there
   *  instead of throwing in browser mode, where there's no filesystem
   *  access to write to at all). The plugin is registered and loaded
   *  — and so already usable this session — regardless of whether the
   *  disk write succeeds; the return value tells the caller which
   *  happened, so "it works but didn't save" and "it failed outright"
   *  don't get reported as the same thing. */
  async addLuaPlugin(name: string, lua: string, category = "plugin"): Promise<{ persisted: boolean; persistError?: unknown }> {
    this.register({ name, desc: "User Lua plugin", category, builtin: false, enabled: true, lua });
    this.persist();
    this.load(name);
    if (!isNativeApp()) return { persisted: false };
    try {
      await writePluginFile(name, lua);
      return { persisted: true };
    } catch (persistError) {
      return { persisted: false, persistError };
    }
  }

  /**
   * Register + load a premium plugin's DECRYPTED source for this
   * session only. Deliberately separate from addLuaPlugin(): that
   * method always writes `lua` to plugins/<name>.lua via
   * writePluginFile(), which would put the plaintext premium source
   * right back on disk next to the whole point of encrypting it (see
   * market.ts's loadPremiumPlugin() / README § Premium Plugin
   * Licensing & Encryption). This keeps the decrypted string in
   * memory only — the encrypted .oxispkg file under .oxis/premium/
   * is the only on-disk copy that ever exists.
   */
  registerPremiumPlugin(name: string, lua: string, category = "premium"): void {
    this.register({ name, desc: "Premium plugin", category, builtin: false, enabled: true, lua });
    this.persist(); // enabled/disabled flag only — no source, see persist()'s own doc comment
    this.load(name);
  }

  /** Save an already-registered Lua plugin's source back to disk —
   *  used when a plugin is edited in place (PluginCreator's Save).
   *  Same persisted/persistError shape as addLuaPlugin, same reason. */
  async saveLuaPlugin(name: string, lua: string): Promise<{ persisted: boolean; persistError?: unknown }> {
    const p = this.plugins.get(name);
    if (p) p.lua = lua;
    if (!isNativeApp()) return { persisted: false };
    try {
      await writePluginFile(name, lua);
      return { persisted: true };
    } catch (persistError) {
      return { persisted: false, persistError };
    }
  }

  /** Load every user/market plugin file from disk (native window
   *  only — browser mode has nothing to scan and just returns). Call
   *  once at startup, after restoreState(). Unlike the old
   *  localStorage-based version, this actually calls load() for each
   *  enabled plugin — the localStorage version only ever registered
   *  metadata, never re-executed the Lua source, so every
   *  user/market-installed plugin silently had zero working commands
   *  after any app restart even though 'plugin list still showed it
   *  as enabled. */
  async loadUserPlugins(): Promise<void> {
    if (!isNativeApp()) return;
    let names: string[];
    try { names = await listPluginFiles(); }
    catch { return; }

    for (const name of names) {
      if (this.plugins.has(name)) continue; // already registered (e.g. re-init)
      let lua: string;
      try { lua = await readPluginFile(name); }
      catch { continue; }
      this.register({ name, desc: "User Lua plugin", category: "plugin", builtin: false, enabled: true, lua });
    }
    // restoreState() (called before this by loader.ts) already applied
    // saved enabled/disabled flags to any plugin that existed when it
    // ran — but these were just registered, so re-apply now, then
    // actually load the ones that ended up enabled.
    this.restoreState();
    for (const name of names) {
      const p = this.plugins.get(name);
      if (p?.enabled) this.load(name);
    }
  }
}

export const pluginManager = new PluginManager();
