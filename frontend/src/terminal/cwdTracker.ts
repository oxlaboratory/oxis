/**
 * cwdTracker.ts — tracks the active shell's real working directory.
 *
 * Before this existed, `getCwd` passed into buildLuaAPI() at root init
 * was a permanent `() => ""` stub (see App.tsx) — `oxis.cwd()` never
 * returned anything real, and there was no way for OXIS to know when
 * the user `cd`s into a different project, which is what automatic
 * workspace detection (README § Workspace System — "OXIS must
 * automatically detect and load a workspace when entering/opening a
 * project containing one") depends on.
 *
 * Approach: there's no portable, zero-config way to ask an arbitrary
 * child shell "what's your cwd right now" other than asking the shell
 * itself. So after the shell settles (on ready, and a short debounce
 * after the user runs anything that looks like a directory change),
 * OXIS writes a one-line probe to the PTY that prints the cwd wrapped
 * in an near-unique marker (U+2063 INVISIBLE SEPARATOR, extremely
 * unlikely to appear in real output), and Terminal's onOutput calls
 * consume() on every raw chunk to pull that marker back out — before
 * anything else gets rendered, so the probe's own line never reaches
 * the visible scrollback.
 *
 * This is a best-effort mechanism, not a guarantee: it depends on the
 * shell actually running the probe line and printing back exactly
 * what was asked (true for PowerShell and any POSIX sh/bash/zsh).
 */

import { workspaceManager } from "./workspaceManager";

const MARK = "\u2063OXISCWD\u2063";
const PROBE_RE = new RegExp(MARK + "([^\\r\\n]*?)" + MARK, "g");

/** The exact line OXIS sends to the shell to ask for its cwd. */
export function buildCwdProbe(isWindows: boolean): string {
  return isWindows
    ? `Write-Host "${MARK}$($PWD.Path)${MARK}"`
    : `printf '${MARK}%s${MARK}\\n' "$PWD"`;
}

/** Loose match for commands that plausibly change directory, used to
 *  decide when it's worth re-probing rather than probing after every
 *  single command. False negatives just mean a slightly stale cwd
 *  until the next probe — never wrong forever. */
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

  /**
   * Scan a raw PTY output chunk for the cwd probe marker, strip it out
   * (so it's invisible to the user), update the tracked cwd if it
   * changed, and kick off workspace auto-detection for the new
   * directory. Returns the chunk with any marker line removed —
   * Terminal's onOutput should always pass raw text through this
   * before rendering it.
   */
  consume(raw: string): string {
    let changed: string | null = null;
    const stripped = raw.replace(PROBE_RE, (_match, path: string) => {
      changed = path.trim();
      return "";
    });
    if (changed !== null && changed !== this.cwd) {
      this.cwd = changed;
      this.listeners.forEach((fn) => fn(changed as string));
      workspaceManager.detectAndLoad(changed).catch(() => { /* not fatal — 'workspace init/reload still works manually */ });
    }
    return stripped;
  }
}

export const cwdTracker = new CwdTracker();
