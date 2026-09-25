/**
 * App.tsx — the OXIS app: terminal and global prompt, editor, Home,
 * theme editor, command palette and the built-in commands.
 */

import React, {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from "react";
import { createPortal } from "react-dom";
import { marked } from "marked";

import { openPty }    from "./pty/ptyClient";
import type { PtySession } from "./pty/ptyClient";

import {
  mkLine, initialLines, processOutput, mergeOutput, visibleText,
  LINE_COLORS,
  wordLeft, wordRight,
  deleteWordLeft, deleteWordRight,
  deleteToLineStart, deleteToLineEnd,
  transposeChars,
  setYankBuf, getYankBuf,
  isWindows,
} from "./terminal/terminal";
import type { Line, LineKind } from "./terminal/terminal";

import { history }                          from "./terminal/history";
import type { SearchResult }               from "./terminal/history";
import { themeManager }                     from "./terminal/themeManager";
import type { Theme }                       from "./terminal/themeManager";
import { events }                           from "./terminal/events";
import { keybinds, registerCoreKeybinds }  from "./terminal/keybinds";
import { registry }                         from "./terminal/commandRegistry";
import type { CommandHandler }              from "./terminal/commandRegistry";
import { workspaceState }                   from "./terminal/workspaceState";
import { workspaceManager }                 from "./terminal/workspaceManager";
import { getRecentErrors, clearRecentErrors, installGlobalErrorCapture } from "./terminal/diagnostics";
import { cwdTracker, buildCwdProbe, looksLikeDirectoryChange, isProbeLine } from "./terminal/cwdTracker";
import { scriptRunTracker, stripStepEcho } from "./terminal/scriptRunTracker";
import { workflowRunner } from "./plugins/workflowRunner";
import {
  grant as grantPermission, revoke as revokePermission, grantedTo as grantedPermissions,
  type PermissionNamespace,
} from "./plugins/permissions";
import { getLicensedEmail, setLicensedEmail, checkLicense } from "./plugins/pluginLicense";
import type { EditorMode, CursorState }     from "./terminal/editorModes";
import {
  moveLeft, moveRight, moveUp, moveDown, moveLineStart, moveLineEnd,
  moveDocStart, moveDocEnd, moveWordForward, moveWordBackward,
  deleteChar, deleteLine, deleteWord, openLineBelow, openLineAbove,
  deleteSelection, selectedText,
} from "./terminal/editorModes";
import { highlight, detectLang, escapeHtml } from "./terminal/syntaxHighlight";
import type { EditorLang }       from "./terminal/syntaxHighlight";
import { pluginManager }                   from "./plugins/pluginManager";
import { UNDOCUMENTED_SENTINEL }           from "./plugins/pluginAPI";
import { initPlugins }                     from "./plugins/loader";
import type { LuaJSValue }                 from "./plugins/luaRuntime";
import * as market                         from "./plugins/market";
import { updatePlugin, updateAllPlugins, rollbackPlugin } from "./plugins/marketUpdate";
import { exportSettings, importSettings, exportWorkspace, importWorkspace, exportPluginSource, createFullBackup, restoreFullBackup } from "./plugins/backup";
import { checkPublishable, findExistingListing, prepareFreePublish, submitPaidPlugin, startConnectOnboarding, requestPluginDeletion } from "./plugins/publish";
import { commitAll, setupRemote, unlinkRemote, getRemotes, parseGitRemote, cancelActiveCommit, type GitProvider } from "./plugins/git";
import { loadUserConfig } from "./terminal/userConfig";
import { userConfigDir } from "./native";
import { readFile, writeFile, listDir, makeDir, statPath, movePath, isNativeApp, openUrl, checkForUpdate, performUpdate, quitApp, writeClipboard, windowGetSize, windowSetSize } from "./native";
import Titlebar from "./components/Titlebar";

// ══════════════════════════════════════════════════════════════
// SHELL CONTEXT — passed to command registry
// ══════════════════════════════════════════════════════════════
interface ShellCtx {
  send:        (cmd: string) => void;
  runLine:     (line: string) => void;
  print:       (text: string, kind?: LineKind) => void;
  /** Batched sibling of print — one state update for several lines
   *  instead of one per line. See addLines in Terminal for why this
   *  exists (a real performance finding, not just a convenience). */
  printLines:  (entries: Array<[string, LineKind?]>) => void;
  clear:       () => void;
  /** `line`, when given, is a 1-based line number the editor jumps
   *  the cursor/scroll position to once the file finishes loading —
   *  see 'oxis resize for the motivating case (pointing the user at
   *  the exact window-size constant instead of making them search). */
  openEditor:  (path: string, line?: number) => void;
  newTerminal: () => void;
}

// Persisted plugin options (oxis.getOption/setOption) and settings.
const OPTIONS_KEY = "oxis-plugin-options-v1";

// Splits an OXIS command line into arguments; "double" or 'single'
// quoted runs are one argument with the quotes stripped.
function splitCmdArgs(body: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  }
  return out;
}

// Joins a user-typed relative path onto baseDir as pure string logic and
// returns null if the result would escape baseDir (.., absolute paths,
// leading slashes). Used where OXIS writes into the user's own project.
function safeJoinWithinDir(baseDir: string, relPath: string): string | null {
  if (/^[A-Za-z]:[\\/]/.test(relPath) || relPath.startsWith("/") || relPath.startsWith("\\")) return null;
  const normalizedBase = baseDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const rooted = normalizedBase.startsWith("/");
  const baseParts = normalizedBase.split("/").filter(Boolean);
  const combinedParts = `${normalizedBase}/${relPath.replace(/\\/g, "/")}`.split("/");
  const resolved: string[] = [];
  for (const part of combinedParts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (resolved.length <= baseParts.length - 1) return null;
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  for (let i = 0; i < baseParts.length; i++) if (resolved[i] !== baseParts[i]) return null;
  if (resolved.length <= baseParts.length) return null;
  return (rooted ? "/" : "") + resolved.join("/");
}

// The registered plugin whose .lua source lives at `path`, if any. The
// editor's save uses this to reload plugins live.
function findPluginForPath(path: string): string | null {
  for (const p of pluginManager.all()) {
    if (p.builtin || !p.lua) continue;
    const expected = p.origin === "user"
      ? `${workspaceManager.pluginsDir()}/${p.name}.lua`
      : `plugins/${p.name}.lua`;
    if (expected === path) return p.name;
  }
  return null;
}

function readAllOptions(): Record<string, unknown> {
  try { return JSON.parse(localStorage.getItem(OPTIONS_KEY) || "{}"); }
  catch { return {}; }
}
function readPersistedOption(key: string): LuaJSValue {
  return readAllOptions()[key] as LuaJSValue;
}
function writePersistedOption(key: string, value: LuaJSValue): void {
  const all = readAllOptions();
  all[key] = value;
  try { localStorage.setItem(OPTIONS_KEY, JSON.stringify(all)); } catch { /* storage full/unavailable — option still works for this session via the per-plugin in-memory cache in pluginAPI.ts */ }
}

// ── Clipboard ─────────────────────────────────────────────
// navigator.clipboard can be rejected inside the WebView (permission or
// focus), in which case the copy falls back to the native OS clipboard
// (App.WriteClipboard). Browser mode has only the JS API.
async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(text);
    return;
  } catch { /* fall through to the native path below */ }
  if (isNativeApp()) {
    try { await writeClipboard(text); }
    catch { /* genuinely nothing left to try — selection itself still stands */ }
  }
}

// ══════════════════════════════════════════════════════════════
// SETTINGS — 'config / 'settings. Stored in the same option store as
// oxis.getOption (keys prefixed "setting."). Each setting applies itself
// when changed and again at startup (applyAllSettings).
// ══════════════════════════════════════════════════════════════
interface SettingDef {
  key: string;
  label: string;
  description: string;
  default: string | number | boolean;
  choices?: string[]; // for a "pick one of these" setting; omitted = free string/number/boolean
  apply: (value: string | number | boolean) => void;
}

const SETTINGS: SettingDef[] = [
  {
    key: "fontSize", label: "Font Size", default: 13,
    description: "Terminal & editor font size in px (line height scales with it)",
    apply: (v) => {
      const n = Number(v) || 13;
      document.documentElement.style.setProperty("--fs", `${n}px`);
      document.documentElement.style.setProperty("--lh", `${Math.round(n * 1.54)}px`);
    },
  },
  {
    key: "cursorStyle", label: "Cursor Style", default: "block", choices: ["block", "bar", "underline"],
    description: "Terminal cursor shape",
    apply: (v) => document.documentElement.setAttribute("data-cursor-style", String(v)),
  },
  {
    key: "cursorBlink", label: "Cursor Blink", default: true,
    description: "Whether the terminal cursor blinks",
    apply: (v) => document.documentElement.setAttribute("data-cursor-blink", v ? "on" : "off"),
  },
  {
    key: "updateCheckOnStartup", label: "Check for Updates", default: true,
    description: "Check for a newer OXIS build on startup",
    apply: () => { /* read by startupUpdateCheck() */ },
  },
];

function settingDef(key: string): SettingDef | undefined {
  return SETTINGS.find(s => s.key.toLowerCase() === key.toLowerCase());
}

function getSetting(key: string): string | number | boolean {
  const def = settingDef(key);
  if (!def) return "";
  const stored = readPersistedOption(`setting.${def.key}`);
  return (stored === undefined || stored === null) ? def.default : (stored as string | number | boolean);
}

function setSetting(key: string, rawValue: string): { ok: boolean; message: string } {
  const def = settingDef(key);
  if (!def) return { ok: false, message: `unknown setting: ${key} — 'config list to see all` };
  let value: string | number | boolean;
  if (def.choices) {
    if (!def.choices.includes(rawValue)) return { ok: false, message: `${def.key} expects one of: ${def.choices.join(", ")}` };
    value = rawValue;
  } else if (typeof def.default === "boolean") {
    const v = rawValue.toLowerCase();
    if (!["true", "false", "on", "off", "1", "0", "yes", "no"].includes(v)) return { ok: false, message: `${def.key} expects true/false` };
    value = ["true", "on", "1", "yes"].includes(v);
  } else if (typeof def.default === "number") {
    const n = Number(rawValue);
    if (!Number.isFinite(n)) return { ok: false, message: `${def.key} expects a number` };
    value = n;
  } else {
    value = rawValue;
  }
  writePersistedOption(`setting.${def.key}`, value);
  def.apply(value);
  return { ok: true, message: `${def.key} = ${value}` };
}

function resetSetting(key: string): { ok: boolean; message: string } {
  const def = settingDef(key);
  if (!def) return { ok: false, message: `unknown setting: ${key} — 'config list to see all` };
  writePersistedOption(`setting.${def.key}`, def.default as LuaJSValue);
  def.apply(def.default);
  return { ok: true, message: `${def.key} reset to ${def.default}` };
}

/** Applies every setting's saved (or default) value; run at startup. */
function applyAllSettings(): void {
  for (const def of SETTINGS) def.apply(getSetting(def.key));
}

const USER_CONFIG_TEMPLATE = `-- ~/.oxis/config.lua — runs every time OXIS starts ('config reload re-runs it).
-- Full oxis.* API: see the Lua API section of the README.

-- oxis.theme("midnight")
-- oxis.plugin.enable("docker")
-- oxis.command("hi", function() oxis.echo("hello from config.lua") end, "say hello")
-- oxis.task("serve", "python -m http.server 8080", "serve this folder")
`;

/** Loads ~/.oxis (themes + config.lua) and prints what happened when
 *  asked to, or when something went wrong. */
async function reportUserConfig(verbose: boolean): Promise<void> {
  const print = (t: string, k?: LineKind) => _ctxRef.current?.print(t, k);
  try {
    const r = await loadUserConfig(forwardingApiCtx);
    if (!r) { if (verbose) print("  ✗  ~/.oxis needs the desktop app", "err"); return; }
    if (verbose) {
      print(`  ✓  ${r.dir}: ${r.configLoaded ? "config.lua loaded" : "no config.lua"} · ${r.themes.length} theme file(s)`, "ok");
    }
    for (const p of r.problems) print(`  ✗  ~/.oxis/${p}`, "err");
  } catch (e) {
    print(`  ✗  ~/.oxis: ${e instanceof Error ? e.message : e}`, "err");
  }
}

// ── init flag so we only register commands once ──────────────
let _commandsRegistered = false;
// One background update check per run, shared by the status bar and the
// terminal notice. null when the check is turned off in settings.
let _startupUpdateCheck: Promise<import("./native").NativeUpdateInfo | null> | null = null;
function startupUpdateCheck() {
  if (!_startupUpdateCheck) {
    _startupUpdateCheck = getSetting("updateCheckOnStartup") === false
      ? Promise.resolve(null)
      : checkForUpdate().catch(() => null);
  }
  return _startupUpdateCheck;
}
// Stable ref so clear/print/send always call the latest Terminal instance
const _ctxRef: { current: ShellCtx | null } = { current: null };

// Plugins and workspaces are initialised once, before the terminal
// exists, and keep the context they were given. This forwarding context
// always calls whatever _apiCtxTarget.current points at, so plugins
// loaded early reach the real terminal once it mounts.
const _apiCtxTarget: { current: import("./plugins/pluginAPI").APIContext } = {
  current: {
    sendToShell: () => {}, print: () => {}, getCwd: () => "",
    newTerminal: () => {}, getOption: () => undefined, setOption: () => {},
    pluginName: "__core__",
  },
};
const forwardingApiCtx: import("./plugins/pluginAPI").APIContext = {
  sendToShell: (cmd) => _apiCtxTarget.current.sendToShell(cmd),
  print:       (t, k) => _apiCtxTarget.current.print(t, k),
  getCwd:      () => _apiCtxTarget.current.getCwd(),
  newTerminal: () => _apiCtxTarget.current.newTerminal(),
  getOption:   (k) => _apiCtxTarget.current.getOption(k),
  setOption:   (k, v) => _apiCtxTarget.current.setOption(k, v),
  pluginName:  "__core__", // pluginManager.load() overrides this per-plugin via spread
};

// Global "go home" trigger, set by the root App component
const _goHomeRef: { current: (() => void) | null } = { current: null };

// ══════════════════════════════════════════════════════════════
// COMMAND DETAILS — 'help <command> for commands with subcommands: each
// form, what it does, and examples. Other commands fall back to their
// one-line registry description.
// ══════════════════════════════════════════════════════════════
interface CommandUsage { syntax: string; description: string }
interface CommandDetail { summary: string; usage: CommandUsage[]; examples?: string[]; notes?: string }

const COMMAND_DETAILS: Record<string, CommandDetail> = {
  workspace: {
    summary: "Manage OXIS workspaces — the single-directory .oxis/workspace.lua flow, and named, switchable workspaces built on top of it.",
    usage: [
      { syntax: "'workspace init",                    description: "create .oxis/workspace.lua in the CURRENT directory (the original, single-project flow)" },
      { syntax: "'workspace init \"name\"",              description: "create a NAMED workspace (workspaces/<name>/) with its own documents/plugins/scripts/tasks/workflows folders" },
      { syntax: "'workspace list",                    description: "list every named workspace — '*' marks the active one" },
      { syntax: "'workspace switch <name>",           description: "activate a named workspace (or 'workspace switch default to go back to the shared, unnamed context)" },
      { syntax: "'workspace rename <old> <new>",      description: "rename a named workspace" },
      { syntax: "'workspace delete <name>",           description: "delete a named workspace and everything inside it" },
      { syntax: "'workspace link \"<path>\"",           description: "connect the ACTIVE named workspace to an existing project directory elsewhere on disk, without moving it" },
      { syntax: "'workspace unlink",                  description: "remove that link" },
      { syntax: "'workspace newfile <relative-path>", description: "create a file inside the CONNECTED external directory (needs 'workspace link first) and open it in the Editor — nested paths create parent folders automatically; refuses anything that would escape the connected directory" },
      { syntax: "'workspace newdir <relative-path>",  description: "same, for a directory" },
      { syntax: "'workspace move <file> <directory>", description: "move a file to a directory, both relative to the connected project — same thing dragging a file onto a folder in the file tree does" },
      { syntax: "'workspace github <owner/repo or URL> [--force]", description: "configure the connected project's git remote for GitHub — initializes a repo if needed, refuses to silently overwrite a DIFFERENT existing origin (add --force to replace it). 'task commit is always available regardless — see 'help project" },
      { syntax: "'workspace gitlab <owner/repo or URL> [--force]", description: "same, for GitLab" },
      { syntax: "'workspace github unlink [--remove-remote]", description: "disconnect the GitHub/GitLab remote without touching the local project, workspace, .oxis/, source files, or .git repo — by default just renames origin (nothing is deleted, connect a different repo right after); --remove-remote actually deletes it" },
      { syntax: "'workspace gitlab unlink [--remove-remote]", description: "same command, works identically either way you spell it — both just operate on the one origin remote" },
      { syntax: "'workspace export <name> [path]",    description: "export one workspace's real files to a JSON file (default: <name>.oxisworkspace.json)" },
      { syntax: "'workspace import <path> [name]",    description: "import one — creates a NEW workspace, never silently overwrites an existing one" },
      { syntax: "'workspace info",                    description: "show the active workspace's state — name, tasks, link if any" },
      { syntax: "'workspace reload",                  description: "re-run .oxis/workspace.lua (picks up edits without switching away and back)" },
      { syntax: "'workspace close",                   description: "unload the active workspace, undoing everything its workspace.lua registered" },
    ],
    examples: [
      "'workspace init \"my-app\"          — create a workspace called my-app",
      "'workspace switch my-app          — make it the active one",
      "'workspace link \"C:\\Projects\\my-app\"  — point it at a real project directory",
      "'workspace github my-name/my-app  — configure the GitHub remote",
      "'workspace switch default         — step back out of it",
    ],
    notes: "Switching workspaces clears the previously-active one's tasks/commands/workflows first — one workspace's stuff never leaks into another's. Path arguments in this command family mean THREE different things, worth being precise about: 'workspace init \"name\" takes just a NAME (becomes workspaces/<name>/ — not a path you choose); 'workspace link \"<path>\" takes a real absolute path anywhere on disk (the external project you're connecting to); 'workspace newfile/newdir <relative-path> are relative to THAT connected path specifically, not the app directory 'edit's relative paths use.",
  },
  plugin: {
    summary: "Create, manage, and inspect plugins — both your own (Plugin Creator/'plugin new) and ones installed from the Market.",
    usage: [
      { syntax: "'plugin list",                                          description: "every plugin + enabled/disabled status" },
      { syntax: "'plugin enable <name>",                                 description: "enable one plugin" },
      { syntax: "'plugin enable all",                                    description: "enable every registered plugin" },
      { syntax: "'plugin disable <name>",                                description: "disable one plugin" },
      { syntax: "'plugin reload <name>",                                 description: "reload a single plugin (picks up file changes without a restart)" },
      { syntax: "'plugin reloadall",                                     description: "reload every enabled plugin" },
      { syntax: "'plugin new <name> [--template=basic|dev|devops|system]", description: "create a new plugin from a real starter template, register it live, and open it in the Editor" },
      { syntax: "'plugin uninstall <name> [--force]",                    description: "remove a plugin's file — refuses if another installed plugin depends on it, unless --force" },
      { syntax: "'plugin delete <name>",                                 description: "alias for uninstall" },
      { syntax: "'plugin info <name>",                                   description: "full metadata: version, author, permissions declared, dependencies + their status" },
      { syntax: "'plugin docs <name>",                                   description: "a plugin's own documentation, if its manifest declares any" },
      { syntax: "'plugin validate <name>",                               description: "check manifest/Lua-syntax/dependencies/compatibility WITHOUT loading it — safe to run on a plugin that's currently in use" },
      { syntax: "'plugin test <name>",                                   description: "actually load it and report what it registered, then restore its prior enabled/disabled state" },
      { syntax: "'plugin doctor",                                        description: "inspect every installed plugin at once — broken/missing dependencies, incompatible versions, invalid manifests, permission gaps, Lua errors, missing files — errors vs. warnings clearly distinguished, with suggested fixes" },
      { syntax: "'plugin permissions <name>",                            description: "see a plugin's fs/process/net/system/workspace/editor/terminal grants" },
      { syntax: "'plugin permissions <name> grant <ns>",                 description: "grant one permission namespace" },
      { syntax: "'plugin permissions <name> revoke <ns>",                description: "revoke one" },
      { syntax: "'plugin rollback <name>",                               description: "restore the backup taken by the last 'market update — works any time after an update, not just right after a failed one" },
      { syntax: "'plugin export <name> [path]",                         description: "export a plugin's .lua source to a file — for sharing it, or backing it up outside OXIS" },
      { syntax: "'plugin publish <name>",                               description: "validates it's ready, then opens a real GitHub pull request adding it to the Market — FREE, not live until a human reviews and merges it" },
      { syntax: "'plugin publish <name> --price=4.99 --interval=month", description: "same, as a PAID listing — creates a real Stripe Connect Express account (via the deployed /connect-onboarding endpoint), opens the onboarding link, then opens the merge request the same way" },
      { syntax: "'plugin publish <name> --email=you@example.com",       description: "email for the Stripe Connect account — defaults to whatever 'market license already has on file" },
      { syntax: "'plugin unpublish <name>",                             description: "opens a GitHub pull request removing the plugin's Market listing — same human-reviewed model, nothing is actually removed until a human merges it" },
    ],
    examples: [
      "'plugin new mytools --template=devops   — start a new devops-flavored plugin",
      "'plugin validate mytools                — check it before relying on it",
      "'plugin permissions mytools grant fs     — let it read/write files",
      "'plugin publish mytools                  — prepare a free Market listing",
      "'plugin publish mytools --price=4.99 --interval=month --email=you@example.com",
    ],
    notes: "Publishing automates the tedious part, not the review — it validates the plugin first, and for paid plugins genuinely creates a Stripe Connect account, then opens a real GitHub pull request (branch + commit + PR, via the Market's /submit-plugin endpoint) adding the plugin's .lua file and index.json entry. Nothing is live until a human reviews and merges that PR on GitHub — this just gets it opened without the developer doing the fork/clone/branch/push/PR steps by hand. Running 'plugin publish again on an already-listed plugin opens an UPDATE pull request (replacing its index.json entry) rather than a new one, detected by checking the Market for an existing entry — no separate command needed for that.",
  },
  market: {
    summary: "Browse and install plugins from the free OXIS Market.",
    usage: [
      { syntax: "'market list",         description: "every free plugin in the Market" },
      { syntax: "'market search <q>",   description: "search by name/description" },
      { syntax: "'market info <name>",  description: "one plugin's details before installing it" },
      { syntax: "'market install <name>", description: "install it — registers and loads it live, same as 'plugin new does for your own" },
      { syntax: "'market update <name>", description: "check for and apply an update — checks OXIS-version/OS compatibility and dependencies against the NEW version first, backs up the current one, and automatically rolls back if the new version fails to load" },
      { syntax: "'market update all", description: "the same, for every Market-installed plugin with an available update; already-current ones are reported, not skipped silently" },
    ],
    notes: "'plugin rollback <name> undoes the last update manually, any time after it — not just automatically right after a failed one.",
  },
  config: {
    summary: "View or change OXIS settings — see README § Settings for the full list and what each one actually does.",
    usage: [
      { syntax: "'config list",              description: "every setting + its current value" },
      { syntax: "'config get <key>",         description: "show one setting" },
      { syntax: "'config set <key> <value>", description: "change a setting — takes effect immediately, no restart" },
      { syntax: "'config reset <key>",       description: "reset a setting to its default" },
      { syntax: "'config export [path]",     description: "export settings to a JSON file (default: oxis-config.json)" },
      { syntax: "'config import <path>",     description: "import settings from one — takes effect immediately, no restart" },
      { syntax: "'config edit",              description: "open ~/.oxis/config.lua (created from a template if missing) — Lua that runs at every startup" },
      { syntax: "'config reload",            description: "re-read ~/.oxis/config.lua and ~/.oxis/themes/*.json without restarting" },
    ],
    examples: [
      "'config set fontSize 15",
      "'config set cursorStyle bar",
      "'config set updateCheckOnStartup false",
    ],
    notes: "'settings is an alias for 'config. Theme isn't a \"setting\" here — see 'theme instead, which has its own dedicated persistence.",
  },
  oxis: {
    summary: "OXIS application settings. The window size is changed live and remembered for the next launch (window.json in the app folder).",
    usage: [
      { syntax: "'oxis resize",               description: "show the current window size and the presets" },
      { syntax: "'oxis resize <preset>",      description: "small 800×520 · default 940×600 · medium 1100×700 · large 1280×800 · xl 1600×1000" },
      { syntax: "'oxis resize <W>x<H>",       description: "any size from 640×400 to 3840×2160, e.g. 'oxis resize 1200x760" },
      { syntax: "'oxis resize config",        description: "open window.json in the editor at the width line" },
    ],
    notes: "In a browser tab the size belongs to the browser, so 'oxis resize only reports it.",
  },
  workflow: {
    summary: "Run multi-step workflows declared in the active workspace's workflows/*.lua files.",
    usage: [
      { syntax: "'workflow list",        description: "workflows loaded from the active workspace" },
      { syntax: "'workflow <name>",      description: "run one — e.g. 'workflow build" },
      { syntax: "'workflow info <name>", description: "show its steps without running it" },
      { syntax: "'workflow cancel",      description: "stop whichever workflow is currently running" },
    ],
    notes: "No workspace active, or that workspace has no workflows/ folder → 'workflow list will say so rather than error.",
  },
  edit: {
    summary: "Open a file in the built-in Editor — Normal/Insert/Visual modes, undo/redo, find & replace, multiple tabs, a file tree (Ctrl+B).",
    usage: [
      { syntax: "'edit <relative-path>",   description: "resolves against the APP's OWN directory (next to oxis.exe) — NOT your project folder, and NOT your current workspace's own subfolder unless you spell that out. See the path notes below — this is the #1 source of \"couldn't open\" errors." },
      { syntax: "'edit \"<absolute path>\"", description: "C:\\... on Windows, /... on Linux/macOS — opens that exact file regardless of where it lives. Quote it if it contains spaces." },
      { syntax: "'edit .oxis/workspace.lua", description: "the active workspace's OWN config file, if you're editing the workspace you're currently in — relative to the app dir the same as any other relative path (see notes)" },
      { syntax: "'edit",                    description: "no argument — just opens the file tree (Ctrl+B does the same once the editor's already open) so you can browse to a file without already knowing its exact path" },
    ],
    examples: [
      "'edit created-documents/notes.md            — a document in the shared default folder",
      "'edit workspaces/my-app/.oxis/workspace.lua  — a NAMED workspace's own config",
      "'edit \"C:\\Users\\Admin\\Downloads\\LICENSE\"    — an absolute path anywhere on disk",
    ],
    notes: "Path rules, precisely: a path starting with a drive letter (C:\\...) or a leading / is absolute and opens exactly that file. Anything else is relative to the APP'S OWN directory (see README § dist/ layout for what lives there — created-documents/, created-plugins/, workspaces/, plugins/), never your shell's current directory and never automatically \"the active workspace's folder.\" This trips people up in one specific way: typing 'edit /workspace.lua expecting \"my current workspace's workspace.lua\" does NOT work — a leading / is an ABSOLUTE path (the filesystem root), not \"the workspace root,\" so OXIS looks for a literal workspace.lua sitting at the very top of your C: drive (or /) and correctly fails to find it there. What you actually want is either 'workspace info (to see the active workspace's real path) or the relative form 'edit workspaces/<name>/.oxis/workspace.lua — no leading slash.",
  },
  task: {
    summary: "Run a task defined by the active workspace's .oxis/workspace.lua (oxis.task(...)).",
    usage: [
      { syntax: "'task <name>", description: "run it — sends the task's command straight to the shell, same as typing it yourself" },
    ],
    notes: "Long-running tasks (e.g. a polling loop meant to run 'until stopped') are interrupted with Ctrl+C, same as any other foreground shell command.",
  },
  project: {
    summary: "Set up and run an external project's own .oxis/ environment — a project ships its OWN tasks/workflows/scripts/plugins/documents alongside its code, instead of only living inside dist/workspaces/.",
    usage: [
      { syntax: "'project init [dir]",  description: "create the full .oxis/ setup in a directory (current directory if omitted) — workspace.lua, project.lua, and tasks/workflows/scripts/plugins/documents folders. Never overwrites files that already exist." },
      { syntax: "'project open [dir]",  description: "load a directory's .oxis/workspace.lua (and project.lua, and its tasks/workflows) — same load() 'workspace init/reload use" },
      { syntax: "'project run <name>",  description: "run a task or workflow by name — tries a workflow first, then a task" },
      { syntax: "'project task",        description: "list the active project's tasks" },
      { syntax: "'project workflow",    description: "list the active project's workflows (alias for 'workflow list)" },
    ],
    examples: [
      "'project init \"C:\\dev\\my-app\"   — set up OXIS inside an existing project",
      "'project open                    — load it (from inside that directory)",
      "'project run deploy",
    ],
    notes: "Deliberately thin — these are wrappers around the exact same load()/task/workflow machinery 'workspace and 'workflow already use, not a second system. A project's tasks/workflows live in .oxis/tasks/ and .oxis/workflows/ (each file just calling oxis.task(...)/oxis.workflow(...), same as anywhere else), in addition to whatever workspace.lua registers directly.",
  },
};

function registerBuiltinCommands(ctx: ShellCtx): void {
  if (_commandsRegistered) return;
  _commandsRegistered = true;
  // Wrap every ctx call through the ref so stale closures never matter
  const ps   = (c: string) => _ctxRef.current?.send(c + "\r");
  const ok   = (s: string) => _ctxRef.current?.print("  ✓  " + s, "ok");
  const err  = (s: string) => _ctxRef.current?.print("  ✗  " + s, "err");
  const dim  = (s: string) => _ctxRef.current?.print("     " + s, "dim");
  const info = (s: string) => _ctxRef.current?.print("  " + s, "info");
  const sep  = ()          => _ctxRef.current?.print("  " + "─".repeat(54), "dim");
  const h    = (cmd: string, d: string) => _ctxRef.current?.print("  " + cmd.padEnd(32) + d, "info");
  const shellCmd = (winCmd: string, unixCmd: string) => isWindows() ? winCmd : unixCmd;
  /** Prints a multi-line message with ✓/✗ prefixes in one state
   *  update rather than one per line. */
  const printResultLines = (message: string, succeeded: boolean) => {
    const entries: Array<[string, LineKind?]> = message.split("\n").map(line =>
      line ? [(succeeded ? "  ✓  " : "  ✗  ") + line, (succeeded ? "ok" : "err") as LineKind] : ["", undefined]);
    _ctxRef.current?.printLines(entries);
  };

  // (ps/ok/err/dim/info/sep/h/shellCmd defined above via _ctxRef)

  // ── files ──────────────────────────────────────────────
  // 'new / 'touch write into the documents folder through the native
  // file API (not the shell), so files land in one predictable place.
  // Absolute paths are used as given, like 'edit.
  const looksAbsolute = (p: string) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\");
  registry.register({ name:"new",    category:"files", description:"Create a document in created-documents/",
    handler:(_,r)=>{ if(!r){err("usage: 'new <file>");return;}
      const dest = looksAbsolute(r) ? r : `${workspaceManager.documentsDir()}/${r}`;
      writeFile(dest, "").then(() => ok(`created: ${dest}`)).catch(e => err(`couldn't create ${dest}: ${e}`)); }});

  registry.register({ name:"hide", category:"ui", description:"Hide part of the Home screen — currently: 'hide workspace",
    handler:(args)=>{
      const target = args[0]?.toLowerCase();
      if(target !== "workspace"){ err("usage: 'hide workspace"); return; }
      writePersistedOption("ui.hideWorkspacePanel", true);
      events.emit("ui_workspace_panel_visibility_changed", { hidden: true });
      ok("workspace panel hidden on Home — 'show workspace to bring it back"); }});

  registry.register({ name:"show", category:"ui", description:"Show part of the Home screen previously hidden with 'hide — currently: 'show workspace",
    handler:(args)=>{
      const target = args[0]?.toLowerCase();
      if(target !== "workspace"){ err("usage: 'show workspace"); return; }
      writePersistedOption("ui.hideWorkspacePanel", false);
      events.emit("ui_workspace_panel_visibility_changed", { hidden: false });
      ok("workspace panel shown on Home"); }});

  registry.register({ name:"touch",  category:"files", description:"Create a document in created-documents/",
    handler:(_,r)=>{ if(!r){err("usage: 'touch <file>");return;}
      const dest = looksAbsolute(r) ? r : `${workspaceManager.documentsDir()}/${r}`;
      writeFile(dest, "").then(() => ok(`created: ${dest}`)).catch(e => err(`couldn't create ${dest}: ${e}`)); }});

  registry.register({ name:"mkdir",  category:"files", description:"Create directory",
    handler:(_,r)=>{ if(!r){err("usage: 'mkdir <dir>");return;}
      ps(shellCmd(`New-Item -ItemType Directory -Path "${r}" -Force | Out-Null; Write-Host "created: ${r}"`,
                  `mkdir -p "${r}" && echo "created: ${r}"`)); }});

  registry.register({ name:"rm",     category:"files", description:"Delete file/dir",
    handler:(_,r)=>{ if(!r){err("usage: 'rm <path>");return;}
      ps(shellCmd(`Remove-Item -Recurse -Force "${r}"; Write-Host "deleted: ${r}"`,
                  `rm -rf "${r}" && echo "deleted: ${r}"`)); }});

  registry.register({ name:"cat",    category:"files", description:"Read file",
    handler:(_,r)=>{ if(!r){err("usage: 'cat <file>");return;}
      ps(shellCmd(`Get-Content "${r}"`, `cat "${r}"`)); }});

  registry.register({ name:"ls",     category:"files", description:"List directory",
    handler:(_,r)=>{
      ps(shellCmd(
        `Get-ChildItem "${r||"."}" | Format-Table Mode,LastWriteTime,@{N='Size';E={if($_.PSIsContainer){'<dir>'}else{"$([math]::Round($_.Length/1KB,1))KB"}}},Name -AutoSize`,
        `ls -la "${r||"."}"`
      )); }});

  registry.register({ name:"dir",    category:"files", description:"List directory",
    handler:(_,r)=>{
      ps(shellCmd(
        `Get-ChildItem "${r||"."}" | Format-Table Mode,LastWriteTime,@{N='Size';E={if($_.PSIsContainer){'<dir>'}else{"$([math]::Round($_.Length/1KB,1))KB"}}},Name -AutoSize`,
        `ls -la "${r||"."}"`
      )); }});

  registry.register({ name:"cd",     category:"files", description:"Change directory",
    handler:(_,r)=>{
      ps(shellCmd(
        `Set-Location "${r||"~"}"; Write-Host (" > " + (Get-Location).Path)`,
        `cd "${r||"~"}" && pwd`
      )); }});

  registry.register({ name:"pwd",    category:"files", description:"Print working directory",
    handler:()=> ps(shellCmd(`Write-Host (Get-Location).Path`, `pwd`)) });

  registry.register({ name:"cp",     category:"files", description:"Copy",
    handler:(a)=>{ if(a.length<2){err("usage: 'cp <src> <dst>");return;}
      ps(shellCmd(`Copy-Item -Path "${a[0]}" -Destination "${a[1]}" -Recurse; Write-Host "copied"`,
                  `cp -r "${a[0]}" "${a[1]}" && echo "copied"`)); }});

  registry.register({ name:"mv",     category:"files", description:"Move / rename",
    handler:(a)=>{ if(a.length<2){err("usage: 'mv <src> <dst>");return;}
      ps(shellCmd(`Move-Item -Path "${a[0]}" -Destination "${a[1]}"; Write-Host "moved"`,
                  `mv "${a[0]}" "${a[1]}" && echo "moved"`)); }});

  registry.register({ name:"write",  category:"files", description:"Write text to file",
    handler:(a,_r)=>{ if(!a[0]){err("usage: 'write <file> [text]");return;}
      const c=a.slice(1).join(" ");
      if(c) ps(shellCmd(`Set-Content -Path "${a[0]}" -Value '${c.replace(/'/g,"''")}' -Encoding UTF8; Write-Host "wrote: ${a[0]}"`,
                        `echo '${c}' > "${a[0]}" && echo "wrote: ${a[0]}"`));
      else  ps(shellCmd(`New-Item -ItemType File -Path "${a[0]}" -Force | Out-Null; Write-Host "created: ${a[0]}"`,
                        `touch "${a[0]}" && echo "created: ${a[0]}"`)); }});

  registry.register({ name:"append", category:"files", description:"Append text to file",
    handler:(a)=>{ if(a.length<2){err("usage: 'append <file> <text>");return;}
      ps(shellCmd(`Add-Content -Path "${a[0]}" -Value '${a.slice(1).join(" ").replace(/'/g,"''")}' -Encoding UTF8; Write-Host "appended"`,
                  `echo '${a.slice(1).join(" ")}' >> "${a[0]}" && echo "appended"`)); }});

  registry.register({ name:"hash",   category:"files", description:"SHA256 of file",
    handler:(_,r)=>{ if(!r){err("usage: 'hash <file>");return;}
      ps(shellCmd(`Get-FileHash "${r}" | Format-Table Algorithm,Hash`,
                  `sha256sum "${r}"`)); }});

  registry.register({ name:"size",   category:"files", description:"Size of path",
    handler:(_,r)=>{ if(!r){err("usage: 'size <path>");return;}
      ps(shellCmd(
        `$s=Get-ChildItem -Recurse "${r}" -EA SilentlyContinue|Measure-Object -Property Length -Sum;Write-Host "$([math]::Round($s.Sum/1MB,2)) MB ($($s.Count) files)"`,
        `du -sh "${r}"`
      )); }});

  registry.register({ name:"edit",   category:"files", description:"Open in built-in editor (no argument: just opens the file tree)",
    handler:(_,r)=>{
      if(!r){ events.emit("open_file_tree", {}); return; }
      _ctxRef.current?.openEditor(r); ok(`opening ${r}`); }});

  registry.register({ name:"update", category:"files", description:"Check for a newer OXIS build, or 'update install to actually install it in place",
    handler:(args)=>{
      if(args[0]?.toLowerCase()==="install"){
        runUpdateInstall();
        return;
      }
      ok("checking for a newer build...");
      checkForUpdate().then(info => {
        if (!info.available) {
          ok(`up to date${info.currentCommit ? ` (${info.currentCommit.slice(0, 7)})` : " (dev build — no commit info embedded)"}`);
          return;
        }
        ok(`newer build available: ${info.currentCommit ? info.currentCommit.slice(0, 7) : "current"} → ${info.latestCommit.slice(0, 7)}`);
        dim("'update install to pull the latest source, build it, and install it in place — automatically, no download link");
      }).catch(() => err("update check failed — check your connection"));
    }});

  /** 'update install — replaces the running app in place (see
   *  PerformUpdate in selfupdate.go: source build first, prebuilt binary
   *  as a fallback, rollback on failure). A bare 'update only reports. */
  function runUpdateInstall(): void {
    info("checking for a newer build...");
    checkForUpdate().then(async checkInfo => {
      if (!checkInfo.available) {
        ok(`already up to date${checkInfo.currentCommit ? ` (${checkInfo.currentCommit.slice(0, 7)})` : ""} — nothing to install`);
        return;
      }
      info(`installing build ${checkInfo.latestCommit.slice(0, 7)} (currently on ${checkInfo.currentCommit ? checkInfo.currentCommit.slice(0, 7) : "unknown"})…`);
      dim("pulling latest source and building it — this rebuilds the whole app locally, so it can take a few minutes");
      // rawBinaryUrl is only used if building from source isn't
      // possible; PerformUpdate reports it if neither works.
      const [ok_, reason] = await performUpdate(checkInfo.rawBinaryUrl);
      if (!ok_) {
        err(`✗ update failed: ${reason} — your current install was left untouched`);
        return;
      }
      ok("✓ update installed — the new version has started, restarting now…");
      setTimeout(() => quitApp(), 800); // brief pause so the message above is actually visible before the window closes
    }).catch(e => err(`update check failed: ${e instanceof Error ? e.message : e}`));
  }

  // ── shell ─────────────────────────────────────────────
  registry.register({ name:"clear",   category:"shell", description:"Clear terminal output",
    handler:()=>_ctxRef.current?.clear() });

  registry.register({ name:"cls",     category:"shell", description:"Clear terminal output",
    handler:()=>_ctxRef.current?.clear() });

  registry.register({ name:"home",    category:"shell", description:"Return to OXIS home screen",
    handler:()=>_goHomeRef.current?.() });

  registry.register({ name:"run",     category:"shell", description:"Run raw command",
    handler:(_,r)=>{ if(!r){err("usage: 'run <cmd>");return;} ps(r); }});

  registry.register({ name:"env",     category:"shell", description:"Environment variables",
    handler:()=> ps(shellCmd(
      `Get-ChildItem Env: | Sort-Object Name | Format-Table Name,Value -AutoSize`,
      `env | sort`
    ))});

  registry.register({ name:"ps",      category:"shell", description:"Running processes",
    handler:()=> ps(shellCmd(
      `Get-Process | Sort-Object CPU -Descending | Select-Object -First 25 Name,Id,@{N='CPU';E={[math]::Round($_.CPU,1)}},@{N='RAM(MB)';E={[math]::Round($_.WorkingSet/1MB,0)}} | Format-Table -AutoSize`,
      `ps aux --sort=-%cpu | head -26`
    ))});

  registry.register({ name:"procs",   category:"shell", description:"Running processes",
    handler:()=> registry.execute("ps",[],"") });

  registry.register({ name:"kill",    category:"shell", description:"Kill process by PID or name",
    handler:(_,r)=>{ if(!r){err("usage: 'kill <pid|name>");return;}
      ps(shellCmd(
        isNaN(+r)
          ? `Stop-Process -Name "${r}" -Force -EA SilentlyContinue; Write-Host "killed: ${r}"`
          : `Stop-Process -Id ${r} -Force -EA SilentlyContinue; Write-Host "killed PID: ${r}"`,
        `kill ${isNaN(+r)?`$(pgrep "${r}")`:`${r}`} && echo "killed: ${r}"`
      )); }});

  registry.register({ name:"ip",      category:"shell", description:"Network addresses",
    handler:()=> ps(shellCmd(
      `Get-NetIPAddress | Where-Object{$_.AddressFamily -eq 'IPv4'} | Select-Object IPAddress,InterfaceAlias | Format-Table -AutoSize`,
      `ip addr show || ifconfig`
    ))});

  registry.register({ name:"disk",    category:"shell", description:"Disk usage",
    handler:()=> ps(shellCmd(
      `Get-PSDrive -PSProvider FileSystem | Where-Object{$_.Used -ne $null} | Select-Object Name,@{N='Used(GB)';E={[math]::Round($_.Used/1GB,1)}},@{N='Free(GB)';E={[math]::Round($_.Free/1GB,1)}},@{N='Total(GB)';E={[math]::Round(($_.Used+$_.Free)/1GB,1)}} | Format-Table -AutoSize`,
      `df -h`
    ))});

  registry.register({ name:"sysinfo", category:"shell", description:"System information",
    handler:()=> ps(shellCmd(
      `$o=Get-CimInstance Win32_OperatingSystem;$c=Get-CimInstance Win32_Processor|Select -First 1;Write-Host "OS:    $($o.Caption)";Write-Host "CPU:   $($c.Name)";Write-Host "Cores: $($c.NumberOfCores)/$($c.NumberOfLogicalProcessors) logical";Write-Host "RAM:   $([math]::Round($o.TotalVisibleMemorySize/1MB,1))GB total  $([math]::Round($o.FreePhysicalMemory/1MB,1))GB free";Write-Host "Host:  $($o.CSName)"`,
      `uname -a && lscpu | head -10 && free -h`
    ))});

  registry.register({ name:"which",   category:"shell", description:"Find command in PATH",
    handler:(_,r)=>{ if(!r){err("usage: 'which <cmd>");return;}
      ps(shellCmd(`Get-Command "${r}" -EA SilentlyContinue | Select-Object -ExpandProperty Source`,
                  `which "${r}"`)); }});

  registry.register({ name:"find",    category:"shell", description:"Search files by name",
    handler:(_,r)=>
      ps(shellCmd(
        `Get-ChildItem -Recurse -EA SilentlyContinue | Where-Object Name -like '*${r||""}*' | Select-Object -First 60 -ExpandProperty FullName`,
        `find . -name '*${r||""}*' 2>/dev/null | head -60`
      ))});

  registry.register({ name:"grep",    category:"shell", description:"Search file contents",
    handler:(a,_r)=>{ if(a.length<2){err("usage: 'grep <pattern> <file>");return;}
      ps(shellCmd(
        `Select-String -Pattern "${a[0]}" -Path "${a.slice(1).join(" ")}"`,
        `grep -rn "${a[0]}" ${a.slice(1).join(" ")}`
      )); }});

  registry.register({ name:"history", category:"shell", description:"Command history",
    handler:()=>{ history.recent(40).forEach((c,i)=>info(`${String(i+1).padStart(3)}  ${c}`)); }});

  registry.register({ name:"hist",    category:"shell", description:"Command history",
    handler:()=> registry.execute("history",[],"") });

  registry.register({ name:"ports",   category:"shell", description:"Listening ports",
    handler:()=> ps(shellCmd(
      `Get-NetTCPConnection | Where-Object State -eq 'Listen' | Sort-Object LocalPort | Select-Object LocalPort,@{N='Process';E={(Get-Process -Id $_.OwningProcess -EA SilentlyContinue).Name}} | Format-Table -AutoSize`,
      `ss -tlnp || netstat -tlnp 2>/dev/null | head -30`
    ))});

  registry.register({ name:"user",    category:"shell", description:"Current user",
    handler:()=> ps(shellCmd(`Write-Host "$env:USERDOMAIN\\$env:USERNAME"`, `whoami`)) });

  registry.register({ name:"path",    category:"shell", description:"PATH entries",
    handler:()=> ps(shellCmd(
      `$env:PATH -split ';' | ForEach-Object { Write-Host $_ }`,
      `echo $PATH | tr ':' '\n'`
    ))});

  registry.register({ name:"alias",   category:"shell", description:"Shell aliases",
    handler:()=> ps(shellCmd(
      `Get-Alias | Format-Table Name,ResolvedCommand -AutoSize | Select-Object -First 30`,
      `alias`
    ))});

  registry.register({ name:"open",    category:"shell", description:"Open file with default app",
    handler:(_,r)=>{ if(!r){err("usage: 'open <file>");return;}
      ps(shellCmd(`Start-Process "${r}"`,
                  `xdg-open "${r}" 2>/dev/null || open "${r}" 2>/dev/null`)); }});

  // ── theme ─────────────────────────────────────────────
  registry.register({ name:"theme",   category:"themes", description:"Manage themes",
    handler:(args,rest)=>{
      const all = themeManager.all();
      const cur = themeManager.getCurrent();
      if(!rest){ sep(); ctx.print("  Themes","accent"); sep();
        Object.keys(all).forEach(n=>ctx.print(`  ${n===cur?"●":"○"}  ${n}${n===cur?"  (active)":""}`,n===cur?"accent":"dim"));
        sep(); dim("'theme <name>  ·  'theme new <name>  ·  'theme delete <name>  ·  'theme export <name>  ·  'theme import <file>"); return; }
      if(args[0]==="new"){
        if(!args[1]){err("usage: 'theme new <name>");return;}
        events.emit("open_theme_editor",{name:args[1]}); return; }
      if(args[0]==="delete"||args[0]==="del"){
        if(!args[1]){err("usage: 'theme delete <name>");return;}
        if(themeManager.builtins()[args[1]]){err(`cannot delete built-in: ${args[1]}`);return;}
        themeManager.removeCustom(args[1]); ok(`theme deleted: ${args[1]}`); return; }
      if(args[0]==="export"){
        const j=themeManager.export(args[1]); if(j) ctx.print(j,"dim"); else err(`not found: ${args[1]}`); return; }
      if(args[0]==="import"){
        if(!args[1]){err("usage: 'theme import <file.json>");return;}
        void readFile(args[1]).then(json => {
          const r = themeManager.import(json);
          if(r.ok){ ok(`imported theme "${r.name}" — 'theme ${r.name} to use it`); events.emit("theme_changed",{name:themeManager.getCurrent()}); }
          else err(`import failed: ${r.error}`);
        }).catch(e => err(`couldn't read ${args[1]}: ${e instanceof Error ? e.message : e}`));
        return; }
      if(themeManager.apply(rest)) ok(`theme → ${rest}`);
      else err(`not found: '${rest}' — run 'theme to list`); }});

  // ── oxis (application settings) ───────────────────────────
  // 'oxis resize changes the native window size live (Go's
  // WindowSetSize) and saves it to window.json in the app folder, which
  // is read again on the next launch.
  const WINDOW_PRESETS: Record<string, [number, number]> = {
    small:   [800, 520],
    default: [940, 600],
    medium:  [1100, 700],
    large:   [1280, 800],
    xl:      [1600, 1000],
  };
  const parseSize = (args: string[]): [number, number] | null => {
    const joined = args.join(" ").trim().toLowerCase();
    if (WINDOW_PRESETS[joined]) return WINDOW_PRESETS[joined];
    const m = /^(\d{3,4})\s*[x×*, ]\s*(\d{3,4})$/.exec(joined);
    return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : null;
  };
  const presetList = () => Object.entries(WINDOW_PRESETS)
    .map(([n, [w, h]]) => `${n} ${w}×${h}`).join("  ·  ");

  // Opens window.json in the editor on its "width" line, creating it
  // from the current size first if it doesn't exist yet.
  const openWindowConfig = async (configPath: string, w: number, h: number) => {
    let text: string;
    try {
      text = await readFile(configPath);
    } catch {
      text = JSON.stringify({ width: w, height: h }, null, 2) + "\n";
      await writeFile(configPath, text);
    }
    const line = text.split(/\r?\n/).findIndex(l => l.includes('"width"')) + 1;
    _ctxRef.current?.openEditor(configPath, line > 0 ? line : 1);
    return line > 0 ? line : 1;
  };

  registry.register({ name:"oxis", category:"ui", description:"OXIS application settings — 'oxis resize",
    handler: async (args) => {
      const sub = args[0]?.toLowerCase();
      if (sub !== "resize") {
        sep();
        ctx.print("  'oxis resize                 — show the window size and presets","accent");
        ctx.print("  'oxis resize <preset>        — " + Object.keys(WINDOW_PRESETS).join(" | "),"accent");
        ctx.print("  'oxis resize <W>x<H>         — custom size, e.g. 'oxis resize 1200x760","accent");
        ctx.print("  'oxis resize config          — open window.json at the size setting","accent");
        sep(); return;
      }
      const rest = args.slice(1);

      if (!isNativeApp()) {
        sep();
        ctx.print(`  browser window: ${window.innerWidth} × ${window.innerHeight}`,"accent");
        dim("OXIS is running in a browser tab here, so its size is the browser window's —");
        dim("resize the browser itself. 'oxis resize controls the desktop app's window.");
        sep(); return;
      }

      let cur;
      try { cur = await windowGetSize(); }
      catch (e) { err(`couldn't read the window size: ${e instanceof Error ? e.message : e}`); return; }

      if (rest.length === 0) {
        sep();
        ctx.print(`  OXIS window: ${cur.width} × ${cur.height}`,"accent");
        dim(`presets: ${presetList()}`);
        dim("'oxis resize <preset>  ·  'oxis resize <W>x<H>  ·  'oxis resize config");
        dim(`saved in ${cur.configPath}`);
        sep(); return;
      }

      if (rest[0].toLowerCase() === "config" || rest[0].toLowerCase() === "edit") {
        try {
          const line = await openWindowConfig(cur.configPath, cur.width, cur.height);
          ok(`opened ${cur.configPath} at line ${line}`);
          dim(`change "width" and "height", save, then restart OXIS (or run 'oxis resize <W>x<H> to apply it now)`);
        } catch (e) { err(`couldn't open ${cur.configPath}: ${e instanceof Error ? e.message : e}`); }
        return;
      }

      const size = parseSize(rest);
      if (!size) { err(`unknown size "${rest.join(" ")}" — use a preset (${Object.keys(WINDOW_PRESETS).join(", ")}) or <width>x<height>`); return; }
      const [w, h] = size;
      if (w < 640 || h < 400 || w > 3840 || h > 2160) { err(`${w}×${h} is outside the supported range (640×400 – 3840×2160)`); return; }

      try {
        const res = await windowSetSize(w, h);
        if (res.width === w && res.height === h) {
          ok(`window resized to ${res.width} × ${res.height}`);
        } else {
          ctx.print(`  ⚠  asked for ${w} × ${h}, the window is now ${res.width} × ${res.height} (limited by the screen or window manager)`,"warn");
        }
        if (res.persisted) dim(`saved — OXIS will open at ${w} × ${h} next time`);
        else dim(`couldn't save ${res.configPath}, so the size resets on restart`);
      } catch (e) {
        err(`resize failed: ${e instanceof Error ? e.message : e}`);
        try {
          const line = await openWindowConfig(cur.configPath, cur.width, cur.height);
          dim(`opened ${cur.configPath} at line ${line} — set "width": ${w}, "height": ${h}, save, and restart OXIS`);
        } catch { /* nothing more to offer */ }
      }
    }});

  // ── plugins ───────────────────────────────────────────
  registry.register({ name:"plugin",  category:"plugins", description:"Manage plugins",
    handler:(args)=>{
      const sub=args[0]?.toLowerCase(); const name=args[1];
      const all=pluginManager.all();
      if(!sub||sub==="list"){
        sep(); ctx.print("  Plugins","accent"); sep();
        const cats=[...new Set(all.map(p=>p.category))];
        for(const cat of cats){
          ctx.print(`  ─ ${cat}`,"dim");
          all.filter(p=>p.category===cat).forEach(p=>
            ctx.print(`  ${p.enabled?"●":"○"}  ${p.name.padEnd(16)} ${p.desc}`,p.enabled?"accent":"dim"));
        }
        sep(); dim("'plugin enable <n>  ·  'plugin disable <n>  ·  'plugin reload <n>  ·  'plugin uninstall <n>  ·  'plugin info <n>  ·  'plugin validate <n>  ·  'plugin permissions <n>  ·  'plugin new <n>"); return; }
      if(sub==="enable"){
        if(!name){err("usage: 'plugin enable <name>");return;}
        if(name.toLowerCase()==="all"){
          const { enabled, alreadyOn, failed } = pluginManager.enableAll();
          if(enabled.length) ok(`enabled: ${enabled.join(", ")}`);
          if(alreadyOn.length) dim(`already on: ${alreadyOn.join(", ")}`);
          if(failed.length) err(`didn't load (see messages above): ${failed.join(", ")}`);
          if(!enabled.length && !alreadyOn.length && !failed.length) dim("no plugins registered");
          return; }
        if(!pluginManager.get(name)){ err(`not found: ${name}`); return; }
        pluginManager.enable(name);
        // enable() sets enabled=true optimistically, then load() may
        // set it straight back to false (exec error / undocumented
        // command) and print exactly why — check the real state
        // rather than assuming "found the plugin" means "it's working".
        if(pluginManager.get(name)?.enabled) ok(`${name} enabled`);
        else err(`${name} didn't load — see the message above for why`);
        return; }
      if(sub==="disable"){
        if(!name){err("usage: 'plugin disable <name>");return;}
        if(pluginManager.disable(name)) ok(`${name} disabled`); else err(`not found: ${name}`); return; }
      if(sub==="reload"){
        if(!name){err("usage: 'plugin reload <name>");return;}
        if(!pluginManager.get(name)){ err(`not found: ${name}`); return; }
        pluginManager.reload(name);
        if(pluginManager.get(name)?.enabled) ok(`${name} reloaded`);
        else err(`${name} didn't reload cleanly — see the message above for why`);
        return; }
      if(sub==="reloadall"){ pluginManager.reloadAll(); ok("all plugins reloaded"); return; }
      if(sub==="delete"||sub==="rm"||sub==="uninstall"){
        if(!name){err(`usage: 'plugin ${sub} <name>`);return;}
        const p=pluginManager.get(name);
        if(!p){ err(`not found: ${name}`); return; }
        if(p.builtin){ err(`${name} is a built-in plugin — 'plugin disable it instead`); return; }
        const force = args.includes("--force");
        pluginManager.remove(name, force).then(r => (r.ok?ok:err)(r.message));
        return; }
      if(sub==="info"){
        if(!name){err("usage: 'plugin info <name>");return;}
        const r = pluginManager.info(name);
        if(r.ok) ctx.printLines(r.text.split("\n").map(line => [line ? "  " + line : "", line ? "info" as LineKind : undefined]));
        else err(r.message);
        return; }
      if(sub==="docs"){
        if(!name){err("usage: 'plugin docs <name>");return;}
        const p = pluginManager.get(name);
        if(!p){ err(`not found: ${name}`); return; }
        const doc = p.manifest?.description;
        if(doc) { sep(); ctx.print(`  ${name}`,"accent"); sep(); dim(doc); sep(); }
        else dim(`${name} hasn't declared any documentation beyond its command descriptions — see 'help ${name}`);
        return; }
      if(sub==="validate"){
        if(!name){err("usage: 'plugin validate <name>");return;}
        const r = pluginManager.validate(name);
        if(r.ok){ ok(`${name}: no issues found`); return; }
        err(`${name}: ${r.issues.length} issue(s)`);
        r.issues.forEach(issue => dim(`  · ${issue}`));
        return; }
      if(sub==="test"){
        if(!name){err("usage: 'plugin test <name>");return;}
        const r = pluginManager.test(name);
        (r.ok?ok:err)(r.message);
        return; }
      if(sub==="doctor"){
        pluginManager.doctor().then(results => {
          sep(); info("Plugin Doctor"); sep();
          if(results.length === 0){ ok("no issues found across any installed plugin"); sep(); return; }
          const sevIcon = { error: "✗", warning: "⚠", info: "·" } as const;
          for(const r of results){
            ctx.print(`  ${r.name}`, "accent");
            for(const f of r.findings){
              ctx.print(`    ${sevIcon[f.severity]}  [${f.severity}]  ${f.message}`, f.severity === "error" ? "err" : f.severity === "warning" ? "warn" : "dim");
              if(f.suggestion) dim(`         → ${f.suggestion}`);
            }
          }
          sep();
          const errCount = results.reduce((n,r) => n + r.findings.filter(f=>f.severity==="error").length, 0);
          const warnCount = results.reduce((n,r) => n + r.findings.filter(f=>f.severity==="warning").length, 0);
          dim(`${errCount} error(s), ${warnCount} warning(s) across ${results.length} plugin(s) with findings`);
          sep();
        });
        return; }
      if(sub==="rollback"){
        if(!name){err("usage: 'plugin rollback <name>");return;}
        rollbackPlugin(name).then(r => (r.ok?ok:err)(r.message));
        return; }
      if(sub==="export"){
        if(!name){err("usage: 'plugin export <name> [path]");return;}
        const path = args[2] || `${name}.lua`;
        exportPluginSource(name).then(source => {
          if(source === null){ err(`no source available for ${name} (built-in, or not currently loaded)`); return; }
          return writeFile(path, source).then(() => ok(`${name} exported to ${path}`));
        }).catch(e => err(`export failed: ${e instanceof Error ? e.message : e}`));
        return; }
      if(sub==="publish"){
        if(!name){err(`usage: 'plugin publish <name> [--price=4.99 --interval=month] [--email=you@example.com] [update]`);return;}
        const check = checkPublishable(name);
        if(!check.ok || !check.metadata){
          err(`${name} isn't ready to publish (${check.issues.length} issue(s)):`);
          check.issues.forEach(issue => dim(`  · ${issue}`));
          dim(`fix these, then 'plugin publish ${name} again`);
          return;
        }
        const priceArg = args.find(a=>a.toLowerCase().startsWith("--price="));
        const intervalArg = args.find(a=>a.toLowerCase().startsWith("--interval="));
        const emailArg = args.find(a=>a.toLowerCase().startsWith("--email="));
        const price = priceArg?.split("=")[1];
        const interval = (intervalArg?.split("=")[1] || "month").toLowerCase();

        findExistingListing(name).then(existing => {
          if(!price){
            // Free plugin — opens a real GitHub PR for review, doesn't auto-merge.
            info(`opening a pull request for "${name}" on GitHub…`);
            return prepareFreePublish(check.metadata!, existing).then(result => {
              printResultLines(result.message, result.ok);
              if(result.pullRequestUrl){
                info("opening the pull request in your browser…");
                void openUrl(result.pullRequestUrl);
              }
            });
          }
          // Paid plugin.
          if(!["month","year"].includes(interval)){ err(`--interval must be "month" or "year" (got "${interval}")`); return; }
          const email = emailArg?.split("=")[1] || getLicensedEmail();
          if(!email){ err(`a paid listing needs an email for the Stripe Connect account — add --email=you@example.com`); return; }
          sep(); info(`Publishing "${name}" as a PAID plugin`); sep();
          dim(`$${price}/${interval} — paid OXIS Market plugins are recurring Stripe subscriptions, not one-time purchases.`);
          dim(`Revenue split: 75% to you, 25% to OXIS — handled automatically by Stripe Connect, same as OXIS's own paid plugins.`);
          info(`creating a Stripe Connect Express account for ${email}…`);
          return startConnectOnboarding(email).then(conn => {
            if(!conn.ok){ err(conn.message); return; }
            ok(conn.message);
            if(conn.onboardingUrl){
              info("opening the Stripe onboarding link in your browser…");
              void openUrl(conn.onboardingUrl);
            }
            info(`opening a pull request for "${name}" on GitHub…`);
            return submitPaidPlugin(check.metadata!, price, interval, conn.accountId || "", existing).then(result => {
              printResultLines(result.message, result.ok);
              if(result.pullRequestUrl){
                info("opening the pull request in your browser…");
                void openUrl(result.pullRequestUrl);
              }
            });
          }).catch(e => err(`Stripe Connect onboarding failed: ${e instanceof Error ? e.message : e}`));
        }).catch(e => err(`couldn't check the Market for an existing listing: ${e instanceof Error ? e.message : e}`));
        return; }
      if(sub==="unpublish"){
        if(!name){err(`usage: 'plugin unpublish <name>`);return;}
        const email = getLicensedEmail();
        const author = email || name; // best-effort — same "not real authentication" caveat as the backend check itself; see delete-plugin.js
        info(`opening a deletion pull request for "${name}" on GitHub…`);
        requestPluginDeletion(name, author).then(result => {
          printResultLines(result.message, result.ok);
          if(result.pullRequestUrl){
            info("opening the merge request in your browser…");
            void openUrl(result.pullRequestUrl);
          }
        }).catch(e => err(`couldn't reach the Market backend: ${e instanceof Error ? e.message : e}`));
        return; }
      if(sub==="new"){
        if(!name){err("usage: 'plugin new <name> [--template=basic|dev|devops|system]");return;}
        if(!/^[a-z0-9_-]+$/i.test(name)){ err("plugin name: letters, numbers, - _ only"); return; }
        const templateArg = args.find(a=>a.toLowerCase().startsWith("--template="));
        const template = templateArg ? templateArg.split("=")[1]?.toLowerCase() : undefined;
        const path = `${workspaceManager.pluginsDir()}/${name}.lua`;
        const existing = pluginManager.get(name);
        if(existing){
          dim(`"${name}" already exists — opening it for editing instead of overwriting it`);
          _ctxRef.current?.openEditor(path);
          return;
        }
        // Register, save and load it now so it works immediately; the
        // editor is just for customising it.
        pluginManager.addLuaPlugin(name, pluginTemplate(name, template), "plugin", "user").then(({ persisted, persistError }) => {
          if(persisted) ok(`created & loaded: ${name}`);
          else err(`created (this session only) — couldn't save to disk: ${persistError instanceof Error ? persistError.message : String(persistError ?? "unknown error")}`);
          _ctxRef.current?.openEditor(path);
        });
        return; }
      if(sub==="permissions"||sub==="perms"){
        // 'plugin permissions <name>                 — list grants
        // 'plugin permissions <name> grant  <ns>      — grant fs/process/net/system
        // 'plugin permissions <name> revoke <ns>      — revoke it
        if(!name){err("usage: 'plugin permissions <name> [grant|revoke <fs|process|net|system|workspace|editor|terminal|shell>]");return;}
        const action = args[2]?.toLowerCase();
        const ns = args[3]?.toLowerCase() as PermissionNamespace | undefined;
        // Must match PermissionNamespace in permissions.ts.
        const VALID: PermissionNamespace[] = ["fs","process","net","system","workspace","editor","terminal","shell"];
        if(action==="grant"||action==="revoke"){
          if(!ns || !VALID.includes(ns)){ err(`usage: 'plugin permissions ${name} ${action} <fs|process|net|system>`); return; }
          if(action==="grant") grantPermission(name, ns); else revokePermission(name, ns);
          ok(`${name}: ${ns} ${action==="grant"?"granted":"revoked"}`);
          return;
        }
        const granted = grantedPermissions(name);
        sep(); ctx.print(`  Permissions — ${name}`,"accent"); sep();
        for(const v of VALID) ctx.print(`  ${granted.includes(v)?"●":"○"}  ${v}`, granted.includes(v)?"accent":"dim");
        sep(); dim(`'plugin permissions ${name} grant <ns>  ·  'plugin permissions ${name} revoke <ns>`);
        return; }
      err(`unknown: 'plugin ${sub} — try list, enable, disable, reload, new, uninstall, info, docs, validate, test, doctor, rollback, export, publish, or permissions`); }});

  // ── plugin marketplace (oxis-market.pages.dev) ─────────
  registry.register({ name:"market",  category:"plugins", description:"Browse and install plugins from oxis-market.pages.dev",
    handler:(args)=>{
      const sub = args[0]?.toLowerCase();
      const rest = args.slice(1).join(" ");

      if (!sub || sub === "list") {
        market.fetchIndex().then(entries => {
          sep(); ctx.print(`  OXIS Market  ·  ${market.MARKET_BASE}`, "accent"); sep();
          if (!entries.length) { dim("(no plugins listed)"); sep(); return; }
          const cats = [...new Set(entries.map(e => e.category))];
          for (const cat of cats) {
            ctx.print(`  ─ ${cat}`, "dim");
            entries.filter(e => e.category === cat).forEach(e => {
              const badge = e.comingSoon ? "  (coming soon)" : e.premium ? `  (${e.priceDisplay || "premium"})` : "";
              ctx.print(`  ○  ${e.name.padEnd(16)} ${e.desc}${e.author ? `  (by ${e.author})` : ""}${badge}`, e.comingSoon ? "dim" : "dim");
            });
          }
          sep(); dim("'market install <n>  ·  'market search <query>  ·  'market info <n>  ·  'market open  ·  'market subscribe <n>  ·  'market license <email>");
        }).catch(e => err(`marketplace unreachable: ${e instanceof Error ? e.message : e}`));
        return;
      }

      if (sub === "search") {
        if (!rest) { err("usage: 'market search <query>"); return; }
        market.fetchIndex().then(entries => {
          const hits = market.searchIndex(entries, rest);
          sep(); ctx.print(`  Marketplace search: "${rest}"`, "accent"); sep();
          if (!hits.length) { dim("(no matches)"); sep(); return; }
          hits.forEach(e => ctx.print(`  ○  ${e.name.padEnd(16)} ${e.desc}`, "dim"));
          sep();
        }).catch(e => err(`marketplace unreachable: ${e instanceof Error ? e.message : e}`));
        return;
      }

      if (sub === "info") {
        const name = args[1];
        if (!name) { err("usage: 'market info <n>"); return; }
        market.findEntry(name).then(async entry => {
          if (!entry) { err(`not found in marketplace: ${name}`); return; }
          sep(); ctx.print(`  ${entry.name}`, "accent");
          dim(entry.desc);
          dim(`category: ${entry.category}${entry.version ? `  ·  v${entry.version}` : ""}${entry.author ? `  ·  by ${entry.author}` : ""}`);
          if (entry.premium) {
            dim(`${entry.priceDisplay || "premium"} — ${entry.comingSoon ? "coming soon, not purchasable yet" : "subscription"}`);
            if (!entry.comingSoon) {
              const count = await market.fetchSubscriberCount(entry.name);
              if (count !== null) dim(`${count} active subscriber${count === 1 ? "" : "s"}`);
              // count === null (network hiccup, KV not bound yet on
              // the Market backend) — say nothing rather than
              // guessing at a number that might be wrong.
            }
          }
          sep(); dim(`'market install ${entry.name}`);
        }).catch(e => err(`marketplace unreachable: ${e instanceof Error ? e.message : e}`));
        return;
      }

      if (sub === "install") {
        const name = args[1];
        if (!name) { err("usage: 'market install <n>"); return; }
        info(`installing ${name}…`);
        market.findEntry(name).then(entry => {
          if (!entry) { err(`not found in marketplace: ${name}`); return; }
          if (entry.comingSoon) { dim(`${name} isn't available yet — coming in a future update`); return; }
          if (entry.premium) {
            // Premium: verify the license, fetch the source, store it
            // encrypted and load it. `loaded` is checked because the
            // package can install while the plugin itself fails to load.
            market.installPremium(name)
              .then(({ loaded, loadMessage }) => {
                if (loaded) ok(`${name} installed & unlocked — 'plugin disable ${name} to turn off`);
                else err(`${name}'s package downloaded and is saved, but it didn't load: ${loadMessage} — 'plugin reload ${name} to retry without re-downloading`);
              })
              .catch(e => err(`premium install failed: ${e instanceof Error ? e.message : e}`));
            return;
          }
          market.install(name)
            .then(({ entry, persisted, persistError }) => {
              // load() has already run; report the plugin's real state
              // (a failed load already printed why).
              const p = pluginManager.get(entry.name);
              if (p?.enabled) {
                ok(`installed & enabled ${entry.name} — 'plugin disable ${entry.name} to turn off`);
                if (!persisted) {
                  dim(`  (works this session, but couldn't save to disk${persistError ? `: ${persistError}` : ""})`);
                }
              } else {
                err(`downloaded ${entry.name} but it didn't load — see the message above for why`);
              }
            })
            .catch(e => err(`install failed: ${e instanceof Error ? e.message : e}`));
        }).catch(e => err(`marketplace unreachable: ${e instanceof Error ? e.message : e}`));
        return;
      }

      if (sub === "update") {
        const name = args[1];
        if (!name) { err("usage: 'market update <name>  ·  or 'market update all"); return; }
        if (name.toLowerCase() === "all") {
          info("checking every Market-installed plugin for updates…");
          updateAllPlugins().then(results => {
            if (results.length === 0) { dim("no Market-installed plugins to update"); return; }
            sep(); info("Market Update — all"); sep();
            for (const r of results) (r.ok ? ok : err)(r.message);
            sep();
          });
          return;
        }
        info(`checking ${name} for an update…`);
        updatePlugin(name).then(r => (r.ok ? ok : err)(r.message));
        return;
      }

      // ── premium plugins — coming in v1.2.2, see README § OXIS
      // Market. The commands exist now (infrastructure is real —
      // Stripe Checkout, webhooks, KV licensing) but every listing is
      // marked comingSoon until account verification is complete.
      if (sub === "license") {
        const email = args[1];
        if (!email) {
          const cur = getLicensedEmail();
          info(cur ? `licensed email: ${cur}` : "no licensed email set — usage: 'market license <email>");
          return;
        }
        setLicensedEmail(email);
        ok(`licensed email set to ${email} — used to check premium plugin subscriptions`);
        return;
      }

      if (sub === "subscribe") {
        const name = args[1];
        if (!name) { err("usage: 'market subscribe <n>"); return; }
        market.findEntry(name).then(entry => {
          if (!entry) { err(`not found in marketplace: ${name}`); return; }
          if (!entry.premium) { err(`${name} is free — 'market install ${name}`); return; }
          if (entry.comingSoon) { dim(`${name} isn't available for subscription yet — coming in a future update`); return; }
          info(`starting checkout for ${name}…`);
          market.subscribe(name, getLicensedEmail() || undefined)
            .then(({ url }) => {
              ok(`opening checkout — complete it in your browser, then run 'market install ${name}`);
              void openUrl(url); // real system browser via Wails' BrowserOpenURL — see native.ts
            })
            .catch(e => err(`checkout failed: ${e instanceof Error ? e.message : e}`));
        }).catch(e => err(`marketplace unreachable: ${e instanceof Error ? e.message : e}`));
        return;
      }

      if (sub === "status") {
        const name = args[1];
        if (!name) { err("usage: 'market status <n>"); return; }
        checkLicense(name, { force: true }).then(r => {
          if (r.active) ok(`${name}: active (${r.status})`);
          else dim(`${name}: ${r.status}${r.error ? ` — ${r.error}` : ""}`);
        });
        return;
      }

      if (sub === "open") {
        void openUrl(market.MARKET_BASE);
        ok("opening the OXIS Market website — also bound to Ctrl+Shift+M");
        return;
      }

      err(`unknown: 'market ${sub}`); }});

  // ── task runner ───────────────────────────────────────
  registry.register({ name:"task",    category:"workspace", description:"Run a workspace task — 'task commit <message> is a direct built-in, see 'help task",
    handler:(args)=>{
      const name=args[0];
      if(!name){info("Usage: 'task <name>"); return;}
      // "commit" is a built-in, not a workspace task (see
      // runCommitTask), so it is always listed first.
      if(name.toLowerCase()==="commit"){
        const message = args.slice(1).join(" ").trim();
        void runCommitTask(message);
        return;
      }
      if(!registry.execute(`task:${name}`,args.slice(1),args.slice(1).join(" ")))
        err(`task not found: ${name}`); }});

  /** 'task commit <message> — the ONLY way to commit now (see the
   *  registration above). Calls commitAll() directly, no shell/task
   *  indirection to go wrong, with real progress/success/failure
   *  reporting at every step rather than silent shell output. */
  async function runCommitTask(message: string): Promise<void> {
    if(!message){ err(`usage: 'task commit <message> — a commit message is required`); return; }
    const dir = await workspaceManager.getActiveExternalPath();
    if(!dir){ err(`no project connected — 'workspace link a directory, or 'workspace github/gitlab to set one up`); return; }
    info(`committing in ${dir}…`);
    try {
      const result = await commitAll(dir, message, step => info(step));
      if(result.ok){
        const lines: Array<[string, LineKind?]> = [
          [`  ✓  committed${result.hash ? ` (${result.hash})` : ""}: ${message}`, "ok"],
        ];
        if (result.pushed) {
          lines.push(["  ✓  pushed to origin", "ok"]);
        } else if (/push failed/.test(result.message)) {
          // commitAll folds the push failure into its own message
          // string (see its own doc comment) — pull just that part
          // back out for its own clearly-marked line instead of one
          // long run-on sentence.
          const pushPart = result.message.split("committed locally, but push failed: ")[1];
          lines.push([`  ⚠  committed locally, but push failed: ${pushPart ?? "unknown reason"}`, "warn"]);
        } else {
          lines.push(["     (no remote configured — commit-only; 'workspace github/gitlab to add one)", "dim"]);
        }
        ctx.printLines(lines);
        events.emit("filetree_refresh", {});
      } else {
        err(`✗ commit failed: ${result.message}`);
      }
    } catch(e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Ctrl+C during a commit rejects with "... was cancelled";
      // report that as a cancellation, not a failure.
      if (/was cancelled/i.test(msg)) {
        info("commit cancelled");
      } else {
        err(`✗ commit failed: ${msg}`);
      }
    }
  }

  // ── workspace ─────────────────────────────────────────
  // Named workspaces (init "name", list, switch, rename, delete, link,
  // unlink) sit on top of the plain .oxis/workspace.lua loader that
  // bare 'workspace init / info / reload / close use.
  registry.register({ name:"workspace", category:"workspace", description:"Manage OXIS workspaces",
    handler:(args)=>{
      const sub = args[0]?.toLowerCase();
      if(!sub || sub==="info"){
        const r = workspaceManager.info();
        r.message.split("\n").forEach(line => (r.ok?info:dim)(line));
        if(r.ok && workspaceManager.getActiveNamed()){
          workspaceManager.listNamed().then(list => {
            const entry = list.find(w => w.name === workspaceManager.getActiveNamed());
            if(entry?.externalPath) dim(`linked to: ${entry.externalPath}`);
          });
        }
        if(!r.ok) dim(`'workspace init "name" to create one`);
        return; }
      if(sub==="init"){
        const name = args[1];
        if(name){
          workspaceManager.createNamed(name).then(r => (r.ok?ok:err)(r.message));
        } else {
          workspaceManager.initWorkspace(cwdTracker.get() || ".").then(r => (r.ok?ok:err)(r.message));
        }
        return; }
      if(sub==="list" || sub==="ls"){
        workspaceManager.listNamed().then(list => {
          if(!list.length){ dim("no named workspaces yet — 'workspace init \"name\" to create one"); return; }
          const active = workspaceManager.getActiveNamed();
          list.forEach(w => {
            const mark = w.name === active ? "* " : "  ";
            info(`${mark}${w.name}${w.externalPath ? `  → ${w.externalPath}` : ""}`);
          });
        });
        return; }
      if(sub==="switch" || sub==="use"){
        workspaceManager.switchNamed(args[1] ?? null).then(r => (r.ok?ok:err)(r.message));
        return; }
      if(sub==="rename" || sub==="mv"){
        if(!args[1] || !args[2]){ err(`usage: 'workspace rename <old> <new>`); return; }
        workspaceManager.renameNamed(args[1], args[2]).then(r => (r.ok?ok:err)(r.message));
        return; }
      if(sub==="delete" || sub==="rm" || sub==="remove"){
        if(!args[1]){ err(`usage: 'workspace delete <name>`); return; }
        workspaceManager.removeNamed(args[1]).then(r => (r.ok?ok:err)(r.message));
        return; }
      if(sub==="link"){
        if(!args[1]){ err(`usage: 'workspace link "<path>"`); return; }
        workspaceManager.linkExternal(args[1]).then(r => (r.ok?ok:err)(r.message));
        return; }
      if(sub==="unlink"){
        workspaceManager.unlinkExternal().then(r => (r.ok?ok:err)(r.message));
        return; }
      if(sub==="newfile"){
        const rel = args[1];
        if(!rel){ err(`usage: 'workspace newfile <relative-path>`); return; }
        workspaceManager.getActiveExternalPath().then(extPath => {
          if(!extPath){ err(`no connected project directory — 'workspace link "<path>" first`); return; }
          const safePath = safeJoinWithinDir(extPath, rel);
          if(!safePath){ err(`invalid path: "${rel}" — must stay inside the connected directory (no absolute paths or ".." that escapes it)`); return; }
          return statPath(safePath).then(stat => {
            if(stat.exists){ err(`already exists: ${safePath}`); return; }
            return writeFile(safePath, "").then(() => {
              ok(`created ${safePath}`);
              events.emit("filetree_refresh", {});
              _ctxRef.current?.openEditor(safePath);
            });
          });
        }).catch(e => err(`couldn't create the file: ${e instanceof Error ? e.message : e}`));
        return; }
      if(sub==="newdir"){
        const rel = args[1];
        if(!rel){ err(`usage: 'workspace newdir <relative-path>`); return; }
        workspaceManager.getActiveExternalPath().then(extPath => {
          if(!extPath){ err(`no connected project directory — 'workspace link "<path>" first`); return; }
          const safePath = safeJoinWithinDir(extPath, rel);
          if(!safePath){ err(`invalid path: "${rel}" — must stay inside the connected directory (no absolute paths or ".." that escapes it)`); return; }
          return statPath(safePath).then(stat => {
            if(stat.exists){ err(`already exists: ${safePath}`); return; }
            return makeDir(safePath).then(() => { ok(`created ${safePath}/`); events.emit("filetree_refresh", {}); });
          });
        }).catch(e => err(`couldn't create the directory: ${e instanceof Error ? e.message : e}`));
        return; }
      if(sub==="move"){
        const srcRel = args[1], dstRel = args[2];
        if(!srcRel || !dstRel){ err(`usage: 'workspace move <file> <directory>`); return; }
        workspaceManager.getActiveExternalPath().then(async extPath => {
          if(!extPath){ err(`no connected project directory — 'workspace link "<path>" first`); return; }
          const srcPath = safeJoinWithinDir(extPath, srcRel);
          const dstDirPath = safeJoinWithinDir(extPath, dstRel);
          if(!srcPath || !dstDirPath){ err(`invalid path — both must stay inside the connected directory`); return; }
          const srcStat = await statPath(srcPath);
          if(!srcStat.exists){ err(`not found: ${srcPath}`); return; }
          const dstDirStat = await statPath(dstDirPath);
          if(!dstDirStat.exists || !dstDirStat.isDir){ err(`not a directory: ${dstDirPath}`); return; }
          const baseName = srcPath.split(/[\\/]/).pop();
          const finalDst = `${dstDirPath}/${baseName}`;
          return movePath(srcPath, finalDst).then(() => {
            ok(`moved ${srcRel} → ${dstRel}/${baseName}`);
            events.emit("filetree_refresh", {});
          });
        }).catch(e => err(`move failed: ${e instanceof Error ? e.message : e}`));
        return; }
      if(sub==="github" || sub==="gitlab"){
        const provider: GitProvider = sub;
        const repoInput = args[1];
        const force = args.includes("--force");
        // `'workspace github unlink` (or gitlab): disconnect origin —
        // renamed to a backup by default, removed with --remove-remote —
        // leaving the project, workspace and .git repo untouched.
        if(repoInput === "unlink"){
          const removeCompletely = args.includes("--remove-remote");
          workspaceManager.getActiveExternalPath().then(extPath => {
            if(!extPath){ err(`no connected project directory — 'workspace link "<path>" first`); return; }
            return unlinkRemote(extPath, removeCompletely).then(r => (r.ok?ok:err)(r.message));
          }).catch(e => err(`couldn't unlink: ${e instanceof Error ? e.message : e}`));
          return;
        }
        if(!repoInput){ err(`usage: 'workspace ${provider} <owner/repo or full URL> [--force]  ·  or 'workspace ${provider} unlink [--remove-remote]`); return; }
        workspaceManager.getActiveExternalPath().then(extPath => {
          if(!extPath){ err(`no connected project directory — 'workspace link "<path>" first`); return; }
          return setupRemote(extPath, provider, repoInput, force).then(async r => {
            if(r.needsConfirmation){
              err(r.message);
              dim(`run 'workspace ${provider} ${repoInput} --force to replace it`);
              return;
            }
            (r.ok?ok:err)(r.message);
            if(r.ok) dim(`'task commit <message> is ready to use for this project`);
          });
        }).catch(e => err(`couldn't set up ${provider}: ${e instanceof Error ? e.message : e}`));
        return; }
      if(sub==="export"){
        const wsName = args[1];
        if(!wsName){ err(`usage: 'workspace export <name> [path]`); return; }
        const path = args[2] || `${wsName}.oxisworkspace.json`;
        exportWorkspace(wsName).then(data => {
          if(!data){ err(`no such workspace: ${wsName}`); return; }
          return writeFile(path, JSON.stringify(data, null, 2)).then(() => ok(`workspace "${wsName}" exported to ${path}`));
        }).catch(e => err(`export failed: ${e instanceof Error ? e.message : e}`));
        return; }
      if(sub==="import"){
        const path = args[1];
        if(!path){ err(`usage: 'workspace import <path> [new-name]`); return; }
        readFile(path).then(raw => importWorkspace(JSON.parse(raw), args[2]))
          .then(r => (r.ok?ok:err)(r.message))
          .catch(e => err(`import failed: ${e instanceof Error ? e.message : e}`));
        return; }
      if(sub==="reload"){
        workspaceManager.reload(args[1]).then(r => (r.ok?ok:err)(r.message));
        return; }
      if(sub==="close"){
        const r = workspaceManager.close();
        (r.ok?ok:err)(r.message);
        return; }
      err(`unknown: 'workspace ${sub} — try init, list, switch, rename, delete, link, unlink, newfile, newdir, move, github, gitlab, export, import, info, reload, or close`); }});

  // ── project ───────────────────────────────────────────
  // 'project init/open/run/task/workflow: a project is a folder with a
  // full .oxis/ setup; these wrap the same loader, task and workflow
  // machinery as 'workspace and 'workflow.
  registry.register({ name:"project", category:"workspace", description:"Set up and run an external project's own .oxis/ environment",
    handler:(args)=>{
      const sub = args[0]?.toLowerCase();
      const dir = (sub === "init" || sub === "open") ? (args[1] || cwdTracker.get() || ".") : "";
      if(!sub || sub==="open"){
        workspaceManager.load(dir || cwdTracker.get() || ".").then(r => {
          (r.ok?ok:err)(r.message);
          if(r.ok) dim("'project task / 'project workflow to see what's available · 'project run <name> to run one");
        });
        return; }
      if(sub==="init"){
        workspaceManager.initProject(dir).then(r => (r.ok?ok:err)(r.message));
        return; }
      if(sub==="run"){
        const name = args[1];
        if(!name){ err("usage: 'project run <name>"); return; }
        if(workflowRunner.get(name)){
          workflowRunner.run(name, { sendToShell: (data) => _ctxRef.current?.send(data), print: (t,k) => _ctxRef.current?.print(t,k) })
            .catch(e => err(`workflow ${name} crashed: ${e instanceof Error ? e.message : e}`));
          return;
        }
        if(registry.get(`task:${name}`)){
          registry.execute(`task:${name}`, [], "");
          return;
        }
        err(`no task or workflow named "${name}" in the active project — 'project task / 'project workflow to see what's available`);
        return; }
      if(sub==="task"){
        const tasks = workspaceState.taskNames();
        if(!tasks.length){ dim("no tasks defined — add oxis.task(...) to .oxis/workspace.lua or a .oxis/tasks/*.lua file"); return; }
        sep(); info("Project tasks"); sep();
        tasks.forEach(t => info(t));
        sep(); dim("'project run <name>  ·  or 'task <name> directly"); return; }
      if(sub==="workflow"){
        registry.execute("workflow", ["list"], "list");
        return; }
      err(`unknown: 'project ${sub} — try init, open, run, task, or workflow`); }});

  // ── workflow ──────────────────────────────────────────
  // 'workflow list / <name> / info <name> / cancel (workflowRunner.ts).
  // Workflows come from the active workspace's workflows/*.lua.
  registry.register({ name:"workflow", category:"workspace", description:"Run a workspace workflow",
    handler:(args)=>{
      const sub = args[0]?.toLowerCase();
      if(!sub || sub==="list"){
        const all = workflowRunner.all();
        if(!all.length){ dim("no workflows loaded — switch to a workspace with a workflows/ folder ('workspace switch <name>), or add one"); return; }
        sep(); info("Workflows"); sep();
        all.forEach(w => info(`${w.name === workflowRunner.currentlyRunning() ? "▶" : "○"}  ${w.name.padEnd(16)} ${w.description}`));
        sep(); dim("'workflow <name>  ·  'workflow info <name>  ·  'workflow cancel"); return; }
      if(sub==="cancel"){
        if(!workflowRunner.isRunning()){ dim("no workflow is currently running"); return; }
        workflowRunner.cancel(); scriptRunTracker.cancel(); _ctxRef.current?.send("\x03");
        ok(`cancelling ${workflowRunner.currentlyRunning()}...`); return; }
      if(sub==="info"){
        const name = args[1];
        if(!name){ err("usage: 'workflow info <name>"); return; }
        const w = workflowRunner.get(name);
        if(!w){ err(`not found: ${name}`); return; }
        sep(); info(w.name); sep();
        if(w.description) dim(w.description);
        if(Object.keys(w.env).length) dim(`env: ${Object.entries(w.env).map(([k,v])=>`${k}=${v}`).join(", ")}`);
        const describeStep = (s: typeof w.steps[number]): string =>
          s.parallel ? `parallel (${s.parallel.length} steps)` : s.task ? `task: ${s.task}` : s.command ? `command: '${s.command}` : s.run ? `run: ${s.run.split("\n")[0]}` : "?";
        w.steps.forEach((s,i) => info(`${i+1}. ${describeStep(s)}${s.continueOnError ? "  (continue on error)" : ""}${s.retry ? `  (retry ${s.retry})` : ""}`));
        return; }
      // Anything else is treated as a workflow name to run — 'workflow build, 'workflow deploy, etc.
      const name = sub;
      if(!workflowRunner.get(name)){ err(`no such workflow: ${name} — 'workflow list to see what's loaded`); return; }
      workflowRunner.run(name, { sendToShell: (data) => _ctxRef.current?.send(data), print: (t,k) => _ctxRef.current?.print(t,k) })
        .catch((e) => err(`workflow ${name} crashed: ${e instanceof Error ? e.message : e}`)); }});

  // ── config / settings ─────────────────────────────────
  // Themes are managed by 'theme, not here.
  const configHandler: CommandHandler = (args) => {
    const sub = args[0]?.toLowerCase();
    if(!sub || sub==="list"){
      sep(); info("Settings"); sep();
      for(const def of SETTINGS){
        const val = getSetting(def.key);
        info(`${def.key.padEnd(20)} = ${String(val).padEnd(10)} ${def.description}${def.choices ? `  [${def.choices.join("|")}]` : ""}`);
      }
      sep(); dim("theme is managed separately — see 'theme");
      dim("'config set <key> <value>  ·  'config get <key>  ·  'config reset <key>");
      dim("'config edit  ·  'config reload   (~/.oxis/config.lua and ~/.oxis/themes/)"); return; }
    if(sub==="reload"){
      void reportUserConfig(true); return; }
    if(sub==="edit"){
      if(!isNativeApp()){ err("~/.oxis/config.lua needs the desktop app"); return; }
      void userConfigDir().then(async dir => {
        const path = `${dir.replace(/\\/g, "/")}/config.lua`;
        const st = await statPath(path);
        if(!st.exists) await writeFile(path, USER_CONFIG_TEMPLATE);
        _ctxRef.current?.openEditor(path);
        dim(`editing ${path} — save, then 'config reload`);
      }).catch(e => err(`couldn't open config.lua: ${e instanceof Error ? e.message : e}`));
      return; }
    if(sub==="get"){
      const key = args[1];
      if(!key){ err("usage: 'config get <key>"); return; }
      const def = settingDef(key);
      if(!def){ err(`unknown setting: ${key} — 'config list to see all`); return; }
      info(`${def.key} = ${getSetting(def.key)}`); return; }
    if(sub==="set"){
      const key = args[1], value = args.slice(2).join(" ");
      if(!key || !value){ err("usage: 'config set <key> <value>"); return; }
      const r = setSetting(key, value);
      (r.ok?ok:err)(r.message); return; }
    if(sub==="reset"){
      const key = args[1];
      if(!key){ err("usage: 'config reset <key>"); return; }
      const r = resetSetting(key);
      (r.ok?ok:err)(r.message); return; }
    if(sub==="export"){
      const path = args[1] || "oxis-config.json";
      writeFile(path, JSON.stringify(exportSettings(), null, 2))
        .then(() => ok(`settings exported to ${path}`))
        .catch(e => err(`export failed: ${e instanceof Error ? e.message : e}`));
      return; }
    if(sub==="import"){
      const path = args[1];
      if(!path){ err("usage: 'config import <path>"); return; }
      readFile(path).then(raw => {
        const r = importSettings(JSON.parse(raw));
        applyAllSettings(); // make the imported values take effect immediately, not just after a restart
        ok(`imported ${r.count} setting(s) from ${path}`);
      }).catch(e => err(`import failed: ${e instanceof Error ? e.message : e}`));
      return; }
    err(`unknown: 'config ${sub} — try list, get, set, reset, export, or import`);
  };
  registry.register({ name:"config", category:"system", description:"View or change OXIS settings", handler: configHandler });
  registry.register({ name:"settings", category:"system", description:"Alias for 'config", handler: configHandler });

  // ── history management ────────────────────────────────
  registry.register({ name:"histclear", category:"shell", description:"Clear command history",
    handler:()=>{ history.clear(); ok("history cleared"); }});

  // ── version / help ────────────────────────────────────
  registry.register({ name:"version", category:"info", description:"Version info",
    handler:()=>{ sep(); ctx.print("  OXIS  v1.2.1","accent");
      dim(`  Platform: ${isWindows()?"Windows / PowerShell":"Linux / bash"}`);
      dim("  Lua extensible · Browser rendered · Single binary");
      dim("  TERMINALS WERE THE BEGINNING."); sep(); }});

  registry.register({ name:"v",       category:"info", description:"Version info",
    handler:()=> registry.execute("version",[],"") });

  // ── diagnostics ────────────────────────────────────────
  // Local only; nothing is sent anywhere.

  // ── git ──────────────────────────────────────────────────
  // Committing is 'task commit <message> (see 'task above).

  registry.register({ name:"diagnostics", category:"info", description:"Local diagnostic info — version, OS, runtime, plugins, workspace, recent errors ('diagnostics clear to reset the error log)",
    handler:(args)=>{
      if(args[0]?.toLowerCase()==="clear"){
        // 'diagnostics clear empties the recorded error list.
        clearRecentErrors();
        ok("recent-errors log cleared");
        return;
      }
      sep(); info("Diagnostics"); sep();
      info(`OXIS version:     1.2.1`);
      info(`OS:                ${isWindows() ? "Windows" : "Linux/Unix"}`);
      info(`Runtime:           ${isNativeApp() ? "native (Wails desktop app)" : "browser"}`);
      const all = pluginManager.all();
      const enabled = all.filter(p => p.enabled);
      info(`Plugins:           ${enabled.length}/${all.length} enabled`);
      const active = workspaceManager.getActiveNamed();
      info(`Active workspace:  ${active || "default (no named workspace active)"}`);
      info("");
      const recent = getRecentErrors();
      if (recent.length === 0) {
        dim("Recent errors: none recorded this session");
      } else {
        dim(`Recent errors (${recent.length}, most recent last):`);
        for (const e of recent.slice(-10)) {
          const t = new Date(e.time).toLocaleTimeString();
          ctx.print(`  [${t}] [${e.source}]  ${e.message.split("\n")[0]}`, "err");
        }
      }
      sep(); dim("This is purely local — nothing on this screen is ever transmitted anywhere.");
      dim("'plugin doctor for a focused check of installed plugins specifically."); dim("'diagnostics clear to reset the recent-errors log."); sep();
    }});

  // ── backup / restore ──────────────────────────────────────
  // Plain JSON (no zip library here); see backup.ts for what's included.
  registry.register({ name:"backup", category:"system", description:"Back up settings, workspaces, documents, and your own plugins to one file",
    handler:(_,r)=>{
      const path = r || "oxis-backup.json";
      info("gathering everything for backup…");
      createFullBackup().then(data => writeFile(path, JSON.stringify(data, null, 2)))
        .then(() => ok(`backup written to ${path}`))
        .catch(e => err(`backup failed: ${e instanceof Error ? e.message : e}`));
    }});

  registry.register({ name:"restore", category:"system", description:"Restore a backup made with 'backup — overwrites matching files, asks first",
    handler:(_,r)=>{
      if(!r){ err("usage: 'restore <path>"); return; }
      if(!confirm(`Restore from ${r}? This will overwrite any settings/workspace files/documents/plugins with the same name as what's in the backup. Anything else is left alone.`)) {
        dim("restore cancelled"); return;
      }
      info(`restoring from ${r}…`);
      readFile(r).then(raw => restoreFullBackup(JSON.parse(raw)))
        .then(res => {
          if(!res.ok){ err(res.message); return; }
          const [first, ...rest] = res.message.split("\n");
          ok(first);
          rest.forEach(line => info(line));
        })
        .catch(e => err(`restore failed: ${e instanceof Error ? e.message : e}`));
    }});

  registry.register({ name:"help",    category:"info", description:"All commands — 'help <command> for details on one, 'help <plugin> for a plugin's commands",
    handler:(args)=>{
      const query = args[0];
      if (query) {
        // 1. A command with real subcommand structure (see COMMAND_DETAILS).
        const detail = COMMAND_DETAILS[query.toLowerCase()];
        if (detail) {
          sep(); ctx.print(`  '${query}`, "accent"); sep();
          dim(detail.summary); info("");
          for (const u of detail.usage) h(u.syntax, u.description);
          if (detail.examples?.length) {
            info(""); dim("examples:");
            for (const ex of detail.examples) dim(`  ${ex}`);
          }
          if (detail.notes) { info(""); dim(detail.notes); }
          sep(); return;
        }
        // 2. A plugin name — every command it registers.
        const p = pluginManager.get(query);
        if (p) {
          const cmds = registry.all()
            .filter(c => c.fromPlugin === query)
            .sort((a, b) => a.name.localeCompare(b.name));
          sep(); ctx.print(`  ${p.name}  —  ${p.desc}`, "accent"); sep();
          if (!p.enabled) { dim(`plugin is disabled — run 'plugin enable ${p.name} to see its commands`); sep(); return; }
          if (!cmds.length) { dim("(this plugin registers no commands)"); sep(); return; }
          for (const c of cmds) {
            const label = c.name.startsWith("task:") ? `'task ${c.name.slice(5)}` : `'${c.name}`;
            h(label, c.description === UNDOCUMENTED_SENTINEL ? "(no description provided)" : c.description);
          }
          sep(); return;
        }
        // 3. A plain single-verb command — whatever's actually in the
        // registry, not a hardcoded copy of it. Covers every builtin
        // ('ls, 'cat, ...) and any plugin command by its own name.
        const entry = registry.get(query) ?? registry.get(query.replace(/^'/, ""));
        if (entry) {
          sep(); ctx.print(`  '${entry.name}`, "accent"); sep();
          info(entry.description === UNDOCUMENTED_SENTINEL ? "(no description provided)" : entry.description);
          dim(`category: ${entry.category}${entry.fromPlugin ? `  ·  from plugin: ${entry.fromPlugin}` : ""}`);
          sep(); return;
        }
        err(`no such command or plugin: ${query}\ntry 'help with no arguments to see everything, or 'plugin list / 'market search to find a plugin`);
        return;
      }
      sep(); ctx.print("  OXIS commands  (prefix: ')","accent"); sep();
      dim("'help <command>   — details + every way to use one command (e.g. 'help workspace)");
      dim("'help <plugin>    — one plugin's commands (e.g. 'help git)");
      dim("'? or 'help       — this list"); info("");
      h("── files ────────────────────────────","");
      h("'ls [dir]","list directory"); h("'cd [dir]","change directory"); h("'pwd","current path");
      h("'cat <f>","read file"); h("'new / 'touch <f>","create file"); h("'mkdir <d>","create directory");
      h("'rm <p>","delete"); h("'cp <s> <d>","copy"); h("'mv <s> <d>","move/rename");
      h("'write <f> [text]","write file"); h("'append <f> <text>","append to file");
      h("'edit <f>","built-in editor"); h("'hash <f>","SHA256"); h("'size <p>","disk size"); h("'update","check for a newer release");
      info(""); h("── shell ─────────────────────────────","");
      h("'clear","clear output"); h("'run <cmd>","raw command"); h("'env","env vars");
      h("'ps","processes"); h("'kill <pid|name>","kill process"); h("'ip","network");
      h("'disk","disk usage"); h("'sysinfo","system info"); h("'which <cmd>","find command");
      h("'find [pat]","search files"); h("'grep <pat> <f>","search contents");
      h("'history","recent commands"); h("'histclear","clear history"); h("'ports","open ports");
      h("'user","current user"); h("'path","PATH entries"); h("'open <f>","open with default app");
      info(""); h("── home screen ──────────────────────","");
      h("'hide workspace","hide the WORKSPACE panel on Home"); h("'show workspace","show it again");
      info(""); h("── oxis ──────────────────────────────","");
      h("'oxis resize","show the window size and presets"); h("'oxis resize <preset|W>x<H>","resize the window now (saved for next launch)");
      h("'oxis resize config","open window.json at the size setting");
      info(""); h("── themes ────────────────────────────","");
      h("'theme","list themes"); h("'theme <name>","switch theme");
      h("'theme new <n>","visual theme editor"); h("'theme delete <n>","delete custom theme");
      h("'theme export <n>","print a theme as JSON"); h("'theme import <file>","add a theme from a JSON file");
      info(""); h("── plugins ───────────────────────────","");
      h("'plugin list","all plugins + status"); h("'plugin enable <n>","enable");
      h("'plugin enable all","enable every plugin"); h("'plugin disable <n>","disable"); h("'plugin reload <n>","reload");
      h("'plugin new <n> [--template=basic|dev|devops|system]","create Lua plugin in-app");
      h("'plugin delete <n>","delete a user/market plugin's file");
      h("'plugin uninstall <n> [--force]","same as delete, but refuses if another plugin depends on it");
      h("'plugin info <n>","full metadata: version, permissions, dependencies");
      h("'plugin validate <n>","check a plugin's manifest/deps/compatibility without loading it");
      h("'plugin test <n>","actually load it and report what it registered");
      h("'plugin doctor","check every installed plugin at once — errors vs warnings, with suggested fixes");
      h("'plugin rollback <n>","restore the backup from the last 'market update, any time after it");
      h("'plugin docs <n>","a plugin's own documentation, if it declares any");
      h("'plugin export <n> [path]","export a plugin's .lua source to a file");
      h("'plugin publish <n> [--price --interval --email] [update]","open a GitHub pull request to add it to the Market — reviewed/merged by a human, not live automatically; see 'help plugin");
      h("'plugin unpublish <n>","open a GitHub pull request to remove it from the Market — same human-reviewed model as publishing");
      h("'plugin permissions <n>","see/grant/revoke fs, process, net, system, workspace, editor, terminal");
      h("'help <n>","show one plugin's commands + what they do");
      h("'market list","browse the free OXIS Market"); h("'market search <q>","search the Market");
      h("'market info <n>","plugin details"); h("'market install <n>","install a Market plugin");
      h("'market update <n>","update one Market-installed plugin — checks compat/deps first, auto-rolls-back on failure");
      h("'market update all","update every Market-installed plugin with an available compatible update");
      info(""); h("── workspace ─────────────────────────","");
      h("'workspace init","create .oxis/workspace.lua in this directory");
      h("'workspace init \"name\"","create a NAMED workspace (workspaces/<name>/)");
      h("'workspace list","list named workspaces"); h("'workspace switch <name>","activate one");
      h("'workspace rename <old> <new>","rename a named workspace"); h("'workspace delete <name>","delete one");
      h("'workspace link \"<path>\"","connect the active workspace to an external project dir");
      h("'workspace unlink","remove that link");
      h("'workspace newfile <relative-path>","create a file inside the connected external directory, opens it in the Editor");
      h("'workspace newdir <relative-path>","create a directory inside the connected external directory");
      h("'workspace move <file> <directory>","move a file to a directory in the connected project — or just drag it in the file tree");
      h("'workspace github <owner/repo>","configure the connected project's GitHub remote (real git, --force to overwrite)");
      h("'workspace gitlab <owner/repo>","same, for GitLab");
      h("'workspace github unlink","disconnect the git remote without deleting anything local — 'help workspace for the full syntax");
      h("'workspace export <n> [path]","export one workspace (its real files) to a JSON file");
      h("'workspace import <path> [name]","import one — creates a NEW workspace, never overwrites");
      h("'workspace info","show the active workspace's state");
      h("'workspace reload","re-run .oxis/workspace.lua");
      h("'workspace close","unload the active workspace");
      h("'task <name>","run a workspace task (see .oxis/workspace.lua)");
      info(""); h("── project ───────────────────────────","");
      h("'project init [dir]","set up a full .oxis/ project environment in a directory");
      h("'project open [dir]","load a directory's .oxis/workspace.lua + project.lua + tasks/workflows");
      h("'project run <name>","run a task or workflow by name");
      h("'project task","list the active project's tasks");
      h("'project workflow","list the active project's workflows");
      info(""); h("── workflow ──────────────────────────","");
      h("'workflow list","list workflows loaded from the active workspace");
      h("'workflow <name>","run one, e.g. 'workflow build");
      h("'workflow info <name>","show its steps without running it");
      h("'workflow cancel","stop whichever workflow is currently running");
      info(""); h("── settings ──────────────────────────","");
      h("'config list","show every setting + its current value");
      h("'config get <key>","show one setting");
      h("'config set <key> <value>","change a setting — takes effect immediately");
      h("'config reset <key>","reset a setting to its default");
      h("'config export [path]","export settings to a JSON file (default: oxis-config.json)");
      h("'config import <path>","import settings from one — takes effect immediately");
      h("'config edit","edit ~/.oxis/config.lua (runs at startup)"); h("'config reload","re-run config.lua, reload ~/.oxis/themes");
      h("'version","version + platform info");
      h("'diagnostics","local diagnostic info — version, OS, runtime, plugins, workspace, recent errors (never transmitted anywhere)");
      h("'backup [path]","back up settings, workspaces, documents, and your own plugins to one file");
      h("'restore <path>","restore a backup — asks for confirmation first, only touches matching files");
      sep(); dim(`Platform: ${isWindows()?"Windows":"Linux"} · Plugin shortcuts: gs, nb, dps, top…`);
      dim("Need more detail on any of these? 'help <command> — e.g. 'help plugin, 'help workspace, 'help config"); sep(); }});

  registry.register({ name:"?",       category:"info", description:"All commands",
    handler:()=> registry.execute("help",[],"") });
}

// ══════════════════════════════════════════════════════════════
// BUILT-IN EDITOR
// ══════════════════════════════════════════════════════════════
interface EditorFile { path: string; content: string; dirty: boolean; loading: boolean; loadError?: string; gotoLine?: number; }

// ══════════════════════════════════════════════════════════════
// ERROR BOUNDARY — shows what threw instead of a blank pane if the
// editor crashes while rendering.
// ══════════════════════════════════════════════════════════════
class ErrorBoundary extends React.Component<
  { children: React.ReactNode; onClose?: () => void },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode; onClose?: () => void }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[oxis:render-crash]", error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="editor">
          <div className="editor-bar">
            <div className="editor-bar-left">
              <span className="editor-icon">✗</span>
              <span className="editor-path">something crashed rendering this view</span>
            </div>
            <div className="editor-bar-right">
              {this.props.onClose && (
                <button className="editor-btn editor-btn--close" onClick={() => { this.setState({ error: null }); this.props.onClose?.(); }}>×</button>
              )}
            </div>
          </div>
          <div className="editor-error">
            {this.state.error.message}
            <span className="editor-error-detail">{this.state.error.stack}</span>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ══════════════════════════════════════════════════════════════
// CODE AREA — a highlighted <pre> behind a transparent <textarea>, so
// the caret, selection and modal keys are the textarea's own.
// ══════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════
// UNSAVED-CHANGE GUTTER — LCS line diff against the content at the last
// save, so inserting a line doesn't mark every line after it.
// ══════════════════════════════════════════════════════════════
function computeChangedLines(oldText: string, newText: string): Set<number> {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const n = oldLines.length, m = newLines.length;
  const changed = new Set<number>();

  // The LCS table is O(n*m); past this size use a positional compare.
  if (n * m > 1_000_000) {
    for (let i = 0; i < m; i++) if (oldLines[i] !== newLines[i]) changed.add(i + 1);
    return changed;
  }

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) { i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { i++; } // this old line was removed — nothing to mark in the new file
    else { changed.add(j + 1); j++; } // this new line is added/modified — 1-indexed to match line numbers
  }
  while (j < m) { changed.add(j + 1); j++; } // trailing added lines
  return changed;
}

const CodeArea = React.forwardRef<HTMLTextAreaElement, {
  value: string;
  lang: EditorLang;
  className?: string;
  onChange?: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  /** 1-based line numbers changed since the last save. Omit when
   *  there's no baseline (an empty Set would mean "nothing changed"). */
  changedLines?: Set<number>;
  /** Style for the outer wrapper (preview split width, or hiding the
   *  code pane in full preview without unmounting it). */
  style?: React.CSSProperties;
  hidden?: boolean;
}>(function CodeArea({ value, lang, className, onChange, onKeyDown, changedLines, style, hidden }, ref) {
  const preRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  // Highlighting a large file on every keystroke causes lag, so below
  // HARD_CUTOFF_CHARS it runs on a debounced copy (the textarea itself
  // is never delayed), and above it it's skipped with a notice.
  const HARD_CUTOFF_CHARS = 500_000;
  const DEBOUNCE_THRESHOLD_CHARS = 20_000;
  const isHuge = value.length > HARD_CUTOFF_CHARS;

  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    if (value.length < DEBOUNCE_THRESHOLD_CHARS) { setDebouncedValue(value); return; }
    const t = setTimeout(() => setDebouncedValue(value), 150);
    return () => clearTimeout(t);
  }, [value]);

  const html = useMemo(() => {
    if (isHuge) return escapeHtml(debouncedValue); // plain, escaped text — no tokenizing at all
    const h = highlight(debouncedValue, lang);
    // Match a trailing newline so the highlight layer's height/scroll
    // extent lines up with the textarea's (otherwise the last empty
    // line makes them drift out of sync by one row).
    return debouncedValue.endsWith("\n") ? h + "\n" : h;
  }, [debouncedValue, lang, isHuge]);

  // Line-number gutter, scrolled with the other layers and sized to the
  // line count. One row per line so change markers can attach to rows.
  // Built from the debounced value so large files don't rebuild it on
  // every keystroke (small files stay in sync).
  const lineCount = useMemo(() => debouncedValue.split("\n").length, [debouncedValue]);
  const gutterWidth = useMemo(() => Math.max(2, String(lineCount).length), [lineCount]);
  const gutterLines = useMemo(() => {
    const rows: React.ReactNode[] = [];
    for (let i = 1; i <= lineCount; i++) {
      rows.push(
        <div key={i} className={`code-area-gutter-line${changedLines?.has(i) ? " code-area-gutter-line--changed" : ""}`}>
          {i}
        </div>,
      );
    }
    return rows;
  }, [lineCount, changedLines]);

  const syncScroll = useCallback((e: React.UIEvent<HTMLTextAreaElement>) => {
    const pre = preRef.current, gutter = gutterRef.current;
    if (pre) { pre.scrollTop = e.currentTarget.scrollTop; pre.scrollLeft = e.currentTarget.scrollLeft; }
    if (gutter) gutter.scrollTop = e.currentTarget.scrollTop;
  }, []);

  return (
    <div className="code-area" style={style} hidden={hidden}>
      {isHuge && (
        <div className="code-area-large-file-notice" title={`${value.length.toLocaleString()} characters`}>
          Large file — syntax highlighting disabled to keep typing responsive
        </div>
      )}
      <div ref={gutterRef} className="code-area-gutter" style={{ width: `${gutterWidth + 3}ch` }} aria-hidden="true">
        {gutterLines}
      </div>
      <div className="code-area-body" style={{ left: `${gutterWidth + 3}ch` }}>
        <pre ref={preRef} className="code-area-highlight" aria-hidden="true">
          <code dangerouslySetInnerHTML={{ __html: html }} />
        </pre>
        <textarea
          ref={ref}
          className={`code-area-input ${className ?? ""}`}
          value={value}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onScroll={syncScroll}
          spellCheck={false}
          autoComplete="off" autoCorrect="off" autoCapitalize="off"
        />
      </div>
    </div>
  );
});

// ══════════════════════════════════════════════════════════════
// MODAL EDITING — Normal/Insert/Visual mode logic for the editor.
// ══════════════════════════════════════════════════════════════
function useModalEditor(opts: {
  taRef:   React.RefObject<HTMLTextAreaElement>;
  content: string;
  /** Called whenever modal editing changes the text (typing in
   *  Insert mode, dd/dw/x deletes, o/O opening a line, Tab indent). */
  onEdit:  (next: string) => void;
  /** Ctrl+S in any mode. */
  onSave:  () => void;
  /** Escape while in Normal mode (Escape in Visual just exits to
   *  Normal — handled internally). Caller decides what "close" means
   *  (e.g. the file Editor confirms first if dirty; Plugin Creator
   *  just closes). */
  onEscapeNormal: () => void;
}) {
  const { taRef, content, onEdit, onSave, onEscapeNormal } = opts;
  // Normal Mode is the default; 'i'/'a'/'o'/etc. drop into Insert,
  // Escape returns to Normal, 'v' starts Visual selection.
  const [mode, setMode] = useState<EditorMode>("normal");
  const [anchor, setAnchor] = useState<number | null>(null);
  const pendingKeyRef = useRef<string>(""); // for two-key commands: dd, dw, gg

  // ── Undo / Redo ────────────────────────────────────────────
  // A snapshot per undo step: the content BEFORE that step, plus
  // where the caret was, so undoing/redoing restores the cursor
  // somewhere sensible too, not just the text.
  type Snapshot = { content: string; pos: number };
  const undoStack = useRef<Snapshot[]>([]);
  const redoStack = useRef<Snapshot[]>([]);
  // Consecutive keystrokes form one undo step, but a pause of
  // GROUP_TIMEOUT_MS starts a new one, so a long Insert session isn't
  // undone in a single Ctrl+Z.
  const grouping = useRef(false);
  const lastEditAt = useRef(0);
  const GROUP_TIMEOUT_MS = 700;

  const curPos = useCallback(() => taRef.current?.selectionStart ?? 0, [taRef]);

  // Every content-changing action funnels through this instead of
  // calling onEdit directly, so nothing can mutate text without also
  // recording how to undo it.
  const commit = useCallback((next: string, grouped: boolean) => {
    const now = Date.now();
    const withinGroupWindow = now - lastEditAt.current < GROUP_TIMEOUT_MS;
    lastEditAt.current = now;
    if (!(grouped && grouping.current && withinGroupWindow)) {
      undoStack.current.push({ content, pos: curPos() });
      if (undoStack.current.length > 500) undoStack.current.shift();
      redoStack.current = [];
    }
    grouping.current = grouped;
    onEdit(next);
  }, [content, curPos, onEdit]);

  const restore = useCallback((snap: Snapshot) => {
    onEdit(snap.content);
    requestAnimationFrame(() => {
      const ta = taRef.current; if (!ta) return;
      ta.selectionStart = ta.selectionEnd = Math.min(snap.pos, snap.content.length);
    });
  }, [onEdit, taRef]);

  const undo = useCallback(() => {
    const snap = undoStack.current.pop();
    if (!snap) return;
    redoStack.current.push({ content, pos: curPos() });
    grouping.current = false;
    restore(snap);
  }, [content, curPos, restore]);

  const redo = useCallback(() => {
    const snap = redoStack.current.pop();
    if (!snap) return;
    undoStack.current.push({ content, pos: curPos() });
    grouping.current = false;
    restore(snap);
  }, [content, curPos, restore]);

  // Mode changes are visible to Lua plugins too (see README § Input
  // Modes — "Mode transitions fire events that plugins can subscribe
  // to"), and drive which `oxis.keymap(mode, ...)` binds are live.
  useEffect(() => {
    events.emit("mode_changed", { mode, context: "editor" });
    keybinds.setActiveMode(mode);
    // Leaving Insert mode always closes the current undo group, so
    // the NEXT insert session (or o/O, dd, etc.) starts a fresh one
    // instead of silently merging with whatever was typed before.
    if (mode !== "insert") grouping.current = false;
    return () => { keybinds.setActiveMode("normal"); }; // don't leak editor mode to the rest of the app on close
  }, [mode]);

  const setPos = useCallback((pos: number, keepAnchor = false) => {
    const ta = taRef.current;
    if (!ta) return;
    if (keepAnchor) {
      // Visual mode: extend the real selection so it's visible, and
      // remember which end is active.
      const a = anchor ?? pos;
      if (pos >= a) {
        requestAnimationFrame(() => ta.setSelectionRange(a, Math.min(pos + 1, content.length), "forward"));
      } else {
        requestAnimationFrame(() => ta.setSelectionRange(pos, Math.min(a + 1, content.length), "backward"));
      }
    } else {
      requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = pos; });
      setAnchor(null);
    }
  }, [anchor, content, taRef]);

  const applyEdit = useCallback((next: CursorState, editOpts?: { toInsert?: boolean }) => {
    commit(next.content, false);
    requestAnimationFrame(() => {
      const ta = taRef.current; if (!ta) return;
      ta.selectionStart = ta.selectionEnd = next.pos;
    });
    if (editOpts?.toInsert) {
      setMode("insert");
      // o/O's newline-insert and the typing that follows it are ONE
      // undo step in vim, not two — extend this group into the
      // upcoming Insert-mode keystrokes instead of starting a new one.
      grouping.current = true;
    }
  }, [commit, taRef]);

  // ── Normal / Visual mode command dispatch ────────────────────
  const handleModalKey = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Ctrl/Cmd combos (copy, select-all, browser/OXIS shortcuts, etc.)
    // are never Normal/Visual-mode commands here — only bare keys and
    // Shift are. Ctrl+S is handled a level up in onKeyDown before this
    // is even called.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const ta = taRef.current!;
    // In Visual mode the caret is whichever end of the selection is
    // active; otherwise it's selectionStart.
    const pos = mode === "visual" && ta.selectionStart !== ta.selectionEnd
      ? (ta.selectionDirection === "backward" ? ta.selectionStart : ta.selectionEnd - 1)
      : ta.selectionStart;
    const cur: CursorState = { content, pos, anchor: mode === "visual" ? (anchor ?? pos) : undefined };
    const pending = pendingKeyRef.current;

    // Two-key sequences: dd / dw / gg
    if (pending === "d") {
      pendingKeyRef.current = "";
      e.preventDefault();
      if (e.key === "d") { applyEdit(deleteLine(cur)); return; }
      if (e.key === "w") { applyEdit(deleteWord(cur)); return; }
      return; // unrecognised — drop the pending 'd'
    }
    if (pending === "g") {
      pendingKeyRef.current = "";
      e.preventDefault();
      if (e.key === "g") { setPos(moveDocStart()); return; }
      return;
    }

    switch (e.key) {
      case "Escape":
        e.preventDefault();
        if (mode === "visual") { setPos(pos); setMode("normal"); return; }
        onEscapeNormal();
        return;
      case "i": e.preventDefault(); setMode("insert"); return;
      case "a": e.preventDefault(); setPos(moveRight(cur)); setMode("insert"); return;
      case "A": e.preventDefault(); setPos(moveLineEnd(cur)); setMode("insert"); return;
      case "I": e.preventDefault(); setPos(moveLineStart(cur)); setMode("insert"); return;
      case "o": e.preventDefault(); applyEdit(openLineBelow(cur), { toInsert: true }); return;
      case "O": e.preventDefault(); applyEdit(openLineAbove(cur), { toInsert: true }); return;
      case "v":
        if (e.ctrlKey || e.metaKey) return; // let Ctrl/Cmd+V paste through
        e.preventDefault();
        if (mode === "visual") { setPos(pos); setMode("normal"); }
        else { setAnchor(pos); setMode("visual"); }
        return;
      case "h": case "ArrowLeft":  e.preventDefault(); setPos(moveLeft(cur),  mode === "visual"); return;
      case "l": case "ArrowRight": e.preventDefault(); setPos(moveRight(cur), mode === "visual"); return;
      case "j": case "ArrowDown":  e.preventDefault(); setPos(moveDown(cur),  mode === "visual"); return;
      case "k": case "ArrowUp":    e.preventDefault(); setPos(moveUp(cur),    mode === "visual"); return;
      case "0": e.preventDefault(); setPos(moveLineStart(cur), mode === "visual"); return;
      case "$": e.preventDefault(); setPos(moveLineEnd(cur),   mode === "visual"); return;
      case "G": e.preventDefault(); setPos(moveDocEnd(cur),    mode === "visual"); return;
      case "w": e.preventDefault(); setPos(moveWordForward(cur), mode === "visual"); return;
      case "b": e.preventDefault(); setPos(moveWordBackward(cur), mode === "visual"); return;
      case "g": e.preventDefault(); pendingKeyRef.current = "g"; return;
      case "x":
        e.preventDefault();
        if (mode === "visual") { applyEdit(deleteSelection(cur)); setMode("normal"); setAnchor(null); }
        else applyEdit(deleteChar(cur));
        return;
      case "d":
        e.preventDefault();
        if (mode === "visual") { applyEdit(deleteSelection(cur)); setMode("normal"); setAnchor(null); }
        else pendingKeyRef.current = "d";
        return;
      case "y":
        if (mode === "visual") {
          e.preventDefault();
          void copyToClipboard(selectedText(cur));
          setPos(pos); setMode("normal");
        }
        return;
      case "Tab": {
        e.preventDefault();
        const s = ta.selectionStart, en = ta.selectionEnd;
        const next = content.slice(0, s) + "  " + content.slice(en);
        commit(next, false);
        requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = s + 2; });
        return;
      }
      default:
        // Normal/Visual mode: plain characters are commands, never
        // inserted. Modifier combos and function keys pass through.
        if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) e.preventDefault();
        return;
    }
  }, [content, mode, anchor, onEscapeNormal, applyEdit, setPos, onEdit, taRef]);

  // ── Find / Find & Replace / Go to line ────────────────────────
  // Uses its own <input> (FindBar), outside the modal key handling.
  const [findOpen, setFindOpen] = useState(false);
  const [findMode, setFindMode] = useState<"find" | "replace" | "goto">("find");
  const [findQuery, setFindQuery] = useState("");
  const [replaceWith, setReplaceWith] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const findInputRef = useRef<HTMLInputElement>(null);

  // Plain substring search, case-insensitive — not regex. A search
  // box that can hang the tab on a malicious/accidental catastrophic
  // regex isn't worth the extra power for what this is for.
  const matches = useMemo(() => {
    if (!findQuery) return [] as number[];
    const idxs: number[] = [];
    const hay = content.toLowerCase();
    const needle = findQuery.toLowerCase();
    let i = 0;
    while (i <= hay.length) {
      const found = hay.indexOf(needle, i);
      if (found === -1) break;
      idxs.push(found);
      i = found + needle.length;
    }
    return idxs;
  }, [content, findQuery]);

  const selectMatch = useCallback((idx: number) => {
    const ta = taRef.current;
    if (!ta || matches.length === 0) return;
    const wrapped = ((idx % matches.length) + matches.length) % matches.length;
    const pos = matches[wrapped];
    ta.setSelectionRange(pos, pos + findQuery.length);
    // Textareas don't reliably auto-scroll a programmatic selection
    // into view — approximate it by line position, generous enough
    // that the match always ends up on-screen even if not perfectly centered.
    const lineNum = content.slice(0, pos).split("\n").length;
    const totalLines = Math.max(1, content.split("\n").length);
    ta.scrollTop = Math.max(0, ((lineNum - 4) / totalLines) * ta.scrollHeight);
  }, [matches, findQuery, content, taRef]);

  useEffect(() => {
    setMatchIndex(0);
    if (matches.length > 0) selectMatch(0);
    // selectMatch intentionally omitted — it's derived from the same
    // matches/findQuery this already re-runs on, including it would
    // just re-fire this identically on every content keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches, findQuery]);

  const openFind = useCallback((asMode: "find" | "replace" | "goto") => {
    setFindMode(asMode);
    setFindOpen(true);
    setTimeout(() => findInputRef.current?.focus(), 20);
  }, []);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setTimeout(() => taRef.current?.focus(), 20);
  }, [taRef]);

  const findNext = useCallback(() => {
    if (matches.length === 0) return;
    const next = matchIndex + 1;
    setMatchIndex(next);
    selectMatch(next);
  }, [matches.length, matchIndex, selectMatch]);

  const findPrev = useCallback(() => {
    if (matches.length === 0) return;
    const prev = matchIndex - 1;
    setMatchIndex(prev);
    selectMatch(prev);
  }, [matches.length, matchIndex, selectMatch]);

  const replaceCurrent = useCallback(() => {
    if (matches.length === 0) return;
    const wrapped = ((matchIndex % matches.length) + matches.length) % matches.length;
    const pos = matches[wrapped];
    const next = content.slice(0, pos) + replaceWith + content.slice(pos + findQuery.length);
    commit(next, false);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) ta.selectionStart = ta.selectionEnd = pos + replaceWith.length;
    });
  }, [matches, matchIndex, content, findQuery, replaceWith, commit, taRef]);

  const replaceAll = useCallback(() => {
    if (matches.length === 0 || !findQuery) return;
    // Rebuild left-to-right from the match offsets already computed
    // above, rather than a global replace, so this can't behave
    // differently from what "matches" (and thus the find count the
    // user is looking at) actually says.
    let next = "";
    let last = 0;
    for (const pos of matches) {
      next += content.slice(last, pos) + replaceWith;
      last = pos + findQuery.length;
    }
    next += content.slice(last);
    const count = matches.length;
    commit(next, false); // one undo step for the whole operation, not one per match
    return count;
  }, [matches, findQuery, replaceWith, content, commit]);

  const goToLine = useCallback((lineStr: string) => {
    const n = parseInt(lineStr, 10);
    if (!Number.isFinite(n) || n < 1) return;
    const lines = content.split("\n");
    const target = Math.min(n, lines.length);
    let pos = 0;
    for (let i = 0; i < target - 1; i++) pos += lines[i].length + 1;
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    ta.selectionStart = ta.selectionEnd = pos;
    ta.scrollTop = Math.max(0, ((target - 4) / lines.length) * ta.scrollHeight);
  }, [content, taRef]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.ctrlKey && e.key === "s") { e.preventDefault(); onSave(); return; }

    // Find / Find & Replace / Go to line — work in any mode, same as
    // Ctrl+Z/Y below, since "I want to search" shouldn't depend on
    // which mode you happen to be in.
    if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === "f") { e.preventDefault(); openFind("find"); return; }
    if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === "h") { e.preventDefault(); openFind("replace"); return; }
    if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === "g") { e.preventDefault(); openFind("goto"); return; }

    // Undo/redo in any mode: Ctrl+Z, and Ctrl+Y or Ctrl+Shift+Z.
    if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "y") {
      e.preventDefault();
      redo();
      return;
    }

    if (mode !== "insert") { handleModalKey(e); return; }

    // Insert Mode — ordinary typing, same behavior as before modes existed.
    if (e.key === "Escape") {
      e.preventDefault();
      const ta = taRef.current!;
      setPos(Math.max(0, ta.selectionStart - 1));
      setMode("normal");
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const ta = taRef.current!;
      const s = ta.selectionStart, en = ta.selectionEnd;
      const next = content.slice(0, s) + "  " + content.slice(en);
      commit(next, true); // part of the same Insert-mode undo group as the surrounding typing
      requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = s + 2; });
    }
  }, [onSave, openFind, undo, redo, mode, handleModalKey, content, setPos, commit, taRef]);

  const resetModal = useCallback(() => {
    setMode("normal"); setAnchor(null);
    undoStack.current = []; redoStack.current = []; grouping.current = false;
  }, []);

  // Typing in Insert mode (the textarea's own onChange) — routed
  // through here instead of the caller setting content directly, so
  // ordinary typing is captured by undo/redo too, grouped one
  // keystroke-run per Insert-mode session (see `commit` above).
  const handleChange = useCallback((next: string) => {
    if (mode !== "insert") return;
    commit(next, true);
  }, [mode, commit]);

  return {
    mode, setMode, resetModal, onKeyDown, handleChange, undo, redo,
    findOpen, findMode, findQuery, setFindQuery, replaceWith, setReplaceWith,
    matches, matchIndex, findInputRef, openFind, closeFind, findNext, findPrev,
    replaceCurrent, replaceAll, goToLine,
  };
}

// ══════════════════════════════════════════════════════════════
// FIND BAR — Find / Find & Replace / Go to line.
// ══════════════════════════════════════════════════════════════
function FindBar({ findMode, findQuery, setFindQuery, replaceWith, setReplaceWith, matches, matchIndex, findInputRef, findNext, findPrev, closeFind, replaceCurrent, replaceAll, goToLine }: {
  findMode: "find" | "replace" | "goto";
  findQuery: string;
  setFindQuery: (v: string) => void;
  replaceWith: string;
  setReplaceWith: (v: string) => void;
  matches: number[];
  matchIndex: number;
  findInputRef: React.RefObject<HTMLInputElement>;
  findNext: () => void;
  findPrev: () => void;
  closeFind: () => void;
  replaceCurrent: () => void;
  replaceAll: () => number | undefined;
  goToLine: (line: string) => void;
}) {
  const [gotoVal, setGotoVal] = useState("");
  const [replacedMsg, setReplacedMsg] = useState("");

  if (findMode === "goto") {
    return (
      <div className="find-bar">
        <span className="find-bar-icon">→</span>
        <input
          ref={findInputRef}
          className="find-bar-input"
          placeholder="Go to line…"
          value={gotoVal}
          onChange={e => setGotoVal(e.target.value.replace(/\D/g, ""))}
          onKeyDown={e => {
            if (e.key === "Enter") { e.preventDefault(); goToLine(gotoVal); closeFind(); }
            if (e.key === "Escape") { e.preventDefault(); closeFind(); }
          }}
        />
        <button className="find-bar-btn find-bar-btn--close" onClick={closeFind}>×</button>
      </div>
    );
  }

  const count = matches.length;
  const displayIndex = count > 0 ? (((matchIndex % count) + count) % count) + 1 : 0;

  return (
    <div className="find-bar">
      <span className="find-bar-icon">⌕</span>
      <input
        ref={findInputRef}
        className="find-bar-input"
        placeholder="Find…"
        value={findQuery}
        onChange={e => setFindQuery(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter") { e.preventDefault(); if (e.shiftKey) findPrev(); else findNext(); }
          if (e.key === "Escape") { e.preventDefault(); closeFind(); }
        }}
      />
      <span className="find-bar-count">{findQuery ? (count > 0 ? `${displayIndex}/${count}` : "0/0") : ""}</span>
      <button className="find-bar-btn" onClick={findPrev} disabled={count === 0} title="Previous (Shift+Enter)">↑</button>
      <button className="find-bar-btn" onClick={findNext} disabled={count === 0} title="Next (Enter)">↓</button>
      {findMode === "replace" && (
        <>
          <input
            className="find-bar-input"
            placeholder="Replace with…"
            value={replaceWith}
            onChange={e => setReplaceWith(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") { e.preventDefault(); replaceCurrent(); }
              if (e.key === "Escape") { e.preventDefault(); closeFind(); }
            }}
          />
          <button className="find-bar-btn" onClick={replaceCurrent} disabled={count === 0}>Replace</button>
          <button className="find-bar-btn" onClick={() => {
            const n = replaceAll();
            if (n) { setReplacedMsg(`${n} replaced`); setTimeout(() => setReplacedMsg(""), 2000); }
          }} disabled={count === 0}>Replace All</button>
          {replacedMsg && <span className="find-bar-count">{replacedMsg}</span>}
        </>
      )}
      <button className="find-bar-btn find-bar-btn--close" onClick={closeFind}>×</button>
    </div>
  );
}

/** Joins baseDir and a relative reference, normalising `.`/`..` for
 *  both `/` and `\` paths. Absolute references are returned as-is. */
function resolveRelativePath(baseDir: string, rel: string): string {
  const usesBackslash = baseDir.includes("\\") && !baseDir.includes("/");
  const sep = usesBackslash ? "\\" : "/";
  const relParts = rel.replace(/\\/g, "/").split("/");
  const baseParts = baseDir.replace(/\\/g, "/").replace(/\/$/, "").split("/");
  for (const part of relParts) {
    if (part === "" || part === ".") continue;
    if (part === "..") baseParts.pop();
    else baseParts.push(part);
  }
  return baseParts.join(sep);
}

/** Renders Markdown GitHub-style (dark) with `marked`. ```mermaid
 *  blocks are rendered as diagrams by Mermaid.js, loaded from a CDN
 *  inside the sandboxed preview iframe. */
function renderMarkdownPreview(markdown: string): string {
  const body = marked.parse(markdown, { gfm: true, breaks: false }) as string;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    background: #0d1117; color: #c9d1d9;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    font-size: 16px; line-height: 1.6;
    max-width: 860px; margin: 0 auto; padding: 32px 24px 80px;
  }
  h1, h2, h3, h4, h5, h6 { color: #e6edf3; font-weight: 600; margin: 24px 0 16px; line-height: 1.25; }
  h1 { font-size: 2em; padding-bottom: .3em; border-bottom: 1px solid #21262d; }
  h2 { font-size: 1.5em; padding-bottom: .3em; border-bottom: 1px solid #21262d; }
  h3 { font-size: 1.25em; }
  h4 { font-size: 1em; }
  p, ul, ol, table, pre, blockquote { margin: 0 0 16px; }
  a { color: #4493f8; text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { background: rgba(110,118,129,.2); padding: .2em .4em; border-radius: 6px; font-family: ui-monospace, "SF Mono", Consolas, monospace; font-size: 85%; }
  pre { background: #161b22; padding: 16px; border-radius: 6px; overflow-x: auto; border: 1px solid #21262d; }
  pre code { background: none; padding: 0; font-size: 85%; }
  blockquote { border-left: .25em solid #3b434b; padding: 0 1em; color: #8b949e; margin-left: 0; }
  table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; }
  th, td { border: 1px solid #30363d; padding: 6px 13px; }
  th { background: #161b22; font-weight: 600; }
  tr:nth-child(2n) { background: #161b22; }
  img { max-width: 100%; background: #fff; border-radius: 6px; }
  hr { border: none; border-top: 1px solid #21262d; margin: 24px 0; }
  ul, ol { padding-left: 2em; }
  li { margin: .25em 0; }
  li > p { margin: 0; }
  kbd { background: #161b22; border: 1px solid #30363d; border-bottom-width: 2px; border-radius: 6px; padding: 2px 6px; font-family: ui-monospace, monospace; font-size: 85%; }
  .mermaid { background: #161b22; border-radius: 6px; padding: 16px; text-align: center; }
</style>
</head>
<body>
${body}
<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
<script>
  // Render each mermaid code block in place; one bad diagram doesn't
  // break the rest.
  (function () {
    if (typeof mermaid === "undefined") return;
    mermaid.initialize({ startOnLoad: false, theme: "dark" });
    document.querySelectorAll('pre > code.language-mermaid').forEach(function (block, i) {
      try {
        var id = "mermaid-preview-" + i;
        var container = document.createElement("div");
        container.className = "mermaid";
        container.textContent = block.textContent;
        block.parentElement.replaceWith(container);
        mermaid.run({ nodes: [container] });
      } catch (e) { /* leave this one as a plain code block rather than breaking the rest */ }
    });
  })();
</script>
</body>
</html>`;
}

/** Inlines a previewed page's relative stylesheets and scripts, since
 *  a srcDoc iframe can't resolve relative URLs. Absolute and data: URLs
 *  are left alone; a file that can't be read becomes an HTML comment. */
async function inlinePreviewAssets(html: string, filePath: string): Promise<string> {
  const baseDir = filePath.replace(/[\\/][^\\/]*$/, "");
  const isRemoteOrInline = (src: string) => /^(https?:)?\/\//.test(src) || src.startsWith("data:");

  async function replaceAll(source: string, re: RegExp, build: (fullMatch: string, src: string) => Promise<string>): Promise<string> {
    const matches = [...source.matchAll(re)];
    let out = source;
    for (const m of matches) {
      const src = m[1];
      if (!src || isRemoteOrInline(src)) continue;
      out = out.replace(m[0], await build(m[0], src));
    }
    return out;
  }

  html = await replaceAll(html, /<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/gi, async (_full, href) => {
    const resolved = resolveRelativePath(baseDir, href);
    try { return `<style>/* inlined for preview: ${href} */\n${await readFile(resolved)}\n</style>`; }
    catch { return `<!-- preview: couldn't load stylesheet "${href}" (looked for ${resolved}) -->`; }
  });
  // Also catches href-before-rel orderings the first pass's fixed
  // attribute order would miss (e.g. <link href="x.css" rel="stylesheet">).
  html = await replaceAll(html, /<link[^>]+href=["']([^"']+\.css)["'][^>]*rel=["']stylesheet["'][^>]*>/gi, async (_full, href) => {
    const resolved = resolveRelativePath(baseDir, href);
    try { return `<style>/* inlined for preview: ${href} */\n${await readFile(resolved)}\n</style>`; }
    catch { return `<!-- preview: couldn't load stylesheet "${href}" (looked for ${resolved}) -->`; }
  });
  html = await replaceAll(html, /<script[^>]+src=["']([^"']+)["'][^>]*><\/script>/gi, async (_full, src) => {
    const resolved = resolveRelativePath(baseDir, src);
    try { return `<script>/* inlined for preview: ${src} */\n${await readFile(resolved)}\n</script>`; }
    catch { return `<!-- preview: couldn't load script "${src}" (looked for ${resolved}) -->`; }
  });
  return html;
}

function Editor({ file, onClose, onSave }: {
  file:    EditorFile;
  onClose: () => void;
  onSave:  (path: string, content: string) => void;
}) {
  const [content, setContent] = useState(file.content);
  const [savedContent, setSavedContent] = useState(file.content); // the baseline the gutter diffs against — becomes `content` on every save, not the original-forever
  const [dirty,   setDirty]   = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Re-sync when a different file opens or the current one finishes
  // loading (the editor opens before the read completes).
  useEffect(() => { setContent(file.content); setSavedContent(file.content); setDirty(false); }, [file.path, file.loading]);
  useEffect(() => { if (!file.loading) setTimeout(() => taRef.current?.focus(), 40); }, [file.loading]);

  // Jump to file.gotoLine once the content is in the textarea: caret at
  // the start of that line, scrolled to the middle of the view.
  useEffect(() => {
    if (file.loading || !file.gotoLine) return;
    const ta = taRef.current;
    if (!ta) return;
    const t = setTimeout(() => {
      const lines = content.split("\n");
      const target = Math.max(1, Math.min(file.gotoLine!, lines.length));
      let offset = 0;
      for (let i = 0; i < target - 1; i++) offset += lines[i].length + 1;
      ta.focus();
      ta.setSelectionRange(offset, offset + lines[target - 1].length);
      const style = window.getComputedStyle(ta);
      const lineHeight = parseFloat(style.lineHeight) || 18;
      ta.scrollTop = Math.max(0, (target - 1) * lineHeight - ta.clientHeight / 2);
    }, 60); // after the focus effect above and the first paint of `content`
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.loading, file.gotoLine, content]);

  const save = useCallback(() => {
    onSave(file.path, content);
    setSavedContent(content); // new baseline — the gutter now shows changes since THIS save, not the original open
    setDirty(false);
  }, [file.path, content, onSave]);

  // The line diff is debounced for large files, like highlighting.
  const [debouncedContent, setDebouncedContent] = useState(content);
  useEffect(() => {
    if (content.length < 20_000) { setDebouncedContent(content); return; }
    const t = setTimeout(() => setDebouncedContent(content), 200);
    return () => clearTimeout(t);
  }, [content]);
  const changedLines = useMemo(
    () => content.length > 500_000 ? new Set<number>() : computeChangedLines(savedContent, debouncedContent),
    [savedContent, debouncedContent, content.length],
  );

  const onEdit = useCallback((next: string) => {
    setContent(prev => { if (next !== prev) setDirty(true); return next; });
  }, []);

  // Live preview for .html/.htm/.md. Off until toggled, so opening a
  // file never runs its scripts.
  const isHtmlFile = /\.html?$/i.test(file.path);
  const isMarkdownFile = /\.(md|markdown)$/i.test(file.path);
  const isPreviewable = isHtmlFile || isMarkdownFile;
  const [previewOpen, setPreviewOpen] = useState(false);
  // Preview reloads are heavier than a diff, so always debounce them.
  const [previewContent, setPreviewContent] = useState(content);
  const previewRunId = useRef(0); // guards against an in-flight resolve landing after a NEWER one already started (fast typing, or a quick file switch)
  const buildPreview = useCallback((raw: string) => {
    const runId = ++previewRunId.current;
    const build = isMarkdownFile
      ? Promise.resolve(renderMarkdownPreview(raw))
      : inlinePreviewAssets(raw, file.path);
    build.then(resolved => {
      if (previewRunId.current === runId) setPreviewContent(resolved);
    });
  }, [file.path, isMarkdownFile]);
  useEffect(() => {
    if (!previewOpen) return; // no reason to keep re-rendering an iframe nobody's looking at
    const t = setTimeout(() => buildPreview(content), 300);
    return () => clearTimeout(t);
  }, [content, previewOpen, buildPreview]);
  // Refreshed the instant the preview is actually opened (not waiting
  // out the debounce for the FIRST render), and again on switching to
  // a different file while it's already open.
  useEffect(() => { if (previewOpen) buildPreview(content); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [previewOpen, file.path]);

  // Resizable split — drag the handle between code and preview.
  // Percent (not pixels) so it stays correct if the window itself is
  // resized afterward. Clamped to a 20-80 range on each side so
  // neither pane can be dragged down to nothing.
  const [previewWidthPct, setPreviewWidthPct] = useState(50);
  const splitRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  // State (so the overlay renders) plus a ref (read synchronously in
  // the mousemove handler).
  const [isResizing, setIsResizing] = useState(false);
  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    setIsResizing(true);
    document.body.style.cursor = "col-resize";
  }, []);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current || !splitRef.current) return;
      const rect = splitRef.current.getBoundingClientRect();
      // -6 accounts for the handle's own width — without it the two
      // panes' percentages plus the handle add up to slightly MORE
      // than the container's real width, so the split visibly doesn't
      // quite track the cursor (worse the wider the container is).
      const usableWidth = rect.width - 6;
      const pct = ((rect.right - e.clientX) / usableWidth) * 100; // preview is on the right, so measure from the right edge
      setPreviewWidthPct(Math.min(80, Math.max(20, pct)));
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      setIsResizing(false);
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  // Full preview hides the code pane (button or Ctrl+Shift+Enter). Esc
  // leaves full preview before doing anything else.
  const [previewFullscreen, setPreviewFullscreen] = useState(false);
  useEffect(() => {
    if (!previewOpen) setPreviewFullscreen(false); // closing preview entirely also exits fullscreen, so re-opening starts split, not full
  }, [previewOpen]);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!previewOpen) return;
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "Enter") {
        e.preventDefault();
        setPreviewFullscreen(f => !f);
      } else if (e.key === "Escape" && previewFullscreen) {
        e.preventDefault();
        e.stopPropagation();
        setPreviewFullscreen(false);
      }
    };
    // Capture phase so this runs BEFORE useModalEditor's own Escape
    // handling below (which would otherwise close the whole editor).
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [previewOpen, previewFullscreen]);

  const {
    mode, resetModal, onKeyDown, handleChange,
    findOpen, findMode, findQuery, setFindQuery, replaceWith, setReplaceWith,
    matches, matchIndex, findInputRef, closeFind, findNext, findPrev, replaceCurrent, replaceAll, goToLine,
  } = useModalEditor({
    taRef,
    content,
    onEdit,
    onSave: save,
    onEscapeNormal: () => {
      if (dirty && !confirm("Discard unsaved changes?")) return;
      onClose();
    },
  });

  useEffect(() => { resetModal(); }, [file.path, file.loading, resetModal]);

  if (file.loading) {
    return (
      <div className="editor">
        <div className="editor-bar">
          <div className="editor-bar-left">
            <span className="editor-icon">◻</span>
            <span className="editor-path">{file.path}</span>
          </div>
          <div className="editor-bar-right">
            <button className="editor-btn editor-btn--close" onClick={onClose}>×</button>
          </div>
        </div>
        <div className="editor-loading">loading…</div>
      </div>
    );
  }

  if (file.loadError) {
    return (
      <div className="editor">
        <div className="editor-bar">
          <div className="editor-bar-left">
            <span className="editor-icon">◻</span>
            <span className="editor-path">{file.path}</span>
          </div>
          <div className="editor-bar-right">
            <button className="editor-btn editor-btn--close" onClick={onClose}>×</button>
          </div>
        </div>
        <div className="editor-error">
          ✗  couldn't open {file.path}
          <span className="editor-error-detail">{file.loadError}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="editor">
      <div className="editor-bar">
        <div className="editor-bar-left">
          <span className="editor-icon">◻</span>
          <span className="editor-path">{file.path}</span>
          {dirty && <span className="editor-dirty">●</span>}
        </div>
        <div className="editor-bar-right">
          <span className={`editor-mode editor-mode--${mode}`}>{mode.toUpperCase()}</span>
          <span className="editor-meta">{content.split("\n").length} lines</span>
          {isPreviewable && (
            <button className={`editor-btn${previewOpen ? " editor-btn--active" : ""}`}
              onClick={() => setPreviewOpen(o => !o)}
              title={isMarkdownFile
                ? "Live preview — rendered like GitHub/GitLab render a README, updates a moment after you stop typing"
                : "Live preview — renders in a sandboxed frame, updates a moment after you stop typing"}>
              {previewOpen ? "preview ✓" : "preview"}
            </button>
          )}
          {isPreviewable && previewOpen && (
            <button className={`editor-btn${previewFullscreen ? " editor-btn--active" : ""}`}
              onClick={() => setPreviewFullscreen(f => !f)}
              title="Expand preview to full size (Ctrl+Shift+Enter, Esc to exit)">
              {previewFullscreen ? "⤢ exit full" : "⤢ full"}
            </button>
          )}
          <button className="editor-btn" onClick={save}>save</button>
          <button className="editor-btn editor-btn--close" onClick={() => {
            if (dirty && !confirm("Discard unsaved changes?")) return;
            onClose();
          }}>×</button>
        </div>
      </div>
      {findOpen && (
        <FindBar findMode={findMode} findQuery={findQuery} setFindQuery={setFindQuery}
          replaceWith={replaceWith} setReplaceWith={setReplaceWith}
          matches={matches} matchIndex={matchIndex} findInputRef={findInputRef}
          findNext={findNext} findPrev={findPrev} closeFind={closeFind}
          replaceCurrent={replaceCurrent} replaceAll={replaceAll} goToLine={goToLine} />
      )}
      <div ref={splitRef} className={`editor-split${previewOpen ? " editor-split--active" : ""}${previewFullscreen ? " editor-split--fullscreen" : ""}`}>
        {/* Sits ABOVE the iframe (see .editor-resize-overlay's z-index)
            for exactly as long as a drag is in progress. Without this,
            mousemove events fire against the IFRAME's own document
            the instant the cursor crosses into it mid-drag, not the
            parent window's listener above — the drag doesn't just
            look janky there, it stops tracking the cursor entirely
            until it re-crosses back out of the iframe. This overlay
            is what actually receives the mouse for the whole drag,
            so the iframe never gets a chance to steal it. */}
        {isResizing && <div className="editor-resize-overlay" />}
        <CodeArea ref={taRef} className={`editor-ta editor-ta--${mode}`} value={content}
          lang={detectLang(file.path)}
          changedLines={changedLines}
          onChange={e => handleChange(e.target.value)}
          onKeyDown={onKeyDown}
          style={previewOpen && !previewFullscreen ? { width: `${100 - previewWidthPct}%`, flex: "none" } : undefined}
          hidden={previewFullscreen} />
        {previewOpen && !previewFullscreen && (
          <div className="editor-split-handle" onMouseDown={startResize} title="Drag to resize">
            <span className="editor-split-handle-grip" />
          </div>
        )}
        {previewOpen && (
          <div className="editor-preview" style={previewFullscreen ? undefined : { width: `${previewWidthPct}%`, flex: "none" }}>
            <div className="editor-preview-bar">
              <span>{isMarkdownFile ? "markdown preview" : "live preview"}</span>
              <span className="editor-preview-note">sandboxed — scripts run, but can't reach OXIS or your files</span>
              {previewFullscreen && (
                <button className="editor-preview-exit" onClick={() => setPreviewFullscreen(false)} title="Exit full size (Esc)">
                  ⤡ exit full (Esc)
                </button>
              )}
            </div>
            {/* key={file.path} forces a fresh iframe (and a fresh JS
                context inside it) per file, rather than one persistent
                iframe silently carrying over state/timers/listeners
                from whatever was previewed before it. sandbox
                deliberately omits allow-same-origin: the previewed
                page's own scripts still run (useful for anything
                beyond static markup), but can't read this app's DOM,
                storage, or make credentialed requests back to it —
                same isolation model tools like CodePen/JSFiddle use
                for exactly this kind of live preview. */}
            <iframe
              key={file.path}
              className="editor-preview-frame"
              srcDoc={previewContent}
              sandbox="allow-scripts"
              title={`Preview of ${file.path}`}
            />
          </div>
        )}
      </div>
      <div className="editor-footer">
        {mode === "insert" && <><span>Esc  normal mode</span><span>Ctrl+S  save</span><span>Tab  2 spaces</span></>}
        {mode === "normal" && <><span>i/a/o  insert</span><span>hjkl  move</span><span>v  visual</span><span>dd/dw/x  delete</span><span>Ctrl+Z/Y  undo/redo</span><span>Ctrl+F/H/G  find/replace/go to</span><span>Esc  close</span></>}
        {mode === "visual" && <><span>hjkl  extend</span><span>d/x  delete</span><span>y  yank</span><span>Esc  cancel</span></>}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// PLUGIN CREATOR — create Lua plugins inside OXIS
// ══════════════════════════════════════════════════════════════
const PLUGIN_TEMPLATES: Record<string, (name: string) => string> = {
  basic: (name) =>
`--[[@manifest
version: 1.0.0
description: ${name} — say hello and run a shell command
author: you
category: plugin
]]
-- ${name}.lua — OXIS Lua plugin
-- Created in OXIS · edit and save, then run 'plugin reload ${name}

-- Register a command  (invoked with '${name})
oxis.command("${name}", function()
  oxis.echo("Hello from ${name}!")
end, "say hello")

-- Run a shell command
oxis.command("${name}run", function()
  oxis.run("echo running ${name}")
end, "run a shell command")

-- Listen to events
oxis.autocmd("ShellOpen", function()
  oxis.echo("${name} plugin ready")
end)

-- Define a keymap  (optional)
-- oxis.keymap("normal", "<C-1>", function()
--   oxis.run("echo keymap triggered")
-- end)

-- Define a task  (run with 'task ${name})
-- oxis.task("${name}-build", "npm run build", "build the project")
`,

  dev: (name) =>
`--[[@manifest
version: 1.0.0
description: ${name} — git/dev shortcuts
author: you
category: dev
]]
-- ${name}.lua — dev-workflow plugin template.
-- oxis.run() needs no declared permission (every plugin can already
-- run shell commands — see README § Plugin Permissions), so a plugin
-- that's "just shortcuts for commands you'd type anyway" needs
-- nothing beyond this manifest's version/description/category.

oxis.command("${name}-status", function()
  oxis.run("git status -sb")
end, "short git status")

oxis.command("${name}-sync", function()
  oxis.run("git pull --rebase && git push")
end, "pull --rebase then push")

oxis.keymap("normal", "<C-g>", function()
  oxis.run("git status -sb")
end)
`,

  devops: (name) =>
`--[[@manifest
version: 1.0.0
description: ${name} — deployment/process helpers
author: you
category: devops
permissions: fs, process
]]
-- ${name}.lua — devops-flavored template. Declares "fs" and "process"
-- since it reads a deploy config file and can list/stop processes —
-- both prompt the user for one-time approval the first time this
-- plugin actually calls oxis.fs.*/oxis.process.* (see README § Plugin
-- Permissions); nothing here is granted just by existing.

oxis.command("${name}-deploy", function()
  oxis.fs.read("deploy.json", function(err, content)
    if err then
      oxis.echo("no deploy.json found in the current directory")
      return
    end
    oxis.echo("deploying with config: " .. content)
    -- oxis.run("./deploy.sh")
  end)
end, "read deploy.json and (eventually) deploy")

oxis.command("${name}-procs", function()
  oxis.process.list(function(err, procs)
    if err then oxis.echo("couldn't list processes: " .. tostring(err)); return end
    oxis.echo(#procs .. " processes running")
  end)
end, "count running processes")

oxis.task("${name}-watch", "while ($true) { Get-Date; Start-Sleep 5 }", "example long-running task (stop with Ctrl+C)")
`,

  system: (name) =>
`--[[@manifest
version: 1.0.0
description: ${name} — system info reporting
author: you
category: system
permissions: system
]]
-- ${name}.lua — reads OS/CPU/memory info via oxis.system.info().
-- Declares "system" so that call prompts for one-time approval
-- instead of silently having access nothing else in this plugin asked
-- for.

oxis.command("${name}-info", function()
  oxis.system.info(function(err, info)
    if err then oxis.echo("system info unavailable: " .. tostring(err)); return end
    oxis.echo(info.os .. " / " .. info.arch .. " — " .. info.numCPU .. " CPUs, " .. info.allocMB .. " MB allocated")
  end)
end, "print OS/arch/CPU/memory info")
`,
};

function pluginTemplate(name: string, template?: string): string {
  const fn = PLUGIN_TEMPLATES[template?.toLowerCase() || "basic"] ?? PLUGIN_TEMPLATES.basic;
  return fn(name);
}

// ══════════════════════════════════════════════════════════════
// THEME EDITOR — fixed, fully functional
// ══════════════════════════════════════════════════════════════
const THEME_FIELDS: [keyof Theme, string, string][] = [
  ["bg",      "Background",        "bg"],
  ["bg1",     "Background 1",      "titlebar/tabs"],
  ["bg2",     "Background 2",      "cards/inputs"],
  ["bg3",     "Background 3",      "hover/buttons"],
  ["bg4",     "Background 4",      "scrollbars"],
  ["border",  "Border",            "subtle borders"],
  ["border2", "Border Accent",     "active/focus borders"],
  ["text",    "Text",              "primary text"],
  ["muted",   "Muted",             "secondary text"],
  ["dim",     "Dim",               "placeholders"],
  ["comment", "Comment",           "faint/disabled text"],
  ["purple",  "Accent",            "banner, prompts, active tabs"],
  ["purple2", "Accent 2",          "active borders, status bar"],
  ["purple3", "Accent 3",          "ok messages, highlights"],
  ["grey",    "Grey",              "neutral text"],
  ["grey2",   "Grey 2",            "neutral dark"],
];

function ThemeEditor({ name: initName, onClose }: { name: string; onClose: () => void }) {
  const base = themeManager.get(themeManager.getCurrent()) ?? themeManager.get("default")!;
  const [name, setName] = useState(initName || "custom");
  const [vals, setVals] = useState<Theme>({ ...base });
  const [err,  setErr]  = useState("");
  const [ok,   setOk]   = useState(false);

  // Live preview on any change
  useEffect(() => { themeManager.applyRaw(vals); }, [vals]);

  // Restore theme on cancel
  const savedTheme = useRef(themeManager.getCurrent());
  const handleClose = useCallback(() => {
    themeManager.apply(savedTheme.current);
    onClose();
  }, [onClose]);

  const setColor = (k: keyof Theme, v: string) =>
    setVals(prev => ({ ...prev, [k]: v }));

  const save = () => {
    if (!name.trim()) { setErr("Name required"); return; }
    if (!/^[a-z0-9_-]+$/i.test(name)) { setErr("Letters, numbers, - _ only"); return; }
    const missing = themeManager.validate(vals);
    if (missing.length) { setErr(`Missing: ${missing.join(", ")}`); return; }
    themeManager.addCustom(name, vals);
    themeManager.apply(name);
    setErr(""); setOk(true);
    setTimeout(() => { setOk(false); onClose(); }, 800);
  };

  return (
    <div className="theme-editor">
      <div className="te-header">
        <span className="te-title">Theme Editor</span>
        <div className="te-header-right">
          <input
            className="te-name-input"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="theme-name"
            maxLength={32}
          />
          <button className="editor-btn editor-btn--close" onClick={handleClose}>×</button>
        </div>
      </div>

      <div className="te-scroll">
        {THEME_FIELDS.map(([key, label, hint]) => (
          <div className="te-row" key={key}>
            <div className="te-swatch" style={{ background: vals[key] as string }} />
            <input
              type="color"
              className="te-color"
              value={/^#[0-9a-f]{6}$/i.test(String(vals[key])) ? String(vals[key]) : "#000000"}
              onChange={e => setColor(key, e.target.value)}
            />
            <div className="te-label-group">
              <span className="te-label">{label}</span>
              <span className="te-hint">{hint}</span>
            </div>
            <input
              type="text"
              className="te-hex"
              value={vals[key] as string}
              onChange={e => setColor(key, e.target.value)}
              maxLength={9}
              spellCheck={false}
            />
          </div>
        ))}
      </div>

      <div className="te-footer">
        {err && <span className="te-err">{err}</span>}
        {ok  && <span className="te-ok">✓ saved</span>}
        <button className="te-btn te-btn--cancel" onClick={handleClose}>cancel</button>
        <button className="te-btn te-btn--save"   onClick={save}>save theme</button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// TERMINAL — fully polished input engine
// ══════════════════════════════════════════════════════════════
interface TermProps {
  id:          string;
  /** true while the terminal view (not Home) is showing */
  isActive:    boolean;
  /** Element the global prompt is portalled into — the fixed bar above
   *  the status line, shared by every screen. */
  promptHost:  HTMLElement | null;
  onReady:     () => void;
  /** Switch to the terminal view. */
  onShowShell: () => void;
  onCloseTab:  () => void;
}

interface InputState { value: string; cursor: number; }

let _pluginsInited = false;
/** Loads plugins and workspaces once, before any built-in commands are
 *  registered against a real terminal (built-ins win name clashes). */
function ensurePluginsInited(): void {
  if (_pluginsInited) return;
  _pluginsInited = true;
  initPlugins(forwardingApiCtx);
  workspaceManager.init(forwardingApiCtx);
  // Give the terminal a moment to be ready to print config.lua errors.
  setTimeout(() => void reportUserConfig(false), 300);
}

// Clickable URLs (open in the system browser) and file paths (open in
// the editor) in terminal output. Only paths ending in an extension
// count, so flags and ratios don't become links.
const LINE_LINK_RE = /(https?:\/\/[^\s"'<>()]+)|([A-Za-z]:\\[^\s"'<>]+?\.[A-Za-z0-9]{1,8}(?=[\s"'<>)]|$))|((?<=^|[\s"'(=:])\/[^\s"'<>]+?\.[A-Za-z0-9]{1,8}(?=[\s"'<>)]|$))/g;

// A mouseup that finishes a text selection also fires click; don't
// treat that as opening the link.
const selectionActive = () => (window.getSelection?.()?.toString().length ?? 0) > 0;

function renderLineWithLinks(text: string, onOpenUrl: (url: string) => void, onOpenPath: (path: string) => void): React.ReactNode {
  if (!text) return "\u00a0";
  LINE_LINK_RE.lastIndex = 0;
  const parts: React.ReactNode[] = [];
  let last = 0, key = 0, m: RegExpExecArray | null;
  while ((m = LINE_LINK_RE.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const matched = m[0];
    if (m[1]) {
      parts.push(<span key={key++} className="term-link" onClick={e => { e.stopPropagation(); if (!selectionActive()) onOpenUrl(matched); }} title={`open ${matched}`}>{matched}</span>);
    } else {
      parts.push(<span key={key++} className="term-link term-link--path" onClick={e => { e.stopPropagation(); if (!selectionActive()) onOpenPath(matched); }} title={`edit ${matched}`}>{matched}</span>);
    }
    last = LINE_LINK_RE.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function Terminal({ id, isActive, promptHost, onReady, onShowShell, onCloseTab }: TermProps) {
  const onNewTab = onShowShell;
  // ── output state ─────────────────────────────────────────
  const [lines,      setLines]      = useState<Line[]>(() => initialLines());
  const [ready,      setReady]      = useState(false);
  const [partial,    setPartial]    = useState("");
  const [connErr,    setConnErr]    = useState("");

  // ── global prompt state ───────────────────────────────────
  // The prompt is a real <input> (native selection, IME, clipboard,
  // mouse positioning). A drawn caret on top of it follows the
  // cursorStyle/cursorBlink settings.
  const [inputVal,     setInputVal]     = useState("");
  const [promptFocused, setPromptFocused] = useState(false);
  const [caret, setCaret] = useState<{ left: number; ch: string; hasSel: boolean }>({ left: 0, ch: " ", hasSel: false });
  // Programmatic cursor moves (history, Ctrl+A/E, completion) are
  // applied after React has written the new value.
  const [caretRequest, setCaretRequest] = useState<{ pos: number; n: number } | null>(null);

  // ── search state ──────────────────────────────────────────
  const [searching,    setSearching]    = useState(false);
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);

  // ── right-click menu on the output (null = closed) ──────────
  const [outputMenu, setOutputMenu] = useState<{ x: number; y: number; hasSel: boolean } | null>(null);

  // ── find in output (Ctrl+Shift+F) — searches the scrollback, unlike
  // Ctrl+R, which searches command history. ─────────────────────────
  const [outputSearchOpen,  setOutputSearchOpen]  = useState(false);
  const [outputSearchQuery, setOutputSearchQuery] = useState("");
  const [outputSearchIndex, setOutputSearchIndex] = useState(0);
  const outputSearchInputRef = useRef<HTMLInputElement>(null);

  // ── editor (also used for plugin editing — see findPluginForPath
  // in editorSave below; plugins open in this exact Editor, not a
  // second one) ──────────────────────────────────────────────
  const [editorFiles,   setEditorFiles]   = useState<EditorFile[]>([]);
  const [activeEditorPath, setActiveEditorPath] = useState<string | null>(null);
  const [fileTreeOpen, setFileTreeOpen] = useState(false);
  // 'edit with no arguments (see registerBuiltinCommands) — opens the
  // tree even with zero files open, so the keyboard-only path into
  // the editor doesn't require already knowing a file's exact path.
  useEffect(() => events.on("open_file_tree", () => setFileTreeOpen(true)), []);
  // File tree root: the linked project folder if the active workspace
  // has one, otherwise the app's own folder. Updated on workspace
  // changes.
  const [fileTreeRoot, setFileTreeRoot] = useState<{ dir: string; label: string }>({ dir: ".", label: "FILES" });
  useEffect(() => {
    const update = async () => {
      const name = workspaceManager.getActiveNamed();
      const extPath = await workspaceManager.getActiveExternalPath();
      if (extPath) setFileTreeRoot({ dir: extPath, label: name || "PROJECT" });
      else setFileTreeRoot({ dir: ".", label: "FILES" });
    };
    update();
    const u1 = events.on("workspace_loaded", update);
    const u2 = events.on("workspace_unloaded", update);
    const u3 = events.on("workspace_linked", update);
    const u4 = events.on("workspace_unlinked", update);
    return () => { u1(); u2(); u3(); u4(); };
  }, []);

  // ── refs ──────────────────────────────────────────────────
  const outRef        = useRef<HTMLDivElement>(null);
  const promptRef     = useRef<HTMLInputElement>(null);
  const mirrorRef     = useRef<HTMLSpanElement>(null);
  const isActiveRef   = useRef(isActive);
  isActiveRef.current = isActive;
  const session       = useRef<PtySession | null>(null);
  const pending       = useRef("");
  const mounted       = useRef(false);
  const inputRef      = useRef<InputState>({ value: "", cursor: 0 });
  const userScrolled  = useRef(false);
  const ctxRef        = useRef<ShellCtx | null>(null);
  const linesRef       = useRef<Line[]>(lines);

  // ── restore scroll + focus when tab becomes visible ─────────
  useEffect(() => {
    if (!isActive) {
      userScrolled.current = false;
      return;
    }
    // Layout isn't ready the same frame display:none flips to flex.
    let attempts = 0;
    const tryScroll = () => {
      const el = outRef.current;
      if (el && el.clientHeight > 0) {
        el.scrollTop = el.scrollHeight;
        if (document.activeElement === document.body) promptRef.current?.focus({ preventScroll: true });
      } else if (attempts++ < 10) {
        requestAnimationFrame(tryScroll);
      }
    };
    requestAnimationFrame(tryScroll);
  }, [isActive]);

  // ── prompt sync ───────────────────────────────────────────
  /** Positions the drawn caret over the input's real cursor. */
  const updateCaret = useCallback(() => {
    const el = promptRef.current, mirror = mirrorRef.current;
    if (!el || !mirror) return;
    const pos = el.selectionStart ?? el.value.length;
    mirror.textContent = el.value.slice(0, pos);
    setCaret({
      left: mirror.offsetWidth - el.scrollLeft,
      ch: el.value[pos] ?? " ",
      hasSel: el.selectionStart !== el.selectionEnd,
    });
  }, []);

  /** Sets the prompt text and cursor from code. */
  const syncInput = useCallback((val: string, cur: number) => {
    inputRef.current = { value: val, cursor: cur };
    setInputVal(val);
    setCaretRequest(r => ({ pos: cur, n: (r?.n ?? 0) + 1 }));
  }, []);

  useLayoutEffect(() => {
    const el = promptRef.current;
    if (!caretRequest || !el) return;
    const pos = Math.min(caretRequest.pos, el.value.length);
    el.setSelectionRange(pos, pos);
    // Keep the cursor in view in a long, horizontally scrolled command.
    if (pos === el.value.length) el.scrollLeft = el.scrollWidth;
    updateCaret();
  }, [caretRequest, updateCaret]);

  const clearInput = useCallback(() => syncInput("", 0), [syncInput]);

  // ── scroll ────────────────────────────────────────────────
  const scrollToBottom = useCallback((force = false) => {
    if (!force && userScrolled.current) return;
    requestAnimationFrame(() => {
      const el = outRef.current;
      if (el && el.scrollHeight > 0) el.scrollTop = el.scrollHeight;
    });
  }, []);

  const handleScroll = useCallback(() => {
    const el = outRef.current;
    if (!el) return;
    userScrolled.current = (el.scrollHeight - el.scrollTop - el.clientHeight) > 60;
  }, []);

  // ── output helpers ────────────────────────────────────────
  const addLine = useCallback((text: string, kind?: LineKind) => {
    setLines(prev => {
      const next = prev.length >= 10_000 ? prev.slice(-8_000) : prev;
      const result = [...next, mkLine(text, kind)];
      linesRef.current = result;
      return result;
    });
    scrollToBottom();
  }, [scrollToBottom]);

  /** Adds several lines in one state update (each may have its own
   *  kind). Cheaper than one addLine per line. */
  const addLines = useCallback((entries: Array<[string, LineKind?]>) => {
    if (entries.length === 0) return;
    setLines(prev => {
      const next = prev.length >= 10_000 ? prev.slice(-8_000) : prev;
      const result = [...next, ...entries.map(([text, kind]) => mkLine(text, kind))];
      linesRef.current = result;
      return result;
    });
    scrollToBottom();
  }, [scrollToBottom]);

  // Real-time workspace auto-reload notifications — see
  // startAutoReload() in workspaceManager.ts. Only the ACTIVE
  // terminal tab prints these (isActive), so switching workspaces in
  // one tab doesn't spam a message into every other open tab too.
  useEffect(() => {
    if (!isActive) return;
    const u1 = events.on("workspace_auto_reloaded", (p) => {
      const path = (p as { path?: string } | undefined)?.path ?? "?";
      addLine(`  ⟳ workspace auto-reloaded (a file changed on disk) — ${path}`, "dim");
    });
    const u2 = events.on("workspace_auto_reload_failed", (p) => {
      const { path, message } = (p as { path?: string; message?: string } | undefined) ?? {};
      addLine(`  ⚠ workspace auto-reload failed: ${message ?? "unknown error"} — ${path ?? "?"}`, "warn");
    });
    // Errors thrown by command handlers (see commandRegistry.ts).
    const u3 = events.on("command_error", (p) => {
      const { name, message } = (p as { name?: string; message?: string } | undefined) ?? {};
      addLine(`  ✗  '${name ?? "?"}' failed: ${message ?? "unknown error"}`, "err");
    });
    return () => { u1(); u2(); u3(); };
  }, [isActive, addLine]);

  const clear = useCallback(() => {
    setPartial("");
    pending.current = "";
    const fresh = initialLines();
    linesRef.current = fresh;
    setLines(fresh);
    userScrolled.current = false;
    scrollToBottom(true);
  }, [scrollToBottom]);

  const sendToShell = useCallback((data: string) => {
    session.current?.write(data);
  }, []);

  const focusPrompt = useCallback(() => {
    promptRef.current?.focus({ preventScroll: true });
  }, []);

  /** Text selected inside the output area, or "" (selections elsewhere,
   *  including inside the prompt, don't count). */
  const outputSelectionText = useCallback((): string => {
    const sel = window.getSelection?.();
    const out = outRef.current;
    if (!sel || sel.isCollapsed || !out) return "";
    if (!out.contains(sel.anchorNode) && !out.contains(sel.focusNode)) return "";
    return sel.toString();
  }, []);

  // Output search (Ctrl+Shift+F) — distinct from Ctrl+R's reverse-i-search
  // through COMMAND HISTORY above; this searches the actual on-screen
  // scrollback (`lines`) instead — "did I already see X printed
  // somewhere above".
  const outputSearchMatches = useMemo(() => {
    const q = outputSearchQuery.trim().toLowerCase();
    if (!q) return [] as number[]; // line ids
    return lines.filter(l => l.text.toLowerCase().includes(q)).map(l => l.id);
  }, [lines, outputSearchQuery]);
  const outputSearchSet = useMemo(() => new Set(outputSearchMatches), [outputSearchMatches]);

  const jumpToOutputMatch = useCallback((idx: number) => {
    if (outputSearchMatches.length === 0) return;
    const wrapped = ((idx % outputSearchMatches.length) + outputSearchMatches.length) % outputSearchMatches.length;
    const lineId = outputSearchMatches[wrapped];
    const el = outRef.current?.querySelector(`[data-line-id="${lineId}"]`);
    el?.scrollIntoView({ block: "center" });
  }, [outputSearchMatches]);

  useEffect(() => {
    setOutputSearchIndex(0);
    if (outputSearchMatches.length > 0) jumpToOutputMatch(0);
    // jumpToOutputMatch intentionally omitted — derived from the same
    // matches/query this already re-runs on (see the equivalent note
    // on the Editor's find-bar effect).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outputSearchMatches, outputSearchQuery]);

  const openOutputSearch = useCallback(() => {
    setOutputSearchOpen(true);
    setTimeout(() => outputSearchInputRef.current?.focus(), 20);
  }, []);
  const closeOutputSearch = useCallback(() => {
    setOutputSearchOpen(false);
    setOutputSearchQuery("");
    setTimeout(() => focusPrompt(), 20);
  }, [focusPrompt]);

  // A plain click in the output focuses the prompt; a drag that selected
  // text leaves the selection (and focus) alone so it can be copied.
  const focusUnlessSelecting = useCallback(() => {
    if (window.getSelection?.()?.toString()) return;
    focusPrompt();
  }, [focusPrompt]);

  // ── right-click menu on the output (Copy / Select All / Clear) ──
  const openOutputMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    // Keep the menu inside the window.
    const x = Math.min(e.clientX, window.innerWidth - 170);
    const y = Math.min(e.clientY, window.innerHeight - 110);
    setOutputMenu({ x, y, hasSel: outputSelectionText().length > 0 });
  }, [outputSelectionText]);

  const copyOutputSelection = useCallback(() => {
    const text = outputSelectionText();
    if (text) void copyToClipboard(text);
    setOutputMenu(null);
  }, [outputSelectionText]);

  const selectAllOutput = useCallback(() => {
    const el = outRef.current;
    if (el && window.getSelection) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    }
    setOutputMenu(null);
  }, []);

  const clearOutputSelectionAction = useCallback(() => {
    window.getSelection?.()?.removeAllRanges();
    setOutputMenu(null);
  }, []);

  // Close the menu on any click elsewhere or Escape.
  useEffect(() => {
    if (!outputMenu) return;
    const onDocClick = () => setOutputMenu(null);
    const onDocKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOutputMenu(null); };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onDocKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onDocKey);
    };
  }, [outputMenu]);

  // When the OS window regains focus with nothing focused inside it,
  // put the cursor back in the prompt.
  useEffect(() => {
    const onWindowFocus = () => {
      setTimeout(() => {
        if (document.activeElement === document.body && editorFiles.length === 0) focusPrompt();
      }, 30);
    };
    window.addEventListener("focus", onWindowFocus);
    return () => window.removeEventListener("focus", onWindowFocus);
  }, [editorFiles.length, focusPrompt]);

  // Keep the prompt ready without stealing focus: Ctrl+I jumps to it,
  // and typing while nothing editable is focused (after clicking the
  // output or Home, say) goes into it.
  useEffect(() => {
    const isEditable = (el: Element | null) =>
      el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "i") {
        e.preventDefault();
        focusPrompt();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
      if (isEditable(document.activeElement)) return;
      if (document.querySelector(".overlay, .cmdp-backdrop")) return;
      focusPrompt(); // the character then lands in the prompt
    };
    const onFocusRequest = () => focusPrompt();
    window.addEventListener("keydown", onKeyDown);
    const off = events.on("focus_prompt", onFocusRequest);
    return () => { window.removeEventListener("keydown", onKeyDown); off(); };
  }, [focusPrompt]);

  useEffect(() => events.on("clear_terminal", () => clear()), [clear]);

  /** Ctrl+C with nothing selected: interrupt whatever the shell runs. */
  const interrupt = useCallback(() => {
    sendToShell("\x03");
    clearInput();
    history.resetNav();
    scriptRunTracker.cancel();
    void cancelActiveCommit();
  }, [sendToShell, clearInput]);

  // Ctrl+C / Ctrl+Shift+C / Cmd+C when focus is outside the prompt (the
  // prompt handles its own keys): selected output is copied, never
  // interrupting anything. With no selection and focus on the terminal
  // itself (not another field or the editor), plain Ctrl+C interrupts.
  useEffect(() => {
    const onWindowKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== "c") return;
      const active = document.activeElement;
      if (active === promptRef.current) return;
      const selected = outputSelectionText();
      if (selected) {
        e.preventDefault();
        void copyToClipboard(selected);
        return;
      }
      if (active instanceof HTMLElement && active !== document.body && !outRef.current?.contains(active)) return;
      if (e.metaKey || e.shiftKey || !isActiveRef.current || editorFiles.length > 0) return;
      e.preventDefault();
      interrupt();
      focusPrompt();
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [editorFiles.length, interrupt, focusPrompt, outputSelectionText]);

  // Ctrl+B toggles the file tree — only wired up while the Editor is
  // actually showing (editorFiles.length > 0); harmless to bind
  // globally too, but there's nothing for it to toggle otherwise.
  useEffect(() => {
    if (!isActive || editorFiles.length === 0) return;
    const onWindowKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.key.toLowerCase() !== "b") return;
      e.preventDefault();
      setFileTreeOpen(o => !o);
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [isActive, editorFiles.length]);

  // ── PTY output ────────────────────────────────────────────
  const onOutput = useCallback((raw: string) => {
    raw = cwdTracker.consume(raw);
    raw = scriptRunTracker.consume(raw);
    if (!raw) return;
    const processed = processOutput(raw, pending.current);
    pending.current = processed.newPending;
    // The unfinished last line (the shell prompt, or a program asking
    // for input) is shown live below the completed lines.
    setPartial(isProbeLine(processed.newPending) ? "" : stripStepEcho(visibleText(processed.newPending)));
    // Drop probe echoes, and collapse runs of blank lines (the shell's
    // screen repaints turn into many of them once cursor moves are
    // stripped).
    const completedLines: string[] = [];
    let prevBlank = (linesRef.current[linesRef.current.length - 1]?.text ?? "x").trim() === "";
    for (const raw of processed.completedLines) {
      if (isProbeLine(raw)) continue;
      const l = stripStepEcho(raw);
      const blank = l.trim() === "";
      if (blank && prevBlank) continue;
      completedLines.push(l);
      prevBlank = blank;
    }
    if (!completedLines.length) return;
    setLines(prev => {
      const next = mergeOutput(prev, completedLines);
      linesRef.current = next;
      return next;
    });
    scrollToBottom();
  }, [scrollToBottom]);

  // ── OXIS command dispatcher ───────────────────────────────
  const dispatchOxisCmd = useCallback((raw: string): boolean => {
    let body = raw.trim();
    if      (body.startsWith("'"))            body = body.slice(1).trimStart();
    else if (/^oxi(\s|$)/i.test(body))        body = body.replace(/^oxi\s*/i, "");
    else return false;

    if (!body) { addLine("  OXIS · type 'help for commands", "accent"); return true; }

    // An earlier command may still be running or waiting at a
    // Read-Host prompt; starting another would type into that prompt.
    if (scriptRunTracker.isBusy()) {
      addLine("  ⚠  a previous command is still running (possibly waiting for input) — answer its prompt or press Ctrl+C first", "err");
      return true;
    }

    const parts = splitCmdArgs(body);
    const verb  = parts[0].toLowerCase();
    const args  = parts.slice(1);
    const rest  = args.join(" ");
    // Keep ctx callbacks current before dispatch
    if (ctxRef.current) {
      ctxRef.current.send  = sendToShell;
      ctxRef.current.print = addLine;
      ctxRef.current.printLines = addLines;
      ctxRef.current.clear = clear;
    }
    return registry.execute(verb, args, rest);
  }, [addLine, sendToShell, clear]);

  // Asks the shell for its cwd (cwdTracker.ts); the probe's echo and
  // answer are filtered out of the output.
  const probeCwd = useCallback(() => {
    sendToShell(buildCwdProbe(isWindows()) + "\r");
  }, [sendToShell]);

  // Runs one command line: 'commands (or "oxi ...") go to the OXIS
  // registry, everything else to the shell. Used by the prompt and by
  // ShellCtx.runLine (command palette, plugins).
  const runLine = useCallback((raw: string) => {
    const cmd = raw.trim();
    if (!cmd) { sendToShell("\r"); return; }
    history.push(cmd);

    const isOxis = cmd.startsWith("'") || /^oxi(\s|$)/i.test(cmd);
    if (isOxis) {
      const disp = cmd.startsWith("'")
        ? cmd.slice(1)
        : cmd.replace(/^oxi\s*/i, "");
      addLine("  '" + disp, "cmd");
      if (!dispatchOxisCmd(cmd)) addLine("  ✗  unknown command — type 'help", "err");
    } else {
      sendToShell(cmd + "\r");
      // Re-probe the cwd after a likely directory change so the
      // workspace there is detected; wait for the cd to finish first.
      if (looksLikeDirectoryChange(cmd)) setTimeout(probeCwd, 400);
    }
    scrollToBottom(true);
  }, [sendToShell, addLine, dispatchOxisCmd, scrollToBottom, probeCwd]);


  // PTY size from .app-body, which the terminal fills and which stays
  // measurable while Home is showing. Getting it right before the
  // terminal is first shown avoids the shell repainting (and so
  // duplicating) its screen on a late resize.
  const measurePtySize = useCallback((): { cols: number; rows: number } | null => {
    const el = outRef.current;
    const host = (el?.closest(".app-body") as HTMLElement | null) ?? el;
    if (!el || !host || host.clientWidth === 0 || host.clientHeight === 0) return null;
    const style = getComputedStyle(el);
    const g = document.createElement("canvas").getContext("2d");
    let charW = 7.8;
    if (g) { g.font = `${style.fontSize} ${style.fontFamily}`; charW = g.measureText("MMMMMMMMMM").width / 10 || charW; }
    const lineH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--lh")) || 20;
    const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    return {
      cols: Math.max(20, Math.floor((host.clientWidth - padX) / charW)),
      rows: Math.max(5,  Math.floor((host.clientHeight - padY) / lineH)),
    };
  }, []);

  // ── PTY connect ───────────────────────────────────────────
  useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;

    session.current = openPty({
      ...(measurePtySize() ?? { cols: 120, rows: 30 }),
      onOutput,
      onReady: () => {
        setReady(true);
        onReady();
        setTimeout(focusPrompt, 60);
        events.emit("shell_started", { id });
        // Initial cwd probe — this is what makes automatic workspace
        // detection on launch actually automatic instead of requiring
        // the user to run 'workspace reload by hand.
        setTimeout(probeCwd, 500);

        // A newer build is announced once, as a single line.
        setTimeout(() => {
          void startupUpdateCheck().then(info => {
            if (info?.available) {
              addLine(`  ↑  a newer OXIS build (${info.latestCommit.slice(0, 7)}) is available${info.currentCommit ? ` (you're on ${info.currentCommit.slice(0, 7)})` : ""} — 'update install to install it`, "info");
            }
          });
        }, 2000);
      },
      onExit: code => {
        if (code !== -1) setConnErr(`shell exited (code ${code})`);
        events.emit("shell_exited", { id, code });
      },
      onError: msg => setConnErr(msg),
    });
    return () => session.current?.kill();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── PTY resize ────────────────────────────────────────────
  useEffect(() => {
    const el = outRef.current;
    if (!el) return;
    const host = (el.closest(".app-body") as HTMLElement | null) ?? el;
    let last = "";
    const ro = new ResizeObserver(() => {
      const size = measurePtySize();
      if (!size) return;
      const key = `${size.cols}x${size.rows}`;
      if (key === last) return;
      last = key;
      session.current?.resize(size.cols, size.rows);
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  // ── Plugin/command init (once ever) ──────────────────────
  useEffect(() => {
    // Wire real callbacks — overrides the stub set at root init
    ctxRef.current = {
      send: sendToShell,
      runLine,
      print: addLine,
      printLines: addLines,
      clear,
      openEditor: (path, line) => {
        setEditorFiles(files => {
          // Already open — still record the new gotoLine (e.g. a
          // second 'oxis resize while the file's already sitting in
          // a background tab should still jump there), just don't
          // re-open or re-read it.
          if (files.some(f => f.path === path)) {
            return line == null ? files : files.map(f => f.path === path ? { ...f, gotoLine: line } : f);
          }
          return [...files, { path, content: "", dirty: false, loading: true, gotoLine: line }];
        });
        setActiveEditorPath(path);
        events.emit("editor_opened", { path });
        readFile(path)
          .then(content => setEditorFiles(files => files.map(f => f.path === path ? { ...f, content, loading: false } : f)))
          .catch(e => setEditorFiles(files => files.map(f => f.path === path
            ? { ...f, loading: false, loadError: e instanceof Error ? e.message : String(e) }
            : f)));
      },
      newTerminal: onNewTab,
    };
    _ctxRef.current = ctxRef.current;

    // Point the forwarding plugin context at this terminal (see
    // forwardingApiCtx), including for plugins that loaded earlier.
    _apiCtxTarget.current = {
      sendToShell: sendToShell,
      print:       addLine,
      getCwd:      () => cwdTracker.get(),
      newTerminal: onNewTab,
      getOption:   readPersistedOption,
      setOption:   writePersistedOption,
      pluginName:  "__core__",
    };

    ensurePluginsInited();
    _commandsRegistered = false;
    registerBuiltinCommands(ctxRef.current);

    return undefined;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep ctx callbacks fresh — also update module-level _ctxRef
  useEffect(() => {
    if (ctxRef.current) {
      ctxRef.current.send    = sendToShell;
      ctxRef.current.runLine = runLine;
      ctxRef.current.print   = addLine;
      ctxRef.current.clear   = clear;
    }
    _ctxRef.current = ctxRef.current;
  }, [sendToShell, runLine, addLine, clear]);

  useEffect(() => {
    const u1 = events.on("plugin_enable_request",  p => { if (p?.name) pluginManager.enable(String(p.name)); });
    const u2 = events.on("plugin_disable_request", p => { if (p?.name) pluginManager.disable(String(p.name)); });
    return () => { u1(); u2(); };
  }, []);

  // ── Submit ────────────────────────────────────────────────
  // From Home, Enter switches to the terminal first so the output is
  // visible; an empty Enter on Home just opens the terminal.
  const submit = useCallback(() => {
    const cmd = inputRef.current.value.trim();
    clearInput();
    history.resetNav();
    if (!isActiveRef.current) {
      onShowShell();
      if (!cmd) return;
    }
    runLine(cmd);
  }, [clearInput, runLine, onShowShell]);

  // ── Search helpers ────────────────────────────────────────
  const enterSearch = useCallback(() => {
    history.enterSearch();
    setSearching(true);
    setSearchResult(null);
  }, []);

  const exitSearch = useCallback((commit: boolean) => {
    if (commit && searchResult) {
      syncInput(searchResult.match, searchResult.match.length);
      inputRef.current = { value: searchResult.match, cursor: searchResult.match.length };
    }
    history.exitSearch();
    setSearching(false);
    setSearchResult(null);
  }, [searchResult, syncInput]);

  /** Mirrors a native edit of the prompt into inputRef and the caret. */
  const onPromptChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    inputRef.current = { value, cursor: e.target.selectionStart ?? value.length };
    setInputVal(value);
    history.setDraft(value);
    requestAnimationFrame(updateCaret);
  }, [updateCaret]);

  // ══════════════════════════════════════════════════════════
  // KEYBOARD — readline/Emacs bindings on top of a native input.
  // Plain typing, Backspace/Delete, arrows, Home/End and Shift/mouse
  // selection are left to the browser.
  // ══════════════════════════════════════════════════════════
  const onKey = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.nativeEvent.isComposing) return; // IME composition owns the keys
    const k    = e.key;
    const ctrl = e.ctrlKey  && !e.altKey;
    const alt  = e.altKey   && !e.ctrlKey;
    const el   = e.currentTarget;
    const val  = el.value;
    const cur  = el.selectionStart ?? val.length;
    const hasPromptSel = el.selectionStart !== el.selectionEnd;
    inputRef.current = { value: val, cursor: cur };

    // ── COPY: Ctrl+C / Ctrl+Shift+C / Cmd+C copy a selection first ──
    // Prompt selection, then output selection. Only a plain Ctrl+C with
    // nothing selected interrupts the running process.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && k.toLowerCase() === "c") {
      e.preventDefault();
      if (hasPromptSel) {
        void copyToClipboard(val.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0));
        return;
      }
      const selected = outputSelectionText();
      if (selected) { void copyToClipboard(selected); return; }
      if (e.shiftKey || e.metaKey) return; // explicit copy never interrupts
      if (searching) exitSearch(false);
      interrupt();
      return;
    }

    // ── REVERSE SEARCH MODE ──────────────────────────────
    if (searching) {
      e.preventDefault();
      if (k === "Escape" || (ctrl && k.toLowerCase() === "g")) { exitSearch(false); return; }
      if (k === "Enter")                                        { exitSearch(true); submit(); return; }
      if (ctrl && k.toLowerCase() === "r")                     { const r = history.searchOlder(); if (r) setSearchResult(r); return; }
      if (k === "Backspace")  { setSearchResult(history.searchBackspace()); return; }
      if (k.length === 1 && !ctrl && !e.metaKey) { setSearchResult(history.searchAppend(k)); return; }
      return;
    }

    // ── VIEW / TAB SHORTCUTS ─────────────────────────────
    if (ctrl && !e.shiftKey && k === "t") { e.preventDefault(); onNewTab();   return; }
    if (ctrl && !e.shiftKey && k === "w") { e.preventDefault(); onCloseTab(); return; }

    // ── ZOOM (Ctrl+= / Ctrl+- / Ctrl+0) — stored as the fontSize setting ──
    if (ctrl && (k === "=" || k === "+")) {
      e.preventDefault();
      const size = Number(getSetting("fontSize")) || 13;
      setSetting("fontSize", String(Math.min(28, size + 1)));
      return;
    }
    if (ctrl && k === "-") {
      e.preventDefault();
      const size = Number(getSetting("fontSize")) || 13;
      setSetting("fontSize", String(Math.max(9, size - 1)));
      return;
    }
    if (ctrl && k === "0") { e.preventDefault(); resetSetting("fontSize"); return; }

    // ── PASSTHROUGH with an empty prompt (a program is reading keys) ──
    // Up/Down/PageUp/PageDown stay OXIS's history and scroll keys.
    if (!val && !e.metaKey) {
      const passSeq: Record<string, string> = {
        ArrowRight:"\x1b[C", ArrowLeft:"\x1b[D",
        Home:"\x1b[H", End:"\x1b[F",
        Delete:"\x1b[3~",
        Tab:"\t", Escape:"\x1b",
        F1:"\x1bOP",F2:"\x1bOQ",F3:"\x1bOR",F4:"\x1bOS",
        F5:"\x1b[15~",F6:"\x1b[17~",F7:"\x1b[18~",F8:"\x1b[19~",
        F9:"\x1b[20~",F10:"\x1b[21~",F11:"\x1b[23~",F12:"\x1b[24~",
      };
      if (passSeq[k] && !ctrl && !alt && !e.shiftKey) { e.preventDefault(); sendToShell(passSeq[k]); return; }
    }

    // ── TAB COMPLETION ─────────────────────────────────────
    // 'commands complete against the real command registry (verb
    // only); anything else sends Tab to the shell's own completion.
    if (!ctrl && !alt && k === "Tab") {
      e.preventDefault();
      if (!val.startsWith("'")) { sendToShell("\t"); return; }
      const body = val.slice(1);
      if (body.includes(" ")) return;
      const prefix = body.toLowerCase();
      const names = [...new Set(registry.all().map(c => c.name).filter(n => !n.includes(":")))].sort();
      const matches = prefix ? names.filter(n => n.toLowerCase().startsWith(prefix)) : names;
      if (matches.length === 1) {
        syncInput(`'${matches[0]} `, matches[0].length + 2);
      } else if (matches.length > 1) {
        let common = matches[0];
        for (const m of matches.slice(1)) {
          while (!m.toLowerCase().startsWith(common.toLowerCase())) common = common.slice(0, -1);
        }
        if (common.length > body.length) syncInput(`'${common}`, common.length + 1);
        else addLine(`  ${matches.slice(0, 20).join("  ")}${matches.length > 20 ? "  …" : ""}`, "dim");
      }
      return;
    }

    // ── CTRL BINDINGS (readline) ──────────────────────────
    if (ctrl && !e.shiftKey) {
      switch (k.toLowerCase()) {
        case "d": e.preventDefault(); sendToShell("\x04"); return;
        case "z": e.preventDefault(); sendToShell("\x1a"); return;
        case "\\": e.preventDefault(); sendToShell("\x1c"); return;

        case "a": e.preventDefault(); syncInput(val, 0);          return; // start of line
        case "e": e.preventDefault(); syncInput(val, val.length); return; // end of line
        case "f": e.preventDefault(); syncInput(val, Math.min(val.length, cur + 1)); return;
        case "b": e.preventDefault(); syncInput(val, Math.max(0, cur - 1));          return;
        case "h": e.preventDefault();
          if (cur > 0) syncInput(val.slice(0, cur - 1) + val.slice(cur), cur - 1);
          return;

        case "k": { // kill to end of line
          e.preventDefault();
          const r = deleteToLineEnd(val, cur);
          setYankBuf(val.slice(cur));
          syncInput(r.text, r.pos);
          return;
        }
        case "u": { // kill to start of line
          e.preventDefault();
          const r = deleteToLineStart(val, cur);
          setYankBuf(val.slice(0, cur));
          syncInput(r.text, r.pos);
          return;
        }
        case "y": { // yank
          e.preventDefault();
          const yank = getYankBuf();
          if (yank) syncInput(val.slice(0, cur) + yank + val.slice(cur), cur + yank.length);
          return;
        }
        case "l": e.preventDefault(); clear(); return;
        case "r": e.preventDefault(); enterSearch(); return;
        case "p": e.preventDefault(); { const p = history.prev(val); syncInput(p, p.length); return; }
        case "n": e.preventDefault(); { const n = history.next(); syncInput(n, n.length); return; }
      }
      // Anything else (Ctrl+V paste, Ctrl+X cut, Ctrl+Arrow word moves,
      // Ctrl+Backspace) is native input behaviour.
      return;
    }
    if (ctrl && e.shiftKey && k.toLowerCase() === "f") { e.preventDefault(); openOutputSearch(); return; }
    if (ctrl) return;

    // ── ALT BINDINGS (word movement / case) ───────────────
    if (alt) {
      switch (k.toLowerCase()) {
        case "f":         e.preventDefault(); syncInput(val, wordRight(val, cur)); return;
        case "b":         e.preventDefault(); syncInput(val, wordLeft(val, cur));  return;
        case "d":         e.preventDefault(); { const r = deleteWordRight(val, cur); setYankBuf(val.slice(cur, wordRight(val, cur))); syncInput(r.text, r.pos); return; }
        case "backspace": e.preventDefault(); { const r = deleteWordLeft(val, cur);  setYankBuf(val.slice(wordLeft(val, cur), cur)); syncInput(r.text, r.pos); return; }
        case "<":         e.preventDefault(); syncInput(val, 0);          return;
        case ">":         e.preventDefault(); syncInput(val, val.length); return;
        case "t": { // transpose words
          e.preventDefault();
          const ls = wordLeft(val, cur);
          const le = wordRight(val, ls);
          const rs = wordLeft(val, wordRight(val, cur));
          const re = wordRight(val, rs);
          if (ls === rs) return;
          const w1 = val.slice(ls, le);
          const w2 = val.slice(rs, re);
          syncInput(val.slice(0, ls) + w2 + val.slice(le, rs) + w1 + val.slice(re), re - (w1.length - w2.length));
          return;
        }
        case "u": { e.preventDefault(); const end = wordRight(val, cur); syncInput(val.slice(0, cur) + val.slice(cur, end).toUpperCase() + val.slice(end), end); return; }
        case "l": { e.preventDefault(); const end = wordRight(val, cur); syncInput(val.slice(0, cur) + val.slice(cur, end).toLowerCase() + val.slice(end), end); return; }
        case "c": {
          e.preventDefault();
          const end = wordRight(val, cur);
          const word = val.slice(cur, end);
          syncInput(val.slice(0, cur) + word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() + val.slice(end), end);
          return;
        }
      }
      return;
    }

    // ── HISTORY / SCROLL / SUBMIT ─────────────────────────
    if (k === "ArrowUp" && !e.shiftKey) {
      e.preventDefault();
      const p = history.prev(val);
      syncInput(p, p.length);
      return;
    }
    if (k === "ArrowDown" && !e.shiftKey) {
      e.preventDefault();
      const n = history.next();
      syncInput(n, n.length);
      return;
    }
    if (k === "PageUp")   { e.preventDefault(); outRef.current?.scrollBy(0, -(outRef.current.clientHeight - 40)); return; }
    if (k === "PageDown") { e.preventDefault(); outRef.current?.scrollBy(0,   outRef.current.clientHeight - 40);  return; }
    if (k === "Enter")    { e.preventDefault(); submit(); return; }
    if (k === "Escape")   {
      e.preventDefault();
      if (hasPromptSel) { el.setSelectionRange(cur, cur); updateCaret(); return; }
      sendToShell("\x1b");
      return;
    }
    // Everything else is native editing; the caret follows via onSelect.
  }, [
    searching, exitSearch, enterSearch, submit, interrupt, outputSelectionText,
    syncInput, sendToShell, addLine, clear, updateCaret,
    onNewTab, onCloseTab, openOutputSearch,
  ]);

  // ── Paste ─────────────────────────────────────────────────
  // One line goes into the prompt natively; several lines go straight
  // to the shell (after confirming).
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text");
    if (!text || !/[\r\n]/.test(text.replace(/[\r\n]+$/, ""))) {
      if (/[\r\n]$/.test(text)) {
        // A single line copied with its newline: paste without it.
        e.preventDefault();
        const el = e.currentTarget;
        const start = el.selectionStart ?? el.value.length, end = el.selectionEnd ?? start;
        const clean = text.replace(/[\r\n]+$/, "");
        syncInput(el.value.slice(0, start) + clean + el.value.slice(end), start + clean.length);
      }
      return;
    }
    e.preventDefault();
    const lns = text.split(/\r?\n/).filter(Boolean);
    if (lns.length > 1 && !window.confirm(`Paste ${lns.length} lines to the shell?`)) return;
    clearInput();
    sendToShell(text.replace(/\r?\n/g, "\r"));
  }, [syncInput, clearInput, sendToShell]);

  // ── Editor save — written natively. A plugin's own source file is
  // saved through pluginManager so it reloads (findPluginForPath).
  const editorSave = useCallback(async (path: string, content: string): Promise<boolean> => {
    const pluginName = findPluginForPath(path);
    if (pluginName) {
      const { persisted, persistError } = await pluginManager.saveLuaPlugin(pluginName, content);
      if (persisted) {
        addLine(`  ✓  saved & reloaded plugin: ${pluginName}`, "ok");
        events.emit("editor_closed", { path });
        return true;
      }
      addLine(`  ✗  save failed: ${persistError instanceof Error ? persistError.message : String(persistError ?? "unknown error")}`, "err");
      return false;
    }
    try {
      await writeFile(path, content);
      addLine(`  ✓  saved: ${path}`, "ok");
      events.emit("editor_closed", { path });
      return true;
    } catch (e) {
      addLine(`  ✗  save failed: ${e instanceof Error ? e.message : String(e)}`, "err");
      return false;
    }
  }, [addLine]);

  const closeEditorTab = useCallback((path: string) => {
    setEditorFiles(files => {
      const remaining = files.filter(f => f.path !== path);
      setActiveEditorPath(cur => {
        if (cur !== path) return cur; // closing a background tab doesn't change which one's active
        const idx = files.findIndex(f => f.path === path);
        const next = remaining[Math.min(idx, remaining.length - 1)];
        return next ? next.path : null;
      });
      return remaining;
    });
  }, []);

  const requestCloseEditorTab = useCallback((path: string) => {
    const f = editorFiles.find(e => e.path === path);
    if (f?.dirty && !confirm(`Discard unsaved changes to ${path}?`)) return;
    closeEditorTab(path);
    if (editorFiles.length <= 1) setTimeout(focusPrompt, 50);
  }, [editorFiles, closeEditorTab, focusPrompt]);

  const saveAllEditorTabs = useCallback(() => {
    const dirty = editorFiles.filter(f => f.dirty && !f.loading);
    if (dirty.length === 0) { addLine("  nothing to save — no dirty tabs", "dim"); return; }
    for (const f of dirty) {
      editorSave(f.path, f.content).then(saved => {
        if (saved) setEditorFiles(files => files.map(x => x.path === f.path ? { ...x, dirty: false } : x));
      });
    }
  }, [editorFiles, editorSave, addLine]);

  // ── Render ────────────────────────────────────────────────
  // The prompt is rendered into the app-level bar (promptHost), so it
  // is the same element on Home, the terminal and the editor, and it
  // never scrolls with the output.
  const promptBar = (
    <div className="term-prompt-bar">
      {searching && (
        <div className="term-search-bar">
          <span className="term-search-label">reverse-i-search</span>
          <span className="term-search-sep">›</span>
          <span className="term-search-query">
            {history.getSearchQuery() || <span className="term-search-ph">type to search…</span>}
          </span>
          {searchResult && (
            <>
              <span className="term-search-sep">›</span>
              <span className="term-search-match">{searchResult.match}</span>
              <span className="term-search-count">{searchResult.rank}/{searchResult.total}</span>
            </>
          )}
          <span className="term-search-hint">Enter run · Esc cancel · Ctrl+R older</span>
        </div>
      )}

      {outputSearchOpen && (
        <div className="term-search-bar term-search-bar--output">
          <span className="term-search-label">find in output</span>
          <span className="term-search-sep">›</span>
          <input
            ref={outputSearchInputRef}
            className="term-search-input"
            value={outputSearchQuery}
            onChange={e => setOutputSearchQuery(e.target.value)}
            placeholder="type to search…"
            onKeyDown={e => {
              if (e.key === "Enter") {
                e.preventDefault();
                const next = e.shiftKey ? outputSearchIndex - 1 : outputSearchIndex + 1;
                setOutputSearchIndex(next);
                jumpToOutputMatch(next);
              }
              if (e.key === "Escape") { e.preventDefault(); closeOutputSearch(); }
            }}
          />
          <span className="term-search-count">
            {outputSearchQuery ? (outputSearchMatches.length > 0
              ? `${((outputSearchIndex % outputSearchMatches.length) + outputSearchMatches.length) % outputSearchMatches.length + 1}/${outputSearchMatches.length}`
              : "0/0") : ""}
          </span>
          <span className="term-search-hint">Enter next · Shift+Enter prev · Esc close</span>
        </div>
      )}

      <div
        className="term-input-row"
        onMouseDown={e => { if (e.target !== promptRef.current) { e.preventDefault(); focusPrompt(); } }}
      >
        <span className="term-prompt" aria-hidden="true">OXIS&nbsp;❯</span>
        <div className="term-input-wrap">
          <input
            ref={promptRef}
            className="term-prompt-input"
            value={inputVal}
            onChange={onPromptChange}
            onBeforeInput={e => {
              // Text that arrives without a keydown (IME, dictation) goes
              // to the reverse-i-search query while it's open.
              if (!searching) return;
              e.preventDefault();
              const data = (e.nativeEvent as InputEvent).data;
              if (data) setSearchResult(history.searchAppend(data));
            }}
            onKeyDown={onKey}
            onKeyUp={updateCaret}
            onSelect={updateCaret}
            onScroll={updateCaret}
            onPaste={handlePaste}
            onFocus={() => { setPromptFocused(true); updateCaret(); }}
            onBlur={() => setPromptFocused(false)}
            spellCheck={false} autoComplete="off" autoCorrect="off" autoCapitalize="off"
            aria-label="OXIS command prompt"
          />
          <span ref={mirrorRef} className="term-input-mirror" aria-hidden="true" />
          {!caret.hasSel && (
            <span
              className={`term-caret ${ready && promptFocused ? "term-caret--on" : "term-caret--off"}`}
              style={{ left: caret.left }}
              aria-hidden="true"
            >{caret.ch === " " ? " " : caret.ch}</span>
          )}
        </div>
      </div>
    </div>
  );
  const promptPortal = promptHost ? createPortal(promptBar, promptHost) : null;

  if (editorFiles.length > 0 || fileTreeOpen) {
    const activeFile = editorFiles.find(f => f.path === activeEditorPath) ?? editorFiles[0];
    return (
      <div className="app-pane app-pane--editor">
        {promptPortal}
        <div className="filetree-rail">
          <button className="filetree-toggle" onClick={() => setFileTreeOpen(o => !o)} title="Toggle file tree (Ctrl+B)">☰</button>
        </div>
        {fileTreeOpen && (
          <FileTree
            rootDir={fileTreeRoot.dir}
            rootLabel={fileTreeRoot.label}
            onOpenFile={path => ctxRef.current?.openEditor(path)}
            onMoveFile={(srcPath, destDirPath) => {
              // These paths come from the tree's own listing, not typed
              // text, so they don't need safeJoinWithinDir.
              const baseName = srcPath.split(/[\\/]/).pop();
              const finalDst = `${destDirPath}/${baseName}`;
              statPath(finalDst).then(stat => {
                if (stat.exists) { addLine(`  ✗  already exists: ${finalDst}`, "err"); return; }
                return movePath(srcPath, finalDst).then(() => {
                  addLine(`  ✓  moved ${srcPath.split(/[\\/]/).pop()} → ${destDirPath}`, "ok");
                  events.emit("filetree_refresh", {});
                });
              }).catch(e => addLine(`  ✗  move failed: ${e instanceof Error ? e.message : e}`, "err"));
            }}
            onClose={() => setFileTreeOpen(false)}
          />
        )}
        <div className="editor-column">
        {editorFiles.length > 1 && (
          <div className="editor-tabs">
            {editorFiles.map(f => (
              <div
                key={f.path}
                className={`editor-tab${f.path === activeFile.path ? " editor-tab--active" : ""}`}
                onClick={() => setActiveEditorPath(f.path)}
                title={f.path}
              >
                <span className="editor-tab-name">{f.path.split(/[\\/]/).pop()}</span>
                {f.dirty && <span className="editor-tab-dirty">●</span>}
                <span className="editor-tab-close" onClick={e => { e.stopPropagation(); requestCloseEditorTab(f.path); }}>×</span>
              </div>
            ))}
            <button className="editor-tabs-saveall" onClick={saveAllEditorTabs} title="Save all dirty tabs">Save All</button>
          </div>
        )}
        {activeFile ? (
          <ErrorBoundary onClose={() => requestCloseEditorTab(activeFile.path)}>
            <Editor
              key={activeFile.path}
              file={activeFile}
              onClose={() => requestCloseEditorTab(activeFile.path)}
              onSave={(p, c) => {
                editorSave(p, c).then(saved => {
                  if (saved) setEditorFiles(files => files.map(f => f.path === p ? { ...f, content: c, dirty: false } : f));
                });
              }}
            />
          </ErrorBoundary>
        ) : (
          // 'edit with no arguments — just opens the tree so the
          // keyboard-only path into the editor doesn't require already
          // knowing a file's exact path first.
          <div className="editor-empty-state">
            <div className="editor-empty-state-msg">No file open</div>
            <div className="editor-empty-state-hint">Pick one from the file tree, or <code>&apos;edit &lt;file&gt;</code></div>
          </div>
        )}
        </div>
      </div>
    );
  }

  return (
    <div className="term">
      {promptPortal}
      {connErr && <div className="term-error">⚠ {connErr}</div>}
      <div className="term-corner-mark" aria-hidden="true">OXIS</div>

      <div
        className="term-out"
        ref={outRef}
        onScroll={handleScroll}
        onMouseUp={e => { if (e.button === 0) focusUnlessSelecting(); }}
        onContextMenu={openOutputMenu}
        tabIndex={-1}
      >
        {lines.map(line => (
          <div key={line.id}
            data-line-id={line.id}
            className={`term-line${outputSearchSet.has(line.id) ? " term-line--match" : ""}`}
            style={{ color: line.kind ? LINE_COLORS[line.kind] : undefined }}>
            {renderLineWithLinks(line.text, u => void openUrl(u), p => _ctxRef.current?.openEditor(p))}
          </div>
        ))}
        {partial && <div className="term-line">{partial}</div>}
      </div>

      {outputMenu && (
        <div
          className="term-ctx-menu"
          style={{ left: outputMenu.x, top: outputMenu.y }}
          // Keep the document mousedown listener from closing the menu
          // before an item's click runs.
          onMouseDown={e => { e.stopPropagation(); e.preventDefault(); }}
        >
          <button className="term-ctx-item" onClick={copyOutputSelection} disabled={!outputMenu.hasSel}>
            <span>Copy</span><span className="term-ctx-key">Ctrl+C</span>
          </button>
          <button className="term-ctx-item" onClick={selectAllOutput}>Select All</button>
          <button className="term-ctx-item" onClick={clearOutputSelectionAction} disabled={!outputMenu.hasSel}>Clear Selection</button>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// HOME — hub
// ══════════════════════════════════════════════════════════════
function ThemeTile({ name, theme, active, isCustom, onClick, onDelete }: {
  name: string; theme: Theme; active: boolean; isCustom?: boolean;
  onClick: () => void; onDelete?: () => void;
}) {
  return (
    <div className={`theme-tile ${active ? "theme-tile--on" : ""}`} onClick={onClick}>
      <div className="theme-tile-preview" style={{ background: theme.bg, borderColor: theme.border }}>
        <div className="theme-tile-bar" style={{ background: theme.bg1 }}>
          <span style={{ color: theme.purple, fontSize: 7, fontWeight: 700 }}>OXIS</span>
        </div>
        <div className="theme-tile-body">
          <span style={{ color: theme.purple, fontSize: 8 }}>❯ </span>
          <span style={{ color: theme.text, fontSize: 8 }}>ls</span>
          <br />
          <span style={{ color: theme.purple2, fontSize: 8 }}>'</span>
          <span style={{ color: theme.dim, fontSize: 8 }}>help</span>
        </div>
      </div>
      <div className="theme-tile-name" style={{ color: active ? "var(--purple3)" : "var(--muted)" }}>
        <span>{name}{active && <span style={{ color: "var(--purple)" }}> ✓</span>}</span>
        {isCustom && onDelete && (
          <button className="theme-tile-del" onClick={e => { e.stopPropagation(); onDelete(); }}
            title="Delete theme">×</button>
        )}
      </div>
    </div>
  );
}

// ── Sky widget: ASCII sun/clouds by day, ASCII moon/stars by night ──
function getMoonPhase(date: Date): number {
  // Returns 0-7 (new moon → waxing → full → waning)
  const synodic = 29.53058867;
  const known = new Date(Date.UTC(2000, 0, 6, 18, 14));
  const days = (date.getTime() - known.getTime()) / 86400000;
  const phase = ((days % synodic) + synodic) % synodic;
  return Math.floor((phase / synodic) * 8) % 8;
}

// Pure ASCII moon phases — width-matched 3-line glyphs
const MOON_ASCII: string[][] = [
  ["()"],          // new moon
  ["()"],          // waxing crescent
  ["|)"],          // first quarter
  ["()"],          // waxing gibbous
  ["(_)"],       // full moon (drawn as circle below)
  ["()"],          // waning gibbous
  ["()"],       // last quarter
  ["(("],          // waning crescent
];

const MOON_FULL = ["  _  ", " ( ) ", "  -  "];


// Cloud glyph variants (day) — picked from randomly per cloud, not
// hand-assigned one-per-slot, so the mix looks different across
// mounts instead of always being the same 2 or 4 shapes in the same
// order.
const CLOUD_GLYPHS = [
  " .--.  \n(____) ",
  " .-.\n(_-_)",
  "  .--.   \n (____)  ",
  " .-.\n(___)",
  ".---.\n(___)",
  " .--.\n(____)",
];

function rand(min: number, max: number): number { return min + Math.random() * (max - min); }

interface CloudLayout { glyph: string; top: number; left: number; fontSize: number; opacity: number; duration: number; delay: number; zIndex: number }

/** One cloud per equal-width band (jittered), with evenly spread
 *  animation phases, so clouds don't clump or move in lockstep. */
function layoutClouds(count: number, widthPx: number): CloudLayout[] {
  const band = widthPx / count;
  const out: CloudLayout[] = [];
  for (let i = 0; i < count; i++) {
    const duration = rand(16, 30);
    out.push({
      glyph: CLOUD_GLYPHS[Math.floor(Math.random() * CLOUD_GLYPHS.length)],
      left: i * band + rand(band * 0.1, band * 0.9),
      // Alternating high/low lane (by index parity) plus jitter, so
      // even two adjacent clouds visibly differ in height rather than
      // both sitting in the same narrow vertical strip.
      top: (i % 2 === 0 ? rand(0, 10) : rand(20, 34)) ,
      fontSize: rand(7, 10),
      opacity: rand(0.35, 0.75),
      duration,
      // Evenly spread starting phase across the cycle (a negative
      // delay starts the animation already partway through), plus
      // enough jitter that it doesn't look mechanically evenly
      // spaced either.
      delay: -((i / count) * duration) + rand(-1.5, 1.5),
      // Randomly in front of (3) or behind (1) the sun (z-index 2) —
      // a real sky has clouds pass both in front of and behind the
      // sun depending on where they are, not permanently one or the
      // other.
      zIndex: Math.random() < 0.5 ? 1 : 3,
    });
  }
  return out;
}

const STAR_GLYPHS = ["*", "."];

interface StarLayout { glyph: string; top: number; left: number; fontSize: number; delay: number }

/** Same banded layout as layoutClouds, for stars. */
function layoutStars(count: number, widthPx: number): StarLayout[] {
  const band = widthPx / count;
  const out: StarLayout[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      glyph: STAR_GLYPHS[Math.floor(Math.random() * STAR_GLYPHS.length)],
      left: i * band + rand(band * 0.1, band * 0.9),
      top: (i % 2 === 0 ? rand(0, 16) : rand(24, 40)),
      fontSize: rand(7, 9),
      delay: rand(0, 2.4), // one full star-twinkle cycle's worth of jitter — no shared phase
    });
  }
  return out;
}

const SKY_WIDGET_WIDTH = 280;

function SkyWidget() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);
  const hour = now.getHours();
  const isDay = hour >= 6 && hour < 18;
  const moonPhase = getMoonPhase(now);

  // Laid out once per mount so clouds don't jump on each clock tick.
  const clouds = useMemo(() => layoutClouds(Math.floor(rand(4, 6)), SKY_WIDGET_WIDTH - 20), []);
  // Same reasoning/count-range as clouds — see layoutStars above.
  const stars = useMemo(() => layoutStars(Math.floor(rand(5, 8)), SKY_WIDGET_WIDTH - 20), []);

  if (isDay) {
    return (
      <div className="sky-widget sky-widget--day">
        <pre className="sky-ascii sky-sun">{"  \\ | /\n -- O --\n  / | \\"}</pre>
        {clouds.map((c, i) => (
          <pre key={i} className="sky-ascii sky-cloud" style={{
            top: `${c.top}px`, left: `${c.left}px`, fontSize: `${c.fontSize}px`,
            animationDuration: `${c.duration}s`, animationDelay: `${c.delay}s`, zIndex: c.zIndex,
            ["--cloud-opacity" as string]: c.opacity,
          } as React.CSSProperties}>{c.glyph}</pre>
        ))}
      </div>
    );
  }
  const moonGlyph = moonPhase === 4 ? MOON_FULL.join("\n") : MOON_ASCII[moonPhase].join("\n");
  return (
    <div className="sky-widget sky-widget--night">
      <pre className="sky-ascii sky-moon">{moonGlyph}</pre>
      {stars.map((s, i) => (
        <span key={i} className="sky-star" style={{
          top: `${s.top}px`, left: `${s.left}px`, fontSize: `${s.fontSize}px`,
          animationDuration: "2.4s", animationDelay: `${s.delay}s`,
        }}>{s.glyph}</span>
      ))}
    </div>
  );
}

function Home({ currentTheme, onTheme, onOpenThemeEditor, onOpenPluginCreator }: {
  currentTheme: string; onTheme: (n: string) => void;
  onOpenThemeEditor: (n: string) => void; onOpenPluginCreator: () => void;
}) {
  const [view, setView] = useState<"home" | "themes" | "plugins">("home");
  const [plugins, setPlugins] = useState(() => pluginManager.all());
  const [psearch, setPsearch] = useState("");
  const [ws, setWs] = useState(() => workspaceState.get());
  const [activeWorkspace, setActiveWorkspace] = useState<string | null>(() => workspaceManager.getActiveNamed());
  const [activeWorkspacePath, setActiveWorkspacePath] = useState<string | null>(null);
  // 'hide workspace / 'show workspace, persisted in the option store.
  const [workspacePanelHidden, setWorkspacePanelHidden] = useState(() => !!readPersistedOption("ui.hideWorkspacePanel"));
  // oxis.dashboard({ header, theme, shortcuts }) from a plugin or config.lua.
  const [dashboard, setDashboard] = useState<{ header?: string; shortcuts?: string[] }>({});
  useEffect(() => events.on("dashboard_config", (p) => {
    const c = ((p as { config?: Record<string, unknown> } | undefined)?.config ?? {}) as Record<string, unknown>;
    if (typeof c.theme === "string" && themeManager.apply(c.theme)) onTheme(c.theme);
    const shortcuts = Array.isArray(c.shortcuts) ? c.shortcuts.map(String)
      : c.shortcuts && typeof c.shortcuts === "object" ? Object.values(c.shortcuts as Record<string, unknown>).map(String)
      : undefined;
    setDashboard({ header: typeof c.header === "string" ? c.header : undefined, shortcuts });
  }), [onTheme]);
  useEffect(() => events.on("ui_workspace_panel_visibility_changed", (p) => {
    setWorkspacePanelHidden(!!(p as { hidden?: boolean } | undefined)?.hidden);
  }), []);
  // Home stays mounted while hidden, so other code opens its panels
  // through this event.
  useEffect(() => events.on("home_view_request", (p) => {
    const v = (p as { view?: string })?.view;
    if (v === "home" || v === "themes" || v === "plugins") setView(v);
  }), []);

  useEffect(() => workspaceState.subscribe(setWs), []);
  // Track the named workspace directly: projectName alone can't tell a
  // named workspace from an ad-hoc .oxis folder.
  useEffect(() => {
    const update = () => {
      const name = workspaceManager.getActiveNamed();
      setActiveWorkspace(name);
      if (!name) { setActiveWorkspacePath(null); return; }
      // The linked folder lives in the registry, not in the
      // workspace_loaded payload, so look it up for the Home card.
      workspaceManager.listNamed().then(list => {
        setActiveWorkspacePath(list.find(w => w.name === name)?.externalPath ?? null);
      });
    };
    update();
    const u1 = events.on("workspace_loaded", update);
    const u2 = events.on("workspace_unloaded", update);
    // 'workspace link/unlink don't fire either of the above (linking
    // doesn't reload the workspace) — listen for those specifically
    // too, or the card would only refresh on the NEXT switch/reload.
    const u3 = events.on("workspace_linked", update);
    const u4 = events.on("workspace_unlinked", update);
    return () => { u1(); u2(); u3(); u4(); };
  }, []);

  const refresh = () => setPlugins(pluginManager.all());
  useEffect(() => { if (view === "plugins") refresh(); }, [view]);

  // Plugins register after Home first renders, so keep the list live.
  useEffect(() => {
    const u1 = events.on("plugin_loaded", refresh);
    const u2 = events.on("plugin_unloaded", refresh);
    return () => { u1(); u2(); };
  }, []);

  const allThemes = useMemo(() => themeManager.all(), [currentTheme]);
  const fp = useMemo(() => {
    const q = psearch.toLowerCase().trim();
    return q ? plugins.filter(p =>
      p.name.toLowerCase().includes(q) || p.desc.toLowerCase().includes(q) || p.category.toLowerCase().includes(q)
    ) : plugins;
  }, [plugins, psearch]);
  const ec = plugins.filter(p => p.enabled).length;
  const tog = (name: string, en: boolean) => { if (en) pluginManager.enable(name); else pluginManager.disable(name); refresh(); };

  let body: React.ReactNode;

  if (view === "themes") {
    body = (
      <div className="oxis-home">
        <div className="nv-panel">
          <div className="nv-panel-header"><span className="nv-panel-title">◉ Themes</span><button className="nv-back" onClick={() => setView("home")}>← back</button></div>
          <div className="themes-grid">
            {Object.entries(allThemes).map(([name, t]) => (
              <ThemeTile key={name} name={name} theme={t} active={name === currentTheme}
                isCustom={!!themeManager.customThemes()[name]}
                onClick={() => { themeManager.apply(name); onTheme(name); }}
                onDelete={() => {
                  if (!confirm(`Delete "${name}"?`)) return;
                  themeManager.removeCustom(name);
                  if (currentTheme === name) { themeManager.apply("default"); onTheme("default"); }
                  else onTheme(currentTheme);
                }} />
            ))}
            <div className="theme-tile theme-tile--new" onClick={() => onOpenThemeEditor("custom")}>
              <div className="theme-tile-preview theme-tile-add"><span>+</span></div>
              <div className="theme-tile-name" style={{ color: "var(--dim)" }}>new theme</div>
            </div>
          </div>
        </div>
      </div>
    );
  } else if (view === "plugins") {
    body = (
      <div className="oxis-home">
        <div className="nv-panel">
          <div className="nv-panel-header">
            <span className="nv-panel-title">⬡ Plugins <span className="nv-count">{ec}/{plugins.length}</span></span>
            <div className="nv-panel-actions"><button className="nv-action-btn" onClick={onOpenPluginCreator}>+ new</button><button className="nv-back" onClick={() => setView("home")}>← back</button></div>
          </div>
          <div className="nv-search-wrap">
            <span className="nv-search-icon">⌕</span>
            <input className="nv-search-input" placeholder="filter plugins…" value={psearch} onChange={e => setPsearch(e.target.value)} spellCheck={false} autoFocus />
            {psearch && <button className="nv-search-clear" onClick={() => setPsearch("")}>×</button>}
          </div>
          <div className="nv-plugin-list">
            {fp.length === 0 ? <div className="nv-empty">no results for "{psearch}"</div> : fp.map(p => (
              <div key={p.name} className="nv-plugin-row">
                <span className={`nv-plugin-dot${p.enabled ? " nv-plugin-dot--on" : ""}`}>●</span>
                <span className="nv-plugin-name">{p.name}</span>
                <span className="nv-plugin-cat">{p.category}</span>
                <span className="nv-plugin-desc">{p.desc}</span>
                <button className={`nv-plugin-tog${p.enabled ? " nv-plugin-tog--on" : ""}`} onClick={() => tog(p.name, !p.enabled)}>{p.enabled ? "on" : "off"}</button>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  } else {
    body = (
      <>
        <SkyWidget />
        <div className="oxis-home">
          <div className="oxis-sub-row">
    <span><strong className="oxis-letter">O</strong>pen</span>
    <span><strong className="oxis-letter">X</strong>enial</span>
    <span><strong className="oxis-letter">I</strong>ntelligent</span>
    <span><strong className="oxis-letter">S</strong>hell</span>
  </div>
          <div className="oxis-ver-row">
            <span className="oxis-ver-label">OXIS</span><span className="oxis-ver-num">v1.2.1</span>
            <button className="oxis-github-btn" onClick={() => void openUrl("https://github.com/oxlaboratory/oxis")}
              title="Open the OXIS repository on GitHub">GitHub ↗</button>
          </div>
          {dashboard.header && <div className="oxis-dash-header">{dashboard.header}</div>}
          {!workspacePanelHidden && <WorkspacePanel ws={ws} plugins={plugins} activeWorkspace={activeWorkspace} activeWorkspacePath={activeWorkspacePath} />}
          <div className="oxis-box oxis-help-box">
            <div className="oxis-help-row"><span className="oht">Type</span> <span className="ohc">&apos;help</span><span className="ohr"> in the prompt below for every command</span></div>
            <div className="oxis-help-row"><span className="oht">Type</span> <span className="ohc">&apos;edit</span> <span className="oha">&lt;file&gt;</span><span className="ohr"> to open the built-in editor</span></div>
            <div className="oxis-help-row"><span className="oht">Type</span> <span className="ohc">&apos;market list</span><span className="ohr"> to browse plugins you can install</span></div>
            <div className="oxis-help-row"><span className="oht">Press</span> <span className="ohc">Ctrl+Shift+P</span><span className="ohr"> to open the command palette</span></div>
            <div className="oxis-help-row"><span className="oht">Press</span> <span className="ohc">Ctrl+Shift+M</span><span className="ohr"> to open the OXIS Market website in your browser</span></div>
            {dashboard.shortcuts?.map(sc => (
              <div key={sc} className="oxis-help-row"><span className="oht">Try</span> <span className="ohc">{sc}</span></div>
            ))}
          </div>
        </div>
      </>
    );
  }

  // Clicking empty space on Home puts the cursor in the global prompt.
  return (
    <div className="home" onMouseDown={e => {
      if (e.target === e.currentTarget || (e.target as HTMLElement).classList?.contains("home-scroll")) {
        e.preventDefault();
        events.emit("focus_prompt");
      }
    }}>
      <div className="home-scroll">{body}</div>
    </div>
  );
}

// ── Workspace panel — Home screen, replaces the old permanent
// donation box (see README § Home Screen & Workspace Panel).
// Read-only: reflects workspaceState/pluginManager, doesn't accept
// input itself, so it never competes with Command Mode for focus.
function WorkspacePanel({ ws, plugins, activeWorkspace, activeWorkspacePath }: {
  ws: ReturnType<typeof workspaceState.get>;
  plugins: ReturnType<typeof pluginManager.all>;
  /** The active named workspace, or null for the default context. */
  activeWorkspace: string | null;
  /** The project folder linked to the active named workspace, if any
   *  (not where the workspace's own files live). */
  activeWorkspacePath: string | null;
}) {
  const active = plugins.filter(p => p.enabled);
  const tasks = workspaceState.taskNames();
  // Git remote of the linked project, read from `git remote -v` so it
  // also shows remotes OXIS didn't set up.
  const [gitInfo, setGitInfo] = useState<{ provider: GitProvider; repo: string } | null | undefined>(undefined); // undefined = "haven't checked yet", null = "checked, not connected"
  useEffect(() => {
    if (!activeWorkspacePath) { setGitInfo(null); return; }
    let cancelled = false;
    setGitInfo(undefined);
    getRemotes(activeWorkspacePath).then(remotes => {
      if (cancelled) return;
      const origin = remotes.find(r => r.name === "origin");
      setGitInfo(origin ? parseGitRemote(origin.url) : null);
    }).catch(() => { if (!cancelled) setGitInfo(null); });
    return () => { cancelled = true; };
  }, [activeWorkspacePath]);
  return (
    <div className="oxis-box oxis-workspace-box">
      <div className="oxis-box-row oxis-workspace-header">
        <span className="oxis-wl">WORKSPACE</span>
        <span className={`oxis-workspace-status oxis-workspace-status--${ws.status}`}>
          {ws.status === "ready" ? "● ready" : ws.status === "loading" ? "◐ loading" : "○ no workspace"}
        </span>
      </div>
      <div className="oxis-box-row"><span className="oxis-wl">workspace</span><span className="oxis-we"> = </span><span className="oxis-wa oxis-wa--name">{activeWorkspace || "default"}</span></div>
      <div className="oxis-box-row">
        <span className="oxis-wl">git</span><span className="oxis-we"> = </span>
        {gitInfo === undefined
          ? <span className="oxis-wa--disconnected">checking…</span>
          : gitInfo
            ? <span className="oxis-wa oxis-wa--connected">{gitInfo.provider === "github" ? "GitHub" : "GitLab"}: {gitInfo.repo}</span>
            : <span className="oxis-wa--disconnected">not connected — <code>&apos;workspace github &quot;owner/repo&quot;</code> or <code>&apos;workspace gitlab &quot;owner/repo&quot;</code></span>}
      </div>
      {ws.projectPath && (
        <div className="oxis-box-row"><span className="oxis-wl">path</span><span className="oxis-we"> = </span><span className="oxis-wa">{ws.projectPath}</span></div>
      )}
      {activeWorkspace && (
        activeWorkspacePath
          ? <div className="oxis-box-row"><span className="oxis-wl">connected</span><span className="oxis-we"> = </span><span className="oxis-wa oxis-wa--connected" title={activeWorkspacePath}>{activeWorkspacePath}</span></div>
          : <div className="oxis-box-row"><span className="oxis-wl">connected</span><span className="oxis-we"> = </span><span className="oxis-wa--disconnected">no project directory connected — <code>&apos;workspace link &quot;&lt;path&gt;&quot;</code></span></div>
      )}
      <div className="oxis-box-row"><span className="oxis-wl">plugins</span><span className="oxis-we"> = </span><span className="oxis-wa">{active.length} active{active.length ? `  (${active.slice(0, 4).map(p => p.name).join(", ")}${active.length > 4 ? "…" : ""})` : ""}</span></div>
      <div className="oxis-box-row"><span className="oxis-wl">tasks</span><span className="oxis-we"> = </span><span className="oxis-wa">{tasks.length ? tasks.join(", ") : "none defined"}</span></div>
      {ws.activity.length > 0 && (
        <div className="oxis-box-row"><span className="oxis-wl">recent</span><span className="oxis-we"> = </span><span className="oxis-wa">{ws.activity[0].text}</span></div>
      )}
      {ws.status === "none" && (
        <div className="oxis-box-row oxis-workspace-footer">
          <span className="oxis-workspace-hint">no workspace here — try <code>&apos;workspace init</code></span>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// STATUS BAR
// ══════════════════════════════════════════════════════════════
function StatusBar({ mode, count, idx, ready, theme, project, updateMsg }: {
  mode: string; count: number; idx: number; ready: boolean; theme: string;
  project?: string; updateMsg?: string;
}) {
  const [time, setTime] = useState(() => new Date().toLocaleTimeString());
  useEffect(() => {
    const t = setInterval(() => setTime(new Date().toLocaleTimeString()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="statusline">
      <div className="sl-mode">{mode === "home" ? "HOME" : "SHELL"}</div>
      <div className="sl-sep" />
      <div className="sl-mid">
        {ready ? "● connected" : "○ connecting"}
        {project && <><span className="sl-dot"> · </span><span className="sl-project">{project}</span></>}
        {updateMsg && <span className="sl-update"> · ⬆ {updateMsg}</span>}
      </div>
      <div className="sl-right">
        <span className="sl-theme">{theme}</span>
        {count > 0 && <span className="sl-pos">{idx + 1}/{count}</span>}
        <span className="sl-time">{time}</span>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// COMMAND PALETTE — Ctrl+Shift+P. Searches the command registry (the
// same list dispatch and Tab completion use) and runs the choice
// through runLine.
// ══════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════
// FILE TREE — Ctrl+B or the ☰ button. Lists folders lazily with the
// native listDir; clicking a file opens it in the editor.
// ══════════════════════════════════════════════════════════════
interface FileTreeEntry { name: string; path: string; isDir: boolean }

function FileTree({ rootDir, rootLabel, onOpenFile, onMoveFile, onClose }: { rootDir: string; rootLabel?: string; onOpenFile: (path: string) => void; onMoveFile: (srcPath: string, destDirPath: string) => void; onClose: () => void }) {
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  const draggedPathRef = useRef<string | null>(null);
  const [childrenOf, setChildrenOf] = useState<Map<string, FileTreeEntry[]>>(new Map());
  const [expanded,   setExpanded]   = useState<Set<string>>(new Set());
  const [loading,    setLoading]    = useState<Set<string>>(new Set());
  const [error,      setError]      = useState("");
  const [focusedIdx, setFocusedIdx] = useState(0);
  const treeRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (dirPath: string) => {
    setLoading(s => new Set(s).add(dirPath));
    try {
      const entries = await listDir(dirPath);
      const items: FileTreeEntry[] = entries
        .filter(e => !e.name.startsWith(".")) // hide dotfiles/.git/.oxis-connector.json clutter
        .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
        .map(e => ({ name: e.name, path: `${dirPath}/${e.name}`, isDir: e.isDir }));
      setChildrenOf(m => new Map(m).set(dirPath, items));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(s => { const n = new Set(s); n.delete(dirPath); return n; });
    }
  }, []);

  const reloadExpanded = useCallback(() => {
    load(rootDir);
    for (const dir of expanded) load(dir);
  }, [load, rootDir, expanded]);

  // Start over whenever the root changes (linking or unlinking a
  // project), not just on first mount.
  useEffect(() => {
    setChildrenOf(new Map());
    setExpanded(new Set());
    setError("");
    load(rootDir);
  }, [rootDir, load]);

  // Keyboard-first, same as everything else in OXIS (Command Palette,
  // find bars, etc.) — Ctrl+B opening the tree should be enough to
  // drive it entirely from the keyboard from there, no mouse required.
  useEffect(() => { setTimeout(() => treeRef.current?.focus(), 20); }, []);

  // Refresh after OXIS itself changes files (newfile, newdir, commit);
  // there's no filesystem watcher.
  useEffect(() => events.on("filetree_refresh", reloadExpanded), [reloadExpanded]);

  const toggleDir = useCallback((path: string, forceExpand?: boolean) => {
    setExpanded(prev => {
      const isOpen = prev.has(path);
      if (forceExpand === true && isOpen) return prev;
      if (forceExpand === false && !isOpen) return prev;
      const next = new Set(prev);
      if (isOpen) next.delete(path);
      else { next.add(path); if (!childrenOf.has(path)) load(path); }
      return next;
    });
  }, [childrenOf, load]);

  // Flattened list of exactly what's ON SCREEN right now (respecting
  // which folders are expanded) — this is what arrow-key navigation
  // actually walks, not the full (possibly not-yet-loaded) tree.
  type Row = { node: FileTreeEntry; depth: number };
  const visibleRows = useMemo(() => {
    const rows: Row[] = [];
    const walk = (items: FileTreeEntry[], depth: number) => {
      for (const node of items) {
        rows.push({ node, depth });
        if (node.isDir && expanded.has(node.path)) walk(childrenOf.get(node.path) ?? [], depth + 1);
      }
    };
    walk(childrenOf.get(rootDir) ?? [], 0);
    return rows;
  }, [childrenOf, expanded, rootDir]);

  useEffect(() => {
    setFocusedIdx(i => Math.max(0, Math.min(i, visibleRows.length - 1)));
  }, [visibleRows.length]);

  const onTreeKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (visibleRows.length === 0 && e.key !== "Escape") return;
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); setFocusedIdx(i => Math.min(i + 1, visibleRows.length - 1)); return;
      case "ArrowUp":   e.preventDefault(); setFocusedIdx(i => Math.max(i - 1, 0)); return;
      case "Home":      e.preventDefault(); setFocusedIdx(0); return;
      case "End":       e.preventDefault(); setFocusedIdx(visibleRows.length - 1); return;
      case "ArrowRight": {
        e.preventDefault();
        const row = visibleRows[focusedIdx];
        if (row?.node.isDir) {
          if (!expanded.has(row.node.path)) toggleDir(row.node.path, true);
          else setFocusedIdx(i => Math.min(i + 1, visibleRows.length - 1)); // already open — move into its first child
        }
        return;
      }
      case "ArrowLeft": {
        e.preventDefault();
        const row = visibleRows[focusedIdx];
        if (row?.node.isDir && expanded.has(row.node.path)) { toggleDir(row.node.path, false); return; }
        // Not an open folder — jump up to the parent row (the nearest
        // preceding row with a shallower depth), same as VS Code's tree.
        for (let i = focusedIdx - 1; i >= 0; i--) {
          if (visibleRows[i].depth < (row?.depth ?? 0)) { setFocusedIdx(i); break; }
        }
        return;
      }
      case "Enter": case " ": {
        e.preventDefault();
        const row = visibleRows[focusedIdx];
        if (!row) return;
        if (row.node.isDir) toggleDir(row.node.path);
        else onOpenFile(row.node.path);
        return;
      }
      case "Escape": e.preventDefault(); onClose(); return;
    }
  }, [visibleRows, focusedIdx, expanded, toggleDir, onOpenFile, onClose]);

  const renderNode = (node: FileTreeEntry, depth: number): React.ReactNode => {
    const idx = visibleRows.findIndex(r => r.node.path === node.path);
    return (
      <div key={node.path}>
        <div
          className={`filetree-row${idx === focusedIdx ? " filetree-row--focused" : ""}${dragOverPath === node.path ? " filetree-row--dragover" : ""}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => { setFocusedIdx(idx); node.isDir ? toggleDir(node.path) : onOpenFile(node.path); }}
          title={node.path}
          draggable
          onDragStart={e => { draggedPathRef.current = node.path; e.dataTransfer.effectAllowed = "move"; }}
          onDragOver={e => {
            if (!node.isDir || draggedPathRef.current === null) return;
            e.preventDefault(); // required for onDrop to fire at all
            setDragOverPath(node.path);
          }}
          onDragLeave={() => { if (dragOverPath === node.path) setDragOverPath(null); }}
          onDrop={e => {
            e.preventDefault();
            setDragOverPath(null);
            const src = draggedPathRef.current;
            draggedPathRef.current = null;
            if (!src || !node.isDir || src === node.path) return;
            onMoveFile(src, node.path);
          }}
        >
          <span className="filetree-icon">{node.isDir ? (expanded.has(node.path) ? "▾" : "▸") : "·"}</span>
          <span className="filetree-name">{node.name}</span>
        </div>
        {node.isDir && expanded.has(node.path) && (childrenOf.get(node.path) ?? []).map(c => renderNode(c, depth + 1))}
        {node.isDir && expanded.has(node.path) && loading.has(node.path) && (
          <div className="filetree-loading" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>loading…</div>
        )}
      </div>
    );
  };

  const rootItems = childrenOf.get(rootDir) ?? [];

  return (
    <div className="filetree" ref={treeRef} tabIndex={0} onKeyDown={onTreeKeyDown}>
      <div className="filetree-header">
        <span className="filetree-header-label" title={rootDir}>{rootLabel || "FILES"}</span>
        <span className="filetree-refresh" onClick={reloadExpanded} title="Refresh">⟳</span>
        <span className="filetree-close" onClick={onClose} title="Close (Ctrl+B)">×</span>
      </div>
      {error && <div className="filetree-error">{error}</div>}
      <div
        className={`filetree-body${dragOverPath === rootDir ? " filetree-row--dragover" : ""}`}
        onDragOver={e => {
          if (draggedPathRef.current === null) return;
          e.preventDefault();
          setDragOverPath(rootDir);
        }}
        onDragLeave={() => { if (dragOverPath === rootDir) setDragOverPath(null); }}
        onDrop={e => {
          e.preventDefault();
          setDragOverPath(null);
          const src = draggedPathRef.current;
          draggedPathRef.current = null;
          if (!src || src === rootDir) return;
          onMoveFile(src, rootDir);
        }}
      >
        {loading.has(rootDir) && rootItems.length === 0 && <div className="filetree-loading" style={{ paddingLeft: 8 }}>loading…</div>}
        {rootItems.map(n => renderNode(n, 0))}
      </div>
      <div className="filetree-hint">↑↓ move · → expand · ← collapse · ↵ open · drag to move · Esc close</div>
    </div>
  );
}

function CommandPalette({ onRun, onClose }: { onRun: (cmd: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // One shared ref, re-pointed at whichever item is currently
  // selected via its own ref callback below — simpler than an array
  // of refs for a list that re-renders on every keystroke/navigation.
  const selectedItemRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 20); }, []);

  const results = useMemo(() => {
    const all = registry.all().filter(c => !c.name.includes(":")); // exclude task:/other internal-only entries — same rule Tab completion uses
    const q = query.trim().toLowerCase();
    if (!q) return all.slice(0, 50).sort((a, b) => a.name.localeCompare(b.name));
    // Simple scored fuzzy-ish match: exact-prefix > name-contains > description-contains.
    const scored = all
      .map(c => {
        const name = c.name.toLowerCase();
        let score = -1;
        if (name.startsWith(q)) score = 3;
        else if (name.includes(q)) score = 2;
        else if (c.description.toLowerCase().includes(q)) score = 1;
        return { c, score };
      })
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name));
    return scored.slice(0, 50).map(r => r.c);
  }, [query]);

  useEffect(() => { setSelected(0); }, [query]);

  // Keep the selected item in view while arrowing ("nearest" scrolls
  // only as far as needed).
  useEffect(() => {
    selectedItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // Close on Escape via a capture-phase window listener, so no other
  // Escape handler can swallow it first.
  useEffect(() => {
    const onWindowEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onWindowEscape, true);
    return () => window.removeEventListener("keydown", onWindowEscape, true);
  }, [onClose]);

  const run = useCallback((cmd: string) => {
    onRun(`'${cmd}`);
  }, [onRun]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setSelected(i => Math.min(i + 1, results.length - 1)); return; }
    if (e.key === "ArrowUp")   { e.preventDefault(); setSelected(i => Math.max(i - 1, 0)); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      const entry = results[selected];
      if (entry) run(entry.name);
      return;
    }
  }, [results, selected, run, onClose]);

  return (
    <div className="cmdp-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cmdp">
        <div className="cmdp-input-row">
          <span className="cmdp-icon">⌘</span>
          <input
            ref={inputRef}
            className="cmdp-input"
            placeholder="Search commands…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <span className="cmdp-hint">↑↓ navigate · ↵ run · esc close</span>
        </div>
        <div className="cmdp-list">
          {results.length === 0 && <div className="cmdp-empty">no matching commands</div>}
          {results.map((c, i) => (
            <div
              key={c.name}
              ref={i === selected ? selectedItemRef : undefined}
              className={`cmdp-item${i === selected ? " cmdp-item--selected" : ""}`}
              onMouseEnter={() => setSelected(i)}
              onMouseDown={e => { e.preventDefault(); run(c.name); }}
            >
              <span className="cmdp-item-name">'{c.name}</span>
              <span className="cmdp-item-desc">{c.description === UNDOCUMENTED_SENTINEL ? "" : c.description}</span>
              <span className="cmdp-item-cat">{c.category}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [view,      setView]      = useState<"home" | "shell">("home");
  const [ready,     setReady]     = useState(false);
  const [curTheme,  setCurTheme]  = useState(() => themeManager.getCurrent());
  const [themeEditorName,  setThemeEditorName]  = useState<string | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [activeProject, setActiveProject] = useState(() => workspaceState.get().projectName);
  const [updateMsg,     setUpdateMsg]     = useState("");
  const pendingCmd = useRef<string>("");
  // The global prompt bar the terminal portals its input into.
  const [promptHost, setPromptHost] = useState<HTMLDivElement | null>(null);

  // The project name shown in the status bar (workspaceState tracks it).
  useEffect(() => workspaceState.subscribe((s) => setActiveProject(s.projectName)), []);

  // Startup: theme, persisted settings, error capture, workspace
  // migration, update check, plugins.
  useEffect(() => {
    themeManager.apply(curTheme);
    applyAllSettings();
    installGlobalErrorCapture();
    void workspaceManager.runAutoUpdateIfNeeded();
    void startupUpdateCheck().then(info => {
      if (info?.available && info.latestCommit) setUpdateMsg(`build ${info.latestCommit.slice(0, 7)} available`);
    });

    ensurePluginsInited();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Event listeners
  useEffect(() => {
    const u1 = events.on("open_theme_editor", p => { if (p?.name) setThemeEditorName(String(p.name)); });
    const u2 = events.on("theme_changed",     p => { if (p?.name) setCurTheme(String(p.name)); });
    return () => { u1(); u2(); };
  }, []);


  // "go home" — wired to the 'home command via _goHomeRef
  const goHome = useCallback(() => setView("home"), []);
  useEffect(() => { _goHomeRef.current = goHome; }, [goHome]);

  const openShell = useCallback(() => setView("shell"), []);

  // Runs a command line for the user (command palette, Home buttons),
  // queuing it until the shell is connected.
  const runCommand = useCallback((cmd: string) => {
    openShell();
    if (ready) setTimeout(() => _ctxRef.current?.runLine(cmd), 0);
    else pendingCmd.current = cmd;
  }, [ready, openShell]);

  // Command Palette — Ctrl+Shift+P (Cmd+Shift+P on Mac), from
  // anywhere. Skipped while the Theme Editor overlay is already open,
  // so overlays don't stack confusingly on top of each other.
  useEffect(() => {
    const onWindowKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "p") {
        if (themeEditorName) return;
        e.preventDefault();
        setCommandPaletteOpen(o => !o);
      }
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [themeEditorName]);

  useEffect(() => {
    registerCoreKeybinds({
      newTab:        openShell,
      closeTab:      () => setView("home"),
      switchTab:     () => {},
      clearTerminal: () => events.emit("clear_terminal"),
      openMarket:    () => { void openUrl(market.MARKET_BASE); },
    });
    // App shortcuts don't fire while typing in another field (the
    // editor, a search box); the global prompt handles its own.
    const inOtherField = () => {
      const el = document.activeElement;
      return el instanceof HTMLElement && !el.classList.contains("term-prompt-input")
        && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    };
    const handler = (e: KeyboardEvent) => keybinds.handle(e, { skipCore: inOtherField() });
    window.addEventListener("keydown", handler, true);
    // In the native window, stop WebView accelerators (reload, find,
    // new window) from firing on Ctrl+R/F/N/P etc. The key still reaches
    // whatever is focused. Plain browser tabs keep their own shortcuts.
    const blockBrowser = (e: KeyboardEvent) => {
      if (!isNativeApp() || !e.ctrlKey || e.altKey) return;
      if (["r","l","w","t","f","n","p","g","j","u"].includes(e.key.toLowerCase())) e.preventDefault();
    };
    window.addEventListener("keydown", blockBrowser, true);
    return () => {
      window.removeEventListener("keydown", handler, true);
      window.removeEventListener("keydown", blockBrowser, true);
    };
  }, [openShell]);

  const isHome = view === "home";

  return (
    <div className={`app${isNativeApp() ? "" : " app--browser"}`}>
      {isNativeApp() && <Titlebar mode={isHome ? "home" : "shell"} />}

      <div className="app-body">
        {/* Overlays — always on top */}
        {themeEditorName && (
          <div className="overlay">
            <ThemeEditor name={themeEditorName} onClose={() => setThemeEditorName(null)} />
          </div>
        )}
        {commandPaletteOpen && (
          <CommandPalette
            onRun={cmd => { setCommandPaletteOpen(false); runCommand(cmd); }}
            onClose={() => setCommandPaletteOpen(false)}
          />
        )}
        {/* Home and the terminal both stay mounted; only one is shown. */}
        <div style={{ display: isHome ? "flex" : "none", flex: 1, minHeight: 0, overflow: "hidden" }}>
          <Home
            currentTheme={curTheme}
            onTheme={n => { themeManager.apply(n); setCurTheme(n); }}
            onOpenThemeEditor={n => setThemeEditorName(n)}
            onOpenPluginCreator={() => runCommand("'plugin new myplugin")}
          />
        </div>

        <div className="app-pane" style={{ display: !isHome ? "flex" : "none" }}>
          <Terminal
            id="main"
            isActive={!isHome}
            promptHost={promptHost}
            onReady={() => {
              setReady(true);
              const cmd = pendingCmd.current;
              if (cmd) { pendingCmd.current = ""; setTimeout(() => _ctxRef.current?.runLine(cmd), 300); }
            }}
            onShowShell={openShell}
            onCloseTab={() => setView("home")}
          />
        </div>
      </div>

      {/* The one global command prompt, fixed above the status line. */}
      <div className="global-prompt" ref={setPromptHost} />

      <StatusBar mode={isHome ? "home" : "shell"}
        count={0} idx={0}
        ready={ready} theme={curTheme}
        project={!isHome ? (activeProject || undefined) : undefined}
        updateMsg={updateMsg || undefined} />
    </div>
  );
}