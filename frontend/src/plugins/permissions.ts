/**
 * permissions.ts — per-plugin grants for the gated oxis.* namespaces.
 *
 * Grants are per plugin and namespace, and persist in localStorage.
 * This is a gate in front of the JS implementations (a plugin without
 * "process" never reaches ListProcesses/KillProcess); it isn't a Lua
 * sandbox.
 */

export type PermissionNamespace = "fs" | "process" | "net" | "system" | "workspace" | "editor" | "terminal" | "shell";

const STORAGE_KEY = "oxis-plugin-permissions-v1";
// Denials aren't persisted (a user might change their mind), but are
// cached for the session so one "no" doesn't turn into a confirm()
// dialog on every single subsequent call in a loop.
const deniedThisSession = new Set<string>();

// ── Declared permissions (from the manifest) ──
// null: legacy plugin without a manifest — any namespace, asked once.
// A Set (even empty): only these namespaces; anything else is denied
// without asking.
const declared = new Map<string, Set<PermissionNamespace> | null>();
// Why the last requestPermission() call for a given plugin+namespace
// failed — lets callers (pluginAPI.ts) throw a specific, actionable
// error instead of a generic "permission denied".
const lastDenialReason = new Map<string, "undeclared" | "declined">();

/** Called by pluginManager when a plugin is (re)registered, from its
 *  parsed manifest's `permissions` field (undefined if the plugin has
 *  no manifest at all — see manifest.ts's parseManifest). */
export function setDeclaredPermissions(plugin: string, list: PermissionNamespace[] | undefined): void {
  declared.set(plugin, list ? new Set(list) : null);
}

/** What a plugin's manifest actually declared, or null for a legacy
 *  plugin with no manifest — used by `'plugin info`/`'plugin validate`. */
export function declaredPermissionsOf(plugin: string): PermissionNamespace[] | null {
  const d = declared.get(plugin);
  return d ? [...d] : null;
}

export function denialReason(plugin: string, ns: PermissionNamespace): "undeclared" | "declined" | null {
  return lastDenialReason.get(`${plugin}::${ns}`) ?? null;
}

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
 * True if granted; otherwise asks once (confirm()) and remembers the
 * answer for the session so repeated calls don't keep prompting.
 */
export function requestPermission(plugin: string, ns: PermissionNamespace): boolean {
  const declaredSet = declared.get(plugin);
  if (declaredSet && !declaredSet.has(ns)) {
    // The manifest doesn't declare this namespace: deny, don't ask.
    lastDenialReason.set(`${plugin}::${ns}`, "undeclared");
    return false;
  }
  if (isGranted(plugin, ns)) return true;
  const key = `${plugin}::${ns}`;
  if (deniedThisSession.has(key)) { lastDenialReason.set(key, "declined"); return false; }
  const label: Record<PermissionNamespace, string> = {
    fs: "read/write files on your computer",
    process: "list and stop running processes",
    net: "make network requests",
    system: "read system information (OS, CPU, memory)",
    workspace: "switch/load OXIS workspaces",
    editor: "open files in the built-in editor",
    terminal: "open new terminal tabs",
    shell: "run arbitrary shell commands",
  };
  const ok = typeof confirm === "function"
    ? confirm(`Plugin "${plugin}" wants to ${label[ns]}.\n\nAllow this permission? You can change it later with 'plugin permissions ${plugin}.`)
    : false;
  if (ok) grant(plugin, ns);
  else { deniedThisSession.add(key); lastDenialReason.set(key, "declined"); }
  return ok;
}

/**
 * Thrown when a gated call is denied, so formatPluginError can print a
 * structured "Permission denied" explanation.
 */
export class PluginPermissionError extends Error {
  constructor(public plugin: string, public permission: PermissionNamespace) {
    const reason = denialReason(plugin, permission);
    const explanation = reason === "undeclared"
      ? `This plugin attempted to use "${permission}" but does not declare the "${permission}" permission in its manifest.`
      : `"${permission}" was not granted. Run 'plugin permissions ${plugin} grant ${permission} to allow it.`;
    super(`Permission denied: ${permission}\n\n${explanation}`);
    this.name = "PluginPermissionError";
  }
}

/** Throws PluginPermissionError if `ns` isn't available to `plugin`;
 *  otherwise returns normally. Use this instead of calling
 *  requestPermission() directly so the thrown error is always the
 *  structured kind pluginManager.ts's error formatter recognizes. */
export function requirePermission(plugin: string, ns: PermissionNamespace): void {
  if (!requestPermission(plugin, ns)) throw new PluginPermissionError(plugin, ns);
}

/**
 * The shell gate (oxis.run / oxis.task) always asks once, even for
 * plugins whose manifest doesn't list "shell": that permission is newer
 * than many published manifests, and hard-denying it would break them.
 */
export function requestShellPermission(plugin: string): boolean {
  if (isGranted(plugin, "shell")) return true;
  const key = `${plugin}::shell`;
  if (deniedThisSession.has(key)) { lastDenialReason.set(key, "declined"); return false; }
  const ok = typeof confirm === "function"
    ? confirm(`Plugin "${plugin}" wants to run shell commands.\n\nAllow this permission? You can change it later with 'plugin permissions ${plugin}.`)
    : false;
  if (ok) grant(plugin, "shell");
  else { deniedThisSession.add(key); lastDenialReason.set(key, "declined"); }
  return ok;
}

/** Throws PluginPermissionError unless `plugin` may use the shell.
 *  Trusted code (built-ins, the user's own workspace files) skips it. */
export function requireShellPermission(plugin: string, isTrusted: boolean): void {
  if (isTrusted) return;
  if (!requestShellPermission(plugin)) throw new PluginPermissionError(plugin, "shell");
}