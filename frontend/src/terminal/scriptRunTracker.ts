import { isWindows } from "./terminal";

/**
 * scriptRunTracker.ts — knows when a command sent to the shared shell
 * (oxis.run(), workflow steps) has finished, including one waiting on a
 * Read-Host prompt.
 *
 * Each command gets an invisible, per-call marker printed after it. The
 * marker is split in two in the command text so the shell's echo of the
 * command never contains it whole; only the real output does. While a
 * marker is outstanding isBusy() is true and the terminal refuses to
 * start another 'command, so a new command can't be swallowed as the
 * answer to a prompt. Calls are also queued, so several oxis.run()
 * calls from one handler run one after another.
 */

// A marker that never comes back (e.g. the shell died) resolves as
// timed out instead of hanging forever.
const STALE_MS = 3 * 60 * 1000;

class ScriptRunTracker {
  // Completion callbacks, keyed by each call's marker.
  private pending = new Map<string, (result: { cancelled: boolean; timedOut: boolean }) => void>();
  // Serialises dispatch so two calls never share the shell at once.
  private queue: Promise<void> = Promise.resolve();
  // Bumped by cancel(); queued calls from an older generation resolve
  // as cancelled without being sent.
  private generation = 0;

  isBusy(): boolean {
    return this.pending.size > 0;
  }

  /** Sends cmdLine followed by this call's marker, and resolves once the
   *  marker is printed (the command has finished), on cancel(), or after
   *  STALE_MS. Waits for earlier calls to finish before sending. */
  runAndAwait(send: (line: string) => void, cmdLine: string): Promise<{ cancelled: boolean; timedOut: boolean }> {
    const id = Math.random().toString(36).slice(2);
    const marker = `\u2063OXISSTEP${id}\u2063`;
    const queuedGeneration = this.generation;
    const result = new Promise<{ cancelled: boolean; timedOut: boolean }>((resolve) => {
      this.queue = this.queue.catch(() => {}).then(() => new Promise<void>((dispatchDone) => {
        if (this.generation !== queuedGeneration) {
          resolve({ cancelled: true, timedOut: false });
          dispatchDone();
          return;
        }
        const localTimer = setTimeout(() => {
          this.pending.delete(marker);
          resolve({ cancelled: false, timedOut: true });
          dispatchDone();
        }, STALE_MS);
        this.pending.set(marker, (r) => {
          clearTimeout(localTimer);
          resolve(r);
          dispatchDone();
        });
        const suffix = isWindows()
          ? `; Write-Host ("\u2063OXIS" + "STEP${id}\u2063")`
          : `; printf '%s%s\\n' '\u2063OXIS' 'STEP${id}\u2063'`;
        send(cmdLine + suffix + "\r");
      }));
    });
    return result;
  }

  /** Ctrl+C: resolve everything pending and queued as cancelled. */
  cancel(): void {
    this.generation++;
    for (const resolve of this.pending.values()) resolve({ cancelled: true, timedOut: false });
    this.pending.clear();
  }

  /** Strips completed markers from raw output and resolves their calls.
   *  Output arrives in chunks, so a marker cut off at the end of one is
   *  held back and completed by the next. */
  consume(raw: string): string {
    let out = this.carry + raw;
    this.carry = "";
    if (this.pending.size === 0) return out;
    for (const [marker, resolve] of [...this.pending]) {
      if (out.includes(marker)) {
        out = out.split(marker).join("");
        this.pending.delete(marker);
        resolve({ cancelled: false, timedOut: false });
      }
    }
    const keep = this.partialMarkerLength(out);
    if (keep > 0) {
      this.carry = out.slice(-keep);
      out = out.slice(0, -keep);
    }
    return out;
  }

  // Output held back by consume() because it may be the start of a marker.
  private carry = "";

  /** Length of the longest end of `text` that begins a pending marker. */
  private partialMarkerLength(text: string): number {
    let best = 0;
    for (const marker of this.pending.keys()) {
      for (let k = Math.min(marker.length - 1, text.length); k > best; k--) {
        if (text.endsWith(marker.slice(0, k))) { best = k; break; }
      }
    }
    return best;
  }
}

/** Removes the marker suffix from the shell's echo of a command line. */
export function stripStepEcho(line: string): string {
  return line
    .replace(/; Write-Host \("\u2063OXIS" \+ "STEP[a-z0-9]*\u2063"\)/g, "")
    .replace(/; printf '%s%s\\n' '\u2063OXIS' 'STEP[a-z0-9]*\u2063'/g, "");
}

export const scriptRunTracker = new ScriptRunTracker();