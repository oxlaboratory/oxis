/**
 * buildInfo.ts — what this build of OXIS is: version, commit, nearest
 * release tag, build number and dates.
 *
 * vite.config.ts bakes the stamp in from scripts/buildstamp.js, the
 * same values the Go binary is stamped with (internal/buildinfo), so
 * 'version works in browser mode too.
 */

export interface BuildStamp {
  /** package.json version, e.g. "1.2.1". */
  version: string;
  /** Full SHA of the commit built; "" when built outside git. */
  commit: string;
  /** Nearest v* tag, e.g. "v1.2.1"; "" when there is none. */
  tag: string;
  commitsSinceTag: number;
  /** Commits on the built branch; 0 when unknown (shallow clone). */
  buildNumber: number;
  /** Tracked files had uncommitted changes. */
  dirty: boolean;
  commitDate: string;
  buildDate: string;
  /** "latest-build" (CI on main), "pr" (CI on a pull request),
   *  "self-update" ('update install), "source" (built from a checkout)
   *  or "dev" (vite dev server). */
  channel: string;
}

declare const __OXIS_BUILD__: BuildStamp | undefined;

export const BUILD: BuildStamp = typeof __OXIS_BUILD__ !== "undefined" ? __OXIS_BUILD__ : {
  version: "0.0.0-dev", commit: "", tag: "", commitsSinceTag: 0, buildNumber: 0,
  dirty: false, commitDate: "", buildDate: "", channel: "dev",
};

export const OXIS_VERSION = BUILD.version;

export const shortCommit = (sha = BUILD.commit): string => sha.slice(0, 7);

/** SemVer with build metadata, e.g. "1.2.1+50.388c9e0" or
 *  "1.2.1+50.388c9e0.dirty". */
export function fullVersion(b: BuildStamp = BUILD): string {
  const meta = [b.buildNumber ? String(b.buildNumber) : "", shortCommit(b.commit), b.dirty ? "dirty" : ""].filter(Boolean);
  return meta.length ? `${b.version}+${meta.join(".")}` : b.version;
}

/** git-describe style: "v1.2.1", "v1.2.1-14-g388c9e0" or, with no tag,
 *  just the short commit. */
export function describe(b: BuildStamp = BUILD): string {
  if (!b.commit) return "";
  if (!b.tag) return `g${shortCommit(b.commit)}${b.dirty ? "-dirty" : ""}`;
  const base = b.commitsSinceTag ? `${b.tag}-${b.commitsSinceTag}-g${shortCommit(b.commit)}` : b.tag;
  return b.dirty ? `${base}-dirty` : base;
}

const CHANNELS: Record<string, string> = {
  "latest-build": "latest-build · prebuilt by CI from main",
  "pr": "pr · CI build of a pull request",
  "self-update": "self-update · built from source by 'update install",
  "source": "source · built from a local checkout",
  "dev": "dev · Vite dev server",
};

export const channelLabel = (c = BUILD.channel): string => CHANNELS[c] ?? c;

/** "2026-09-27 09:14 UTC" plus "(3 days ago)" when recent enough. */
export function formatStampDate(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!iso || Number.isNaN(t)) return "";
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  const abs = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
  const mins = Math.round((now - t) / 60000);
  if (mins < 0) return abs;
  const days = Math.round(mins / 1440);
  const ago = mins < 1 ? "just now"
    : mins < 60 ? `${mins} min ago`
    : mins < 60 * 24 ? `${Math.round(mins / 60)} h ago`
    : days === 1 ? "yesterday"
    : days < 60 ? `${days} days ago`
    : "";
  return ago ? `${abs} (${ago})` : abs;
}
