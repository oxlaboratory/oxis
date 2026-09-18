import { isWindows } from "./terminal";

/**
 * scriptRunTracker.ts — lets JS code that talks to the PTY shell
 * (oxis.run(), workflowRunner.ts) actually know when a command it
 * just sent has finished — including one that blocked on a real
 * Read-Host prompt — instead of firing it and hoping.
 *
 * The bug this originally fixed: sending a script-launch line to the
 * PTY and moving on immediately meant nothing tracked whether it was
 * still running. If a SECOND '-command (any oxis.run()-backed one —
 * 'healthcheck, 'tail, 'sshconnect, nearly every builtin plugin) got
 * dispatched before the first script finished (e.g. the user ran
 * 'tail right after 'healthcheck without answering healthcheck's
 * Read-Host prompt), that second command's own launch line got sent
 * straight into the PTY's stdin and was silently consumed as the
 * FIRST script's Read-Host answer, instead of being interpreted as a
 * new command. PowerShell then tried to use that literal text as e.g.
 * a URL, producing the "Invalid URI: The hostname could not be
 * parsed" / garbled-looking output this was reported against — and
 * since nearly every builtin/market plugin uses an interactive
 * Read-Host prompt somewhere, this could break effectively any of
 * them; plugins with no prompts at all (the built-in games —
 * 8ball/guess/roll) were never affected, which is why those were the
 * ones that "worked".
 *
 * Fix: the same technique as cwdTracker.ts — append an invisible,
 * per-call-unique marker to the end of whatever's sent, so it only
 * prints once that whole line has genuinely finished, Read-Host
 * prompts included. While any marker is outstanding, isBusy() is
 * true, and dispatchOxisCmd in App.tsx refuses to launch another
 * '-command on top of it — instead of silently corrupting whatever's
 * still waiting for input. runAndAwait() below additionally resolves
 * a real Promise per call, which is what lets workflowRunner.ts run
 * steps one at a time and know exactly when each one finished.
 */

// Safety valve: if a marker is lost in a way that skips it entirely
// (e.g. antivirus holding a temp file, or a shell that doesn't echo
// output the way expected — browser mode has nothing real to send
// commands to at all), don't leave a step hanging forever — resolve
// it as timed out after a generous window.
const STALE_MS = 3 * 60 * 1000;

class ScriptRunTracker {
  // Per-call completion signals — see runAndAwait(). Keyed by that
  // call's own unique marker.
  private pending = new Map<string, (result: { cancelled: boolean; timedOut: boolean }) => void>();

  isBusy(): boolean {
    return this.pending.size > 0;
  }

  /** Sends `send(cmdLine + <a completion marker unique to this call>)`
   *  and resolves once THAT marker (not just any marker) comes back
   *  through consume() — i.e. once the shell has genuinely finished
   *  that specific line, any Read-Host prompt included. Resolves
   *  `{ timedOut: true }` after a generous timeout if the marker never
   *  comes back at all, so a caller (a workflow step, in particular)
   *  can never hang forever — treat a timeout as a failed step, since
   *  success was never actually confirmed.
   *
   *  Concurrent calls each get their own marker and promise, but they
   *  all still share the ONE real shell — sending a second one before
   *  the first's marker has come back would reproduce the exact
   *  corruption described above. Callers that need real concurrency
   *  (workflowRunner's "parallel" steps) must serialize any
   *  shell-touching steps against each other; only non-shell work can
   *  genuinely run alongside one. */
  runAndAwait(send: (line: string) => void, cmdLine: string): Promise<{ cancelled: boolean; timedOut: boolean }> {
    const marker = `\u2063OXISSTEP${Math.random().toString(36).slice(2)}\u2063`;
    return new Promise((resolve) => {
      const localTimer = setTimeout(() => {
        this.pending.delete(marker);
        resolve({ cancelled: false, timedOut: true });
      }, STALE_MS);
      this.pending.set(marker, (result) => {
        clearTimeout(localTimer);
        resolve(result);
      });
      const suffix = isWindows() ? `; Write-Host "${marker}"` : `; printf '%s\\n' '${marker}'`;
      send(cmdLine + suffix + "\r");
    });
  }

  /** Call when the user explicitly interrupts the shell (Ctrl+C) —
   *  they're taking back control of whatever was running/prompting.
   *  Every pending runAndAwait() resolves too (as cancelled, not
   *  succeeded) — otherwise a cancelled step would just hang forever,
   *  since its marker can now never come back. */
  cancel(): void {
    for (const resolve of this.pending.values()) resolve({ cancelled: true, timedOut: false });
    this.pending.clear();
  }

  /** Scan a raw PTY output chunk for any pending runAndAwait() marker,
   *  strip it (so it's invisible to the user, matching
   *  cwdTracker.consume()), and resolve that call. App.tsx's onOutput
   *  should run every chunk through this. */
  consume(raw: string): string {
    if (this.pending.size === 0) return raw;
    let out = raw;
    for (const [marker, resolve] of [...this.pending]) {
      if (out.includes(marker)) {
        out = out.split(marker).join("");
        this.pending.delete(marker);
        resolve({ cancelled: false, timedOut: false });
      }
    }
    return out;
  }
}

export const scriptRunTracker = new ScriptRunTracker();