/**
 * backup.ts — 'backup / 'restore, 'config export / import,
 * 'workspace export / import, 'plugin export.
 *
 * Files are plain JSON: a map of relative path → text content.
 *
 * Included: settings ("setting.*" options), each workspace's files, and
 * for a full backup also created-documents/, created-plugins/ and the
 * workspace registry. Not included: Market plugins (reinstallable) and
 * installer build output.
 *
 * The command handlers in App.tsx confirm with the user before
 * restoring.
 */

import { readFile, writeFile, listDir, isNativeApp } from "../native";
import { workspaceManager, type NamedWorkspaceEntry } from "../terminal/workspaceManager";

const SETTING_PREFIX = "setting.";
const OPTIONS_STORAGE_KEY = "oxis-plugin-options-v1"; // must match OPTIONS_KEY in App.tsx

function readRawOptions(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(OPTIONS_STORAGE_KEY);
    return raw ? JSON.parse(raw) as Record<string, unknown> : {};
  } catch { return {}; }
}

function writeRawOptions(all: Record<string, unknown>): void {
  try { localStorage.setItem(OPTIONS_STORAGE_KEY, JSON.stringify(all)); } catch { /* storage full/unavailable */ }
}

export interface SettingsExport { settings: Record<string, unknown> }

export function exportSettings(): SettingsExport {
  const all = readRawOptions();
  const settings: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(all)) if (k.startsWith(SETTING_PREFIX)) settings[k] = v;
  return { settings };
}

export function importSettings(data: SettingsExport): { count: number } {
  const all = readRawOptions();
  let count = 0;
  for (const [k, v] of Object.entries(data.settings || {})) {
    if (!k.startsWith(SETTING_PREFIX)) continue; // refuse anything that isn't actually a setting key — an import shouldn't be a way to inject arbitrary option data
    all[k] = v;
    count++;
  }
  writeRawOptions(all);
  return { count };
}

async function readDirRecursive(basePath: string, relPath = ""): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const full = relPath ? `${basePath}/${relPath}` : basePath;
  let entries;
  try { entries = await listDir(full); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".oxis") continue; // skip dotfiles, but .oxis/workspace.lua matters
    const rel = relPath ? `${relPath}/${e.name}` : e.name;
    if (e.isDir) {
      Object.assign(out, await readDirRecursive(basePath, rel));
    } else {
      try { out[rel] = await readFile(`${basePath}/${rel}`); }
      catch { /* unreadable/binary — skip rather than fail the whole export */ }
    }
  }
  return out;
}

/** A path from a backup or export file, or null unless it stays inside
 *  the folder it's restored into: relative, no "..", no drive letter or
 *  ":" (Windows streams), no NUL. A crafted file could otherwise write
 *  anywhere, e.g. "../../AppData/.../Startup/x.bat". */
export function safeRelPath(rel: string): string | null {
  const parts = rel.replace(/\\/g, "/").split("/").filter(s => s !== "" && s !== ".");
  if (parts.length === 0 || /^[\\/]/.test(rel)) return null;
  if (parts.some(s => s === ".." || s.includes(":") || s.includes("\0"))) return null;
  return parts.join("/");
}

interface WriteResult { written: number; refused: number }

async function writeFilesFromMap(basePath: string, files: Record<string, string>): Promise<WriteResult> {
  const result: WriteResult = { written: 0, refused: 0 };
  for (const [rel, content] of Object.entries(files)) {
    const safe = typeof content === "string" ? safeRelPath(rel) : null;
    if (!safe) { result.refused++; continue; }
    try { await writeFile(`${basePath}/${safe}`, content); result.written++; }
    catch { /* one bad path shouldn't abort the whole restore */ }
  }
  return result;
}

const refusedNote = (n: number) => n ? ` — refused ${n} file(s) with unsafe paths` : "";

export interface WorkspaceExport {
  name: string;
  entry: NamedWorkspaceEntry;
  files: Record<string, string>; // path relative to workspaces/<name>/ -> content
}

/** `'workspace export <name>`. */
export async function exportWorkspace(name: string): Promise<WorkspaceExport | null> {
  const list = await workspaceManager.listNamed();
  const entry = list.find(w => w.name === name);
  if (!entry) return null;
  const files = await readDirRecursive(`workspaces/${name}`);
  return { name, entry, files };
}

/** `'workspace import <path> [newName]` — creates a NEW named
 *  workspace (never overwrites an existing one silently; refuses if
 *  the target name is already taken, same as 'workspace init does). */
export async function importWorkspace(data: WorkspaceExport, targetName?: string): Promise<{ ok: boolean; message: string }> {
  const name = targetName || data.name;
  const created = await workspaceManager.createNamed(name);
  if (!created.ok) return created;
  const { written, refused } = await writeFilesFromMap(`workspaces/${name}`, data.files || {});
  // An external project path is never re-linked automatically: linking
  // only applies to the active workspace, so the user does it.
  const external = data.entry?.externalPath;
  return { ok: true, message: `workspace "${name}" imported (${written} file(s))${refusedNote(refused)}${external ? ` — re-link its external path with: 'workspace link "${external}"` : ""}` };
}

/** `'plugin export <name> <path>` — just the plugin's own .lua
 *  source, not a bundle — for sharing one plugin file, or backing it
 *  up outside OXIS entirely. */
export async function exportPluginSource(name: string): Promise<string | null> {
  const { pluginManager } = await import("./pluginManager");
  const p = pluginManager.get(name);
  if (!p?.lua) return null;
  return p.lua;
}

export interface FullBackup {
  createdAt: string;
  oxisVersion: string;
  settings: Record<string, unknown>;
  workspaceRegistry: NamedWorkspaceEntry[];
  workspaces: Record<string, Record<string, string>>; // workspace name -> its files
  createdDocuments: Record<string, string>;
  createdPlugins: Record<string, string>;
}

/** `'backup <path>` — everything real, user-created data: settings,
 *  every named workspace's actual files, created-documents/,
 *  created-plugins/. Explicitly NOT Market-installed plugins
 *  (re-fetchable with 'market install) or installer build output. */
export async function createFullBackup(): Promise<FullBackup> {
  const registry = await workspaceManager.listNamed();
  const workspaces: Record<string, Record<string, string>> = {};
  for (const w of registry) workspaces[w.name] = await readDirRecursive(`workspaces/${w.name}`);
  return {
    createdAt: new Date().toISOString(),
    oxisVersion: "1.2.1",
    settings: exportSettings().settings,
    workspaceRegistry: registry,
    workspaces,
    createdDocuments: await readDirRecursive("created-documents"),
    createdPlugins: await readDirRecursive("created-plugins"),
  };
}

/** `'restore <path>` (the caller confirms first). Only writes files the
 *  backup contains; nothing else is deleted. */
export async function restoreFullBackup(data: FullBackup): Promise<{ ok: boolean; message: string }> {
  if (!isNativeApp()) return { ok: false, message: "restore needs the desktop app (no filesystem access in browser mode)" };
  const workspaceResults: string[] = [];

  const settingsCount = importSettings({ settings: data.settings }).count;
  const docs = await writeFilesFromMap("created-documents", data.createdDocuments || {});
  const plugins = await writeFilesFromMap("created-plugins", data.createdPlugins || {});

  for (const entry of data.workspaceRegistry || []) {
    const existing = (await workspaceManager.listNamed()).find(w => w.name === entry.name);
    if (!existing) {
      const created = await workspaceManager.createNamed(entry.name);
      if (!created.ok) { workspaceResults.push(`${entry.name}: skipped (${created.message})`); continue; }
    }
    const { written, refused } = await writeFilesFromMap(`workspaces/${entry.name}`, data.workspaces?.[entry.name] || {});
    workspaceResults.push(`${entry.name}: ${written} file(s)${existing ? " (merged into existing workspace)" : ""}${refusedNote(refused)}`);
  }

  return {
    ok: true,
    message: [
      `restored ${settingsCount} setting(s), ${docs.written} document(s), ${plugins.written} created-plugin file(s)${refusedNote(docs.refused + plugins.refused)}`,
      ...workspaceResults.map(r => `  workspace ${r}`),
    ].join("\n"),
  };
}