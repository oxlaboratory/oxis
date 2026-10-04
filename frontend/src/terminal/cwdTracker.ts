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

/** The exact line OXIS sends to the shell to ask for its cwd. An sh on
 *  Windows (Git Bash) is asked for the Windows path (`pwd -W`, not
 *  /c/Users/…), which is what OXIS opens files by. */
export function buildCwdProbe(powershell: boolean, windows = false, cmd = false): string {
  // cmd: %CD:~0,0% is empty, so the echo of the command splits the
  // marker and only the printed answer has it whole.
  if (cmd) return `echo ${HALF_A}%CD:~0,0%${HALF_B}%CD%${HALF_A}%CD:~0,0%${HALF_B}`;
  const dir = windows ? `"$(pwd -W 2>/dev/null || pwd)"` : `"$PWD"`;
  return powershell
    ? `Write-Host ("${HALF_A}" + "${HALF_B}" + $PWD.Path + "${HALF_A}" + "${HALF_B}")`
    : `printf '%s%s%s%s%s\\n' '${HALF_A}' '${HALF_B}' ${dir} '${HALF_A}' '${HALF_B}'`;
}

/** Commands that plausibly change directory, worth a re-probe. */
export function looksLikeDirectoryChange(cmd: string): boolean {
  return /^\s*(cd|z|pushd|popd|set-location|sl)\b/i.test(cmd);
}

/** One terminal tab's directory. Only the active tab's is the app's:
 *  what 'workspace commands and plugins' oxis.cwd() see (cwdTracker
 *  below), and what workspaces are detected from, so a `cd` in a tab in
 *  the background doesn't switch the workspace. */
export class CwdTracker {
  private cwd = "";
  private listeners = new Set<(cwd: string) => void>();
  // Output held back by consume() because it may be part of an answer.
  private carry = "";
  private active = false;

  /** This tab became the active one (or stopped being it): from now
   *  on its directory is the app's. */
  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    if (!on) { if (activeTracker === this) activeTracker = null; return; }
    activeTracker = this;
    if (this.cwd) announce(this.cwd);
  }

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
   *  integration mark): tell the listeners and, in the active tab,
   *  detect the workspace. */
  set(cwd: string): void {
    // WSL on Windows: /mnt/c/… is C:\….
    const wsl = /^\/mnt\/([a-z])(\/.*)?$/i.exec(cwd);
    if (wsl && typeof navigator !== "undefined" && /win/i.test(navigator.platform || "")) {
      cwd = `${wsl[1].toUpperCase()}:${(wsl[2] || "\\").replace(/\//g, "\\")}`;
    }
    if (!cwd || cwd === this.cwd) return;
    this.cwd = cwd;
    this.listeners.forEach((fn) => fn(cwd));
    if (this.active) announce(cwd);
  }
}

let activeTracker: CwdTracker | null = null;
let announced = "";

/** The app's directory is now `cwd` (switching to a tab in the same
 *  directory isn't a change). */
function announce(cwd: string): void {
  if (cwd === announced) return;
  announced = cwd;
  events.emit("directory_changed", { path: cwd });
  workspaceManager.detectAndLoad(cwd).catch(() => { /* 'workspace reload still works */ });
}

/** The active terminal tab's directory ("" before it's known). */
export const cwdTracker = { get: (): string => activeTracker?.get() ?? "" };

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
  // Git Bash, MSYS2, Cygwin: /c/Users/… is C:\Users\…. (On Windows only
  // they send this mark; PowerShell sends 9;9.) Their own folders (/usr,
  // /tmp) have no Windows path here.
  if (/^\/[A-Za-z](\/|$)/.test(path)) return path[1].toUpperCase() + ":\\" + path.slice(3).replace(/\//g, "\\");
  if (/^\/(usr|tmp|etc|bin|home|opt|var|mingw64|mingw32|ucrt64|clang64)(\/|$)/.test(path)) return null;
  const host = m[1];
  return host && host !== "localhost" ? "\\\\" + host + path.replace(/\//g, "\\") : path.replace(/\//g, "\\");
}
