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
import { workspaceManager } from "../terminal/workspaceManager";
import { loadLuaPlugin, checkLuaSyntax, type LoadedLuaPlugin } from "./luaRuntime";
import { buildLuaAPI, UNDOCUMENTED_SENTINEL, type APIContext } from "./pluginAPI";
import { isNativeApp, listPluginFiles, readPluginFile, writePluginFile, deletePluginFile, readFile, writeFile, listDir, deletePath } from "../native";
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
  /** Where a non-builtin plugin's .lua file actually lives:
   *  "market" → dist/plugins/ (via the dedicated ListPlugins/
   *  ReadPluginFile/WritePluginFile/DeletePluginFile Go bindings —
   *  see pluginsDir() in internal/wailsapp/app.go), the original
   *  location, still used for 'market install.
   *  "user" → created-plugins/ (or the active workspace's own
   *  plugins/ — see workspaceManager.pluginsDir()), via the generic
   *  file bridge. Used for plugins made with the Plugin Creator
   *  ('plugin new), so a user's own plugins land somewhere separate
   *  from ones installed from the marketplace. Undefined for
   *  premium plugins (never written to disk at all) and builtins. */
  origin?: "user" | "market";
  /** Parsed from a `--[[@manifest ... ]]` block in the plugin's Lua
   *  source — see manifest.ts. Undefined for a "legacy" plugin (no
   *  manifest block at all, including every built-in) — see
   *  checkCompatibility() and permissions.ts's declaredPermissions for
   *  where legacy vs. manifest'd plugins are actually treated
   *  differently. */
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

/** The one place a plugin-related failure becomes text a user reads —
 *  used for Lua exec errors (load(), oxis.command()/oxis.task()
 *  invocations in pluginAPI.ts) AND compatibility/dependency/
 *  permission failures here, so every failure mode looks like the
 *  same kind of thing instead of some being a formatted block and
 *  others a raw exception message or stack trace. */
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
    // User-created plugins are workspace-scoped (see pluginsDir() —
    // "created-plugins/" with no workspace active, or the active
    // named workspace's own "plugins/" folder) — but until this,
    // nothing ever re-scanned that folder after startup. Switching
    // workspaces left the PREVIOUS workspace's user plugins still
    // registered/enabled (stale — their files might not even exist
    // under the new workspace) and never loaded the NEW workspace's
    // own. Re-sync on every workspace_loaded/unloaded: clear out
    // whatever "user"-origin plugins are currently registered, then
    // re-scan whichever plugins/ directory is active now. Market-
    // installed plugins are untouched — those were never workspace-
    // scoped to begin with.
    events.on("workspace_loaded",   () => this.resyncUserPlugins());
    events.on("workspace_unloaded", () => this.resyncUserPlugins());
  }

  // Guards against overlapping calls — a workspace auto-detected right
  // at startup could fire "workspace_loaded" around the same moment
  // loader.ts makes its own initial loadUserPlugins() call; without
  // this, both could interleave (unload-while-loading) since JS only
  // yields at await points, not mid-statement, but there's no reason
  // to rely on that being harmless when a simple guard avoids it.
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
        // Manifest fields fill in gaps rather than overriding anything
        // the caller (addLuaPlugin/loadUserPlugins) already set —
        // e.g. 'market install already knows the real category from
        // the Market index, which should win over a stale one someone
        // hand-wrote into their own manifest.
        if (manifest.version && !meta.version) meta.version = manifest.version;
        if (manifest.author && !meta.author) meta.author = manifest.author;
        if (manifest.description) meta.desc = manifest.description;
        if (manifest.category) meta.category = manifest.category;
      }
    }
    setDeclaredPermissions(meta.name, meta.manifest ? (meta.manifest.permissions ?? []) : undefined);
    this.plugins.set(meta.name, meta);
  }

  /** OS / min-OXIS-version / dependency checks — run BEFORE a manifest'd
   *  plugin's Lua ever executes. A legacy plugin (no manifest) skips
   *  all of this entirely, same as before manifests existed: there's
   *  nothing declared to check compatibility against, and it already
   *  worked, so it keeps working. Dependency resolution enables an
   *  already-installed-but-disabled dependency automatically (with
   *  cycle detection via `chain`); a genuinely MISSING dependency is
   *  reported, not auto-installed from the Market — that's a bigger,
   *  separate piece of work (see README § Plugin System's roadmap
   *  note) this doesn't attempt to fake. */
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
        // Checked BEFORE looking at whether depName is enabled —
        // enabled or not, if it's already an ancestor in this
        // resolution chain (including p itself, for a self-dependency),
        // enabling it would mean enabling p a second time to satisfy
        // it, which is exactly what a cycle is. Gating this behind
        // "only recurse if disabled" (as an earlier version of this
        // code did) missed real cycles whenever the ancestor happened
        // to already be marked enabled — which, since the caller in
        // load()/enable() sets `enabled = true` on p optimistically
        // BEFORE calling this, is true almost every time p is its own
        // indirect dependency.
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
  load(name: string): boolean {
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
      // isTrusted: built-in plugins are shipped BY OXIS itself, same
      // trust level as OXIS's own core TypeScript — they skip the
      // oxis.run()/oxis.task() shell-permission prompt (see
      // requireShellPermission in permissions.ts). Every market/user
      // plugin (p.builtin === false) goes through the real prompt.
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

  /** Every OTHER installed plugin whose manifest depends on `name`. */
  dependentsOf(name: string): string[] {
    return [...this.plugins.values()]
      .filter(p => p.name !== name && p.manifest?.dependencies && Object.keys(p.manifest.dependencies).includes(name))
      .map(p => p.name);
  }

  /** Remove a plugin entirely: unload it, drop its metadata, and (for
   *  user/market plugins) delete its real file from disk. Refuses if
   *  another installed plugin depends on it — pass `force` to remove
   *  anyway (the caller is responsible for warning the user first;
   *  see 'plugin uninstall's handler in App.tsx). */
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
    this.unload(name);
    this.plugins.delete(name);
    this.persist();
    if (!p.builtin && isNativeApp()) {
      try {
        if (p.origin === "user") await deletePath(`${workspaceManager.pluginsDir()}/${name}.lua`);
        else await deletePluginFile(name);
      } catch { /* already gone, or browser mode */ }
    }
    return {
      ok: true,
      message: dependents.length > 0
        ? `removed ${name} (⚠ was a dependency of: ${dependents.join(", ")} — they may no longer work)`
        : `removed ${name}`,
    };
  }

  /** 'plugin validate <name> — checks the manifest, permissions,
   *  dependencies, version, and OS/OXIS-version compatibility, plus a
   *  full Lua syntax check — all WITHOUT executing a single
   *  instruction of the plugin's Lua (see checkLuaSyntax). That catches
   *  every syntax error (Lua compiles the whole chunk upfront, so this
   *  isn't limited to "whichever branch happens to run"), but not
   *  runtime/logic errors that only surface when specific code
   *  actually executes (e.g. a nil dereference inside a rarely-called
   *  command handler) — 'plugin test actually loads the plugin for
   *  that; this is the fast, safe, "is this installable at all" check. */
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
      // checkLuaSyntax only compiles the chunk — it never executes it
      // (unlike loadLuaPlugin, a real run), so this is safe to call on
      // a plugin that's currently loaded/enabled: it can't duplicate
      // its registered commands or re-trigger side effects a real
      // load would (a top-level oxis.run(), etc.).
      const syntaxCheck = checkLuaSyntax(p.lua);
      if (!syntaxCheck.ok) issues.push(`Lua syntax error: ${syntaxCheck.error}`);
    }

    return { ok: issues.length === 0, issues };
  }

  /** 'plugin doctor — validate() run across EVERY installed (non-
   *  builtin) plugin at once, plus a couple of checks validate()
   *  doesn't do because they only matter in aggregate or against real
   *  disk state: a missing file (deleted outside OXIS after being
   *  registered) and whether a plugin marked enabled actually has any
   *  commands registered right now (a real, currently-broken plugin,
   *  vs. one that's merely disabled and fine). Severity is genuinely
   *  distinguished, not just a flat issue list: an enabled plugin with
   *  problems is an ERROR (it's actively not working); a disabled
   *  plugin with the same problems is a WARNING (dormant, not
   *  currently hurting anything); a legacy plugin's "no manifest" note
   *  is INFO (not a problem at all, just informational). */
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

  /** 'plugin test <name> — actually loads the plugin (a real
   *  execution, unlike validate()) and reports what got registered,
   *  then restores whatever enabled/disabled state it had before —
   *  so running a test on a currently-disabled plugin doesn't leave it
   *  enabled afterward. This is a real load through the exact same
   *  path 'plugin enable uses, not a separate sandboxed copy (OXIS
   *  doesn't have a second, isolated Lua environment to run a
   *  plugin-under-test in without affecting the live one) — treat it
   *  as "does this actually load cleanly right now", not as proof
   *  nothing it registers could ever misbehave once actually used. */
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

  /** Register + persist + load a new Lua plugin in one call — used by
   *  both 'plugin new (PluginCreator) and 'market install. Writes the
   *  real .lua file to disk (native window only; returns false there
   *  instead of throwing in browser mode, where there's no filesystem
   *  access to write to at all) — but only once load() actually
   *  succeeds. A plugin that fails to load (a real syntax error, or —
   *  what was actually happening here before the Cloudflare Pages
   *  root-directory fix — a "market install" that silently downloaded
   *  the wrong HTML page instead of real Lua source, since a
   *  misconfigured Market deployment serves *something* at every
   *  path, just not the plugin) used to get written to disk anyway.
   *  That's what made a single bad install self-perpetuating: every
   *  future launch would load that same broken file from disk again,
   *  fail again, and print the same error again — with no obvious way
   *  to tell "this plugin is broken" from "this plugin never actually
   *  installed". Skipping the write on failure means a failed install
   *  leaves nothing behind to retry against; running the same
   *  install/'plugin new again is a clean retry, not a repeat of
   *  whatever went wrong the first time. */
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
    // Actually apply the new code, not just remember/persist it — this
    // is what makes saving a plugin file in the Editor equivalent to
    // the old Plugin Creator's dedicated "save & load" button, now
    // that plugins are edited in the exact same Editor as any other
    // file (see openEditor's plugin-aware save path in App.tsx).
    if (p?.enabled) this.reload(name);
    return result;
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
      if (p?.enabled) this.load(name);
    }
  }
}

export const pluginManager = new PluginManager();