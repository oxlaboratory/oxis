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
import { registry } from "./commandRegistry";
import { events } from "./events";

const WORKSPACE_PLUGIN_NAME = "__workspace__";
const WORKSPACE_REL_PATH = ".oxis/workspace.lua";
const NAMED_SUBDIRS = ["documents", "plugins", "scripts", "tasks", "workflows", ".oxis"] as const;
const REGISTRY_PATH = "workspaces/registry.json";
// A workspace name becomes a real folder name under workspaces/, so
// keep it to something safe on every OS's filesystem and that can't
// escape that folder via ".." or a path separator.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

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

oxis.task("dev",   "npm run dev",   "Start the dev server")
oxis.task("build", "npm run build", "Production build")
oxis.task("test",  "npm test",      "Run the test suite")

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
    if (workspaceAlreadyExisted) await this.load(dir); // still load it, same as a fresh init would
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
    return this.load(target);
  }

  /** `'workspace close` — unload, undoing everything workspace.lua registered. */
  close(): WorkspaceOpResult {
    if (!this.disposer) return { ok: false, message: "no workspace is currently loaded" };
    registry.unregisterByPlugin(WORKSPACE_PLUGIN_NAME);
    try { this.disposer.dispose(); } catch { /* VM already gone */ }
    this.disposer = null;
    this.activeDir = null;
    this.activeNamed = null;
    workflowRunner.clear(); // workflows are workspace-scoped — see loadWorkflows() below
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
    const bindings = buildLuaAPI({ ...this.apiCtx!, pluginName: WORKSPACE_PLUGIN_NAME });
    const result = loadLuaPlugin(source, bindings);
    if (!result.ok) {
      events.emit("workspace_unloaded", {});
      return { ok: false, message: `${path} failed to load: ${result.error}` };
    }
    this.disposer = result.plugin;
    this.activeDir = dir;
    await this.loadTasks(dir);
    await this.loadWorkflows(dir);
    // Authoritative "workspace_loaded" with the real absolute
    // directory — separate from whatever oxis.workspace(path) inside
    // the .lua file itself passed (usually just "."), which
    // workspaceState.ts explicitly does NOT use for display.
    events.emit("workspace_loaded", { path: dir });
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
      const bindings = buildLuaAPI({ ...this.apiCtx!, pluginName });
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
      const bindings = buildLuaAPI({ ...this.apiCtx!, pluginName });
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
    entries.push({ name, createdAt: new Date().toISOString() });
    await this.writeRegistry(entries);
    return { ok: true, message: `workspace "${name}" created (${dir}/) — 'workspace switch ${name} to activate it` };
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
    const result = await this.load(`workspaces/${name}`);
    if (!result.ok) return result;
    this.activeNamed = name;
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
   *  documents/plugins/scripts/tasks/workflows folders around it. */
  async linkExternal(path: string): Promise<WorkspaceOpResult> {
    if (!this.activeNamed) {
      return { ok: false, message: "no workspace active — 'workspace switch <name> first (or 'workspace init \"name\" then switch)" };
    }
    const entries = await this.readRegistry();
    const entry = entries.find(e => e.name === this.activeNamed);
    if (!entry) return { ok: false, message: `active workspace "${this.activeNamed}" is missing its registry entry` };
    entry.externalPath = path;
    await this.writeRegistry(entries);
    return { ok: true, message: `workspace "${this.activeNamed}" linked to ${path}` };
  }

  /** `'workspace unlink` — remove the active workspace's external path. */
  async unlinkExternal(): Promise<WorkspaceOpResult> {
    if (!this.activeNamed) return { ok: false, message: "no workspace active" };
    const entries = await this.readRegistry();
    const entry = entries.find(e => e.name === this.activeNamed);
    if (!entry) return { ok: false, message: `active workspace "${this.activeNamed}" is missing its registry entry` };
    delete entry.externalPath;
    await this.writeRegistry(entries);
    return { ok: true, message: `workspace "${this.activeNamed}" unlinked` };
  }

  getActiveNamed(): string | null { return this.activeNamed; }

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