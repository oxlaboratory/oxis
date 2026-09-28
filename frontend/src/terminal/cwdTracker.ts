/**
 * cwdTracker.ts — tracks the shell's working directory.
 *
 * After startup and after anything that looks like a `cd`, OXIS sends a
 * one-line probe that prints the cwd between invisible U+2063 markers.
 * consume() pulls the answer out of the raw output, and isProbeLine()
 * lets the terminal drop the echoed probe command, so neither is shown.
 * The cwd drives oxis.cwd() and automatic workspace detection.
 */

import { stripSgr } from "./ansi";
import { workspaceManager } from "./workspaceManager";
import { events } from "./events";

const MARK = "\u2063OXISCWD\u2063";
const PROBE_RE = new RegExp(MARK + "([^\\r\\n]*?)" + MARK, "g");

/** True for the shell's echo of a cwd probe command. */
export function isProbeLine(line: string): boolean {
  return line.includes("CWD\u2063");
}

// The command text splits the marker in two, so the shell's echo of the
// command never contains it whole; only the printed answer does.
const HALF_A = "\u2063OXIS", HALF_B = "CWD\u2063";

/** The exact line OXIS sends to the shell to ask for its cwd. */
export function buildCwdProbe(isWindows: boolean): string {
  return isWindows
    ? `Write-Host ("${HALF_A}" + "${HALF_B}" + $PWD.Path + "${HALF_A}" + "${HALF_B}")`
    : `printf '%s%s%s%s%s\\n' '${HALF_A}' '${HALF_B}' "$PWD" '${HALF_A}' '${HALF_B}'`;
}

/** Commands that plausibly change directory, worth a re-probe. */
export function looksLikeDirectoryChange(cmd: string): boolean {
  return /^\s*(cd|z|pushd|popd|set-location|sl)\b/i.test(cmd);
}

class CwdTracker {
  private cwd = "";
  private listeners = new Set<(cwd: string) => void>();
  // Output held back by consume() because it may be part of an answer.
  private carry = "";

  get(): string {
    return this.cwd;
  }

  subscribe(fn: (cwd: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Forgets output held back for the next chunk: the line it was on
   *  is being redrawn, and comes again whole. */
  dropCarry(): void {
    this.carry = "";
  }

  /** Strips probe answers from a raw output chunk and updates the cwd
   *  (triggering workspace detection) when it changed. */
  consume(raw: string): string {
    let changed: string | null = null;
    let stripped = (this.carry + raw).replace(PROBE_RE, (_match, path: string) => {
      changed = stripSgr(path).trim(); // a coloured prompt can leave codes around it
      return "";
    });
    this.carry = "";
    // An answer cut off by the end of this chunk waits for the rest:
    // an opening marker with no closing one on its line, or the start
    // of a marker at the very end.
    const open = stripped.lastIndexOf(MARK);
    let keep = open >= 0 && !/[\r\n]/.test(stripped.slice(open)) ? stripped.length - open : 0;
    if (keep === 0) {
      for (let k = MARK.length - 1; k > 0; k--) {
        if (stripped.endsWith(MARK.slice(0, k))) { keep = k; break; }
      }
    }
    if (keep > 0) {
      this.carry = stripped.slice(-keep);
      stripped = stripped.slice(0, -keep);
    }
    if (changed !== null) this.set(changed);
    return stripped;
  }

  /** The shell reported its directory (a probe's answer, or a shell
   *  integration mark): tell the listeners and detect the workspace. */
  set(cwd: string): void {
    if (!cwd || cwd === this.cwd) return;
    this.cwd = cwd;
    this.listeners.forEach((fn) => fn(cwd));
    events.emit("directory_changed", { path: cwd });
    workspaceManager.detectAndLoad(cwd).catch(() => { /* 'workspace reload still works */ });
  }
}

export const cwdTracker = new CwdTracker();

/** The directory in a shell-integration mark: "7;file://host/path"
 *  (percent-encoded; on Windows "/C:/…" is a drive, and a host means a
 *  network share) or Windows Terminal's "9;9;path". */
export function cwdFromMark(mark: string, windows: boolean): string | null {
  if (mark.startsWith("9;9;")) return mark.slice(4).replace(/^"|"$/g, "") || null;
  const m = /^7;file:\/\/([^/]*)(\/.*)?$/.exec(mark);
  if (!m) return null;
  let path = m[2] ?? "/";
  try { path = decodeURIComponent(path); } catch { /* not encoded */ }
  if (!windows) return path;
  if (/^\/[A-Za-z]:/.test(path)) return path.slice(1).replace(/\//g, "\\");
  const host = m[1];
  return host && host !== "localhost" ? "\\\\" + host + path.replace(/\//g, "\\") : path.replace(/\//g, "\\");
}
