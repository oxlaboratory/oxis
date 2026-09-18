/**
 * marketUpdate.ts — 'market update <name> / 'market update all /
 * 'plugin rollback <name>.
 *
 * Backup-before-replace, automatic rollback on failure: before an
 * update touches anything, the CURRENTLY WORKING version's source is
 * saved (one backup per plugin, overwritten by the next update — this
 * is "undo the last update", not a full version history). If the new
 * version fails to load, this automatically restores that backup
 * rather than leaving a half-installed, broken plugin registered.
 * `'plugin rollback <name>` does the same thing manually, any time
 * after an update (not just right after a failed one).
 *
 * Compatibility and dependencies are checked against the NEW
 * version's manifest — parsed from its downloaded source — BEFORE
 * anything is replaced, same checks pluginManager.load() itself does
 * for a fresh install, just run one step earlier here so a doomed
 * update never even gets as far as touching the installed plugin.
 */

import { pluginManager } from "./pluginManager";
import { findEntry, fetchPluginSource, type MarketEntry } from "./market";
import { parseManifest, compareVersions, satisfiesMin, OXIS_VERSION } from "./manifest";
import { isWindows } from "../terminal/terminal";

const BACKUP_PREFIX = "oxis-plugin-backup:";

interface Backup { version?: string; lua: string }

function backupKey(name: string): string {
  return `${BACKUP_PREFIX}${name}`;
}

function saveBackup(name: string, version: string | undefined, lua: string): void {
  try { localStorage.setItem(backupKey(name), JSON.stringify({ version, lua } satisfies Backup)); }
  catch { /* storage full/unavailable — update still proceeds, just without a safety net */ }
}

function loadBackup(name: string): Backup | null {
  try {
    const raw = localStorage.getItem(backupKey(name));
    return raw ? JSON.parse(raw) as Backup : null;
  } catch { return null; }
}

export interface UpdateResult { ok: boolean; message: string }

/** Checks the NEW version's manifest (parsed from source that hasn't
 *  been installed yet) for compatibility/dependency problems — the
 *  same checks pluginManager.load() does for any plugin, run here
 *  first so a doomed update is refused before it replaces anything. */
function precheckNewVersion(source: string): { ok: true } | { ok: false; error: string } {
  const manifest = parseManifest(source);
  if (!manifest) return { ok: true }; // no manifest — nothing declared to check
  if (manifest.minOxisVersion && !satisfiesMin(OXIS_VERSION, manifest.minOxisVersion)) {
    return { ok: false, error: `requires OXIS >= ${manifest.minOxisVersion} (running ${OXIS_VERSION})` };
  }
  if (manifest.os && manifest.os.length > 0) {
    const current = isWindows() ? "windows" : "unix";
    if (!manifest.os.includes(current)) {
      return { ok: false, error: `not supported on this OS — needs ${manifest.os.join(", ")}` };
    }
  }
  if (manifest.dependencies) {
    for (const [dep, range] of Object.entries(manifest.dependencies)) {
      if (!pluginManager.get(dep)) {
        return { ok: false, error: `missing dependency: ${dep}${range !== "*" ? " " + range : ""} — install it first` };
      }
    }
  }
  return { ok: true };
}

/** `'market update <name>`. */
export async function updatePlugin(name: string): Promise<UpdateResult> {
  const p = pluginManager.get(name);
  if (!p) return { ok: false, message: `not installed: ${name}` };
  if (p.builtin) return { ok: false, message: `${name} is built-in — nothing to update` };
  if (p.origin !== "market") {
    return { ok: false, message: `${name} isn't a Market-installed plugin (${p.origin === "user" ? "it's one of yours" : "unknown origin"}) — 'market update only applies to plugins installed via 'market install` };
  }

  let entry: MarketEntry | undefined;
  try { entry = await findEntry(name); }
  catch (e) { return { ok: false, message: `couldn't reach the Market: ${e instanceof Error ? e.message : String(e)}` }; }
  if (!entry) return { ok: false, message: `${name} is no longer listed on the Market — can't check for updates` };

  const installedVersion = p.version;
  if (installedVersion && entry.version) {
    let isNewer = true;
    try { isNewer = compareVersions(entry.version, installedVersion) > 0; }
    catch { /* unparseable version on either side — proceed as if an update might be available rather than getting stuck */ }
    if (!isNewer) return { ok: true, message: `${name} is already up to date (v${installedVersion})` };
  }

  let newSource: string;
  try { newSource = await fetchPluginSource(entry); }
  catch (e) { return { ok: false, message: `download failed: ${e instanceof Error ? e.message : String(e)}` }; }

  const precheck = precheckNewVersion(newSource);
  if (!precheck.ok) return { ok: false, message: `update refused: ${precheck.error}` };

  // Back up the CURRENTLY WORKING version before touching anything.
  saveBackup(name, installedVersion, p.lua ?? "");

  const { persisted, persistError } = await pluginManager.addLuaPlugin(name, newSource, entry.category || p.category, "market");
  const afterUpdate = pluginManager.get(name);
  if (!afterUpdate?.enabled) {
    // addLuaPlugin's own load() already disabled it on failure — the
    // backup we just saved is what makes this safe to undo automatically
    // instead of leaving a broken plugin registered.
    const restored = await rollbackPlugin(name);
    return { ok: false, message: `update failed to load — automatically rolled back. ${restored.message}` };
  }

  return {
    ok: true,
    message: `${name}: v${installedVersion || "?"} → v${entry.version || "?"}`
      + (persisted ? "" : ` (this session only — couldn't save to disk: ${persistError instanceof Error ? persistError.message : String(persistError ?? "unknown error")})`),
  };
}

/** `'market update all` — every Market-installed plugin with an
 *  available, compatible update; already-current ones are reported
 *  as such, not silently skipped. */
export async function updateAllPlugins(): Promise<UpdateResult[]> {
  const marketPlugins = pluginManager.all().filter(p => p.origin === "market");
  const results: UpdateResult[] = [];
  for (const p of marketPlugins) results.push(await updatePlugin(p.name));
  return results;
}

/** `'plugin rollback <name>` — restores the ONE backup taken by the
 *  last update (not a full version history). Works any time after an
 *  update, not just automatically right after a failed one. */
export async function rollbackPlugin(name: string): Promise<UpdateResult> {
  const backup = loadBackup(name);
  if (!backup) return { ok: false, message: `no backup available for ${name} — rollback only works after 'market update has run at least once` };
  const p = pluginManager.get(name);
  const { persisted, persistError } = await pluginManager.addLuaPlugin(name, backup.lua, p?.category || "market", "market");
  return {
    ok: true,
    message: `${name} rolled back to v${backup.version || "previous"}`
      + (persisted ? "" : ` (this session only — couldn't save to disk: ${persistError instanceof Error ? persistError.message : String(persistError ?? "unknown error")})`),
  };
}