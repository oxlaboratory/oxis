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

async function writeFilesFromMap(basePath: string, files: Record<string, string>): Promise<number> {
  let count = 0;
  for (const [rel, content] of Object.entries(files)) {
    try { await writeFile(`${basePath}/${rel}`, content); count++; }
    catch { /* one bad path shouldn't abort the whole restore */ }
  }
  return count;
}

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
  const count = await writeFilesFromMap(`workspaces/${name}`, data.files);
  if (data.entry.externalPath) {
    // createNamed() just made it — switch to it briefly is overkill;
    // write the link directly via the same mechanism 'workspace link uses.
    const list = await workspaceManager.listNamed();
    const entry = list.find(w => w.name === name);
    if (entry) { /* linkExternal only affects the ACTIVE workspace by design — see workspaceManager.ts; leave externalPath for the user to re-link with 'workspace switch + 'workspace link if they need it, rather than reaching around that on their behalf */ }
  }
  return { ok: true, message: `workspace "${name}" imported (${count} file(s))${data.entry.externalPath ? ` — re-link its external path manually: 'workspace link "${data.entry.externalPath}"` : ""}` };
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
  let settingsCount = 0, docCount = 0, pluginCount = 0;
  const workspaceResults: string[] = [];

  settingsCount = importSettings({ settings: data.settings }).count;
  docCount = await writeFilesFromMap("created-documents", data.createdDocuments || {});
  pluginCount = await writeFilesFromMap("created-plugins", data.createdPlugins || {});

  for (const entry of data.workspaceRegistry || []) {
    const existing = (await workspaceManager.listNamed()).find(w => w.name === entry.name);
    if (!existing) {
      const created = await workspaceManager.createNamed(entry.name);
      if (!created.ok) { workspaceResults.push(`${entry.name}: skipped (${created.message})`); continue; }
    }
    const count = await writeFilesFromMap(`workspaces/${entry.name}`, data.workspaces?.[entry.name] || {});
    workspaceResults.push(`${entry.name}: ${count} file(s)${existing ? " (merged into existing workspace)" : ""}`);
  }

  return {
    ok: true,
    message: [
      `restored ${settingsCount} setting(s), ${docCount} document(s), ${pluginCount} created-plugin file(s)`,
      ...workspaceResults.map(r => `  workspace ${r}`),
    ].join("\n"),
  };
}