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

import { readFile, writeFile, statPath, listDir, makeDir, deletePath, isNativeApp } from "../native";
import { loadLuaPlugin, type LoadedLuaPlugin } from "../plugins/luaRuntime";
import { buildLuaAPI, type APIContext } from "../plugins/pluginAPI";
import { workflowRunner } from "../plugins/workflowRunner";
import { OXIS_VERSION } from "../plugins/manifest";
import { registry } from "./commandRegistry";
import { events } from "./events";

const WORKSPACE_PLUGIN_NAME = "__workspace__";
const WORKSPACE_REL_PATH = ".oxis/workspace.lua";
const NAMED_SUBDIRS = ["documents", "plugins", "scripts", "tasks", "workflows", ".oxis"] as const;
const REGISTRY_PATH = "workspaces/registry.json";

// Bumped whenever a new OXIS version changes what a workspace's own
// folder is expected to contain (a new entry added to NAMED_SUBDIRS,
// for instance — tasks/ and workflows/ didn't always exist). See
// migrateWorkspaces() below — this is the "auto-updater for
// workspaces" that runs once whenever OXIS itself has been updated
// since the last launch, bringing every EXISTING workspace's on-disk
// layout in line with what the running version expects, without
// touching anything the user actually created or customized.
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

/** Writes (creating if absent) `<dir>/.gitignore` with the one rule
 *  needed to keep the OXIS connector file (below) out of the user's
 *  actual repository — see item 8: never overwrites or reorders
 *  anything already in the file, never duplicates the rule if it's
 *  already there (checked as a real line match, not just a substring,
 *  so a rule that happens to CONTAIN this text for unrelated reasons
 *  doesn't get treated as already covering this). Best-effort: a
 *  read-only or otherwise inaccessible directory logs and returns
 *  rather than throwing, since failing to link the workspace itself
 *  over a .gitignore write failure would be a worse outcome. */
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

/** Writes the connector file itself — a small, non-sensitive marker
 *  (just the OXIS workspace name and when it was linked) that lives
 *  IN the external project directory, representing "this directory is
 *  linked to this OXIS workspace." The real source of truth for the
 *  link is still workspaces/registry.json (see linkExternal) — this
 *  is a secondary, human-discoverable marker, not sensitive OXIS
 *  internal data, so there's nothing here that would matter if it
 *  leaked; it's gitignored purely so a project's own repo doesn't
 *  carry OXIS-specific clutter that means nothing to anyone else who
 *  clones it. */
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

/** One row of the multi-workspace registry (workspaces/registry.json)
 *  — see the "Named workspaces" section below. Kept separate from the
 *  single-directory .oxis/workspace.lua concept above; a named
 *  workspace just happens to have one of those files inside its own
 *  folder and reuses load()/close() to run it. */
export interface NamedWorkspaceEntry {
  name: string;
  createdAt: string;
  /** An existing project directory elsewhere on disk this workspace
   *  is linked to — see linkExternal(). Absolute path, set by the
   *  user, never written to by anything here. */
  externalPath?: string;
  /** Which OXIS version's workspace layout this entry was last
   *  migrated to — see migrateWorkspaces()/CURRENT_WORKSPACE_SCHEMA
   *  below. Absent on any workspace created before this existed
   *  (treated as needing a migration check, same as any older
   *  version would be). */
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

// A project.lua stub — deliberately does almost nothing on its own.
// workspace.lua already owns tasks/theme/commands/plugins; this
// exists as a place for genuinely PROJECT-level config that isn't
// about the workspace per se (e.g. metadata a workflow step might
// read via oxis.getOption) without overloading workspace.lua's job.
// Loaded by 'project open in addition to workspace.lua, not instead
// of it — see initProject()/openProject() below.
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
  // Which NAMED workspace (see "Named workspaces" below), if any, is
  // currently active — separate from activeDir because activeDir can
  // also be an ad-hoc directory that just happens to have its own
  // .oxis/workspace.lua (the original, still-supported flow), which
  // isn't part of the workspaces/ registry at all.
  private activeNamed: string | null = null;

  // ── Auto-reload polling — see startAutoReload()/stopAutoReload() ──
  // Not a real native file-system watcher (that would need a new Go
  // dependency like fsnotify, new Wails event plumbing, and — same as
  // every other new Go binding this project has added — I have no
  // way to compile or exercise that here to trust it). This is a
  // plain interval poll against the same statPath()/listDir() calls
  // already used and working everywhere else, checked against a
  // remembered signature — real, but push-based it is not: a change
  // can take up to AUTO_RELOAD_POLL_MS to be noticed, not instant.
  private autoReloadTimer: ReturnType<typeof setInterval> | null = null;
  private lastSignature: string | null = null;

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
   *  no-op (not an error) when there's simply no workspace here.
   *
   *  Deliberately does NOT auto-detect while a NAMED workspace is
   *  active — a named workspace is an explicit choice ('workspace
   *  switch), and incidentally `cd`-ing somewhere in the shell that
   *  happens to have its own .oxis/workspace.lua shouldn't silently
   *  yank the user out of it. 'workspace switch default first if you
   *  actually want the ad-hoc, cwd-based flow to take over. */
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

  /** `'project init [dir]` — the project layer (see README § Project
   *  Layer): a project is an EXTERNAL directory that carries its own
   *  full .oxis/ setup (workspace.lua + project.lua + tasks/workflows/
   *  scripts/plugins/documents), so a project can ship its own OXIS
   *  environment alongside its code instead of that living only inside
   *  dist/workspaces/. Reuses initWorkspace()'s own .oxis/workspace.lua
   *  creation (never overwrites one that's already there) and just
   *  adds the companion folders + a project.lua stub around it —
   *  no new load/permission/task machinery, no duplicated system. */
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
    // initWorkspace() failing because workspace.lua already exists
    // isn't a failure for 'project init specifically — the companion
    // folders above still got created either way, which is the actual
    // point of this command. A genuine failure (couldn't write files
    // at all) still needs to surface, though.
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
    const tasks = registry.all().filter(c => c.category === "task" && c.fromPlugin === WORKSPACE_PLUGIN_NAME);
    const lines = [
      this.activeNamed ? `workspace: "${this.activeNamed}"  (workspaces/${this.activeNamed}/)` : `workspace: ${this.activeDir}`,
      `tasks: ${tasks.length ? tasks.map(t => t.name.replace(/^task:/, "")).join(", ") : "none"}`,
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

  /** A cheap, comparable string standing in for "the state of this
   *  workspace's own editable files right now" — workspace.lua's own
   *  mtime, plus the tasks/ and workflows/ folders' listings (name +
   *  mtime per entry, so an added/removed/edited file inside either
   *  changes the signature even though workspace.lua itself didn't).
   *  Not a hash of file CONTENT (would mean reading every file on
   *  every poll tick, real I/O cost for no real benefit — mtime
   *  already changes the instant a save happens). Returns null on any
   *  read failure (workspace directory gone, etc.) rather than
   *  throwing — the poll loop treats null as "can't tell, skip this
   *  tick" rather than a reload trigger. */
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

  /** Polls computeSignature() every AUTO_RELOAD_POLL_MS and calls
   *  reload() the moment it changes — see the class-field comment
   *  above for why this is polling, not a real push-based watcher.
   *  Started by load() on every successful load (of either kind —
   *  named or ad-hoc; there's no reason this should only work for
   *  one), stopped by stopAutoReload() (called from close(), and from
   *  load() itself before starting a new one, so switching workspaces
   *  never leaves an old interval polling a directory that's no
   *  longer active). Errors from a single tick are swallowed (logged,
   *  not thrown) — a background poller raising an unhandled rejection
   *  every few seconds would be worse than just skipping that tick
   *  and trying again next time. */
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

  /** Core load path shared by init/reload/detectAndLoad/switchNamed.
   *  `namedWorkspace` is the SINGLE place `activeNamed` gets set —
   *  every caller must say explicitly whether this load is a named
   *  workspace (pass its name) or an ad-hoc directory (pass null).
   *  This used to be left to callers to manage as an afterthought
   *  (only switchNamed updated it, after the fact) — which meant
   *  activeNamed could go stale the moment ANY other path called
   *  load(): switch to a named workspace, then have the shell cd into
   *  an unrelated directory with its own .oxis/workspace.lua
   *  (detectAndLoad), and the system would still think the OLD named
   *  workspace was active — wrong workspace shown everywhere
   *  (Home's panel, the file tree's root, 'workspace newfile/github/
   *  gitlab all operating against the wrong registry entry). Now
   *  load() itself is the only place this can be set, so it can't
   *  drift out of sync with what's actually loaded. */
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

    // Unload whatever was there before (tasks/commands/workflows/etc.
    // it registered) — a reload shouldn't leave the previous run's
    // registrations dangling alongside the new ones, and switching to
    // a DIFFERENT workspace must not leak its workflows into this one
    // (workflow isolation — see workflowRunner.ts's clear()).
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
    // Real-time auto-reload — see startAutoReload()'s own doc comment
    // for what this actually is (polling, not a push-based watcher).
    // Restarting it here (even when THIS load() call was itself
    // triggered by the poller noticing a change) re-baselines the
    // signature to what was just loaded, which is exactly what should
    // happen after a reload — otherwise the next tick would compare
    // against the PRE-reload signature and could re-trigger
    // immediately for no reason.
    this.startAutoReload(dir, namedWorkspace);
    return { ok: true, message: `workspace loaded from ${path}` };
  }

  /** Loads every workflows/*.lua file in this workspace/project — each
   *  one is just Lua source that calls oxis.workflow("name", {...},
   *  "desc") (the same oxis.* API everything else uses), executed once
   *  to register its definition into workflowRunner and then disposed
   *  — a workflow's definition is plain JS data after that (see
   *  workflowRunner.ts), so nothing needs the Lua VM to stay alive.
   *  Errors in one workflow file are reported and skipped rather than
   *  aborting the rest — consistent with how a broken plugin doesn't
   *  take down plugin loading generally.
   *
   *  Checks BOTH `<dir>/workflows/` (the named-workspace convention —
   *  see NAMED_SUBDIRS) and `<dir>/.oxis/workflows/` (the project
   *  layer's convention — see initProject) since the same load() path
   *  serves both a named workspace and a project's .oxis/workspace.lua
   *  alike; whichever one actually exists for a given directory is
   *  loaded, and having neither is fine (nothing to load). */
  private async loadWorkflows(dir: string): Promise<void> {
    await this.loadWorkflowsFrom(`${dir}/workflows`);
    await this.loadWorkflowsFrom(`${dir}/.oxis/workflows`);
  }

  /** Same idea as loadWorkflows, for the tasks/ folder — this existed
   *  structurally (see NAMED_SUBDIRS, and now initProject's .oxis/tasks/)
   *  but nothing ever actually loaded .lua files from it; task
   *  registration only ever happened via workspace.lua's own
   *  oxis.task(...) calls. A tasks/*.lua file works exactly the same
   *  way a workflows/*.lua file does — it's just Lua source that calls
   *  oxis.task(name, cmd, desc), loaded once and disposed. */
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
  // Named workspaces — 'workspace init "name" / list / switch /
  // rename / delete / link / unlink.
  //
  // Each named workspace is a real folder, workspaces/<name>/, holding
  // its own documents/, plugins/, scripts/, tasks/, workflows/ and a
  // .oxis/workspace.lua — the SAME kind of file the single-directory
  // flow above uses, so switching to a named workspace just calls the
  // existing load() against workspaces/<name>, reusing all of its
  // Lua-loading, task-registration, and event-emitting behavior
  // instead of duplicating it. workspaces/registry.json is the only
  // new piece of state: a flat list of {name, createdAt, externalPath}
  // so 'workspace list doesn't need to guess folder names apart from
  // scanning workspaces/ (which would also work, but the registry is
  // what carries externalPath and survives a workspace being briefly
  // absent/renamed mid-operation cleanly).
  //
  // scripts/ and tasks/ are plain folders you keep your own files in
  // and open with 'edit — there's no separate "script engine" here;
  // running things still goes through 'task / oxis.command in
  // .oxis/workspace.lua like it always has. workflows/ is different:
  // see loadWorkflows() below and workflowRunner.ts — 'workflow <name>
  // is a real, if intentionally scoped, execution engine now.
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

  /** The actual "auto-updater for workspaces" — call once at startup
   *  (see App.tsx's init effect). Compares the running OXIS_VERSION
   *  against whatever was last seen (localStorage) and, ONLY if it's
   *  different (a real update happened, or this is the very first
   *  launch), runs migrateWorkspaces() across every named workspace.
   *  Cheap and safe to call on every launch regardless — the version
   *  check just avoids doing the (idempotent, but not free) folder
   *  scan on every single startup when nothing's actually changed. */
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

  /** Brings every named workspace's on-disk folder layout up to
   *  whatever the running OXIS version expects — currently just
   *  "every folder in NAMED_SUBDIRS actually exists" (a workspace
   *  created before tasks/workflows were added to that list would be
   *  missing them; `.oxis/` similarly for anything from before the
   *  project layer). Purely additive: creates missing folders, never
   *  touches, overwrites, or deletes anything that's already there —
   *  a workspace's `workspace.lua`, its documents, its own tasks are
   *  never rewritten by this. Safe and cheap to run repeatedly
   *  (checked via schemaVersion first, so an up-to-date workspace
   *  does no filesystem work at all beyond the registry read). */
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
      return this.disposer ? this.close() : { ok: true, message: "no workspace was active" };
    }
    const entries = await this.readRegistry();
    if (!entries.some(e => e.name === name)) {
      return { ok: false, message: `no workspace named "${name}" — see 'workspace list` };
    }
    const result = await this.load(`workspaces/${name}`, name);
    if (!result.ok) return result;
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
    const entries = await this.readRegistry();
    const idx = entries.findIndex(e => e.name === name);
    if (idx === -1) return { ok: false, message: `no workspace named "${name}"` };
    if (this.activeNamed === name) this.close();
    await deletePath(`workspaces/${name}`);
    entries.splice(idx, 1);
    await this.writeRegistry(entries);
    return { ok: true, message: `deleted workspace "${name}"` };
  }

  /** `'workspace link "<path>"` — connect the ACTIVE named workspace
   *  to an existing project directory elsewhere on disk. This doesn't
   *  copy anything into dist/ — externalPath is just remembered on
   *  the workspace's registry entry for your own scripts/tasks/
   *  workflows to reference (e.g. a task that `cd`s there before
   *  running a build), while OXIS keeps managing the workspace's own
   *  documents/plugins/scripts/tasks/workflows folders around it.
   *
   *  Also writes a small connector marker file into that directory
   *  and makes sure its .gitignore excludes it (see writeConnectorFile/
   *  ensureGitignoreRule above) — real, working side effects, not
   *  just an internal pointer nothing else reflects. */
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
    return { ok: true, message: `workspace "${this.activeNamed}" linked to ${path} (added a .gitignore rule for the connector file, if one wasn't already there)` };
  }

  /** `'workspace unlink` — remove the active workspace's external path.
   *  Cleans up the connector file too, but never lets that block the
   *  actual unlink — the directory may already be moved, deleted, or
   *  otherwise inaccessible by the time you unlink (see item 7), and
   *  the registry entry should still be cleared regardless. */
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

  /** Writes the "commit" task into the ACTIVE workspace's own tasks/
   *  folder (workspaces/<name>/tasks/commit.lua for a named workspace,
   *  or .oxis/tasks/commit.lua for the ad-hoc single-directory flow)
   *  and loads it immediately — called by 'workspace github/gitlab
   *  right after a remote is actually configured (see README § Git
   *  Integration: "no default task... only when github or gitlab
   *  connected"). A separate file, not an edit to workspace.lua's own
   *  text, so it can't clobber anything hand-written there. Never
   *  overwrites a commit.lua that's already there (the user may have
   *  customized it), and checks the registry — not just the file's
   *  existence — before treating it as "already set up", so a
   *  workspace.lua that already registers its OWN task named "commit"
   *  (however it does so) isn't duplicated either. Returns whether it
   *  actually created anything new. */
  async ensureCommitTask(): Promise<boolean> {
    if (!this.activeDir) return false;
    if (registry.get("task:commit")) return false; // already exists, from this or any other source
    const tasksDir = `${this.activeDir}/tasks`;
    const commitLuaPath = `${tasksDir}/commit.lua`;
    const already = await statPath(commitLuaPath).catch(() => ({ exists: false, isDir: false, size: 0, modTime: 0 }));
    if (already.exists) return false; // a commit.lua exists but wasn't loaded as "commit" for some other reason — don't overwrite it blind
    await makeDir(tasksDir);
    await writeFile(commitLuaPath, `-- Added automatically by 'workspace github/gitlab once a remote was configured.\n-- A completely normal task — rename, edit, or delete it like any other.\noxis.task("commit", "'git-commit-dialog", "Commit the connected project's changes")\n`);
    await this.loadTasksFrom(tasksDir);
    return true;
  }

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
  documentsDir(): string {
    return this.activeNamed ? `workspaces/${this.activeNamed}/documents` : "created-documents";
  }

  /** Where Plugin Creator should write user-created plugins right now. */
  pluginsDir(): string {
    return this.activeNamed ? `workspaces/${this.activeNamed}/plugins` : "created-plugins";
  }
}

export const workspaceManager = new WorkspaceManager();