/**
 * cwdTracker.ts — tracks the shell's working directory.
 *
 * After startup and after anything that looks like a `cd`, OXIS sends a
 * one-line probe that prints the cwd between invisible U+2063 markers.
 * consume() pulls the answer out of the raw output, and isProbeLine()
 * lets the terminal drop the echoed probe command, so neither is shown.
 * The cwd drives oxis.cwd() and automatic workspace detection.
 */

import { workspaceManager } from "./workspaceManager";

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

  get(): string {
    return this.cwd;
  }

  subscribe(fn: (cwd: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Strips probe answers from a raw output chunk and updates the cwd
   *  (triggering workspace detection) when it changed. */
  consume(raw: string): string {
    let changed: string | null = null;
    const stripped = raw.replace(PROBE_RE, (_match, path: string) => {
      changed = path.trim();
      return "";
    });
    if (changed !== null && changed !== this.cwd) {
      this.cwd = changed;
      this.listeners.forEach((fn) => fn(changed as string));
      workspaceManager.detectAndLoad(changed).catch(() => { /* 'workspace reload still works */ });
    }
    return stripped;
  }
}

export const cwdTracker = new CwdTracker();
