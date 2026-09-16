/**
 * permissions.ts — per-plugin permission grants for the Core System
 * APIs (oxis.fs/process/net/system — see README § Core System APIs).
 *
 * A plugin can't reach any of these until its permission for that
 * namespace has been granted. Grants persist in localStorage (so a
 * user isn't re-prompted every reload) and are keyed by plugin name +
 * namespace, so granting "fs" to one plugin doesn't grant it to
 * another. This intentionally does NOT attempt sandboxing at the Lua
 * VM level (every plugin still runs in the same fengari interpreter
 * process, same as before) — it's a permission *gate* in front of the
 * JS-side implementations of fs/process/net/system, which is the
 * actual security boundary that matters here: a plugin without the
 * "process" grant simply never reaches ListProcesses/KillProcess at
 * all, regardless of what its Lua source tries to call.
 */

export type PermissionNamespace = "fs" | "process" | "net" | "system";

const STORAGE_KEY = "oxis-plugin-permissions-v1";
// Denials aren't persisted (a user might change their mind), but are
// cached for the session so one "no" doesn't turn into a confirm()
// dialog on every single subsequent call in a loop.
const deniedThisSession = new Set<string>();

function readAll(): Record<string, PermissionNamespace[]> {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); }
  catch { return {}; }
}

function writeAll(all: Record<string, PermissionNamespace[]>): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(all)); }
  catch { /* storage unavailable — grants just won't survive a restart */ }
}

export function isGranted(plugin: string, ns: PermissionNamespace): boolean {
  return (readAll()[plugin] || []).includes(ns);
}

export function grant(plugin: string, ns: PermissionNamespace): void {
  const all = readAll();
  const cur = new Set(all[plugin] || []);
  cur.add(ns);
  all[plugin] = [...cur];
  writeAll(all);
  deniedThisSession.delete(`${plugin}::${ns}`);
}

export function revoke(plugin: string, ns: PermissionNamespace): void {
  const all = readAll();
  all[plugin] = (all[plugin] || []).filter((x) => x !== ns);
  writeAll(all);
}

/** All namespaces currently granted to a plugin — used by `'plugin permissions <name>`. */
export function grantedTo(plugin: string): PermissionNamespace[] {
  return readAll()[plugin] || [];
}

/**
 * The actual gate: true if already granted; otherwise prompts once
 * (native `confirm()` — this is a desktop app, not a web page fighting
 * a popup blocker) and caches either answer for the rest of this
 * session so a plugin looping over oxis.fs.* calls doesn't spam
 * dialogs. Returns false without prompting again if the user already
 * said no this session.
 */
export function requestPermission(plugin: string, ns: PermissionNamespace): boolean {
  if (isGranted(plugin, ns)) return true;
  const key = `${plugin}::${ns}`;
  if (deniedThisSession.has(key)) return false;
  const label: Record<PermissionNamespace, string> = {
    fs: "read/write files on your computer",
    process: "list and stop running processes",
    net: "make network requests",
    system: "read system information (OS, CPU, memory)",
  };
  const ok = typeof confirm === "function"
    ? confirm(`Plugin "${plugin}" wants to ${label[ns]}.\n\nAllow this permission? You can change it later with 'plugin permissions ${plugin}.`)
    : false;
  if (ok) grant(plugin, ns);
  else deniedThisSession.add(key);
  return ok;
}
