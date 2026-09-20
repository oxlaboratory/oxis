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

export type PermissionNamespace = "fs" | "process" | "net" | "system" | "workspace" | "editor" | "terminal" | "shell";

const STORAGE_KEY = "oxis-plugin-permissions-v1";
// Denials aren't persisted (a user might change their mind), but are
// cached for the session so one "no" doesn't turn into a confirm()
// dialog on every single subsequent call in a loop.
const deniedThisSession = new Set<string>();

// ── Declared permissions (from a plugin's manifest — see manifest.ts) ──
// null = "legacy" plugin with no manifest at all: every namespace stays
// reachable via the original prompt-on-first-use flow below, exactly
// as it worked before manifests existed — nothing already shipped
// loses access it used to have.
// A Set (even empty) = this plugin HAS a manifest with a declared
// `permissions:` list: any namespace NOT in that list is hard-denied,
// with no prompt at all — this is the "don't silently grant anything
// undeclared" behavior, opt-in per-plugin via writing a manifest.
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
 * The actual gate: true if already granted; otherwise prompts once
 * (native `confirm()` — this is a desktop app, not a web page fighting
 * a popup blocker) and caches either answer for the rest of this
 * session so a plugin looping over oxis.fs.* calls doesn't spam
 * dialogs. Returns false without prompting again if the user already
 * said no this session.
 */
export function requestPermission(plugin: string, ns: PermissionNamespace): boolean {
  const declaredSet = declared.get(plugin);
  if (declaredSet && !declaredSet.has(ns)) {
    // This plugin HAS a manifest, and it didn't ask for this
    // namespace — hard deny, no prompt. A confirm() dialog here would
    // imply the user could grant something the plugin never even
    // claimed to need, which is exactly the "silently grant undeclared
    // access" behavior manifests exist to prevent.
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
 * Thrown by pluginAPI.ts when a gated call is denied, instead of a
 * generic Error — lets the catch handler around oxis.command()/
 * oxis.task() invocations (see pluginManager.ts's formatPluginError)
 * print the structured "Permission denied" block instead of a raw
 * message, with the right explanation for WHY it was denied.
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
 * A SEPARATE, deliberately more lenient gate for oxis.run() (shell
 * execution) specifically — see requireShellPermission below for why
 * this can't just be requirePermission(plugin, "shell").
 *
 * requestPermission()'s declared-permissions check HARD-DENIES a
 * namespace the moment a plugin has ANY manifest that doesn't list
 * it — correct for fs/process/net/system, where a plugin author
 * explicitly opted into that stricter model by writing a manifest at
 * all. But "shell" didn't exist as a concept when every already-
 * published plugin's manifest was written (oxis.run() had no gate at
 * all until this) — applying the same hard-deny rule to it would
 * instantly and silently break every existing plugin that calls
 * oxis.run(), which per pluginAPI.ts's own doc comment is "nearly
 * every builtin/market plugin". That's a worse outcome than the gap
 * being closed. Instead: EVERY plugin (manifested or not, whatever
 * it does or doesn't declare) gets the same fair one-time prompt —
 * never a silent, automatic denial based on an old manifest that
 * predates this permission existing.
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

/** Throws PluginPermissionError if shell access isn't granted to
 *  `plugin`. `isTrusted` (builtin plugins, and OXIS's own workspace/
 *  task/workflow loading — see pluginAPI.ts's APIContext) skips this
 *  entirely: those aren't third-party code a user needs to be asked
 *  about, any more than OXIS's own core TypeScript would be. */
export function requireShellPermission(plugin: string, isTrusted: boolean): void {
  if (isTrusted) return;
  if (!requestShellPermission(plugin)) throw new PluginPermissionError(plugin, "shell");
}