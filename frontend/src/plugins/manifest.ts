/**
 * manifest.ts — plugin manifest parsing + semantic version comparison.
 *
 * A manifest is an OPTIONAL structured comment block at the top of a
 * plugin's Lua source:
 *
 *   --[[@manifest
 *   version: 1.0.0
 *   description: says hello
 *   author: jane
 *   category: dev
 *   min_oxis_version: 1.2.1
 *   os: windows, unix
 *   permissions: fs, net
 *   dependencies: git_advanced>=1.0.0, lsp_diag^1.2.0
 *   ]]
 *
 * It's parsed with a plain line-by-line reader BEFORE the source ever
 * reaches the Lua VM — permissions/compatibility have to be known
 * ahead of running any of the plugin's own code, and a manifest
 * expressed as an oxis.manifest(...) Lua call would run too late for
 * that (Lua runs top-to-bottom; nothing stops a plugin from calling
 * oxis.fs.* above its own oxis.manifest() call).
 *
 * A plugin with NO manifest block (every plugin shipped before this)
 * is treated as "legacy": no declared permission list at all, which
 * keeps it on the exact same permission behavior it already had
 * (prompt-on-first-use via permissions.ts, every namespace reachable)
 * rather than retroactively locking it out of something it always
 * could do. See permissions.ts's declaredPermissions for where that
 * distinction actually matters.
 */

import type { PermissionNamespace } from "./permissions";

/** Kept in sync with package.json's "version" — used for min_oxis_version
 *  compatibility checks (see checkCompatibility in pluginManager.ts).
 *  Not wired up to replace every other hardcoded "1.2.1" already in
 *  App.tsx (the version banner, update-check comparison) — this is
 *  specifically for the new compatibility-gate logic, not a version
 *  string refactor. */
export const OXIS_VERSION = "1.2.1";

// Kept in sync with PermissionNamespace's own type union by hand —
// this is what the manifest's `permissions:` field parser filters
// against (see below), and it SILENTLY DROPS anything not in this
// list, no error or warning to the plugin author. Found and fixed a
// real instance of this drifting out of sync: "shell" existed as a
// real, working permission namespace elsewhere in the codebase for a
// while before this list was updated to match, meaning a plugin
// manifest that declared `permissions: shell` would have had it
// silently vanish from the parsed result the whole time.
const ALL_NAMESPACES: PermissionNamespace[] = ["fs", "process", "net", "system", "workspace", "editor", "terminal", "shell"];

export interface PluginManifest {
  version?: string;
  description?: string;
  author?: string;
  category?: string;
  minOxisVersion?: string;
  /** Supported platforms — "windows" and/or "unix". Absent = both. */
  os?: string[];
  /** Declared permission namespaces. Presence of this field (even an
   *  empty list) is what switches a plugin from "legacy" (prompted,
   *  unrestricted) to "declared" (undeclared namespaces hard-denied)
   *  — see permissions.ts. */
  permissions?: PermissionNamespace[];
  /** name -> version range, e.g. { git_advanced: ">=1.0.0", lsp_diag: "^1.2.0" } */
  dependencies?: Record<string, string>;
}

const MANIFEST_RE = /--\[\[@manifest\s*([\s\S]*?)\]\]/;

/** Parses one manifest block out of a plugin's raw Lua source. Returns
 *  null if there isn't one (a legacy plugin, or one that just doesn't
 *  need to declare anything beyond what oxis.command()/oxis.task()
 *  already register). Malformed lines are skipped rather than
 *  rejecting the whole manifest — a typo in one field shouldn't brick
 *  every other declared field. */
export function parseManifest(source: string): PluginManifest | null {
  const m = MANIFEST_RE.exec(source);
  if (!m) return null;

  const manifest: PluginManifest = {};
  const lines = m[1].split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!value) continue;

    switch (key) {
      case "version": manifest.version = value; break;
      case "description": manifest.description = value; break;
      case "author": manifest.author = value; break;
      case "category": manifest.category = value; break;
      case "min_oxis_version": manifest.minOxisVersion = value; break;
      case "os":
        manifest.os = value.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
        break;
      case "permissions":
        manifest.permissions = value.split(",")
          .map(s => s.trim().toLowerCase())
          .filter((s): s is PermissionNamespace => (ALL_NAMESPACES as string[]).includes(s));
        break;
      case "dependencies": {
        const deps: Record<string, string> = {};
        for (const part of value.split(",")) {
          const dep = part.trim();
          if (!dep) continue;
          const rangeMatch = /^([A-Za-z0-9_-]+)\s*(>=|\^|=)?\s*(.*)$/.exec(dep);
          if (rangeMatch && rangeMatch[1]) {
            const [, depName, op, ver] = rangeMatch;
            deps[depName] = ver ? `${op || "="}${ver}` : "*";
          }
        }
        manifest.dependencies = deps;
        break;
      }
      default: break; // unknown field — ignore, don't fail the whole manifest over it
    }
  }
  return manifest;
}

// ── Semantic version comparison ──────────────────────────────────

/** Parses "1.2.3" (extra components/pre-release suffixes are ignored)
 *  into [major, minor, patch]. Returns null if it doesn't look like a
 *  version at all, so callers can skip comparisons they can't
 *  honestly make rather than guessing. */
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** -1 if a<b, 0 if equal, 1 if a>b. Throws if either isn't parseable —
 *  callers that might have unparseable input should check
 *  parseVersion() first, same as the range-checking functions below do. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`not a valid version: "${!pa ? a : b}"`);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** `version` satisfies `min` (i.e. version >= min). Unparseable input
 *  on either side fails closed (false) rather than throwing, since
 *  this is meant for a yes/no compatibility gate, not a place to
 *  crash plugin loading over a malformed manifest field. */
export function satisfiesMin(version: string, min: string): boolean {
  try { return compareVersions(version, min) >= 0; } catch { return false; }
}

/** `version` satisfies a dependency range: ">=1.0.0", "^1.2.0", or a
 *  bare "1.0.0" (exact match). "*" (or empty) always matches — used
 *  for a dependency with no declared version to check against. */
export function satisfiesRange(version: string, range: string): boolean {
  if (!range || range === "*") return true;
  const pv = parseVersion(version);
  if (!pv) return false;

  if (range.startsWith(">=")) {
    const pr = parseVersion(range.slice(2));
    return pr ? compareVersions(version, range.slice(2)) >= 0 : false;
  }
  if (range.startsWith("^")) {
    const pr = parseVersion(range.slice(1));
    if (!pr) return false;
    // Same major, >= minor.patch — the usual "^" meaning.
    if (pv[0] !== pr[0]) return false;
    return compareVersions(version, range.slice(1)) >= 0;
  }
  // Bare version — exact match.
  const pr = parseVersion(range);
  return pr ? compareVersions(version, range) === 0 : false;
}