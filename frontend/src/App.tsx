/**
 * App.tsx — OXIS v1.2.1
 * Complete application: terminal, editor (also used to edit plugins), home, theme editor.
 */

import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from "react";

import { openPty }    from "./pty/ptyClient";
import type { PtySession } from "./pty/ptyClient";

import {
  mkLine, bannerLines, processOutput, mergeOutput,
  LINE_COLORS, TRAIN_BODY_LINES, trainWheelFrame, BANNER_LINE_COUNT,
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
import { sessionManager }                   from "./terminal/sessionManager";
import { workspaceState }                   from "./terminal/workspaceState";
import { workspaceManager }                 from "./terminal/workspaceManager";
import { getRecentErrors, installGlobalErrorCapture } from "./terminal/diagnostics";
import { cwdTracker, buildCwdProbe, looksLikeDirectoryChange } from "./terminal/cwdTracker";
import { scriptRunTracker } from "./terminal/scriptRunTracker";
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
import { commitAll, setupRemote, getRemotes, parseGitRemote, type GitProvider } from "./plugins/git";
import { readFile, writeFile, listDir, makeDir, statPath, movePath, isNativeApp, openUrl, checkForUpdate } from "./native";
import Titlebar from "./components/Titlebar";

// ══════════════════════════════════════════════════════════════
// SHELL CONTEXT — passed to command registry
// ══════════════════════════════════════════════════════════════
interface ShellCtx {
  send:        (cmd: string) => void;
  runLine:     (line: string) => void;
  print:       (text: string, kind?: LineKind) => void;
  clear:       () => void;
  openEditor:  (path: string) => void;
  newTerminal: () => void;
}

// ── oxis.option(key[, value]) persistence ────────────────────────
// Backs ctx.getOption/setOption in the plugin API context — used to
// be a permanent `undefined`/no-op stub (see forwardingApiCtx above),
// so any plugin option not already cached in that plugin's own VM
// session never actually persisted across a reload or app restart.
const OPTIONS_KEY = "oxis-plugin-options-v1";
// Splits an OXIS command line into arguments, honoring "double" and
// 'single' quotes as one argument each (with the quotes themselves
// stripped) — e.g. 'edit "C:\Users\Admin\My Docs\file.txt" keeps that
// whole path as one argument instead of splitting on its spaces.
// Unquoted runs of non-whitespace still split on whitespace as before.
function splitCmdArgs(body: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  }
  return out;
}

// Is this file path where a currently-registered plugin's .lua source
// actually lives? Used by the Editor's save path (see editorSave in
// the Terminal component) so saving a plugin file reloads it live —
// plugins are edited in the exact same Editor as any other file, not
// a second editor with its own save button, so the Editor itself has
// to know when "save" also means "reload this plugin".
// Resolves relPath against baseDir purely as string logic (no filesystem
// access — safe to check before ever touching disk) and refuses
// anything that would escape baseDir via ".." segments, an absolute
// path pretending to be relative, or a stray leading slash — see
// 'workspace newfile/newdir, the one place OXIS writes into a path the
// USER chose (their connected external project directory) rather than
// one it manages itself, so this is the one place that actually needs
// this check.
function safeJoinWithinDir(baseDir: string, relPath: string): string | null {
  if (/^[A-Za-z]:[\\/]/.test(relPath) || relPath.startsWith("/") || relPath.startsWith("\\")) return null;
  const normalizedBase = baseDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const baseParts = normalizedBase.split("/").filter(Boolean);
  const combinedParts = `${normalizedBase}/${relPath.replace(/\\/g, "/")}`.split("/");
  const resolved: string[] = [];
  for (const part of combinedParts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (resolved.length <= baseParts.length - 1) return null; // would climb above baseDir itself
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  for (let i = 0; i < baseParts.length; i++) if (resolved[i] !== baseParts[i]) return null;
  if (resolved.length <= baseParts.length) return null; // resolved to baseDir itself or above — not a valid file/dir name
  return resolved.join("/");
}

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

// ══════════════════════════════════════════════════════════════
// SETTINGS — 'config / 'settings. Backed by the SAME localStorage
// option store as oxis.getOption/setOption above (keys prefixed
// "setting." to avoid colliding with a plugin's own option names) —
// not a second, parallel persistence mechanism. Each setting knows
// how to actually apply itself (a real, immediate side effect, not
// just a stored value nothing reads) — applyAllSettings() runs once
// at startup so a setting from last session takes effect again
// without a restart, same as changing it live does.
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
    description: "Check gitlab.com for a newer OXIS release on startup",
    apply: () => { /* read directly where used — see checkUpdate() in the root App component */ },
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

/** Applies every setting's persisted (or default) value — called once
 *  at startup so settings from last session take effect immediately,
 *  same as this session's changes already do live. */
function applyAllSettings(): void {
  for (const def of SETTINGS) def.apply(getSetting(def.key));
}

// ── init flag so we only register commands once ──────────────
let _commandsRegistered = false;
// Gates the background update check to once per app run (see onReady
// below) — Terminal mounts once per tab, and there's no reason to hit
// gitlab.com again for a tab opened later in the same session.
let _updateCheckedThisRun = false;
// Stable ref so clear/print/send always call the latest Terminal instance
const _ctxRef: { current: ShellCtx | null } = { current: null };

// Live-forwarding plugin API context (fixes a real bug: pluginManager
// and workspaceManager only ever get init()'d ONCE, at root mount,
// before any shell exists — every Lua/shortcut plugin loaded at that
// point (i.e. all of them, since plugins load before any terminal
// tab opens) captured a snapshot of whatever ctx.sendToShell/print
// were at load time via `{ ...this.apiCtx, pluginName }` in
// pluginManager.load(). If that snapshot were the root's `() => {}`
// stubs, EVERY plugin command that calls oxis.run()/oxis.echo() —
// and every TypeScript shortcut plugin's command, like 'gs or 'nb —
// would silently do nothing, forever, even after a real terminal
// mounts. Fix: initPlugins()/workspaceManager.init() get this stable
// object instead, whose methods forward to _apiCtxTarget.current —
// so updating _apiCtxTarget.current when the real Terminal mounts
// (below) fixes already-loaded plugins too, not just future ones.
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
// COMMAND DETAILS — backs 'help <command> for the commands with a
// real "other ways to use it" surface (subcommands): every syntax
// variant a command actually accepts, described individually, plus
// worked examples. Kept separate from CommandEntry.description (a
// one-liner for the all-commands listing) rather than cramming all of
// this into that single string — one is for scanning a big list
// quickly, this is for "I picked this one, now show me everything it
// can do." Simple one-verb commands ('ls, 'cat, etc.) don't need an
// entry here; their registry description already says what they do,
// and 'help <command> falls back to that automatically — see the
// 'help handler below.
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
      { syntax: "'workspace github <owner/repo or URL> [--force]", description: "configure the connected project's git remote for GitHub — initializes a repo if needed, refuses to silently overwrite a DIFFERENT existing origin (add --force to replace it). Also adds a \"commit\" task the first time this succeeds — see 'help project" },
      { syntax: "'workspace gitlab <owner/repo or URL> [--force]", description: "same, for GitLab" },
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
      { syntax: "'plugin publish <name>",                               description: "validates it's ready, then opens a real GitLab merge request adding it to the Market — FREE, not live until a human reviews and merges it" },
      { syntax: "'plugin publish <name> --price=4.99 --interval=month", description: "same, as a PAID listing — creates a real Stripe Connect Express account (via the deployed /connect-onboarding endpoint), opens the onboarding link, then opens the merge request the same way" },
      { syntax: "'plugin publish <name> --email=you@example.com",       description: "email for the Stripe Connect account — defaults to whatever 'market license already has on file" },
      { syntax: "'plugin unpublish <name>",                             description: "opens a GitLab merge request removing the plugin's Market listing — same human-reviewed model, nothing is actually removed until a human merges it" },
    ],
    examples: [
      "'plugin new mytools --template=devops   — start a new devops-flavored plugin",
      "'plugin validate mytools                — check it before relying on it",
      "'plugin permissions mytools grant fs     — let it read/write files",
      "'plugin publish mytools                  — prepare a free Market listing",
      "'plugin publish mytools --price=4.99 --interval=month --email=you@example.com",
    ],
    notes: "Publishing automates the tedious part, not the review — it validates the plugin first, and for paid plugins genuinely creates a Stripe Connect account, then opens a real GitLab merge request (branch + commit + MR, via the Market's /submit-plugin endpoint) adding the plugin's .lua file and index.json entry. Nothing is live until a human reviews and merges that MR on GitLab — this just gets it opened without the developer doing the fork/clone/branch/push/MR steps by hand. Running 'plugin publish again on an already-listed plugin opens an UPDATE merge request (replacing its index.json entry) rather than a new one, detected by checking the Market for an existing entry — no separate command needed for that.",
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
    ],
    examples: [
      "'config set fontSize 15",
      "'config set cursorStyle bar",
      "'config set updateCheckOnStartup false",
    ],
    notes: "'settings is an alias for 'config. Theme isn't a \"setting\" here — see 'theme instead, which has its own dedicated persistence.",
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

  // (ps/ok/err/dim/info/sep/h/shellCmd defined above via _ctxRef)

  // ── files ──────────────────────────────────────────────
  // 'new / 'touch: land in created-documents/ (or the active
  // workspace's own documents/ — see workspaceManager.documentsDir())
  // via the native file bridge, NOT a raw shell command — the old
  // version ran New-Item/touch through whatever the *shell's* current
  // directory happened to be, which is why files it created were
  // scattered wherever the user last `cd`'d rather than somewhere
  // predictable. An absolute-looking path (drive letter, leading / or
  // \\) is still respected as-is, same as 'edit.
  const looksAbsolute = (p: string) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\");
  registry.register({ name:"new",    category:"files", description:"Create a document (in created-documents/, or the active workspace)",
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

  registry.register({ name:"touch",  category:"files", description:"Create a document (in created-documents/, or the active workspace)",
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
    handler:(a,r)=>{ if(!a[0]){err("usage: 'write <file> [text]");return;}
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

  registry.register({ name:"update", category:"files", description:"Check for a newer OXIS build (commit-based, not release-tag-based — see internal/update/update.go)",
    handler:()=>{
      ok("checking for a newer build...");
      checkForUpdate().then(info => {
        if (!info.available) {
          ok(`up to date${info.currentCommit ? ` (${info.currentCommit.slice(0, 7)})` : " (dev build — no commit info embedded)"}`);
          return;
        }
        ok(`newer build available: ${info.currentCommit ? info.currentCommit.slice(0, 7) : "current"} → ${info.latestCommit.slice(0, 7)}`);
        if (info.downloadUrl) openUrl(info.downloadUrl);
        else if (info.releaseUrl) openUrl(info.releaseUrl);
      }).catch(() => err("update check failed — check your connection"));
    }});

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
    handler:(a,r)=>{ if(a.length<2){err("usage: 'grep <pattern> <file>");return;}
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
        sep(); dim("'theme <name>  ·  'theme new <name>  ·  'theme delete <name>"); return; }
      if(args[0]==="new"){
        if(!args[1]){err("usage: 'theme new <name>");return;}
        events.emit("open_theme_editor",{name:args[1]}); return; }
      if(args[0]==="delete"||args[0]==="del"){
        if(!args[1]){err("usage: 'theme delete <name>");return;}
        if(themeManager.builtins()[args[1]]){err(`cannot delete built-in: ${args[1]}`);return;}
        themeManager.removeCustom(args[1]); ok(`theme deleted: ${args[1]}`); return; }
      if(args[0]==="export"){
        const j=themeManager.export(args[1]); if(j) ctx.print(j,"dim"); else err(`not found: ${args[1]}`); return; }
      if(themeManager.apply(rest)) ok(`theme → ${rest}`);
      else err(`not found: '${rest}' — run 'theme to list`); }});

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
        if(r.ok) r.text.split("\n").forEach(line => line ? info(line) : ctx.print(""));
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
            // Free plugin — opens a real GitLab MR for review, doesn't auto-merge.
            info(`opening a merge request for "${name}" on GitLab…`);
            return prepareFreePublish(check.metadata!, existing).then(result => {
              result.message.split("\n").forEach(line => line ? (result.ok?ok:err)(line) : ctx.print(""));
              if(result.mergeRequestUrl){
                info("opening the merge request in your browser…");
                void openUrl(result.mergeRequestUrl);
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
            info(`opening a merge request for "${name}" on GitLab…`);
            return submitPaidPlugin(check.metadata!, price, interval, conn.accountId || "", existing).then(result => {
              result.message.split("\n").forEach(line => line ? (result.ok?ok:err)(line) : ctx.print(""));
              if(result.mergeRequestUrl){
                info("opening the merge request in your browser…");
                void openUrl(result.mergeRequestUrl);
              }
            });
          }).catch(e => err(`Stripe Connect onboarding failed: ${e instanceof Error ? e.message : e}`));
        }).catch(e => err(`couldn't check the Market for an existing listing: ${e instanceof Error ? e.message : e}`));
        return; }
      if(sub==="unpublish"){
        if(!name){err(`usage: 'plugin unpublish <name>`);return;}
        const email = getLicensedEmail();
        const author = email || name; // best-effort — same "not real authentication" caveat as the backend check itself; see delete-plugin.js
        info(`opening a deletion merge request for "${name}" on GitLab…`);
        requestPluginDeletion(name, author).then(result => {
          result.message.split("\n").forEach(line => line ? (result.ok?ok:err)(line) : ctx.print(""));
          if(result.mergeRequestUrl){
            info("opening the merge request in your browser…");
            void openUrl(result.mergeRequestUrl);
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
        // Same register+persist+load addLuaPlugin() the old Plugin
        // Creator's "save & load" button called — the plugin is live
        // immediately with the template's starter code; the Editor
        // that opens right after is just for customizing it further,
        // exactly like opening any other file (see findPluginForPath).
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
        if(!name){err("usage: 'plugin permissions <name> [grant|revoke <fs|process|net|system|workspace|editor|terminal>]");return;}
        const action = args[2]?.toLowerCase();
        const ns = args[3]?.toLowerCase() as PermissionNamespace | undefined;
        const VALID: PermissionNamespace[] = ["fs","process","net","system","workspace","editor","terminal"];
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
            // Premium install path: verify the Stripe-issued license,
            // fetch source over HTTPS (never a public static file —
            // see premium-plugin.js), encrypt it locally, register it.
            market.installPremium(name)
              .then(() => ok(`${name} installed & unlocked — 'plugin disable ${name} to turn off`))
              .catch(e => err(`premium install failed: ${e instanceof Error ? e.message : e}`));
            return;
          }
          market.install(name)
            .then(({ entry, persisted, persistError }) => {
              // addLuaPlugin() (inside market.install) calls load()
              // synchronously before the disk write, so by the time
              // this resolves the plugin's real final state is already
              // settled — check it instead of assuming "downloaded"
              // means "working". A plugin that fails to execute, or
              // fails the description-compliance check, disables itself
              // inside load() and already printed exactly why above.
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
      // "commit" is a universal built-in, not a per-workspace task
      // file — see runCommitTask below for why (this used to be
      // written into every workspace as an oxis.task() whose "command"
      // was the STRING "'git-commit-dialog", which got sent to the
      // real shell as if it were a shell command — PowerShell/bash has
      // no idea what a leading-apostrophe OXIS command is, which is
      // exactly the garbled "Write-Host..." output that was actually
      // the shell trying and failing to parse it as its own syntax).
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
      const result = await commitAll(dir, message);
      if(result.ok){
        ok(`✓ committed${result.hash ? ` (${result.hash})` : ""}: ${message}`);
        events.emit("filetree_refresh", {});
      } else {
        err(`✗ commit failed: ${result.message}`);
      }
    } catch(e) {
      err(`✗ commit failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  // ── workspace ─────────────────────────────────────────
  // 'workspace init "name" / list / switch / rename / delete / link /
  // unlink — the new named, multi-workspace layer (see "Named
  // workspaces" in workspaceManager.ts). 'workspace info/reload/close
  // and bare 'workspace init (no name — inits at the current
  // directory) are the original single-directory .oxis/workspace.lua
  // flow, unchanged and still fully supported alongside it: switching
  // to a named workspace uses that exact same loader under the hood.
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
        if(!repoInput){ err(`usage: 'workspace ${provider} <owner/repo or full URL> [--force]`); return; }
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
  // 'project init/open/run/task/workflow — the project layer (see
  // README § Project Layer). Deliberately thin: a "project" is just
  // an external directory with a full .oxis/ setup in it
  // (workspace.lua + project.lua + tasks/workflows/scripts/plugins/
  // documents — see initProject in workspaceManager.ts), so these
  // commands are wrappers around the SAME load()/task/workflow
  // machinery 'workspace and 'workflow already use, not a second,
  // parallel system — exactly what avoids duplicating what already
  // exists, per how this was actually built.
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
  // 'workflow list / <name> / info <name> / cancel — see
  // workflowRunner.ts. Workflows come from the active workspace's
  // workflows/*.lua files (loaded by workspaceManager.ts when a
  // workspace is switched to); with no workspace active, there are
  // none registered ('workflow list says so rather than erroring).
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
  // Persisted via the same option store oxis.getOption/setOption use
  // (see writePersistedOption above) — not a second config system.
  // Theme has its own dedicated 'theme <n> command already (and its
  // own persistence via themeManager) so it's deliberately not
  // duplicated here as a "setting" — 'config list says so.
  const configHandler: CommandHandler = (args) => {
    const sub = args[0]?.toLowerCase();
    if(!sub || sub==="list"){
      sep(); info("Settings"); sep();
      for(const def of SETTINGS){
        const val = getSetting(def.key);
        info(`${def.key.padEnd(20)} = ${String(val).padEnd(10)} ${def.description}${def.choices ? `  [${def.choices.join("|")}]` : ""}`);
      }
      sep(); dim("theme is managed separately — see 'theme");
      dim("'config set <key> <value>  ·  'config get <key>  ·  'config reset <key>"); return; }
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
  // ── diagnostics ────────────────────────────────────────
  // Purely local — see diagnostics.ts. Nothing here is ever sent
  // anywhere; this exists so YOU can see what's going on, not for
  // OXIS to collect anything about you.

  // ── git ──────────────────────────────────────────────────
  // Committing is now 'task commit <message> directly (see the 'task
  // registration above) — the old dialog-based flow (git-commit-
  // dialog command + CommitDialog component) was retired: it never
  // actually worked (see 'task's own doc comment for why), and the
  // new direct flow doesn't need a separate command to open a UI at
  // all — 'task commit just does the commit and reports the result.

  registry.register({ name:"diagnostics", category:"info", description:"Local diagnostic info — version, OS, runtime, plugins, workspace, recent errors",
    handler:()=>{
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
      dim("'plugin doctor for a focused check of installed plugins specifically."); sep();
    }});

  // ── backup / restore ──────────────────────────────────────
  // Format: plain JSON, not an actual .zip (no zip library available
  // in this environment) — see backup.ts for exactly what's included
  // (every named workspace's real files, created-documents/,
  // created-plugins/, settings) and what's deliberately excluded
  // (Market-installed plugins — re-fetchable with 'market install;
  // installer build output).
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
      h("'clear","clear output (keeps the banner)"); h("'run <cmd>","raw command"); h("'env","env vars");
      h("'ps","processes"); h("'kill <pid|name>","kill process"); h("'ip","network");
      h("'disk","disk usage"); h("'sysinfo","system info"); h("'which <cmd>","find command");
      h("'find [pat]","search files"); h("'grep <pat> <f>","search contents");
      h("'history","recent commands"); h("'histclear","clear history"); h("'ports","open ports");
      h("'user","current user"); h("'path","PATH entries"); h("'open <f>","open with default app");
      info(""); h("── home screen ──────────────────────","");
      h("'hide workspace","hide the WORKSPACE panel on Home"); h("'show workspace","show it again");
      info(""); h("── themes ────────────────────────────","");
      h("'theme","list themes"); h("'theme <name>","switch theme");
      h("'theme new <n>","visual theme editor"); h("'theme delete <n>","delete custom theme");
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
      h("'plugin publish <n> [--price --interval --email] [update]","open a GitLab merge request to add it to the Market — reviewed/merged by a human, not live automatically; see 'help plugin");
      h("'plugin unpublish <n>","open a GitLab merge request to remove it from the Market — same human-reviewed model as publishing");
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
interface EditorFile { path: string; content: string; dirty: boolean; loading: boolean; loadError?: string; }

// ══════════════════════════════════════════════════════════════
// ERROR BOUNDARY — a render-time crash anywhere below this should
// never produce a silently blank pane (see the Editor's Normal-mode
// investigation: a blank screen with no error is much harder to
// diagnose than one that at least shows what threw). Wraps the
// Editor and PluginCreator, the two full-pane views most likely to
// hit an edge case (arbitrary file content, arbitrary Lua source).
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
// CODE AREA — shared syntax-highlighted text area used by both the
// Editor and the Plugin Creator (see syntaxHighlight.ts). Classic
// "highlighted textarea" trick: a <pre> with highlighted spans sits
// behind a real <textarea> whose text is transparent but whose caret
// and selection stay visible, so typing/selecting/vim-motions keep
// working exactly as before — only the paint underneath changes.
// ══════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════
// UNSAVED-CHANGE GUTTER — a real line-level diff between the last
// SAVED content and the current one (not the original file content
// forever — see Editor's `savedContent`, which becomes the new
// baseline every time you save, so the gutter always reflects "what's
// changed since the last save" the same way git's gutter decorations
// mean "changed since the last commit", not "changed since forever").
// A real LCS line-diff, not a naive positional compare — inserting or
// deleting a whole line in the middle of a file doesn't make every
// line after it look "changed".
// ══════════════════════════════════════════════════════════════
function computeChangedLines(oldText: string, newText: string): Set<number> {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const n = oldLines.length, m = newLines.length;
  const changed = new Set<number>();

  // LCS DP is O(n*m) in line count — fine for typical files, but a
  // huge one (a few thousand lines) could make that cell count
  // balloon. Fall back to a cheap positional compare past that point
  // — less precise about insertions/deletions shifting later lines,
  // but still real, still useful, and never hangs the tab.
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
  /** Line numbers (1-indexed) changed since the last save — see
   *  computeChangedLines above and Editor's `savedContent`. Optional:
   *  omitted entirely (not just empty) means "don't know" rather than
   *  "nothing's changed" — the Plugin Creator's old standalone state
   *  before it was unified into this Editor had no equivalent
   *  concept, and callers that genuinely have no baseline to diff
   *  against should omit this rather than pass an empty Set that
   *  would misleadingly render as "all saved". */
  changedLines?: Set<number>;
  /** Passed straight through to the outer wrapper div — used by the
   *  Editor's resizable HTML-preview split (a computed width while
   *  resizing) and its fullscreen-preview mode (hides the code pane
   *  entirely without unmounting/remounting it, so typed content and
   *  undo history survive toggling fullscreen on and off). */
  style?: React.CSSProperties;
  hidden?: boolean;
}>(function CodeArea({ value, lang, className, onChange, onKeyDown, changedLines, style, hidden }, ref) {
  const preRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  // Large-file handling: the highlighter is a single regex pass over
  // the WHOLE file (see syntaxHighlight.ts) — O(n) in file size, not
  // pathological, but re-running that synchronously on every single
  // keystroke is exactly what caused real, reported freezing/lag on
  // big files, since it blocks the render regardless of how fast the
  // regex itself is. Two real, layered fixes, not one:
  //  1. Below HARD_CUTOFF_CHARS, highlighting still runs, but against
  //     a DEBOUNCED copy of the content rather than every keystroke
  //     directly — the actual <textarea> below is never debounced (it
  //     always reflects `value` immediately), so typing itself is
  //     never delayed; only the color overlay can lag a beat behind
  //     on a big file. Small files get no perceptible debounce at all
  //     (see the length check inside the effect).
  //  2. Above HARD_CUTOFF_CHARS, highlighting is skipped entirely —
  //     even a debounced full-file pass on a truly huge file would
  //     still cause a noticeable hitch each time it fires. This is an
  //     explicit, visible trade-off (a small notice, not a silent
  //     failure) for files large enough that it matters, not a
  //     reduction in normal-file functionality.
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

  // Line numbers — a third layer, scrolled in sync with the other two
  // exactly like the highlight <pre> already is (see syncScroll). Its
  // own width is based on the actual line count so a 4-digit file
  // doesn't clip against a gutter sized for 3, and the highlight/input
  // layers below get that same width as a left inset so the numbers
  // never overlap real text. Each line is its own fixed-height row
  // (not one joined <pre> string) so a changed-line marker can be
  // attached to the exact row it belongs to. Uses the real `value`
  // (not debouncedValue) — line count is cheap (one split), and having
  // the gutter's own row count lag behind what's actually on screen
  // would look broken in a way a slightly-stale highlight color doesn't.
  const lineCount = useMemo(() => value.split("\n").length, [value]);
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
// MODAL EDITING — shared Normal/Insert/Visual mode logic (see
// README § Input Modes), used by BOTH the file Editor and the
// Plugin Creator. This used to live only inside Editor; the Plugin
// Creator had its own separate, mode-less textarea handling, which
// is why it never got Normal/Insert/Visual — it wasn't "our main
// editor," it was a second, simpler one. Pulling this out into a
// hook means the Plugin Creator now runs the exact same modal
// editing as file editing, not just the same visual chrome.
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
  // Consecutive keystrokes collapse into a single undo step, same as
  // real editors — otherwise Ctrl+Z after typing a sentence would undo
  // one character at a time. `grouping` tracks "the next edit belongs
  // to the same step as the last one" rather than starting a new one.
  //
  // Critically, a group also breaks after a pause (see GROUP_TIMEOUT_MS
  // below) — without that, one continuous Insert-mode session, however
  // long (a user typing an entire file without ever pressing Escape,
  // which is completely normal for anyone not used to modal editing),
  // would collapse into ONE undo step, so a single Ctrl+Z would wipe
  // the whole thing back to empty. That's a real bug, not a style
  // choice — real editors (and vim itself) only group typing that
  // actually happens in one continuous burst, not "however long the
  // mode happens to stay active."
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
      // Visual mode — extend the *real* browser selection from the
      // anchor to `pos` so the selected range is actually visible
      // (via ::selection) instead of only being tracked invisibly in
      // React state. `direction` records which end is the "active"
      // side so the next motion can recover the true cursor position
      // back out of selectionStart/selectionEnd (see below).
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
    // In Visual mode, selectionStart/selectionEnd are a real range now
    // (see setPos), so the "current cursor" isn't always
    // selectionStart — it's whichever end is the active one, per
    // selectionDirection. Outside Visual mode there's never an active
    // range, so selectionStart alone is the caret as before.
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
          navigator.clipboard?.writeText(selectedText(cur)).catch(() => { /* clipboard unavailable */ });
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
        // Swallow ordinary characters in Normal/Visual mode — this is
        // the whole point of the mode: typing "hello" navigates
        // (h, then nothing bound to 'e'/'l'/'o' — a fuller
        // implementation would map more keys) rather than inserting
        // text. Ctrl/Alt/Meta combos and function keys pass through
        // untouched so shortcuts like Ctrl+S below still work.
        if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) e.preventDefault();
        return;
    }
  }, [content, mode, anchor, onEscapeNormal, applyEdit, setPos, onEdit, taRef]);

  // ── Find / Find & Replace / Go to line ────────────────────────
  // A separate DOM <input> (see FindBar below), not part of the
  // Normal/Insert/Visual modal system above — typing a search term
  // was never meant to be vim motions, so giving it its own real
  // input sidesteps that entirely rather than needing a fourth mode.
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

    // Undo/Redo — standard editor bindings, work in any mode (real
    // vim uses "u"/Ctrl+R instead, but this app already leans on
    // Ctrl+S etc. over vim's own conventions, so Ctrl+Z/Ctrl+Y here
    // matches that and matches what most people reach for first).
    // Both Ctrl+Y and Ctrl+Shift+Z redo, to cover Windows and Mac muscle memory.
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
// FIND BAR — Find / Find & Replace / Go to line, shared by the
// Editor and Plugin Creator (see useModalEditor's find state above).
// A plain DOM input, deliberately outside the modal Normal/Insert/
// Visual system — typing a search term was never meant to be vim
// motions.
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

/** Joins a base directory with a relative reference and normalizes
 *  `.`/`..` segments — handles both `/`- and `\`-style paths (Windows
 *  project directories use the latter). Doesn't touch absolute paths
 *  (already-rooted references pass straight through unresolved,
 *  matching how every other path-taking function in this codebase
 *  treats an absolute path as already complete). */
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

/** Inlines a preview HTML page's own local stylesheet/script
 *  references (relative `<link rel="stylesheet" href="...">` and
 *  `<script src="...">` tags) so the live preview actually looks
 *  like the real project instead of unstyled, script-less markup —
 *  a real, reported gap: `srcDoc` gives the iframe no meaningful base
 *  URL to resolve a relative `css/style.css` against, so those
 *  requests silently failed and every preview looked broken for any
 *  project split across more than one file (which is most of them).
 *  Absolute URLs (http/https/protocol-relative) and already-inline
 *  data: URIs are left completely alone — only same-project relative
 *  references are read from disk and substituted in. Best-effort: a
 *  referenced file that can't be read (typo'd path, genuinely
 *  missing) is left as a comment explaining what didn't resolve,
 *  rather than silently dropped or left as a dead link the iframe
 *  can't do anything useful with anyway. */
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

  // Re-sync local content when a *different* file is opened, or when
  // the async ReadFile for the current file finishes loading. Watching
  // only file.path would miss the load-finished transition, since the
  // editor opens immediately with empty content while the read is
  // still in flight (see openEditor in the root component).
  useEffect(() => { setContent(file.content); setSavedContent(file.content); setDirty(false); }, [file.path, file.loading]);
  useEffect(() => { if (!file.loading) setTimeout(() => taRef.current?.focus(), 40); }, [file.loading]);

  const save = useCallback(() => {
    onSave(file.path, content);
    setSavedContent(content); // new baseline — the gutter now shows changes since THIS save, not the original open
    setDirty(false);
  }, [file.path, content, onSave]);

  // Same reasoning as CodeArea's highlight debounce (see App.tsx) —
  // computeChangedLines is a real O(n·m) LCS diff (capped, with a
  // fallback, but still real work), and recomputing it synchronously
  // on every keystroke is unnecessary on a large file when the
  // textarea itself never needs the result to stay responsive.
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

  // HTML live preview — a split view (code | rendered iframe) for
  // .html/.htm files specifically. Off by default even for an HTML
  // file (a toggle, not automatic) — opening an editor shouldn't
  // silently start executing whatever script tags are in the file
  // the user just clicked on.
  const isHtmlFile = /\.html?$/i.test(file.path);
  const [previewOpen, setPreviewOpen] = useState(false);
  // Debounced independently of changedLines' own debounce above (that
  // one only kicks in past 20,000 characters; a live preview visibly
  // flashing/reloading on every keystroke would look broken even on a
  // small file, so this one always debounces, a short 300ms rather
  // than that one's 200ms since a full iframe reload is a heavier,
  // more visually disruptive operation than a diff recompute).
  const [previewContent, setPreviewContent] = useState(content);
  const previewRunId = useRef(0); // guards against an in-flight resolve landing after a NEWER one already started (fast typing, or a quick file switch)
  const buildPreview = useCallback((html: string) => {
    const runId = ++previewRunId.current;
    inlinePreviewAssets(html, file.path).then(resolved => {
      if (previewRunId.current === runId) setPreviewContent(resolved);
    });
  }, [file.path]);
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
  // A real, rendered state (not just a ref) so the overlay below
  // actually mounts — see its own comment for why the overlay is the
  // real fix here, not a cosmetic addition. The ref is still needed
  // too: it's read synchronously inside the mousemove handler itself,
  // where a stale closure over state (even with a dependency array)
  // could otherwise read a one-tick-old value.
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

  // Fullscreen preview — hides the code pane entirely rather than
  // just growing the split further (dragging can only ever reach the
  // 20-80 clamp above; this is a distinct, deliberate "just show me
  // the page" mode, not the extreme end of resizing). Button in the
  // toolbar and Ctrl+Shift+Enter both toggle the same state; Escape
  // backs out of fullscreen first if it's active, same "handle the
  // more specific overlay first" pattern the rest of the app uses for
  // Escape (find bar, etc.) — only falls through to the editor's own
  // Escape-to-normal-mode/close behavior once fullscreen is off.
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
          {isHtmlFile && (
            <button className={`editor-btn${previewOpen ? " editor-btn--active" : ""}`}
              onClick={() => setPreviewOpen(o => !o)}
              title="Live preview — renders in a sandboxed frame, updates a moment after you stop typing">
              {previewOpen ? "preview ✓" : "preview"}
            </button>
          )}
          {isHtmlFile && previewOpen && (
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
              <span>live preview</span>
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
  isActive:    boolean;
  onReady:     () => void;
  onNewTab:    () => void;
  onCloseTab:  () => void;
  onSwitchTab: (n: number) => void;
}

interface InputState { value: string; cursor: number; }

let _pluginsInited = false;

/**
 * ChimneySmoke / renderTrainRow
 *
 * The smoke used to be a separate absolutely-positioned block, sized
 * and offset by hand (ch units for `left`, row-height arithmetic for
 * `top`) to land on the chimney glyph ("[]") in whichever ASCII row
 * held it. That math had to be re-derived per call site (different
 * font-size, line-height, and even letter-spacing each time) and kept
 * coming out wrong in some context or other.
 *
 * Anchoring directly to the glyph sidesteps all of that: the "[]" is
 * wrapped in its own `position: relative; display: inline-block` span
 * (.oxis-chimney), and the smoke stack is rendered as an absolutely
 * positioned CHILD of that span, centered on it via `left:50%;
 * transform:translateX(-50%)` and anchored to its top edge via
 * `bottom:100%`. Wherever the browser lays out that "[]" — at any
 * font-size, any letter-spacing, any row height — the smoke lands
 * exactly there, because it's positioned relative to the glyph
 * itself rather than a guess about where the glyph will end up.
 */
function ChimneySmoke({ height }: { height: number }) {
  return (
    <span className="oxis-smoke-stack" style={{ height }} aria-hidden="true">
      <span className="puff puff-1">o</span>
      <span className="puff puff-2">O</span>
      <span className="puff puff-3">o</span>
      <span className="puff puff-4">O</span>
      <span className="puff puff-5">o</span>
      <span className="puff puff-6">O</span>
    </span>
  );
}

/** Renders one row of train ASCII art, splicing in ChimneySmoke at the
 *  "[]" if this row has one. `smokeHeight` controls how tall a plume
 *  ("how high the smoke can rise") fits the context — the shell boot
 *  banner's smaller art uses a shorter one (70) than the startup
 *  splash (110); Home no longer has a train of its own at all. */
// Clickable URLs and file paths in terminal output — a URL opens in
// the real system browser (openUrl, native.ts); a path opens in the
// built-in Editor (the same openEditor() 'edit uses). Deliberately
// conservative about what counts as a "path" (must end in a real
// extension) rather than linkifying every bare "/" or "C:\" — a
// terminal line has plenty of those that aren't actually paths (CLI
// flags, ratios, etc.), and a wrong guess that's clickable is worse
// than a real path that isn't.
const LINE_LINK_RE = /(https?:\/\/[^\s"'<>()]+)|([A-Za-z]:\\[^\s"'<>]+?\.[A-Za-z0-9]{1,8}(?=[\s"'<>)]|$))|(\/[^\s"'<>]+?\.[A-Za-z0-9]{1,8}(?=[\s"'<>)]|$))/g;

function renderLineWithLinks(text: string, onOpenUrl: (url: string) => void, onOpenPath: (path: string) => void): React.ReactNode {
  if (!text) return "\u00a0";
  LINE_LINK_RE.lastIndex = 0;
  const parts: React.ReactNode[] = [];
  let last = 0, key = 0, m: RegExpExecArray | null;
  while ((m = LINE_LINK_RE.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const matched = m[0];
    if (m[1]) {
      parts.push(<span key={key++} className="term-link" onClick={e => { e.stopPropagation(); onOpenUrl(matched); }} title={`open ${matched}`}>{matched}</span>);
    } else {
      parts.push(<span key={key++} className="term-link term-link--path" onClick={e => { e.stopPropagation(); onOpenPath(matched); }} title={`edit ${matched}`}>{matched}</span>);
    }
    last = LINE_LINK_RE.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function renderTrainRow(text: string, smokeHeight: number): React.ReactNode {
  const i = text.indexOf("[]");
  if (i === -1) return text || "\u00a0";
  return (
    <>
      {text.slice(0, i)}
      <span className="oxis-chimney">
        {"[]"}
        <ChimneySmoke height={smokeHeight} />
      </span>
      {text.slice(i + 2)}
    </>
  );
}

function Terminal({ id, isActive, onReady, onNewTab, onCloseTab, onSwitchTab }: TermProps) {
  // ── output state ─────────────────────────────────────────
  const [lines,      setLines]      = useState<Line[]>(() => bannerLines());
  const [ready,      setReady]      = useState(false);
  const [connErr,    setConnErr]    = useState("");

  // ── input visual state ────────────────────────────────────
  const [inputVal,    setInputVal]    = useState("");
  const [inputCursor, setInputCursor] = useState(0);

  // ── search state ──────────────────────────────────────────
  const [searching,    setSearching]    = useState(false);
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);

  // ── output search (Ctrl+F) — distinct from the above, which is
  // Ctrl+R's reverse-i-search through COMMAND HISTORY. This searches
  // the actual on-screen scrollback (`lines`) instead — "did I already
  // see X printed somewhere above". ──────────────────────────────
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
  // The file tree's root — the connected external project directory
  // if the active workspace has one (item 2: "the editor's file tree
  // should switch from showing an OXIS-managed workspace structure to
  // showing the actual connected project"), or "." (the app's own
  // directory — the normal OXIS-managed view) otherwise. Refreshed on
  // the same events Home's connected-path display uses, so switching
  // workspaces or linking/unlinking updates the tree immediately
  // rather than needing it closed and reopened.
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
  const ghostRef      = useRef<HTMLTextAreaElement>(null);
  const session       = useRef<PtySession | null>(null);
  const pending       = useRef("");
  const mounted       = useRef(false);
  const inputRef      = useRef<InputState>({ value: "", cursor: 0 });
  const userScrolled  = useRef(false);
  const ctxRef        = useRef<ShellCtx | null>(null);
  const linesRef       = useRef<Line[]>(bannerLines());
  const suppressOutput = useRef(false);
  const bannerWheelId  = useRef<number | null>(null);

  // Capture the boot banner's wheel-row line id once, from whatever
  // was actually used to initialise `lines`, so the spin effect below
  // can target the right row without re-deriving the banner.
  useEffect(() => {
    const wheelLine = lines.find(l => l.kind === "banner-wheel");
    if (wheelLine) bannerWheelId.current = wheelLine.id;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "The train is moving" — cycle the boot banner's wheel glyphs
  // while the shell tab is visible, so the boot banner reads as
  // rolling rather than parked. Home no longer has a train of its
  // own at all (removed).
  useEffect(() => {
    if (!isActive) return;
    let frame = 0;
    const t = setInterval(() => {
      frame++;
      const id = bannerWheelId.current;
      if (id == null) return;
      setLines(prev => {
        const idx = prev.findIndex(l => l.id === id);
        if (idx === -1) return prev;
        const next = prev.slice();
        next[idx] = { ...next[idx], text: trainWheelFrame(frame) };
        return next;
      });
    }, 130);
    return () => clearInterval(t);
  }, [isActive]);

  // ── restore scroll + focus when tab becomes visible ─────────
  useEffect(() => {
    if (!isActive) {
      userScrolled.current = false;
      return;
    }
    // Poll until scrollHeight > 0 (display:none → flex is async in the browser)
    let attempts = 0;
    const tryScroll = () => {
      const el = outRef.current;
      if (el && el.scrollHeight > 50) {
        el.scrollTop = el.scrollHeight;
        ghostRef.current?.focus({ preventScroll: true });
      } else if (attempts++ < 10) {
        requestAnimationFrame(tryScroll);
      }
    };
    requestAnimationFrame(tryScroll);
  }, [isActive]);

  // ── input sync ────────────────────────────────────────────
  const syncInput = useCallback((val: string, cur: number) => {
    inputRef.current = { value: val, cursor: cur };
    setInputVal(val);
    setInputCursor(cur);
  }, []);

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
    return () => { u1(); u2(); };
  }, [isActive, addLine]);

  const clear = useCallback(() => {
    // Keep the boot banner (the train ascii) -- only the scrollback below
    // it gets wiped. Filtering (rather than rebuilding a fresh banner)
    // preserves the exact same line objects/ids already tracked by the
    // wheel-spin effect above, so the animation just keeps going
    // uninterrupted instead of restarting or needing its ref re-pointed.
    setLines(prev => {
      const kept = prev.filter(l => l.kind === "banner" || l.kind === "banner-wheel");
      linesRef.current = kept;
      return kept;
    });
    pending.current      = "";
    userScrolled.current = false;
    // Also clear the PTY shell buffer (Ctrl+L)
    suppressOutput.current = true;
    setTimeout(() => { suppressOutput.current = false; }, 400);
    session.current?.write("");
    scrollToBottom(true);
  }, [scrollToBottom]);

  const sendToShell = useCallback((data: string) => {
    session.current?.write(data);
  }, []);

  const focusGhost = useCallback(() => {
    ghostRef.current?.focus({ preventScroll: true });
  }, []);

  // Output search (Ctrl+F) — distinct from Ctrl+R's reverse-i-search
  // through COMMAND HISTORY above; this searches the actual on-screen
  // scrollback (`lines`) instead — "did I already see X printed
  // somewhere above".
  const outputSearchMatches = useMemo(() => {
    const q = outputSearchQuery.trim().toLowerCase();
    if (!q) return [] as number[]; // line ids
    return lines.filter(l => l.text.toLowerCase().includes(q)).map(l => l.id);
  }, [lines, outputSearchQuery]);

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
    setTimeout(() => focusGhost(), 20);
  }, [focusGhost]);

  // Refocus the hidden input on a plain click anywhere in the terminal
  // (output scrollback included) — but not when the mousedown/up was
  // actually a text-selection drag, so copy still works normally.
  // Also copy-on-select: a real terminal-emulator convention (X11
  // PRIMARY-selection-style) — finishing a drag-select copies it to
  // the clipboard immediately, no separate Ctrl+C needed. Ctrl+C
  // still works too (see the window-level Ctrl+C handler elsewhere),
  // for anyone used to that instead.
  const refocusUnlessSelecting = useCallback(() => {
    const sel = window.getSelection?.();
    const text = sel?.toString() ?? "";
    if (text.length > 0) {
      navigator.clipboard?.writeText(text).catch(() => { /* clipboard unavailable — selection itself still stands */ });
      return;
    }
    focusGhost();
  }, [focusGhost]);

  // Restore focus to the input when the OS window regains focus
  // (alt-tab back in, click on the window from the taskbar) — without
  // this, the window can appear active but typing goes nowhere until
  // the terminal itself is clicked.
  useEffect(() => {
    if (!isActive) return;
    const onWindowFocus = () => {
      if (editorFiles.length === 0) {
        setTimeout(() => ghostRef.current?.focus({ preventScroll: true }), 30);
      }
    };
    window.addEventListener("focus", onWindowFocus);
    return () => window.removeEventListener("focus", onWindowFocus);
  }, [isActive, editorFiles.length]);

  // Ctrl+C safety net — it MUST always be able to interrupt whatever's
  // running in the shell (e.g. 'task watch-mem's infinite polling
  // loop), which normally goes through the hidden input's own key
  // handler below. But continuous/rapid PTY output while a foreground
  // loop is running can end up stealing focus off that hidden input
  // (scrollback re-rendering, etc.) — the reported "no way to stop
  // watch-mem" — after which Ctrl+C just does the browser's default
  // (nothing, or copy) instead of ever reaching sendToShell. Catch it
  // at the window level too as a fallback, but bow out if focus is in
  // some OTHER real text field (plugin name box, search box, the file
  // Editor/Plugin Creator's own textarea — closed here anyway) or
  // there's an actual text selection, so normal copy and that field's
  // own Ctrl+Z/undo still work as expected.
  useEffect(() => {
    if (!isActive || editorFiles.length > 0) return;
    const onWindowKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.metaKey || e.altKey || e.key.toLowerCase() !== "c") return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== ghostRef.current
          && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
      const sel = window.getSelection?.();
      if (sel && sel.toString().length > 0) return; // let the browser copy the selection instead
      e.preventDefault();
      sendToShell("\x03");
      scriptRunTracker.cancel();
      focusGhost();
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [isActive, editorFiles.length, sendToShell, focusGhost]);

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
    // Always strip the cwd probe marker first — see cwdTracker.ts —
    // so it happens even during a suppressOutput window (startup
    // noise) instead of just being silently thrown away with it.
    raw = cwdTracker.consume(raw);
    raw = scriptRunTracker.consume(raw);
    if (suppressOutput.current) { pending.current = ""; return; }
    if (!raw) return;
    const { completedLines, newPending } = processOutput(raw, pending.current);
    pending.current = newPending;
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

    // A previous '-command's oxis.run() script may still be running —
    // possibly blocked on its own Read-Host prompt waiting for real
    // keystrokes. Launching a second one on top of it would send this
    // command's own launch line into that pending prompt instead of
    // running it, corrupting both (see scriptRunTracker.ts for the
    // full story — this is the "'tail right after 'healthcheck"
    // bug). Refuse instead: answer the prompt (or Ctrl+C to cancel
    // it) first.
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
      ctxRef.current.clear = clear;
    }
    return registry.execute(verb, args, rest);
  }, [addLine, sendToShell, clear]);

  // ── Run one command line through the same dispatch that real typed
  // Enter uses: checks for the "'"/"oxi" OXIS-command prefix and
  // routes to dispatchOxisCmd (with the same echo line), otherwise
  // forwards to the actual PTY shell. Shared by submit() (below) and
  // by ShellCtx.runLine, which is what the Home screen's command bar
  // now calls — it used to call ctxRef.current.send() directly, which
  // is the RAW PTY-write path with no OXIS-prefix handling at all, so
  // typing e.g. `'help` on the home screen sent the literal text
  // `'help` to the real OS shell (which has no idea what that means)
  // Send an invisible cwd probe (see cwdTracker.ts) and briefly
  // suppress rendered output so the probe's own echoed input line
  // doesn't show up in the scrollback. onOutput strips the marker
  // *before* checking suppressOutput, so the probe's actual answer
  // still gets through even during this window.
  const probeCwd = useCallback(() => {
    suppressOutput.current = true;
    sendToShell(buildCwdProbe(isWindows()) + "\r");
    setTimeout(() => { suppressOutput.current = false; }, 250);
  }, [sendToShell]);

  // instead of running the built-in help command.
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
      // Re-probe cwd after anything that plausibly changed it (cd,
      // Set-Location, pushd/popd, z…) — see README § Workspace System,
      // "OXIS must automatically detect and load a workspace when
      // entering/opening a project". A short delay lets the shell
      // actually finish the directory change first.
      if (looksLikeDirectoryChange(cmd)) setTimeout(probeCwd, 400);
    }
    scrollToBottom(true);
  }, [sendToShell, addLine, dispatchOxisCmd, scrollToBottom, probeCwd]);


  // ── PTY connect ───────────────────────────────────────────
  useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;

    session.current = openPty({
      cols: 220, rows: 50, onOutput,
      onReady: () => {
        pending.current = "";
        suppressOutput.current = true;
        setTimeout(() => { suppressOutput.current = false; }, 300);
        setReady(true);
        onReady();
        setTimeout(focusGhost, 60);
        events.emit("shell_started", { id });
        // Initial cwd probe — this is what makes automatic workspace
        // detection on launch actually automatic instead of requiring
        // the user to run 'workspace reload by hand.
        setTimeout(probeCwd, 500);

        // Background update check — once per app run, well after
        // startup (see _updateCheckedThisRun) so a slow/offline
        // gitlab.com never delays the shell becoming usable. Silent
        // when up to date; a single line (not a popup) when not, same
        // as every other passive notice in this terminal.
        if (!_updateCheckedThisRun) {
          _updateCheckedThisRun = true;
          setTimeout(() => {
            checkForUpdate().then(info => {
              if (info.available) {
                addLine(`  ↑  a newer OXIS build (${info.latestCommit.slice(0, 7)}) is available${info.currentCommit ? ` (you're on ${info.currentCommit.slice(0, 7)})` : ""} — run 'update to open it`, "info");
              }
            }).catch(() => {}); // silent — a background check should never surface as an error
          }, 2000);
        }
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
    const ro = new ResizeObserver(() => {
      const cols = Math.max(10, Math.floor(el.clientWidth  / 7.8));
      const rows = Math.max(5,  Math.floor(el.clientHeight / 20));
      session.current?.resize(cols, rows);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Plugin/command init (once ever) ──────────────────────
  useEffect(() => {
    // Wire real callbacks — overrides the stub set at root init
    ctxRef.current = {
      send: sendToShell,
      runLine,
      print: addLine,
      clear,
      openEditor: path => {
        setEditorFiles(files => {
          if (files.some(f => f.path === path)) return files; // already open — just switch to it
          return [...files, { path, content: "", dirty: false, loading: true }];
        });
        setActiveEditorPath(path);
        readFile(path)
          .then(content => setEditorFiles(files => files.map(f => f.path === path ? { ...f, content, loading: false } : f)))
          .catch(e => setEditorFiles(files => files.map(f => f.path === path
            ? { ...f, loading: false, loadError: e instanceof Error ? e.message : String(e) }
            : f)));
      },
      newTerminal: onNewTab,
    };
    _ctxRef.current = ctxRef.current;

    // Point the live-forwarding plugin API context at this real shell
    // (see forwardingApiCtx's comment above) — this is what actually
    // makes oxis.run()/oxis.echo() and every shortcut plugin's
    // commands work, for plugins that were already loaded before this
    // Terminal existed, not just ones loaded from here on.
    _apiCtxTarget.current = {
      sendToShell: sendToShell,
      print:       addLine,
      getCwd:      () => cwdTracker.get(),
      newTerminal: onNewTab,
      getOption:   readPersistedOption,
      setOption:   writePersistedOption,
      pluginName:  "__core__",
    };

    // Re-register commands with real ctx now that shell is live
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
  const submit = useCallback(() => {
    const cmd = inputRef.current.value.trim();
    clearInput();
    history.resetNav();
    runLine(cmd);
  }, [clearInput, runLine]);

  // ── Search helpers ────────────────────────────────────────
  const enterSearch = useCallback(() => {
    history.enterSearch();
    setSearching(true);
    setSearchResult(null);
  }, []);

  const exitSearch = useCallback((commit: boolean) => {
    if (commit && searchResult) {
      syncInput(searchResult.match, searchResult.match.length);
    }
    history.exitSearch();
    setSearching(false);
    setSearchResult(null);
  }, [searchResult, syncInput]);

  // ══════════════════════════════════════════════════════════
  // KEYBOARD ENGINE
  // Complete readline/bash/Emacs keybinding set
  // ══════════════════════════════════════════════════════════
  const onKey = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    const k    = e.key;
    const ctrl = e.ctrlKey  && !e.altKey;
    const alt  = e.altKey   && !e.ctrlKey;
    const { value: val, cursor: cur } = inputRef.current;

    // ── REVERSE SEARCH MODE ──────────────────────────────
    if (searching) {
      e.preventDefault();
      if (k === "Escape" || (ctrl && k.toLowerCase() === "g")) { exitSearch(false); return; }
      if (k === "Enter")                                        { exitSearch(true); submit(); return; }
      if (ctrl && k.toLowerCase() === "r")                     { const r = history.searchOlder(); if (r) setSearchResult(r); return; }
      if (k === "Backspace")  { setSearchResult(history.searchBackspace()); return; }
      if (k.length === 1)     { setSearchResult(history.searchAppend(k));   return; }
      return;
    }

    // ── TAB SWITCHING (global — works in any mode) ────────
    if (ctrl && k === "t") { e.preventDefault(); onNewTab();   return; }
    if (ctrl && k === "w") { e.preventDefault(); onCloseTab(); return; }
    if (ctrl && k >= "1" && k <= "9") { e.preventDefault(); onSwitchTab(+k - 1); return; }

    // ── TERMINAL ZOOM — Ctrl+= / Ctrl+- / Ctrl+0, the same keys every
    // browser already uses for page zoom, so it's muscle memory
    // instead of a new thing to learn. Reuses the real fontSize
    // setting ('config set fontSize <n>) rather than a separate
    // zoom-only mechanism, so the effect persists across restarts
    // exactly like setting it directly would, and 'config get
    // fontSize always reflects what zoom last left it at.
    if (ctrl && (k === "=" || k === "+")) {
      e.preventDefault();
      const cur = Number(getSetting("fontSize")) || 13;
      setSetting("fontSize", String(Math.min(28, cur + 1)));
      return;
    }
    if (ctrl && k === "-") {
      e.preventDefault();
      const cur = Number(getSetting("fontSize")) || 13;
      setSetting("fontSize", String(Math.max(9, cur - 1)));
      return;
    }
    if (ctrl && k === "0") {
      e.preventDefault();
      resetSetting("fontSize");
      return;
    }

    // ── PASSTHROUGH when input empty (program is running) ─
    if (!val) {
      const passSeq: Record<string, string> = {
        ArrowUp:"\x1b[A", ArrowDown:"\x1b[B", ArrowRight:"\x1b[C", ArrowLeft:"\x1b[D",
        Home:"\x1b[H", End:"\x1b[F",
        Delete:"\x1b[3~", PageUp:"\x1b[5~", PageDown:"\x1b[6~",
        Tab:"\t", Escape:"\x1b",
        F1:"\x1bOP",F2:"\x1bOQ",F3:"\x1bOR",F4:"\x1bOS",
        F5:"\x1b[15~",F6:"\x1b[17~",F7:"\x1b[18~",F8:"\x1b[19~",
        F9:"\x1b[20~",F10:"\x1b[21~",F11:"\x1b[23~",F12:"\x1b[24~",
      };
      if (passSeq[k]) { e.preventDefault(); sendToShell(passSeq[k]); return; }
    }

    // ── TAB COMPLETION ─────────────────────────────────────
    // A "'command <tab>" completes against the REAL command registry
    // (registry.all()) — every name it offers is one that actually
    // works, not a hardcoded guess list. Scoped to just the verb (the
    // first word after '), not subcommands like 'workspace <tab> ->
    // init/list/switch/... — those aren't their own registry entries
    // (they're just strings matched inside each command's own
    // handler), so faking a subcommand list here would be exactly the
    // "autocomplete disconnected from the real registry" this is
    // meant to avoid. Anything NOT starting with ' (an ordinary shell
    // command) passes a real \t through to the shell instead, so
    // PowerShell/bash's own native completion still works exactly as
    // it always has — this only ever intercepts Tab for OXIS's own
    // '-commands, never shell ones.
    if (!ctrl && !alt && k === "Tab") {
      e.preventDefault();
      if (!val.startsWith("'")) { sendToShell("\t"); return; }
      const body = val.slice(1);
      if (body.includes(" ")) return; // past the verb — nothing to complete yet
      const prefix = body.toLowerCase();
      const names = [...new Set(registry.all().map(c => c.name).filter(n => !n.includes(":")))].sort();
      const matches = prefix ? names.filter(n => n.toLowerCase().startsWith(prefix)) : names;
      if (matches.length === 1) {
        syncInput(`'${matches[0]} `, matches[0].length + 2);
      } else if (matches.length > 1) {
        // Extend as far as unambiguous (like bash), same as pressing
        // Tab again with more matches than fit on one line still does.
        let common = matches[0];
        for (const m of matches.slice(1)) {
          while (!m.toLowerCase().startsWith(common.toLowerCase())) common = common.slice(0, -1);
        }
        if (common.length > body.length) syncInput(`'${common}`, common.length + 1);
        else addLine(`  ${matches.slice(0, 20).join("  ")}${matches.length > 20 ? "  …" : ""}`, "dim");
      }
      return;
    }

    // ── CTRL BINDINGS ─────────────────────────────────────
    if (ctrl) {
      switch (k.toLowerCase()) {
        // Interrupt / EOF / suspend
        case "c": e.preventDefault(); sendToShell("\x03"); clearInput(); history.resetNav(); scriptRunTracker.cancel(); return;
        case "d": e.preventDefault(); sendToShell("\x04"); return;
        case "z": e.preventDefault(); sendToShell("\x1a"); return;
        case "\\": e.preventDefault(); sendToShell("\x1c"); return;

        // Line editing
        case "a": e.preventDefault(); syncInput(val, 0);          return; // BOL
        case "e": e.preventDefault(); syncInput(val, val.length); return; // EOL
        case "f": e.preventDefault(); syncInput(val, Math.min(val.length, cur + 1)); return; // fwd char
        case "b": e.preventDefault(); syncInput(val, Math.max(0, cur - 1));          return; // back char
        case "h": e.preventDefault(); // Ctrl+H = Backspace
          if (cur > 0) syncInput(val.slice(0, cur - 1) + val.slice(cur), cur - 1);
          return;

        case "k": { // kill to end of line — save to yank buf
          e.preventDefault();
          const r = deleteToLineEnd(val, cur);
          setYankBuf(val.slice(cur));
          syncInput(r.text, r.pos);
          return;
        }
        case "u": { // kill to start of line — save to yank buf
          e.preventDefault();
          const r = deleteToLineStart(val, cur);
          setYankBuf(val.slice(0, cur));
          syncInput(r.text, r.pos);
          return;
        }
        case "w": { // delete word left — save to yank buf
          e.preventDefault();
          const r = deleteWordLeft(val, cur);
          setYankBuf(val.slice(wordLeft(val, cur), cur));
          syncInput(r.text, r.pos);
          return;
        }
        case "y": { // yank (paste from kill buffer)
          e.preventDefault();
          const yank = getYankBuf();
          if (!yank) return;
          syncInput(val.slice(0, cur) + yank + val.slice(cur), cur + yank.length);
          return;
        }
        case "t": { // transpose chars
          e.preventDefault();
          const r = transposeChars(val, cur);
          syncInput(r.text, r.pos);
          return;
        }
        case "l": e.preventDefault(); clear(); return; // clear screen

        case "r": e.preventDefault(); enterSearch(); return; // reverse search (command HISTORY)

        case "f": e.preventDefault(); openOutputSearch(); return; // output search (on-screen SCROLLBACK)

        case "p": // previous history (like up arrow)
          e.preventDefault();
          { const p = history.prev(val); syncInput(p, p.length); return; }
        case "n": // next history (like down arrow)
          e.preventDefault();
          { const n = history.next(); syncInput(n, n.length); return; }

        case "v": return; // allow paste passthrough
      }
      return;
    }

    // ── ALT BINDINGS (word movement) ──────────────────────
    if (alt) {
      switch (k.toLowerCase()) {
        case "f":         e.preventDefault(); syncInput(val, wordRight(val, cur)); return;
        case "b":         e.preventDefault(); syncInput(val, wordLeft(val, cur));  return;
        case "d":         e.preventDefault(); { const r = deleteWordRight(val, cur); setYankBuf(val.slice(cur, wordRight(val, cur))); syncInput(r.text, r.pos); return; }
        case "backspace": e.preventDefault(); { const r = deleteWordLeft(val, cur);  setYankBuf(val.slice(wordLeft(val, cur), cur)); syncInput(r.text, r.pos); return; }
        case "<":         e.preventDefault(); syncInput(val, 0);          return; // BOF
        case ">":         e.preventDefault(); syncInput(val, val.length); return; // EOF
        case "t": { // transpose words
          e.preventDefault();
          const ls = wordLeft(val, cur);
          const le = wordRight(val, ls);
          const rs = wordLeft(val, wordRight(val, cur));
          const re = wordRight(val, rs);
          if (ls === rs) return;
          const w1 = val.slice(ls, le);
          const w2 = val.slice(rs, re);
          const next = val.slice(0, ls) + w2 + val.slice(le, rs) + w1 + val.slice(re);
          syncInput(next, re - (w1.length - w2.length));
          return;
        }
        case "u": { // uppercase word
          e.preventDefault();
          const end = wordRight(val, cur);
          syncInput(val.slice(0, cur) + val.slice(cur, end).toUpperCase() + val.slice(end), end);
          return;
        }
        case "l": { // lowercase word
          e.preventDefault();
          const end = wordRight(val, cur);
          syncInput(val.slice(0, cur) + val.slice(cur, end).toLowerCase() + val.slice(end), end);
          return;
        }
        case "c": { // capitalise word
          e.preventDefault();
          const end = wordRight(val, cur);
          const word = val.slice(cur, end);
          syncInput(val.slice(0, cur) + word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() + val.slice(end), end);
          return;
        }
      }
      return;
    }

    // ── NAVIGATION KEYS ───────────────────────────────────
    if (k === "ArrowLeft") {
      e.preventDefault();
      syncInput(val, e.ctrlKey ? wordLeft(val, cur) : Math.max(0, cur - 1));
      return;
    }
    if (k === "ArrowRight") {
      e.preventDefault();
      syncInput(val, e.ctrlKey ? wordRight(val, cur) : Math.min(val.length, cur + 1));
      return;
    }
    if (k === "ArrowUp") {
      e.preventDefault();
      const p = history.prev(val);
      syncInput(p, p.length);
      return;
    }
    if (k === "ArrowDown") {
      e.preventDefault();
      const n = history.next();
      syncInput(n, n.length);
      return;
    }
    if (k === "Home")   { e.preventDefault(); syncInput(val, 0);          return; }
    if (k === "End")    { e.preventDefault(); syncInput(val, val.length); return; }
    if (k === "Delete") {
      e.preventDefault();
      if (cur < val.length) syncInput(val.slice(0, cur) + val.slice(cur + 1), cur);
      return;
    }
    if (k === "PageUp")   { e.preventDefault(); outRef.current?.scrollBy(0, -300); return; }
    if (k === "PageDown") { e.preventDefault(); outRef.current?.scrollBy(0,  300); return; }

    if (k === "Tab") {
      e.preventDefault();
      // If buffer empty, pass tab to shell for completion
      if (!val) { sendToShell("\t"); return; }
      const next = val.slice(0, cur) + "  " + val.slice(cur);
      syncInput(next, cur + 2);
      return;
    }

    if (k === "Enter") {
      e.preventDefault();
      submit();
      return;
    }

    if (k === "Escape") {
      e.preventDefault();
      sendToShell("\x1b");
      return;
    }

    if (k === "Backspace") {
      e.preventDefault();
      if (cur > 0) {
        const next = val.slice(0, cur - 1) + val.slice(cur);
        syncInput(next, cur - 1);
        history.setDraft(next);
      }
      return;
    }

    // ── PRINTABLE ─────────────────────────────────────────
    if (k.length === 1 && !e.ctrlKey && !e.metaKey) {
      const next = val.slice(0, cur) + k + val.slice(cur);
      syncInput(next, cur + 1);
      history.setDraft(next);
    }
  }, [
    searching, searchResult, exitSearch, enterSearch, submit,
    syncInput, clearInput, sendToShell, addLine, clear,
    onNewTab, onCloseTab, onSwitchTab, scrollToBottom,
  ]);

  // ── Paste handler ─────────────────────────────────────────
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text");
    if (!text) return;
    if (text.includes("\n")) {
      const lns = text.split(/\r?\n/).filter(Boolean);
      if (lns.length > 1 && !window.confirm(`Paste ${lns.length} lines to shell?`)) return;
      clearInput();
      sendToShell(text);
      return;
    }
    const { value: val, cursor: cur } = inputRef.current;
    const next = val.slice(0, cur) + text + val.slice(cur);
    syncInput(next, cur + text.length);
  }, [syncInput, clearInput, sendToShell]);

  // ── Editor save — native file write, no PTY round-trip. Plugin-aware:
  // a file that's actually a registered plugin's source saves (and
  // reloads live) through pluginManager.saveLuaPlugin instead of a
  // plain write — see findPluginForPath. This is what makes plugin
  // editing "the same Editor as any file" instead of a second one:
  // the Editor itself doesn't know or care it's a plugin, only this
  // save path does.
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
    if (editorFiles.length <= 1) setTimeout(focusGhost, 50);
  }, [editorFiles, closeEditorTab, focusGhost]);

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
  // bannerEnd MUST be computed unconditionally, before the editor
  // early return below — it's a hook, and calling it only on the
  // "normal" render path (skipped whenever editorFiles is non-empty)
  // violates the Rules of Hooks: React sees a different hook count
  // between renders and throws, which is what was producing the blank
  // screen when opening 'edit.
  const bannerEnd = useMemo(() => {
    let i = 0;
    while (i < lines.length && (lines[i].kind === "banner" || lines[i].kind === "banner-wheel")) i++;
    return i;
  }, [lines]);

  if (editorFiles.length > 0 || fileTreeOpen) {
    const activeFile = editorFiles.find(f => f.path === activeEditorPath) ?? editorFiles[0];
    return (
      <div className="app-pane app-pane--editor">
        <div className="filetree-rail">
          <button className="filetree-toggle" onClick={() => setFileTreeOpen(o => !o)} title="Toggle file tree (Ctrl+B)">☰</button>
        </div>
        {fileTreeOpen && (
          <FileTree
            rootDir={fileTreeRoot.dir}
            rootLabel={fileTreeRoot.label}
            onOpenFile={path => ctxRef.current?.openEditor(path)}
            onMoveFile={(srcPath, destDirPath) => {
              // Unlike 'workspace move (which parses raw user-typed
              // text and genuinely needs safeJoinWithinDir), srcPath/
              // destDirPath here are real, already-resolved paths the
              // tree itself produced from an actual directory listing
              // — there's no user-controlled string to validate.
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

  const beforeCursor = inputVal.slice(0, inputCursor);
  const atCursor     = inputVal[inputCursor] ?? "";
  const afterCursor  = inputVal.slice(inputCursor + (atCursor ? 1 : 0));
  const cursorChar   = atCursor || "\u00a0";

  // Boot banner (if 'clear hasn't wiped it) is always a contiguous
  // run at the very start of `lines` — see bannerLines()/clear().
  // It's split out into its own .term-banner-block wrapper (fit-content
  // width, so the centered rows don't stretch full-width) rather than
  // rendering directly in .term-out — see .oxis-chimney in index.css
  // for how the smoke itself anchors (to the "[]" glyph, not this
  // wrapper).
  const bannerPart = bannerEnd > 0 ? lines.slice(0, bannerEnd) : null;
  const restPart    = bannerEnd > 0 ? lines.slice(bannerEnd) : lines;

  return (
    <div className="term" onMouseUp={refocusUnlessSelecting}>
      {connErr && <div className="term-error">⚠ {connErr}</div>}

      <div className="term-out" ref={outRef} onScroll={handleScroll} tabIndex={-1}>
        {bannerPart && (
          <div className="term-banner-block">
            {bannerPart.map(line => (
              <div key={line.id} className="term-line term-line--banner"
                style={{ color: line.kind ? LINE_COLORS[line.kind] : undefined }}>
                {renderTrainRow(line.text, 110)}
              </div>
            ))}
          </div>
        )}
        {restPart.map(line => (
          <div key={line.id}
            data-line-id={line.id}
            className={`term-line${outputSearchMatches.includes(line.id) ? " term-line--match" : ""}`}
            style={{ color: line.kind ? LINE_COLORS[line.kind] : undefined }}>
            {renderLineWithLinks(line.text, u => void openUrl(u), p => _ctxRef.current?.openEditor(p))}
          </div>
        ))}

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
            <span className="term-search-hint">Enter ·  Esc cancel · Ctrl+R older</span>
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

        {!searching && (
          <div className="term-input-row">
            <span className="term-prompt">❯{"\u00a0"}</span>
            <span className="term-input-pre">{beforeCursor}</span>
            <span className={`term-caret ${ready ? "term-caret--on" : "term-caret--off"}`}>{cursorChar}</span>
            <span className="term-input-post">{afterCursor}</span>
          </div>
        )}
      </div>

      <textarea ref={ghostRef} className="term-ghost"
        value={inputVal} onChange={() => {}}
        onKeyDown={onKey} onPaste={handlePaste}
        spellCheck={false} autoComplete="off" autoCorrect="off" autoCapitalize="off"
        rows={1} tabIndex={0} aria-label="terminal input"
        onFocus={() => { /* keep ghost focused */ }}
        onBlur={e => {
          // An overlay (editor) legitimately owns focus — this
          // component isn't even rendering the ghost in that case, but
          // guard anyway in case of a same-render toggle.
          if (editorFiles.length > 0) return;
          const next = e.relatedTarget as HTMLElement | null;
          // Don't steal focus from something the user deliberately
          // clicked into elsewhere (a real input/textarea/select/button —
          // e.g. the theme editor, plugin search box, titlebar controls).
          if (next && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(next.tagName)) return;
          setTimeout(() => ghostRef.current?.focus({ preventScroll: true }), 50);
        }} />
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

function PluginCard({ p, onToggle }: {
  p: ReturnType<typeof pluginManager.all>[0];
  onToggle: (name: string, enabled: boolean) => void;
}) {
  const shortcuts = p.shortcuts ? Object.keys(p.shortcuts) : [];
  return (
    <div className="plugin-card">
      <div className="plugin-card-status" style={{ background: p.enabled ? "var(--purple2)" : "var(--bg4)" }} />
      <div className="plugin-card-body">
        <div className="plugin-card-top">
          <span className="plugin-card-name">{p.name}</span>
          <span className="plugin-card-cat">{p.category}</span>
          {p.builtin && <span className="plugin-card-builtin">built-in</span>}
          {p.lua && !p.builtin && <span className="plugin-card-builtin" style={{color:"var(--purple3)"}}>lua</span>}
        </div>
        <div className="plugin-card-desc">{p.desc}</div>
        {shortcuts.length > 0 && (
          <div className="plugin-card-keys">
            {shortcuts.slice(0, 8).map(s => <code key={s} className="plugin-key">{s}</code>)}
            {shortcuts.length > 8 && <span className="plugin-more">+{shortcuts.length - 8}</span>}
          </div>
        )}
      </div>
      <button className={`plugin-tog ${p.enabled ? "plugin-tog--on" : ""}`}
        onClick={() => onToggle(p.name, !p.enabled)}>
        {p.enabled ? "on" : "off"}
      </button>
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

// ── Startup splash — the train, rolling in ──────────────────
// Shown once on launch (see `.startup-anim` fade in index.css). Uses
// the same train art as the terminal's own shell-boot banner, but
// spins the wheels for the ~1.8s the splash is visible so it reads
// as the train arriving. Home no longer has a train of its own at
// all (removed — see the Home function's return).
function StartupSplash({ onClick }: { onClick: () => void }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setFrame(f => f + 1), 120);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    // Match .startup-anim's 16s CSS fade (index.css) — auto-dismiss
    // once it's finished fading rather than leaving the splash
    // (and its wheel-spin interval) mounted forever if the user
    // never clicks to skip it early.
    //
    // Deliberately NOT depending on `onClick`: the parent passes a
    // fresh arrow function every render (`onClick={() =>
    // setShowAnim(false)}`), so depending on it here would reset
    // this timer on every parent re-render (e.g. the home screen's
    // clock ticking) and the splash might never auto-dismiss. The
    // underlying setState call it wraps is referentially stable
    // across renders regardless of which render's closure calls it,
    // so capturing the mount-time closure once is correct.
    const t = setTimeout(onClick, 16000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="startup-anim" onClick={onClick}>
      <div className="startup-logo">
        {TRAIN_BODY_LINES.map((l, i) => <div key={i}>{renderTrainRow(l, 110)}</div>)}
        <div>{trainWheelFrame(frame)}</div>
      </div>
    </div>
  );
}

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

/** Stratified, not pure-uniform, random layout — pure `rand()` for
 *  every cloud independently is exactly what produced the actual bug
 *  reported (clouds landing on top of each other and drifting in
 *  near-lockstep): with only a handful of clouds in a small area,
 *  independent uniform randomness clumps by chance far more often
 *  than it spreads out. Instead: divide the available width into
 *  `count` equal bands and place one cloud per band (with jitter
 *  inside its own band) — this GUARANTEES minimum horizontal spacing
 *  rather than hoping for it. Same idea for timing: divide the drift
 *  cycle into `count` equal phase offsets so clouds are mechanically
 *  spread across different points of their drift instead of
 *  independently-random delays coincidentally landing close together. */
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

/** Same stratified-spacing idea as layoutClouds — bands guarantee
 *  minimum spacing instead of hoping independent randomness spreads
 *  out on its own (see layoutClouds's doc comment for why that
 *  matters; it was a real, reported bug there before this fix). */
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

  // Randomized once per mount (empty deps), not on every 30s clock
  // tick — a cloud silently teleporting to a new random spot every
  // half-minute would look broken, not natural. Uses nearly the FULL
  // widget width (not just a half reserved for the sun) — a cloud
  // passing near the sun during its drift is a brief, decorative
  // moment, not a real collision; leaving half the space empty was
  // itself part of why the remaining clouds looked cramped together.
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

// ── Persistent command line — defined OUTSIDE Home so it never remounts ──
const HomeCmdLine = React.memo(function HomeCmdLine({
  value, onChange, onKeyDown, inputRef,
}: {
  value: string;
  onChange: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  inputRef: React.RefObject<HTMLInputElement>;
}) {
  return (
    <div className="oxis-cmdline">
      <span className="oxis-cmdline-label">Shell </span>
      <span className="oxis-cmdline-mode">&lt;command-mode&gt; </span>
      <input
        ref={inputRef}
        className="oxis-cmdline-input"
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Type Here or Ctrl+I"
        spellCheck={false}
        autoComplete="off"
      />
    </div>
  );
});

function Home({ onNew, currentTheme, onTheme, onOpenThemeEditor, onOpenPluginCreator, onCommand }: {
  onNew: () => void; currentTheme: string; onTheme: (n: string) => void;
  onOpenThemeEditor: (n: string) => void; onOpenPluginCreator: () => void; onCommand: (cmd: string) => void;
}) {
  const [input, setInput] = useState("");
  const [view, setView] = useState<"home" | "themes" | "plugins">("home");
  const [plugins, setPlugins] = useState(() => pluginManager.all());
  const [psearch, setPsearch] = useState("");
  const [ws, setWs] = useState(() => workspaceState.get());
  const [activeWorkspace, setActiveWorkspace] = useState<string | null>(() => workspaceManager.getActiveNamed());
  const [activeWorkspacePath, setActiveWorkspacePath] = useState<string | null>(null);
  // 'hide workspace / 'show workspace — see the command handlers
  // (search this file for "hideHandler"/"showHandler"). Persisted via
  // the same option store 'config/oxis.getOption use, under its own
  // key rather than a formal SETTINGS entry, since this is a small,
  // dedicated toggle rather than a general setting.
  const [workspacePanelHidden, setWorkspacePanelHidden] = useState(() => !!readPersistedOption("ui.hideWorkspacePanel"));
  useEffect(() => events.on("ui_workspace_panel_visibility_changed", (p) => {
    setWorkspacePanelHidden(!!(p as { hidden?: boolean } | undefined)?.hidden);
  }), []);
  const inputRef = useRef<HTMLInputElement>(null);

  // Home is always mounted (see root App — it's hidden, not unmounted,
  // when the shell is active), so 'support (and anything else that
  // wants to jump straight to one of Home's internal panels) reaches
  // it via this event instead of a prop, regardless of whether Home
  // happens to be the visible view right now.
  useEffect(() => events.on("home_view_request", (p) => {
    const v = (p as { view?: string })?.view;
    if (v === "home" || v === "themes" || v === "plugins") setView(v);
  }), []);

  useEffect(() => workspaceState.subscribe(setWs), []);
  // workspaceState's own projectName is derived from whatever path
  // .oxis/workspace.lua loaded from — correct for a NAMED workspace
  // (switchNamed loads "workspaces/<name>", so the last path segment
  // IS the name) but not distinguishable there from an ad-hoc
  // directory-based workspace with no name at all. Track the
  // authoritative named-workspace state directly instead, so the
  // "workspace" row below is always right regardless of that.
  useEffect(() => {
    const update = () => {
      const name = workspaceManager.getActiveNamed();
      setActiveWorkspace(name);
      if (!name) { setActiveWorkspacePath(null); return; }
      // The external link (see 'workspace link) is per-entry in the
      // named-workspace registry, not something workspace_loaded's
      // payload carries — look it up explicitly so the Home card can
      // show it (see item 5: "Connected: <path>" on the card).
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

  // Keep focus on the input — retried twice (40ms, then 250ms) since
  // a single attempt could lose a race with something else mounting
  // right after view changes (the banner animation, a panel
  // re-rendering) that steals it back. Skips stealing focus from
  // another REAL input the user is actively using (e.g. the plugin
  // search box) rather than unconditionally grabbing it every time.
  useEffect(() => {
    const focusIfIdle = () => {
      const active = document.activeElement;
      if (active && active !== document.body && active !== inputRef.current
          && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
      inputRef.current?.focus();
    };
    const t1 = setTimeout(focusIfIdle, 40);
    const t2 = setTimeout(focusIfIdle, 250);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [view]);

  // Ctrl+I — jumps to the command line from anywhere on Home,
  // regardless of whether the auto-focus above happened to stick.
  // Shown right in the input's own placeholder ("Type Here or
  // Ctrl+I") so it's discoverable without needing to already know it.
  // Guarded by offsetParent (null when display:none) rather than a
  // visibility prop — Home is always mounted, just hidden via CSS
  // when the shell is active (see the root component), so without
  // this check Ctrl+I would leak into the terminal too, where it's
  // the literal byte for Tab and would break tab-completion there.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "i") {
        if (inputRef.current?.offsetParent === null) return; // Home isn't the visible screen right now
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const refresh = () => setPlugins(pluginManager.all());
  useEffect(() => { if (view === "plugins") refresh(); }, [view]);

  // Keep the plugin count/list live instead of a one-time snapshot —
  // useState(() => pluginManager.all()) above only ever reflects
  // whatever was registered at the exact instant Home first rendered,
  // which is BEFORE initPlugins()'s effect in the root App component
  // has run at all (state initializers run during render; plugin
  // registration happens in an effect, which fires after). That's why
  // the workspace panel always showed "0 plugins" — every plugin,
  // built-in or market-installed, finishes registering strictly after
  // this snapshot was taken, and nothing ever told this component to
  // look again unless the user happened to open the Plugins tab (see
  // the effect above). plugin_loaded/plugin_unloaded (emitted by
  // pluginManager.load()/unload() — see pluginManager.ts) fire for
  // every one of those registrations, on startup and later, so
  // subscribing here keeps this accurate everywhere it's shown, not
  // just inside the Plugins tab.
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

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") { setInput(""); return; }
    if (e.key === "Enter") {
      const cmd = input.trim();
      setInput("");
      if (!cmd) { onNew(); return; }
      onCommand(cmd);
    }
  }, [input, onNew, onCommand]);

  const handleChange = useCallback((v: string) => {
    setInput(v);
    if (v === "t") { setView("themes"); setInput(""); }
    if (v === "p") { setView("plugins"); setInput(""); }
    if (v === "n") { setInput(""); onNew(); }
  }, [onNew]);

  if (view === "themes") return (
    <div className="home" onMouseDown={e => { if (e.target === e.currentTarget) inputRef.current?.focus(); }}>
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
          <div style={{ marginTop: 12 }}>
            <HomeCmdLine value={input} onChange={handleChange} onKeyDown={handleKeyDown} inputRef={inputRef} />
          </div>
        </div>
      </div>
    </div>
  );

  if (view === "plugins") return (
    <div className="home" onMouseDown={e => { if (e.target === e.currentTarget) inputRef.current?.focus(); }}>
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
          <div style={{ marginTop: 10 }}>
            <HomeCmdLine value={input} onChange={handleChange} onKeyDown={handleKeyDown} inputRef={inputRef} />
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="home" onMouseDown={e => { if (e.target === e.currentTarget) inputRef.current?.focus(); }}>
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
          <button className="oxis-gitlab-btn" onClick={() => void openUrl("https://gitlab.com/oxidelab/oxis.git")}
            title="Open the OXIS repository on GitLab">GitLab ↗</button>
        </div>
        {!workspacePanelHidden && <WorkspacePanel ws={ws} plugins={plugins} activeWorkspace={activeWorkspace} activeWorkspacePath={activeWorkspacePath} />}
        <div className="oxis-box oxis-help-box">
          <div className="oxis-help-row"><span className="oht">Type</span> <span className="ohc">&apos;help</span><span className="ohr"> if you need some help</span></div>
          <div className="oxis-help-row"><span className="oht">Type</span> <span className="ohc">&apos;edit</span> <span className="oha">&lt;file&gt;</span><span className="ohr"> to open the built-in editor</span></div>
          <div className="oxis-help-row"><span className="oht">Type</span> <span className="ohc">&apos;market list</span><span className="ohr"> to browse plugins you can install</span></div>
          <div className="oxis-help-row"><span className="oht">Type</span> <span className="ohc">&apos;theme</span><span className="ohr"> to see and switch color themes</span></div>
          <div className="oxis-help-row"><span className="oht">Press</span> <span className="ohc">Ctrl+Shift+M</span><span className="ohr"> to open the OXIS Market website in your browser</span></div>
        </div>
        <HomeCmdLine value={input} onChange={handleChange} onKeyDown={handleKeyDown} inputRef={inputRef} />
      </div>
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
  /** The active NAMED workspace ('workspace switch <name>), or null
   *  for the shared default context — see workspaceManager.ts's
   *  getActiveNamed(). Distinct from ws.projectName (an ad-hoc
   *  directory's .oxis/workspace.lua can be loaded with no name at
   *  all) — shown as its own row so it's never ambiguous which one
   *  is active, especially once more than one named workspace exists. */
  activeWorkspace: string | null;
  /** The EXTERNAL project directory the active named workspace is
   *  linked to via 'workspace link (see workspaceManager.ts's
   *  externalPath) — null if it isn't linked to one. Distinct from
   *  ws.projectPath, which is where THIS workspace's own
   *  .oxis/workspace.lua lives (inside dist/workspaces/<name>/), not
   *  the external project it points at. */
  activeWorkspacePath: string | null;
}) {
  const active = plugins.filter(p => p.enabled);
  const tasks = workspaceState.taskNames();
  // Real git connection info — GitHub/GitLab + repo — replacing the
  // old "project" row (just ws.projectName, which duplicated the
  // "workspace" row above it in the common case and told you nothing
  // about whether the connected project is actually hooked up to a
  // remote anywhere). Fetched fresh whenever the connected external
  // path changes; genuinely queries `git remote -v` rather than
  // inferring anything from the workspace's own metadata, since a
  // project can be connected to OXIS without (yet) having a remote,
  // or could have one OXIS was never told about via
  // 'workspace github/gitlab.
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
// ROOT APP — inside the native Wails window (frameless), <Titlebar>
// draws the custom draggable titlebar + window controls. OXIS can
// also be opened directly in a plain browser at http://127.0.0.1:1420
// (see server.Listen in internal/server/server.go) — there's no
// native frameless window to control there, just an ordinary browser
// tab with its own chrome, so the custom titlebar has nothing to do
// and is skipped entirely (isNativeApp() — see native.ts).
// ══════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════
// COMMAND PALETTE — Ctrl+Shift+P. Searches the REAL command registry
// (registry.all()) — the exact same one dispatchOxisCmd looks up
// every typed '-command against, and the same one Tab completion
// reads from (see the terminal's onKey) — not a second, hand-curated
// action list that could list something that doesn't actually work.
// Selecting an entry opens the shell (if needed) and runs it through
// the same runLine() path Home's own buttons already use.
// ══════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════
// FILE TREE — Ctrl+B toggles it, or the ☰ button pinned over the
// editor. Browses from the app's own directory (".", same root
// created-documents/created-plugins/workspaces/plugins resolve
// against — see resolvePath in internal/wailsapp/app.go), via the
// generic listDir() native call — lazily: a folder's contents are
// only fetched the first time it's expanded, not the whole tree
// upfront. Clicking a file opens it in the Editor via openEditor(),
// the exact same call 'edit and 'plugin new use.
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

  // Reload from scratch whenever the root itself changes (connecting/
  // disconnecting an external project switches this — see item 2:
  // "when the workspace is disconnected, restore the normal OXIS
  // workspace file-tree behavior"), not just on first mount.
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

  // Auto-refresh after OXIS's own operations that change the
  // filesystem (newfile/newdir/git commit) — see item 2's "refresh
  // when files/directories are created, deleted, or changed". This
  // isn't a filesystem watcher (no such API here) — it's every place
  // OXIS itself writes into the connected project telling the tree to
  // re-check what it's already showing.
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
  const [showAnim, setShowAnim] = useState(true);
  const pendingHomeCmd = useRef<string>("");
  const shellMounted   = useRef(false); // shell only ever mounts once, then stays alive forever

  // activeProject used to be dead state — declared, passed to <StatusBar>,
  // but nothing ever called setActiveProject. workspaceState is the thing
  // that actually listens for oxis.workspace(path)/"workspace_loaded" (see
  // workspaceState.ts + the Home screen's Workspace panel).
  useEffect(() => workspaceState.subscribe((s) => setActiveProject(s.projectName)), []);

  // Init on mount — apply theme, init plugins immediately (before any terminal opens)
  useEffect(() => {
    themeManager.apply(curTheme);
    applyAllSettings(); // font size, cursor style/blink — persisted from last session, same as changing them live
    installGlobalErrorCapture(); // 'diagnostics — captures uncaught JS exceptions too, not just recordError() call sites
    void workspaceManager.runAutoUpdateIfNeeded(); // brings existing workspaces' folder layout up to date whenever OXIS itself has been updated since the last launch — see README § Workspace Auto-Update
    sessionManager.clear();
    const animT = setTimeout(() => setShowAnim(false), 1800);
    const checkUpdate = async () => {
      if (getSetting("updateCheckOnStartup") === false) return; // 'config set updateCheckOnStartup false
      // This used to be a SEPARATE, already-broken implementation —
      // a raw fetch() straight to GitLab's API with a literal
      // "YOUR_PROJECT_ID" placeholder that was never filled in,
      // silently doing nothing on every single launch (the catch
      // swallowed the resulting fetch failure). Replaced with the
      // real, working mechanism — the same commit-based check
      // 'update itself uses (see internal/update/update.go) — so
      // this setting actually does something now.
      try {
        const info = await checkForUpdate();
        if (info.available && info.latestCommit) setUpdateMsg(`build ${info.latestCommit.slice(0, 7)} available`);
      } catch { /* offline, or checkForUpdate itself isn't available (browser mode) — silent is correct here, this is a passive background check, not something the user asked for right now */ }
    };
    checkUpdate();

    // Init plugins at root level so they show up in Home before any shell opens
    if (!_pluginsInited) {
      _pluginsInited = true;
      const stubCtx: ShellCtx = {
        send:        () => {},
        runLine:     () => {},
        print:       (t, k) => console.log("[oxis]", t),
        clear:       () => {},
        openEditor:  () => {},
        newTerminal: () => {},
      };
      _ctxRef.current = stubCtx;
      initPlugins(forwardingApiCtx);
      workspaceManager.init(forwardingApiCtx);
      registerBuiltinCommands(stubCtx);
    }
    return () => clearTimeout(animT);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Event listeners
  // Note: plugins are edited through the exact same Editor as any
  // other file now (see findPluginForPath in the Terminal component's
  // editorSave) — there's no separate "open_plugin_creator" event or
  // component to listen for here anymore. 'plugin new writes the
  // template file, registers it live, then calls ctx.openEditor() on
  // it directly, the same path 'edit uses.
  useEffect(() => {
    const u1 = events.on("open_theme_editor", p => { if (p?.name) setThemeEditorName(String(p.name)); });
    const u2 = events.on("theme_changed",     p => { if (p?.name) setCurTheme(String(p.name)); });
    return () => { u1(); u2(); };
  }, []);

  // Persist minimal session state
  useEffect(() => {
    sessionManager.save({
      tabs:      [],
      activeTab: view,
      theme:     curTheme,
      savedAt:   Date.now(),
    });
  }, [view, curTheme]);

  // "go home" — wired to the 'home command via _goHomeRef
  const goHome = useCallback(() => setView("home"), []);
  useEffect(() => { _goHomeRef.current = goHome; }, [goHome]);

  // Open shell — either from home's typed command, or Ctrl+T
  const openShell = useCallback(() => {
    shellMounted.current = true;
    setView("shell");
  }, []);

  // Opens the shell (if needed) and runs a command line through it —
  // shared by Home's "+ new" button, its onCommand prop, and the
  // Command Palette, so there's exactly one "run this for the user"
  // path instead of three copies of the same ready/pendingHomeCmd
  // dance drifting apart from each other.
  const runHomeCommand = useCallback((cmd: string) => {
    if (ready) {
      openShell();
      setTimeout(() => _ctxRef.current?.runLine(cmd), 60);
    } else {
      pendingHomeCmd.current = cmd;
      openShell();
    }
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
      closeTab:      () => { if (view === "shell") setView("home"); },
      switchTab:     () => {},
      clearTerminal: () => events.emit("clear_terminal"),
      openMarket:    () => { void openUrl(market.MARKET_BASE); },
    });
    const handler = (e: KeyboardEvent) => keybinds.handle(e);
    window.addEventListener("keydown", handler, true);
    // Steals Ctrl+R/L/W/T/F/N away from the OS chrome and redirects
    // them to OXIS's own terminal shortcuts. That's the right thing to
    // do inside the native frameless window (there's no address bar,
    // no tab strip — none of those shortcuts have anywhere else useful
    // to go), but genuinely hostile in a plain browser tab (see
    // isNativeApp() in native.ts): trapping Ctrl+W so the user can't
    // close the tab, or Ctrl+R so they can't refresh, isn't something
    // OXIS should be doing to someone's ordinary browser session just
    // because they pointed it at http://127.0.0.1:1420.
    const blockBrowser = (e: KeyboardEvent) => {
      if (!isNativeApp()) return;
      if (!e.ctrlKey) return;
      const k = e.key.toLowerCase();
      if (["r","l","w","t","f","n"].includes(k)) {
        e.preventDefault(); e.stopPropagation();
        const ghost = document.querySelector(".term-ghost") as HTMLTextAreaElement | null;
        if (ghost) ghost.dispatchEvent(new KeyboardEvent("keydown", {
          key: e.key, ctrlKey: true, shiftKey: e.shiftKey, altKey: e.altKey, bubbles: true, cancelable: true,
        }));
      }
    };
    window.addEventListener("keydown", blockBrowser, true);
    return () => {
      window.removeEventListener("keydown", handler, true);
      window.removeEventListener("keydown", blockBrowser, true);
    };
  }, [openShell, view]);

  const isHome = view === "home";

  return (
    <div className={`app${isNativeApp() ? "" : " app--browser"}`}>
      {isNativeApp() && <Titlebar mode={isHome ? "home" : "shell"} />}
      {showAnim && <StartupSplash onClick={() => setShowAnim(false)} />}

      <div className="app-body">
        {/* Overlays — always on top */}
        {themeEditorName && (
          <div className="overlay">
            <ThemeEditor name={themeEditorName} onClose={() => setThemeEditorName(null)} />
          </div>
        )}
        {commandPaletteOpen && (
          <CommandPalette
            onRun={cmd => { setCommandPaletteOpen(false); runHomeCommand(cmd); }}
            onClose={() => setCommandPaletteOpen(false)}
          />
        )}
        {/* Home page — hidden (not unmounted) when shell active */}
        <div style={{ display: isHome ? "flex" : "none", flex: 1, minHeight: 0, overflow: "hidden" }}>
          <Home
            onNew={openShell}
            currentTheme={curTheme}
            onTheme={n => { themeManager.apply(n); setCurTheme(n); }}
            onOpenThemeEditor={n => setThemeEditorName(n)}
            // Routed through the shell's own "plugin new <name>" command
            // (same as typing it), which writes the file, registers it
            // live, and opens it in the exact same Editor 'edit uses —
            // not a separate overlay/component.
            onOpenPluginCreator={() => runHomeCommand("plugin new myplugin")}
            onCommand={runHomeCommand}
          />
        </div>

        {/* Single persistent shell session — mounts once, never unmounts */}
        {shellMounted.current && (
          <div className="app-pane" style={{ display: !isHome ? "flex" : "none" }}>
            <Terminal
              id="main"
              isActive={!isHome}
              onReady={() => {
                setReady(true);
                const cmd = pendingHomeCmd.current;
                if (cmd) { pendingHomeCmd.current = ""; setTimeout(() => _ctxRef.current?.runLine(cmd), 400); }
              }}
              onNewTab={openShell}
              onCloseTab={() => setView("home")}
              onSwitchTab={() => {}}
              
            />
          </div>
        )}
      </div>

      <StatusBar mode={isHome ? "home" : "shell"}
        count={0} idx={0}
        ready={ready} theme={curTheme}
        project={!isHome ? (activeProject || undefined) : undefined}
        updateMsg={updateMsg || undefined} />
    </div>
  );
}