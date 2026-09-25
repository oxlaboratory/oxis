/**
 * pluginManager.ts — plugin discovery, loading, enable/disable, reload,
 * uninstall and persistence.
 *
 * Built-ins are TypeScript shortcut tables or bundled Lua; user and
 * Market plugins are .lua files on disk (native app only), run in their
 * own Lua VM (luaRuntime.ts). A command registered without a
 * description gets a generated one plus a warning to the author.
 */

import { registry } from "../terminal/commandRegistry";
import { events } from "../terminal/events";
import { workspaceManager } from "../terminal/workspaceManager";
import { loadLuaPlugin, checkLuaSyntax, type LoadedLuaPlugin } from "./luaRuntime";
import { buildLuaAPI, UNDOCUMENTED_SENTINEL, type APIContext } from "./pluginAPI";
import { isNativeApp, listPluginFiles, readPluginFile, writePluginFile, deletePluginFile, readFile, writeFile, listDir, deletePath, statPath } from "../native";
import type { CommandHandler } from "../terminal/commandRegistry";
import { parseManifest, satisfiesMin, satisfiesRange, OXIS_VERSION, type PluginManifest } from "./manifest";
import { setDeclaredPermissions, declaredPermissionsOf, type PermissionNamespace } from "./permissions";
import { isWindows } from "../terminal/terminal";
import { recordError } from "../terminal/diagnostics";

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
  /** Where a non-builtin plugin's file lives: "market" → plugins/ (the
   *  plugin-file Go bindings), "user" → created-plugins/ or the active
   *  workspace's plugins/. Undefined for builtins and premium plugins
   *  (never written to disk). */
  origin?: "user" | "market";
  /** From the `--[[@manifest ... ]]` block (manifest.ts); undefined for
   *  legacy plugins, which skip compatibility checks. */
  manifest?: PluginManifest;
}

const PERSIST_KEY = "oxis-plugins-v2";

/** Turns an undocumented command's own name into something at least
 *  minimally useful for 'help until the plugin author adds a real
 *  description — e.g. "gwip" -> "[games] gwip". */
function fallbackDescription(pluginName: string, commandName: string): string {
  return `[${pluginName}] ${commandName.replace(/^task:/, "task: ")}`;
}

export interface PluginErrorInfo {
  plugin: string;
  command?: string;
  error: string;
  permission?: PermissionNamespace;
  dependency?: string;
  suggestion?: string;
}

export type DoctorSeverity = "error" | "warning" | "info";
export interface PluginDoctorFinding { severity: DoctorSeverity; message: string; suggestion?: string }
export interface PluginDoctorResult { name: string; findings: PluginDoctorFinding[] }

/** A plain-language suggestion for one of validate()'s issue strings
 *  — matched by what the message is ABOUT (dependency/version/OS/
 *  permission/syntax), not the exact wording, so this doesn't quietly
 *  break the moment validate()'s phrasing changes. */
function suggestionFor(issue: string, pluginName: string): string | undefined {
  const low = issue.toLowerCase();
  if (low.startsWith("missing dependency")) return `Install the missing plugin, then 'plugin reload ${pluginName}`;
  if (low.startsWith("incompatible dependency")) return `Check if a compatible version is available — 'market info <dependency>`;
  if (low.includes("dependency cycle")) return `Break the cycle by removing one side of the mutual dependency from the manifest`;
  if (low.startsWith("not supported on this os")) return `This plugin can't run on this machine — 'plugin disable ${pluginName} to stop it being attempted`;
  if (low.startsWith("requires oxis >=")) return `Update OXIS, or find an older version of this plugin compatible with what's installed`;
  if (low.startsWith("lua syntax error")) return `Fix the syntax error — 'edit the plugin's .lua file (see 'plugin info ${pluginName} for where it lives)`;
  if (low.includes("no permissions list")) return `Add a permissions: line to the manifest — 'plugin info ${pluginName} to see what it's declared so far`;
  if (low.includes("no version")) return `Add a version: line to the manifest so dependents can check compatibility against it`;
  return undefined;
}

/** Formats every plugin failure (Lua errors, compatibility,
 *  dependencies, permissions) the same way. */
export function formatPluginError(info: PluginErrorInfo): string {
  const lines = ["Plugin Error", `Plugin: ${info.plugin}`];
  if (info.command) lines.push(`Command: ${info.command}`);
  if (info.permission) lines.push(`Permission: ${info.permission}`);
  if (info.dependency) lines.push(`Dependency: ${info.dependency}`);
  lines.push("", info.error);
  if (info.suggestion) lines.push("", info.suggestion);
  return lines.join("\n");
}

class PluginManager {
  private plugins = new Map<string, PluginMeta>();
  private disposers = new Map<string, LoadedLuaPlugin>();
  private warnedUndocumented = new Set<string>();
  private apiCtx: APIContext | null = null;

  /** Must be called once at startup before loading plugins */
  init(ctx: APIContext): void {
    this.apiCtx = ctx;
    // User plugins are per-workspace: on every workspace change, drop
    // the current user plugins and rescan the active plugins/ folder.
    // Market plugins aren't affected.
    events.on("workspace_loaded",   () => this.resyncUserPlugins());
    events.on("workspace_unloaded", () => this.resyncUserPlugins());
  }

  // Prevents overlapping rescans (startup load vs. an early
  // workspace_loaded).
  private userPluginResyncInFlight = false;
  private resyncUserPlugins(): void {
    if (this.userPluginResyncInFlight) return;
    this.userPluginResyncInFlight = true;
    this.unloadAllUserPlugins();
    this.loadUserPlugins().finally(() => { this.userPluginResyncInFlight = false; });
  }

  /** Unloads and de-registers every "user"-origin plugin — see init()'s
   *  workspace_loaded/unloaded listeners. Market-installed plugins are
   *  never touched by this. */
  unloadAllUserPlugins(): void {
    for (const p of [...this.plugins.values()]) {
      if (p.origin === "user") {
        this.unload(p.name);
        this.plugins.delete(p.name);
      }
    }
  }

  register(meta: PluginMeta): void {
    if (meta.lua && !meta.manifest) {
      const manifest = parseManifest(meta.lua);
      if (manifest) {
        meta.manifest = manifest;
        // Manifest fields only fill gaps; values the caller already set
        // (e.g. the Market's category) win.
        if (manifest.version && !meta.version) meta.version = manifest.version;
        if (manifest.author && !meta.author) meta.author = manifest.author;
        if (manifest.description) meta.desc = manifest.description;
        if (manifest.category) meta.category = manifest.category;
      }
    }
    setDeclaredPermissions(meta.name, meta.manifest ? (meta.manifest.permissions ?? []) : undefined);
    this.plugins.set(meta.name, meta);
  }

  /** OS, minimum OXIS version and dependency checks, run before a
   *  manifest plugin's Lua executes (legacy plugins skip them). An
   *  installed but disabled dependency is enabled; a missing one is
   *  reported. `chain` detects cycles. */
  private checkCompatibility(p: PluginMeta, chain: Set<string> = new Set()): { ok: true } | { ok: false; error: string; dependency?: string } {
    const m = p.manifest;
    if (!m) return { ok: true };

    if (m.os && m.os.length > 0) {
      const current = isWindows() ? "windows" : "unix";
      if (!m.os.includes(current)) {
        return { ok: false, error: `Not supported on this OS.\nSupported OS: ${m.os.join(", ")}\nThis machine: ${current}` };
      }
    }

    if (m.minOxisVersion && !satisfiesMin(OXIS_VERSION, m.minOxisVersion)) {
      return { ok: false, error: `Requires OXIS >= ${m.minOxisVersion} (running ${OXIS_VERSION}).` };
    }

    if (m.dependencies) {
      if (chain.has(p.name)) {
        return { ok: false, error: `Dependency cycle detected: ${[...chain, p.name].join(" -> ")}` };
      }
      const nextChain = new Set(chain).add(p.name);
      for (const [depName, range] of Object.entries(m.dependencies)) {
        // Check for a cycle first, whether or not the dependency is
        // enabled (the caller marks p enabled before calling this).
        if (nextChain.has(depName)) {
          return { ok: false, dependency: depName, error: `Dependency cycle detected: ${[...nextChain, depName].join(" -> ")}` };
        }
        const dep = this.plugins.get(depName);
        if (!dep) {
          return {
            ok: false, dependency: depName,
            error: `Missing dependency: ${depName} ${range !== "*" ? range : ""}\nInstall it first — 'market install ${depName} (or 'plugin new ${depName} if it's your own).`,
          };
        }
        if (dep.version && !satisfiesRange(dep.version, range)) {
          return {
            ok: false, dependency: depName,
            error: `Incompatible dependency: ${depName} ${range} required, but ${dep.version} is installed.\nA newer version may be available on the Market — check 'market info ${depName}.`,
          };
        }
        if (!dep.enabled) {
          const depCheck = this.checkCompatibility(dep, nextChain);
          if (!depCheck.ok) {
            return { ok: false, dependency: depName, error: `Dependency "${depName}" can't be enabled: ${depCheck.error}` };
          }
          dep.enabled = true;
          this.load(depName);
          if (!dep.enabled) {
            return { ok: false, dependency: depName, error: `Dependency "${depName}" failed to load — see the message above for why.` };
          }
        }
      }
    }

    return { ok: true };
  }

  /** Load a plugin's commands into the registry */
  /** silent: skip the plugin_loaded event, for bulk startup loading
   *  (otherwise Home's "recent" row fills with startup noise). */
  load(name: string, silent = false): boolean {
    const p = this.plugins.get(name);
    if (!p || !p.enabled) return false;

    if (p.manifest) {
      const compat = this.checkCompatibility(p);
      if (!compat.ok) {
        p.enabled = false;
        this.persist();
        const msg = formatPluginError({ plugin: name, error: compat.error, dependency: compat.dependency });
        this.apiCtx?.print(msg, "err");
        recordError(msg);
        return false;
      }
    }

    // Shortcut plugins: the description is the command it runs.
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
      // Built-in plugins are trusted (no shell prompt); every
      // Market/user plugin goes through requireShellPermission.
      const bindings = buildLuaAPI({ ...this.apiCtx, pluginName: name, isTrusted: p.builtin });
      const result = loadLuaPlugin(p.lua, bindings);
      if (!result.ok) {
        console.warn(`[oxis:plugin] ${name} load error: ${result.error}`);
        const msg = formatPluginError({
          plugin: name, error: result.error,
          suggestion: "'plugin validate " + name + " to check its manifest, or 'plugin docs " + name + " for what it expects.",
        });
        this.apiCtx.print(msg, "err");
        recordError(msg);
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

    if (!silent) events.emit("plugin_loaded", { name });
    return true;
  }

  /** Never lets a throwing dispose() abort the caller, so disable()
   *  still persists its new state. */
  unload(name: string): void {
    registry.unregisterByPlugin(name);
    const loaded = this.disposers.get(name);
    if (loaded) {
      try { loaded.dispose(); } catch { /* best-effort — a plugin's own teardown failing must not block the rest of unload()/disable() from completing */ }
      this.disposers.delete(name);
    }
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

  /** Every OTHER installed plugin whose manifest depends on `name`. */
  dependentsOf(name: string): string[] {
    return [...this.plugins.values()]
      .filter(p => p.name !== name && p.manifest?.dependencies && Object.keys(p.manifest.dependencies).includes(name))
      .map(p => p.name);
  }

  /** Removes a plugin: unloads it, deletes its file (user/Market), and
   *  drops it from the list. Refuses if another plugin depends on it
   *  unless `force` is set (the caller warns the user). */
  /** The file is deleted and confirmed gone (statPath) before the
   *  plugin is removed from the list; otherwise it would be rediscovered
   *  on the next start. A file that survives the delete is reported and
   *  the plugin left as it was. */
  async remove(name: string, force = false): Promise<{ ok: boolean; message: string }> {
    const p = this.plugins.get(name);
    if (!p) return { ok: false, message: `not found: ${name}` };
    const dependents = this.dependentsOf(name);
    if (dependents.length > 0 && !force) {
      return {
        ok: false,
        message: `"${name}" is a dependency of: ${dependents.join(", ")}. Uninstalling it would break them.\nUninstall those first, or 'plugin uninstall ${name} --force to remove it anyway.`,
      };
    }

    if (!p.builtin && isNativeApp()) {
      const filePath = p.origin === "user" ? `${workspaceManager.pluginsDir()}/${name}.lua` : null;
      try {
        if (filePath) await deletePath(filePath);
        else await deletePluginFile(name);
      } catch {
        /* "already gone" or a real failure; statPath below decides */
      }
      const stillThere = filePath
        ? await statPath(filePath).then(s => s.exists).catch(() => false)
        : await listPluginFiles().then(names => names.includes(name)).catch(() => false);
      if (stillThere) {
        return { ok: false, message: `couldn't remove ${name} — its file is still on disk and couldn't be deleted (locked, or a permissions issue)` };
      }
    }

    this.unload(name);
    this.plugins.delete(name);
    this.persist();
    return {
      ok: true,
      message: dependents.length > 0
        ? `removed ${name} (⚠ was a dependency of: ${dependents.join(", ")} — they may no longer work)`
        : `removed ${name}`,
    };
  }

  /** 'plugin validate <name>: manifest, permissions, dependencies,
   *  compatibility and a Lua syntax check, without running any of the
   *  plugin's code ('plugin test does that). */
  validate(name: string): { ok: boolean; issues: string[] } {
    const p = this.plugins.get(name);
    if (!p) return { ok: false, issues: [`not found: ${name}`] };
    const issues: string[] = [];

    if (!p.manifest) {
      issues.push("no manifest block (--[[@manifest ... ]]) — running as a legacy plugin: unrestricted permissions, no declared version/OS/dependencies to check");
    } else {
      const m = p.manifest;
      if (!m.version) issues.push("manifest has no version — dependency version checks against this plugin will be skipped");
      if (!m.permissions) issues.push("manifest has no permissions list — every Core System API call will be hard-denied (no prompt) until one is added, even an empty `permissions:` line if it genuinely needs none");
      if (m.minOxisVersion && !/^\d+\.\d+\.\d+/.test(m.minOxisVersion)) issues.push(`min_oxis_version "${m.minOxisVersion}" doesn't look like a valid version (expected e.g. "1.2.1")`);
      const compat = this.checkCompatibility(p);
      if (!compat.ok) issues.push(compat.error.split("\n")[0]);
    }

    if (p.lua) {
      // Compile only, never run, so this is safe on a loaded plugin.
      const syntaxCheck = checkLuaSyntax(p.lua);
      if (!syntaxCheck.ok) issues.push(`Lua syntax error: ${syntaxCheck.error}`);
    }

    return { ok: issues.length === 0, issues };
  }

  /** 'plugin doctor: validate() for every installed plugin, plus
   *  missing files and enabled plugins with no commands. Problems on an
   *  enabled plugin are errors, on a disabled one warnings; "no
   *  manifest" is info. */
  async doctor(): Promise<PluginDoctorResult[]> {
    const results: PluginDoctorResult[] = [];
    for (const p of this.plugins.values()) {
      if (p.builtin) continue;
      const { issues } = this.validate(p.name);
      const findings: PluginDoctorFinding[] = issues.map(issue => ({
        severity: !p.enabled ? "warning" : issue.startsWith("no manifest block") ? "info" : "error",
        message: issue,
        suggestion: suggestionFor(issue, p.name),
      }));

      if (isNativeApp() && !p.builtin) {
        const path = p.origin === "user" ? `${workspaceManager.pluginsDir()}/${p.name}.lua` : `plugins/${p.name}.lua`;
        try {
          if (p.origin === "user") await readFile(path); else await readPluginFile(p.name);
        } catch {
          findings.push({
            severity: p.enabled ? "error" : "warning",
            message: `file missing on disk: ${path} (registered in memory, but the file behind it is gone)`,
            suggestion: `'plugin uninstall ${p.name} to clean up the stale registration, or restore the file at ${path}`,
          });
        }
      }

      if (p.enabled) {
        const registered = registry.all().filter(c => c.fromPlugin === p.name);
        if (registered.length === 0 && findings.length === 0) {
          findings.push({
            severity: "warning",
            message: "enabled, loads without error, but registers zero commands — probably fine (some plugins only add keymaps/autocmds), but worth a second look if you expected commands from it",
            suggestion: `'plugin test ${p.name} to see exactly what it registers`,
          });
        }
      }

      if (findings.length > 0) results.push({ name: p.name, findings });
    }
    return results;
  }

  /** 'plugin info <name> — everything known about a plugin in one
   *  place: metadata, manifest fields, permissions (declared vs.
   *  granted), dependencies, and dependents. */
  info(name: string): { ok: true; text: string } | { ok: false; message: string } {
    const p = this.plugins.get(name);
    if (!p) return { ok: false, message: `not found: ${name}` };
    const m = p.manifest;
    const lines = [
      `${p.name}  ${p.version ? `v${p.version}` : "(no version declared)"}`,
      p.desc,
      `category: ${p.category}   status: ${p.enabled ? "enabled" : "disabled"}   origin: ${p.builtin ? "built-in" : p.origin ?? "unknown"}`,
    ];
    if (p.author) lines.push(`author: ${p.author}`);
    if (m?.minOxisVersion) lines.push(`requires OXIS >= ${m.minOxisVersion} (running ${OXIS_VERSION})`);
    if (m?.os) lines.push(`supported OS: ${m.os.join(", ")}`);
    const declaredPerms = declaredPermissionsOf(name);
    lines.push(declaredPerms ? `declared permissions: ${declaredPerms.join(", ") || "(none)"}` : "permissions: not declared (legacy plugin — prompts on first use)");
    if (m?.dependencies && Object.keys(m.dependencies).length > 0) {
      lines.push("dependencies:");
      for (const [dep, range] of Object.entries(m.dependencies)) {
        const installed = this.plugins.get(dep);
        const status = !installed ? "MISSING" : installed.version && !satisfiesRange(installed.version, range) ? `installed v${installed.version}, INCOMPATIBLE` : "ok";
        lines.push(`  ${dep} ${range !== "*" ? range : ""}  — ${status}`);
      }
    }
    const dependents = this.dependentsOf(name);
    if (dependents.length > 0) lines.push(`depended on by: ${dependents.join(", ")}`);
    if (!p.builtin) lines.push("", "'plugin docs " + name + " for its full documentation (if provided) · 'plugin validate " + name + " to check it");
    return { ok: true, text: lines.join("\n") };
  }

  /** 'plugin test <name>: loads the plugin for real, reports what it
   *  registered, then restores its previous enabled state. */
  test(name: string): { ok: boolean; message: string } {
    const p = this.plugins.get(name);
    if (!p) return { ok: false, message: `not found: ${name}` };
    const wasEnabled = p.enabled;
    if (wasEnabled) this.unload(name); // clean slate, don't double-register
    p.enabled = true;
    const loaded = this.load(name);
    const commands = loaded ? registry.all().filter(c => c.fromPlugin === name) : [];
    if (!wasEnabled) {
      this.unload(name);
      p.enabled = false;
    }
    this.persist();
    return loaded
      ? { ok: true, message: `${name}: loaded successfully — ${commands.length} command(s): ${commands.map(c => c.name).join(", ") || "(none)"}` }
      : { ok: false, message: `${name}: failed to load — see the error above` };
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

  /** Register, load and save a new Lua plugin ('plugin new,
   *  'market install). The file is only written if load() succeeds, so
   *  a broken download or plugin leaves nothing behind to fail again on
   *  the next start. Returns false in browser mode. */
  async addLuaPlugin(name: string, lua: string, category = "plugin", origin: "user" | "market" = "market"): Promise<{ persisted: boolean; persistError?: unknown }> {
    this.register({ name, desc: "User Lua plugin", category, builtin: false, enabled: true, lua, origin });
    this.persist();
    this.load(name);
    // load() sets enabled back to false on failure (see its own doc
    // comment) — check the real post-load state, not the optimistic
    // one register() set above.
    if (!this.plugins.get(name)?.enabled) return { persisted: false };
    if (!isNativeApp()) return { persisted: false };
    try {
      if (origin === "user") await writeFile(`${workspaceManager.pluginsDir()}/${name}.lua`, lua);
      else await writePluginFile(name, lua);
      return { persisted: true };
    } catch (persistError) {
      return { persisted: false, persistError };
    }
  }

  /**
   * Registers and loads a premium plugin's decrypted source for this
   * session only. Unlike addLuaPlugin() nothing is written to disk; the
   * encrypted .oxispkg stays the only copy.
   */
  registerPremiumPlugin(name: string, lua: string, category = "premium", silent = false): void {
    this.register({ name, desc: "Premium plugin", category, builtin: false, enabled: true, lua });
    this.persist(); // enabled/disabled flag only — no source, see persist()'s own doc comment
    this.load(name, silent);
  }

  /** Save an already-registered Lua plugin's source back to disk —
   *  used when a plugin is edited in place (PluginCreator's Save).
   *  Same persisted/persistError shape as addLuaPlugin, same reason. */
  async saveLuaPlugin(name: string, lua: string): Promise<{ persisted: boolean; persistError?: unknown }> {
    const p = this.plugins.get(name);
    if (p) p.lua = lua;
    let result: { persisted: boolean; persistError?: unknown };
    if (!isNativeApp()) {
      result = { persisted: false };
    } else {
      try {
        if (p?.origin === "user") await writeFile(`${workspaceManager.pluginsDir()}/${name}.lua`, lua);
        else await writePluginFile(name, lua);
        result = { persisted: true };
      } catch (persistError) {
        result = { persisted: false, persistError };
      }
    }
    // Apply the new code now, so saving the file in the editor reloads
    // the plugin.
    if (p?.enabled) this.reload(name);
    return result;
  }

  /** Loads every user/Market plugin file from disk and runs the enabled
   *  ones (native app only). Called once at startup after restoreState(). */
  async loadUserPlugins(): Promise<void> {
    if (!isNativeApp()) return;

    // Market-installed plugins: dist/plugins/, via the dedicated Go bindings.
    let marketNames: string[];
    try { marketNames = await listPluginFiles(); }
    catch { marketNames = []; }
    for (const name of marketNames) {
      if (this.plugins.has(name)) continue; // already registered (e.g. re-init)
      let lua: string;
      try { lua = await readPluginFile(name); }
      catch { continue; }
      this.register({ name, desc: "User Lua plugin", category: "plugin", builtin: false, enabled: true, lua, origin: "market" });
    }

    // User-created plugins (Plugin Creator / 'plugin new): created-plugins/,
    // or the active workspace's own plugins/ — via the generic file
    // bridge (see PluginMeta.origin's doc comment for why these are
    // kept separate from market-installed ones).
    let userNames: string[] = [];
    try {
      const dir = workspaceManager.pluginsDir();
      const entries = await listDir(dir);
      userNames = entries.filter(e => !e.isDir && e.name.endsWith(".lua")).map(e => e.name.slice(0, -4));
    } catch { /* folder doesn't exist yet — nothing created there so far */ }
    for (const name of userNames) {
      if (this.plugins.has(name)) continue; // a market plugin of the same name wins if both exist
      let lua: string;
      try { lua = await readFile(`${workspaceManager.pluginsDir()}/${name}.lua`); }
      catch { continue; }
      this.register({ name, desc: "User Lua plugin", category: "plugin", builtin: false, enabled: true, lua, origin: "user" });
    }

    const names = [...marketNames, ...userNames];
    // restoreState() (called before this by loader.ts) already applied
    // saved enabled/disabled flags to any plugin that existed when it
    // ran — but these were just registered, so re-apply now, then
    // actually load the ones that ended up enabled.
    this.restoreState();
    for (const name of names) {
      const p = this.plugins.get(name);
      if (p?.enabled) this.load(name, true); // silent — see load()'s own doc comment
    }
  }
}

export const pluginManager = new PluginManager();