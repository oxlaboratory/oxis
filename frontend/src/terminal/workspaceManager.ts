/**
 * workspaceManager.ts — workspace lifecycle.
 *
 * A workspace is a `.oxis/workspace.lua` run through the normal plugin
 * Lua VM and oxis.* bindings under the pseudo-plugin name
 * "__workspace__", so closing it can unregister everything it added.
 * Named workspaces, linked projects, tasks/workflows folders, auto-reload
 * and layout migration are built on the same load().
 *
 * Needs the native app; in a browser every method fails with a message.
 */

import { readFile, writeFile, statPath, listDir, makeDir, deletePath, isNativeApp } from "../native";
import { loadLuaPlugin, type LoadedLuaPlugin } from "../plugins/luaRuntime";
import { buildLuaAPI, type APIContext } from "../plugins/pluginAPI";
import { workflowRunner } from "../plugins/workflowRunner";
import { OXIS_VERSION } from "../plugins/manifest";
import { registry } from "./commandRegistry";
import { events } from "./events";
import { detectProject, writeDetectedTasks } from "./projectDetector";
import { reconcileDetectedTasks } from "./taskReconciler";

const WORKSPACE_PLUGIN_NAME = "__workspace__";

// The named workspace to reopen on the next launch.
const ACTIVE_WORKSPACE_KEY = "oxis-active-workspace";
function rememberActive(name: string | null): void {
  try {
    if (name) localStorage.setItem(ACTIVE_WORKSPACE_KEY, name);
    else localStorage.removeItem(ACTIVE_WORKSPACE_KEY);
  } catch { /* storage unavailable: just not remembered */ }
}
const WORKSPACE_REL_PATH = ".oxis/workspace.lua";
const NAMED_SUBDIRS = ["documents", "plugins", "scripts", "tasks", "workflows", ".oxis"] as const;
const REGISTRY_PATH = "workspaces/registry.json";

// Bumped when the expected workspace folder layout changes (e.g. a new
// NAMED_SUBDIRS entry); see migrateWorkspaces().
const CURRENT_WORKSPACE_SCHEMA = 1;
const LAST_SEEN_VERSION_KEY = "oxis-last-seen-version";
const AUTO_RELOAD_POLL_MS = 3000;

// A workspace name becomes a real folder name under workspaces/, so
// keep it to something safe on every OS's filesystem and that can't
// escape that folder via ".." or a path separator.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const CONNECTOR_FILENAME = ".oxis-connector.json";
const GITIGNORE_RULE = `${CONNECTOR_FILENAME}`;
const GITIGNORE_MARKER = "# OXIS workspace connector — do not commit"; // written just above the rule so it's identifiable/removable on unlink, and so a human reading .gitignore knows why the line is there

/** Adds the connector-file rule to `<dir>/.gitignore` (created if
 *  missing) without touching existing rules or duplicating it. Failures
 *  are logged, not thrown: linking shouldn't fail over a .gitignore. */
async function ensureGitignoreRule(dir: string): Promise<void> {
  const path = `${dir}/.gitignore`;
  let existing = "";
  try { existing = await readFile(path); } catch { /* doesn't exist yet — created fresh below */ }
  const lines = existing.split(/\r?\n/);
  if (lines.some(l => l.trim() === GITIGNORE_RULE)) return; // already present — never duplicate
  const needsLeadingBlank = existing.length > 0 && !existing.endsWith("\n");
  const addition = `${needsLeadingBlank ? "\n" : ""}${existing.length > 0 ? "\n" : ""}${GITIGNORE_MARKER}\n${GITIGNORE_RULE}\n`;
  try { await writeFile(path, existing + addition); }
  catch { /* read-only/inaccessible directory — the link itself still succeeds, just without this protection; 'workspace info can't easily surface this from here, so it's a silent best-effort by design rather than failing the whole link */ }
}

/** Writes the connector marker (workspace name + link time) into the
 *  linked project. registry.json remains the source of truth. */
async function writeConnectorFile(dir: string, workspaceName: string): Promise<void> {
  const path = `${dir}/${CONNECTOR_FILENAME}`;
  const body = JSON.stringify({ oxisWorkspace: workspaceName, linkedAt: new Date().toISOString() }, null, 2);
  try { await writeFile(path, body); } catch { /* best-effort, same reasoning as ensureGitignoreRule */ }
}

async function removeConnectorFile(dir: string): Promise<void> {
  try { await deletePath(`${dir}/${CONNECTOR_FILENAME}`); }
  catch { /* directory may be moved/deleted/inaccessible by now — nothing to clean up, and the internal unlink below still proceeds regardless (see item 7: "handled safely when the connected directory is moved, deleted, or becomes inaccessible") */ }
}


function validateWorkspaceName(name: string): string | null {
  if (!NAME_RE.test(name)) {
    return "workspace names: letters, numbers, - and _ only, up to 64 chars, can't start with - or _";
  }
  return null;
}

/** One entry of workspaces/registry.json. */
export interface NamedWorkspaceEntry {
  name: string;
  createdAt: string;
  /** An existing project directory elsewhere on disk this workspace
   *  is linked to — see linkExternal(). Absolute path, set by the
   *  user, never written to by anything here. */
  externalPath?: string;
  /** Layout version this workspace was last migrated to (absent on
   *  old entries, which are checked). */
  schemaVersion?: number;
}

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

-- Starts with NO tasks at all — a fresh workspace shouldn't assume
-- anything about what this project needs. Add your own for what THIS
-- project actually does, e.g.:
-- oxis.task("dev",   "npm run dev",   "Start the dev server")
-- oxis.task("build", "npm run build", "Production build")
-- oxis.task("test",  "npm test",      "Run the test suite")
--
-- The one exception: 'workspace github/gitlab automatically adds a
-- "commit" task (a real commit dialog — see README § Git Integration)
-- the moment you actually connect a remote — never before that, and
-- never here in this template, since a workspace with no git
-- connection yet has nothing for a commit task to do.

-- oxis.plugin.enable("git")          -- auto-enable a plugin for this workspace

-- oxis.command("hello", function()
--   oxis.echo("hello from " .. "${projectName}")
-- end, "Say hello — remove me, I'm just an example")
`;

// project.lua: for project-level settings that don't belong in
// workspace.lua. 'project open loads it alongside workspace.lua.
const PROJECT_TEMPLATE = `-- OXIS project config — loaded by 'project open, alongside .oxis/workspace.lua
-- (which still owns tasks/theme/commands — see that file). This is
-- for project-level metadata/setup that isn't really about the
-- workspace itself. Most projects can leave this empty.

-- oxis.echo("project loaded")
`;

class WorkspaceManager {
  private apiCtx: APIContext | null = null;
  private disposer: LoadedLuaPlugin | null = null;
  private activeDir: string | null = null;
  // The active named workspace, if any. activeDir may instead be an
  // ad-hoc folder with its own .oxis/workspace.lua.
  private activeNamed: string | null = null;

  // ── Auto-reload: polls statPath/listDir every AUTO_RELOAD_POLL_MS
  // and compares a signature (there's no native file watcher). ──
  private autoReloadTimer: ReturnType<typeof setInterval> | null = null;
  private lastSignature: string | null = null;

  /** Must be called once at startup, same as pluginManager.init(). */
  init(ctx: APIContext): void {
    this.apiCtx = ctx;
  }

  /** Reopens the named workspace that was active when OXIS last closed.
   *  A workspace that no longer exists is forgotten. */
  async restoreLastActive(): Promise<void> {
    if (!isNativeApp()) return;
    let name: string | null = null;
    try { name = localStorage.getItem(ACTIVE_WORKSPACE_KEY); } catch { return; }
    if (!name || this.activeNamed) return;
    const result = await this.switchNamed(name);
    if (!result.ok) rememberActive(null);
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

  /** Detects and loads a workspace in `dir`; used at startup and after
   *  cwd changes. Does nothing while a named workspace is active, so a
   *  `cd` can't switch you out of it. */
  async detectAndLoad(dir: string): Promise<WorkspaceOpResult | null> {
    if (this.activeNamed) return null;
    const found = await this.detect(dir);
    if (!found) return null;
    if (this.activeDir === dir) return null; // already loaded
    return this.load(dir, null);
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
    const loaded = await this.load(dir, null); // ad-hoc directory — never a named workspace
    return { ok: loaded.ok, message: `created ${path}${loaded.ok ? " and loaded it" : ` (${loaded.message})`}` };
  }

  /** `'project init [dir]`: a full .oxis/ setup (workspace.lua,
   *  project.lua, tasks/, workflows/, scripts/, plugins/, documents/) in
   *  an existing folder. Never overwrites an existing workspace.lua. */
  async initProject(dir: string): Promise<WorkspaceOpResult> {
    const unavailable = this.unavailable();
    if (unavailable) return unavailable;
    const created: string[] = [];
    for (const sub of ["tasks", "workflows", "scripts", "plugins", "documents"]) {
      const subPath = joinPath(dir, `.oxis/${sub}`);
      const already = await statPath(subPath).catch(() => ({ exists: false, isDir: false, size: 0, modTime: 0 }));
      if (!already.exists) { await makeDir(subPath); created.push(`.oxis/${sub}/`); }
    }
    const projectLuaPath = joinPath(dir, ".oxis/project.lua");
    const projectLuaExists = await statPath(projectLuaPath).catch(() => ({ exists: false, isDir: false, size: 0, modTime: 0 }));
    if (!projectLuaExists.exists) {
      await writeFile(projectLuaPath, PROJECT_TEMPLATE);
      created.push(".oxis/project.lua");
    }
    const wsResult = await this.initWorkspace(dir);
    // An existing workspace.lua is fine here; only a real write
    // failure is an error.
    const workspaceAlreadyExisted = !wsResult.ok && wsResult.message.includes("already exists at");
    if (!wsResult.ok && !workspaceAlreadyExisted) return wsResult;
    if (workspaceAlreadyExisted) await this.load(dir, null); // still load it, same as a fresh init would — ad-hoc, never named
    return {
      ok: true,
      message: created.length > 0
        ? `project set up in ${dir} — created ${created.join(", ")}${workspaceAlreadyExisted ? " (workspace.lua already existed — left as-is)" : ""}`
        : `${dir} already has a full .oxis/ project setup — nothing new to create`,
    };
  }

  /** `'workspace info` — human-readable dump of the active workspace. */
  info(): WorkspaceOpResult {
    if (!this.activeDir) return { ok: false, message: "no workspace loaded — try 'workspace init \"name\" or open a directory that has one" };
    const registeredTasks = registry.all().filter(c => c.category === "task" && c.fromPlugin === WORKSPACE_PLUGIN_NAME).map(t => t.name.replace(/^task:/, ""));
    // "commit" always shown first — see taskNames()'s own doc comment
    // in workspaceState.ts for why it isn't a real registry entry
    // here the way the rest of these are, and why it's still shown.
    const taskNames = ["commit", ...registeredTasks.filter(n => n !== "commit")];
    const lines = [
      this.activeNamed ? `workspace: "${this.activeNamed}"  (workspaces/${this.activeNamed}/)` : `workspace: ${this.activeDir}`,
      `tasks: ${taskNames.join(", ")}`,
    ];
    return { ok: true, message: lines.join("\n") };
  }

  /** `'workspace reload` — close, then re-run workspace.lua from disk. */
  async reload(dir?: string): Promise<WorkspaceOpResult> {
    const target = dir ?? this.activeDir;
    if (!target) return { ok: false, message: "no workspace loaded to reload — pass a directory, or 'workspace init one" };
    // Preserve whatever named workspace (if any) is currently active —
    // a reload re-runs the SAME workspace, named or not, it never
    // changes which one that is. Captured before load() runs, since
    // load() is what actually sets/clears activeNamed now.
    const currentNamed = this.activeNamed;
    return this.load(target, currentNamed);
  }

  /** `'workspace close` — unload, undoing everything workspace.lua registered. */
  close(): WorkspaceOpResult {
    if (!this.disposer) return { ok: false, message: "no workspace is currently loaded" };
    this.stopAutoReload();
    registry.unregisterByPlugin(WORKSPACE_PLUGIN_NAME);
    try { this.disposer.dispose(); } catch { /* VM already gone */ }
    this.disposer = null;
    this.activeDir = null;
    this.activeNamed = null;
    workflowRunner.clear(); // workflows are workspace-scoped — see loadWorkflows() below
    events.emit("workspace_unloaded", {});
    return { ok: true, message: "workspace closed" };
  }

  /** A cheap change signature: workspace.lua's mtime plus name+mtime of
   *  each file in tasks/ and workflows/. null if anything can't be read
   *  (the poller then skips that tick). */
  private async computeSignature(dir: string): Promise<string | null> {
    try {
      const parts: string[] = [];
      const workspaceLuaStat = await statPath(`${dir}/${WORKSPACE_REL_PATH}`).catch(() => null);
      parts.push(workspaceLuaStat ? String(workspaceLuaStat.modTime) : "missing");
      for (const sub of ["tasks", "workflows"] as const) {
        const entries = await listDir(`${dir}/${sub}`).catch(() => [] as { name: string; modTime?: number }[]);
        parts.push(`${sub}:` + entries.map(e => `${e.name}@${e.modTime ?? 0}`).sort().join(","));
      }
      return parts.join("|");
    } catch {
      return null;
    }
  }

  /** Starts polling the signature and reloads when it changes. load()
   *  restarts it; close() stops it. Tick errors are logged and skipped. */
  private startAutoReload(dir: string, namedWorkspace: string | null): void {
    this.stopAutoReload();
    // Seed the baseline from the load that just happened, rather than
    // null — otherwise the very first tick would always see a
    // "change" (null -> real signature) and trigger an immediate,
    // pointless reload of the workspace that was just freshly loaded.
    void this.computeSignature(dir).then(sig => { this.lastSignature = sig; });
    this.autoReloadTimer = setInterval(async () => {
      try {
        const sig = await this.computeSignature(dir);
        if (sig === null) return; // couldn't read — skip this tick, don't treat as a change
        if (this.lastSignature !== null && sig !== this.lastSignature && this.activeDir === dir) {
          this.lastSignature = sig;
          const result = await this.load(dir, namedWorkspace);
          events.emit(result.ok ? "workspace_auto_reloaded" : "workspace_auto_reload_failed", { path: dir, message: result.message });
        } else {
          this.lastSignature = sig;
        }
      } catch (e) {
        // Never let one bad tick kill the interval — surfacing this
        // as a real error every 3s would be far worse than silently
        // skipping until the next tick.
        console.warn("[oxis:workspace] auto-reload poll failed:", e);
      }
    }, AUTO_RELOAD_POLL_MS);
  }

  private stopAutoReload(): void {
    if (this.autoReloadTimer !== null) { clearInterval(this.autoReloadTimer); this.autoReloadTimer = null; }
    this.lastSignature = null;
  }

  /** Core load path for init/reload/detectAndLoad/switchNamed.
   *  `namedWorkspace` is the only place activeNamed is set, so it can't
   *  disagree with what's actually loaded. */
  async load(dir: string, namedWorkspace: string | null = null): Promise<WorkspaceOpResult> {
    const unavailable = this.unavailable();
    if (unavailable) return unavailable;
    const path = joinPath(dir, WORKSPACE_REL_PATH);
    let source: string;
    try {
      source = await readFile(path);
    } catch {
      return { ok: false, message: `no workspace found at ${path} — try 'workspace init` };
    }

    // Unload the previous run's commands, tasks and workflows so nothing
    // leaks into this one.
    if (this.disposer) {
      registry.unregisterByPlugin(WORKSPACE_PLUGIN_NAME);
      try { this.disposer.dispose(); } catch { /* ignore */ }
      this.disposer = null;
    }
    workflowRunner.clear();

    events.emit("workspace_loading", { path: dir });
    // isTrusted: workspace.lua is the user's OWN local config file,
    // not third-party plugin code — same reasoning as built-in
    // plugins (see pluginManager.ts's load()) for why this skips the
    // oxis.run()/oxis.task() shell-permission prompt.
    const bindings = buildLuaAPI({ ...this.apiCtx!, pluginName: WORKSPACE_PLUGIN_NAME, isTrusted: true });
    const result = loadLuaPlugin(source, bindings);
    if (!result.ok) {
      this.activeDir = null;
      this.activeNamed = null;
      events.emit("workspace_unloaded", {});
      return { ok: false, message: `${path} failed to load: ${result.error}` };
    }
    this.disposer = result.plugin;
    this.activeDir = dir;
    this.activeNamed = namedWorkspace;
    await this.loadTasks(dir);
    await this.loadWorkflows(dir);
    // Authoritative "workspace_loaded" with the real absolute
    // directory — separate from whatever oxis.workspace(path) inside
    // the .lua file itself passed (usually just "."), which
    // workspaceState.ts explicitly does NOT use for display.
    events.emit("workspace_loaded", { path: dir });
    // Restart auto-reload so the signature baseline matches what was
    // just loaded.
    this.startAutoReload(dir, namedWorkspace);
    void this.runTaskReconciliationInBackground(dir, namedWorkspace);
    return { ok: true, message: `workspace loaded from ${path}` };
  }

  /** Task integrity check for a linked project, run in the background
   *  so it never delays loading. If it changed the generated tasks the
   *  workspace is reloaded once; a second pass then finds nothing to do. */
  private async runTaskReconciliationInBackground(dir: string, namedWorkspace: string | null): Promise<void> {
    if (!namedWorkspace) return; // ad-hoc (unnamed) workspaces have no registry entry to read an externalPath from
    try {
      const entries = await this.readRegistry();
      const entry = entries.find(e => e.name === namedWorkspace);
      if (!entry?.externalPath) return; // never linked to a project — nothing to reconcile against
      const result = await reconcileDetectedTasks(entry.externalPath, `${dir}/.oxis/tasks`);
      if (!result.ran) return;
      const changed = result.added.length + result.updated.length + result.removed.length;
      if (changed === 0) return;
      this.apiCtx?.print(
        `  ⟳  workspace tasks updated: ${[
          result.added.length ? `+${result.added.join(", ")}` : "",
          result.updated.length ? `~${result.updated.join(", ")}` : "",
          result.removed.length ? `-${result.removed.join(", ")}` : "",
        ].filter(Boolean).join("  ")}`,
        "dim",
      );
      // Only reload if this is STILL the active workspace — reconciliation
      // is async and the user may have switched away by the time it finishes.
      if (this.activeNamed === namedWorkspace) {
        await this.load(dir, namedWorkspace);
      }
    } catch {
      /* best-effort — a reconciliation failure should never disrupt
       * an already-successfully-loaded workspace */
    }
  }

  /** Loads workflows/*.lua (or .oxis/workflows/*.lua for a project):
   *  each file calls oxis.workflow(...) and its VM is then disposed.
   *  A broken file is reported and skipped. */
  private async loadWorkflows(dir: string): Promise<void> {
    await this.loadWorkflowsFrom(`${dir}/workflows`);
    await this.loadWorkflowsFrom(`${dir}/.oxis/workflows`);
  }

  /** Same for tasks/*.lua: each file calls oxis.task(...). */
  private async loadTasks(dir: string): Promise<void> {
    await this.loadTasksFrom(`${dir}/tasks`);
    await this.loadTasksFrom(`${dir}/.oxis/tasks`);
  }

  private async loadTasksFrom(tasksDir: string): Promise<void> {
    let entries;
    try { entries = await listDir(tasksDir); }
    catch { return; }
    const files = entries.filter(e => !e.isDir && e.name.endsWith(".lua"));
    for (const file of files) {
      let source: string;
      try { source = await readFile(`${tasksDir}/${file.name}`); }
      catch { continue; }
      const pluginName = WORKSPACE_PLUGIN_NAME; // tasks defined this way ARE workspace tasks — 'workspace close/reload should undo them same as workspace.lua's own oxis.task() calls
      const bindings = buildLuaAPI({ ...this.apiCtx!, pluginName, isTrusted: true }); // the user's own local tasks/ folder, not third-party code — see workspace.lua's own load() above
      const result = loadLuaPlugin(source, bindings);
      if (!result.ok) {
        this.apiCtx?.print(`  ✗  ${tasksDir}/${file.name} failed to load: ${result.error}`, "err");
        continue;
      }
      try { result.plugin.dispose(); } catch { /* ignore — registered commands/tasks stay in the registry, only the Lua VM itself is disposable here */ }
    }
  }

  private async loadWorkflowsFrom(workflowsDir: string): Promise<void> {
    let entries;
    try { entries = await listDir(workflowsDir); }
    catch { return; } // folder doesn't exist (or is empty) — nothing to load
    const files = entries.filter(e => !e.isDir && e.name.endsWith(".lua"));
    for (const file of files) {
      let source: string;
      try { source = await readFile(`${workflowsDir}/${file.name}`); }
      catch { continue; }
      const pluginName = `__workflow_file__:${file.name}`;
      const bindings = buildLuaAPI({ ...this.apiCtx!, pluginName, isTrusted: true }); // the user's own local workflows/ folder, not third-party code
      const result = loadLuaPlugin(source, bindings);
      if (!result.ok) {
        this.apiCtx?.print(`  ✗  ${workflowsDir}/${file.name} failed to load: ${result.error}`, "err");
        continue;
      }
      // Only oxis.workflow() calls matter here — if the file also
      // called oxis.command()/oxis.task() (unusual, but not
      // forbidden), unregister those too so this stays purely additive
      // to workflowRunner rather than leaving stray commands behind.
      registry.unregisterByPlugin(pluginName);
      try { result.plugin.dispose(); } catch { /* ignore */ }
    }
  }

  getActiveDir(): string | null {
    return this.activeDir;
  }

  // ══════════════════════════════════════════════════════════════
  // Named workspaces — 'workspace init "name" / list / switch / rename /
  // delete / link / unlink.
  //
  // Each is a folder, workspaces/<name>/, with documents/, plugins/,
  // scripts/, tasks/, workflows/ and .oxis/workspace.lua; switching just
  // calls load() on it. workspaces/registry.json lists them with their
  // linked folder.
  // ══════════════════════════════════════════════════════════════

  private async readRegistry(): Promise<NamedWorkspaceEntry[]> {
    try {
      const raw = await readFile(REGISTRY_PATH);
      return JSON.parse(raw) as NamedWorkspaceEntry[];
    } catch { return []; }
  }

  private async writeRegistry(entries: NamedWorkspaceEntry[]): Promise<void> {
    await writeFile(REGISTRY_PATH, JSON.stringify(entries, null, 2));
  }

  private async copyTree(src: string, dst: string): Promise<void> {
    let entries;
    try { entries = await listDir(src); } catch { return; }
    for (const e of entries) {
      const s = `${src}/${e.name}`, d = `${dst}/${e.name}`;
      if (e.isDir) { await makeDir(d); await this.copyTree(s, d); }
      else { try { await writeFile(d, await readFile(s)); } catch { /* skip unreadable/binary file */ } }
    }
  }

  /** `'workspace init "name"` — create a new named workspace and its
   *  folders. Does NOT switch to it (mirrors 'plugin new not
   *  auto-enabling silently) — 'workspace switch <name> right after. */
  async createNamed(name: string): Promise<WorkspaceOpResult> {
    const unavailable = this.unavailable();
    if (unavailable) return unavailable;
    const nameErr = validateWorkspaceName(name);
    if (nameErr) return { ok: false, message: nameErr };
    const entries = await this.readRegistry();
    if (entries.some(e => e.name === name)) {
      return { ok: false, message: `workspace "${name}" already exists — 'workspace switch ${name} to use it` };
    }
    const dir = `workspaces/${name}`;
    try {
      for (const sub of NAMED_SUBDIRS) await makeDir(`${dir}/${sub}`);
      await writeFile(joinPath(dir, WORKSPACE_REL_PATH), DEFAULT_TEMPLATE(name));
    } catch (e) {
      return { ok: false, message: `couldn't create ${dir}: ${e}` };
    }
    entries.push({ name, createdAt: new Date().toISOString(), schemaVersion: CURRENT_WORKSPACE_SCHEMA });
    await this.writeRegistry(entries);
    return { ok: true, message: `workspace "${name}" created (${dir}/) — 'workspace switch ${name} to activate it` };
  }

  /** Runs migrateWorkspaces() once after OXIS itself was updated
   *  (the last-seen version is kept in localStorage). */
  async runAutoUpdateIfNeeded(): Promise<void> {
    if (!isNativeApp()) return;
    let lastSeen: string | null = null;
    try { lastSeen = localStorage.getItem(LAST_SEEN_VERSION_KEY); } catch { /* storage unavailable — just run the migration; it's idempotent */ }
    if (lastSeen === OXIS_VERSION) return;
    const result = await this.migrateWorkspaces();
    if (result.migrated.length > 0) {
      this.apiCtx?.print(`  ⚙  updated ${result.migrated.length} workspace(s) for OXIS ${OXIS_VERSION}: ${result.migrated.join(", ")}`, "dim");
    }
    try { localStorage.setItem(LAST_SEEN_VERSION_KEY, OXIS_VERSION); } catch { /* not fatal — just means this runs again next launch too */ }
  }

  /** Creates any folders a named workspace is missing for the current
   *  layout. Additive only: never changes or deletes existing files. */
  async migrateWorkspaces(): Promise<{ migrated: string[] }> {
    if (!isNativeApp()) return { migrated: [] };
    const entries = await this.readRegistry();
    const migrated: string[] = [];
    let changed = false;
    for (const entry of entries) {
      if ((entry.schemaVersion ?? 0) >= CURRENT_WORKSPACE_SCHEMA) continue;
      const dir = `workspaces/${entry.name}`;
      let addedAnything = false;
      for (const sub of NAMED_SUBDIRS) {
        const subPath = `${dir}/${sub}`;
        const already = await statPath(subPath).catch(() => ({ exists: false, isDir: false, size: 0, modTime: 0 }));
        if (!already.exists) {
          try { await makeDir(subPath); addedAnything = true; } catch { /* best-effort — a failure here shouldn't block the rest of the migration or the app starting up */ }
        }
      }
      entry.schemaVersion = CURRENT_WORKSPACE_SCHEMA;
      changed = true;
      if (addedAnything) migrated.push(entry.name);
    }
    if (changed) await this.writeRegistry(entries);
    return { migrated };
  }

  /** `'workspace list` */
  async listNamed(): Promise<NamedWorkspaceEntry[]> {
    if (!isNativeApp()) return [];
    const entries = await this.readRegistry();
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** `'workspace switch <name>` (or "default"/omitted to close back to
   *  no active workspace). */
  async switchNamed(name: string | null): Promise<WorkspaceOpResult> {
    if (name === null || name.toLowerCase() === "default") {
      rememberActive(null);
      return this.disposer ? this.close() : { ok: true, message: "no workspace was active" };
    }
    const entries = await this.readRegistry();
    if (!entries.some(e => e.name === name)) {
      return { ok: false, message: `no workspace named "${name}" — see 'workspace list` };
    }
    const result = await this.load(`workspaces/${name}`, name);
    if (!result.ok) return result;
    rememberActive(name);
    return { ok: true, message: `switched to workspace "${name}"` };
  }

  /** `'workspace rename <old> <new>` */
  async renameNamed(oldName: string, newName: string): Promise<WorkspaceOpResult> {
    const nameErr = validateWorkspaceName(newName);
    if (nameErr) return { ok: false, message: nameErr };
    const entries = await this.readRegistry();
    const entry = entries.find(e => e.name === oldName);
    if (!entry) return { ok: false, message: `no workspace named "${oldName}"` };
    if (entries.some(e => e.name === newName)) return { ok: false, message: `workspace "${newName}" already exists` };

    const wasActive = this.activeNamed === oldName;
    if (wasActive) this.close(); // don't rename folders out from under a loaded Lua VM

    const oldDir = `workspaces/${oldName}`, newDir = `workspaces/${newName}`;
    for (const sub of NAMED_SUBDIRS) {
      await makeDir(`${newDir}/${sub}`);
      await this.copyTree(`${oldDir}/${sub}`, `${newDir}/${sub}`);
    }
    await deletePath(oldDir);
    entry.name = newName;
    await this.writeRegistry(entries);
    if (wasActive) return this.switchNamed(newName);
    return { ok: true, message: `renamed workspace "${oldName}" → "${newName}"` };
  }

  /** `'workspace delete <name>` */
  async removeNamed(name: string): Promise<WorkspaceOpResult> {
    try { if (localStorage.getItem(ACTIVE_WORKSPACE_KEY) === name) rememberActive(null); } catch { /* storage unavailable */ }
    const entries = await this.readRegistry();
    const idx = entries.findIndex(e => e.name === name);
    if (idx === -1) return { ok: false, message: `no workspace named "${name}"` };
    if (this.activeNamed === name) this.close();
    await deletePath(`workspaces/${name}`);
    entries.splice(idx, 1);
    await this.writeRegistry(entries);
    return { ok: true, message: `deleted workspace "${name}"` };
  }

  /** `'workspace link "<path>"`: connect the active named workspace to a
   *  project folder. Records it in the registry, writes the connector
   *  file (gitignored), and generates tasks from the project. */
  async linkExternal(path: string): Promise<WorkspaceOpResult> {
    if (!this.activeNamed) {
      return { ok: false, message: "no workspace active — 'workspace switch <name> first (or 'workspace init \"name\" then switch)" };
    }
    const stat = await statPath(path).catch(() => ({ exists: false, isDir: false, size: 0, modTime: 0 }));
    if (!stat.exists) return { ok: false, message: `no such directory: ${path}` };
    if (!stat.isDir) return { ok: false, message: `${path} is a file, not a directory` };
    const entries = await this.readRegistry();
    const entry = entries.find(e => e.name === this.activeNamed);
    if (!entry) return { ok: false, message: `active workspace "${this.activeNamed}" is missing its registry entry` };
    entry.externalPath = path;
    await this.writeRegistry(entries);
    await writeConnectorFile(path, this.activeNamed);
    await ensureGitignoreRule(path);
    events.emit("workspace_linked", { path });

    // Detect the project type and write .oxis/tasks/auto-detected.lua.
    // A detection failure is reported but doesn't undo the link.
    let detectionNote = "";
    try {
      const result = await detectProject(path);
      if (result.tasks.length > 0) {
        const dir = this.activeNamed ? `workspaces/${this.activeNamed}` : null;
        if (dir) {
          await writeDetectedTasks(`${dir}/.oxis/tasks`, result);
          await this.loadTasks(dir); // load the newly-written tasks immediately, not just on the next full workspace reload
          detectionNote = ` — detected ${result.projectTypes.join(", ")}, generated ${result.tasks.length} task${result.tasks.length === 1 ? "" : "s"} (${result.tasks.map(t => t.name).join(", ")})`;
        }
      } else {
        detectionNote = " — no recognizable project configuration found to generate tasks from";
      }
    } catch (e) {
      detectionNote = ` — project detection failed (${e instanceof Error ? e.message : e}), link itself still succeeded`;
    }

    return { ok: true, message: `workspace "${this.activeNamed}" linked to ${path} (added a .gitignore rule for the connector file, if one wasn't already there)${detectionNote}` };
  }

  /** `'workspace unlink`: clear the link, and remove the connector file
   *  if the folder is still reachable. */
  async unlinkExternal(): Promise<WorkspaceOpResult> {
    if (!this.activeNamed) return { ok: false, message: "no workspace active" };
    const entries = await this.readRegistry();
    const entry = entries.find(e => e.name === this.activeNamed);
    if (!entry) return { ok: false, message: `active workspace "${this.activeNamed}" is missing its registry entry` };
    const oldPath = entry.externalPath;
    delete entry.externalPath;
    await this.writeRegistry(entries);
    if (oldPath) await removeConnectorFile(oldPath);
    events.emit("workspace_unlinked", {});
    return { ok: true, message: `workspace "${this.activeNamed}" unlinked` };
  }

  getActiveNamed(): string | null { return this.activeNamed; }

  /** The active named workspace's connected external directory (see
   *  linkExternal), or null if there's no active named workspace or
   *  it isn't linked to one. Async because the link itself lives in
   *  the on-disk registry, not cached in memory. */
  async getActiveExternalPath(): Promise<string | null> {
    if (!this.activeNamed) return null;
    const entries = await this.readRegistry();
    return entries.find(e => e.name === this.activeNamed)?.externalPath ?? null;
  }

  /** Where 'new should write documents right now. */
  /** Where 'new / 'touch write: always created-documents/, where people
   *  expect to find them (plugins, unlike documents, are per-workspace). */
  documentsDir(): string {
    return "created-documents";
  }

  /** Where Plugin Creator should write user-created plugins right now. */
  pluginsDir(): string {
    return this.activeNamed ? `workspaces/${this.activeNamed}/plugins` : "created-plugins";
  }
}

export const workspaceManager = new WorkspaceManager();