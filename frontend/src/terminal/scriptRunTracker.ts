import { isWindows, currentShell } from "./terminal";

/**
 * scriptRunTracker.ts — knows when a command sent to the shared shell
 * (oxis.run(), workflow steps) has finished, and with what exit status,
 * including one waiting on a Read-Host prompt.
 *
 * Each command gets an invisible, per-call marker printed after it,
 * carrying the command's exit status. The marker is split in two in the
 * command text so the shell's echo of the command never contains it
 * whole; only the real output does. While a marker is outstanding
 * isBusy() is true and the terminal refuses to start another 'command,
 * so a new command can't be swallowed as the answer to a prompt. Calls
 * are also queued, so several oxis.run() calls from one handler run one
 * after another.
 */

// A marker that never comes back (e.g. the shell died) resolves as
// timed out instead of hanging forever.
const STALE_MS = 3 * 60 * 1000;

const MARK = "\u2063";

export interface RunResult {
  cancelled: boolean;
  timedOut: boolean;
  /** The command's exit status; null when it was cancelled or timed out. */
  exitCode: number | null;
}

// PowerShell: the real exit code of the last native program if there
// was one, else 1 if the last command failed, else 0. $LASTEXITCODE is
// reset first (PS_PREFIX) so an old program's code isn't reported.
const PS_PREFIX = "$global:LASTEXITCODE = 0; ";
const PS_STATUS = "$(if ($LASTEXITCODE) { $LASTEXITCODE } elseif (-not $?) { 1 } else { 0 })";

/** The text sent after a command so it prints its marker when done. */
function markerSuffix(id: string): string {
  if (isWindows() && currentShell() !== "bash") {
    return `; Write-Host ("${MARK}OXIS" + "STEP${id}:" + ${PS_STATUS} + "${MARK}")`;
  }
  const status = currentShell() === "fish" ? "$status" : "$?";
  return `; printf '%s%s:%s\\n' '${MARK}OXIS' 'STEP${id}' "${status}"'${MARK}'`;
}

class ScriptRunTracker {
  // Completion callbacks, keyed by each call's id.
  private pending = new Map<string, (result: RunResult) => void>();
  // Serialises dispatch so two calls never share the shell at once.
  private queue: Promise<void> = Promise.resolve();
  // Bumped by cancel(); queued calls from an older generation resolve
  // as cancelled without being sent.
  private generation = 0;
  // Output held back by consume() because it may be the start of a marker.
  private carry = "";

  isBusy(): boolean {
    return this.pending.size > 0;
  }

  /** Sends cmdLine followed by this call's marker, and resolves once the
   *  marker is printed (the command has finished), on cancel(), or after
   *  STALE_MS. Waits for earlier calls to finish before sending. */
  runAndAwait(send: (line: string) => void, cmdLine: string): Promise<RunResult> {
    const id = Math.random().toString(36).slice(2);
    const queuedGeneration = this.generation;
    return new Promise<RunResult>((resolve) => {
      this.queue = this.queue.catch(() => {}).then(() => new Promise<void>((dispatchDone) => {
        if (this.generation !== queuedGeneration) {
          resolve({ cancelled: true, timedOut: false, exitCode: null });
          dispatchDone();
          return;
        }
        const localTimer = setTimeout(() => {
          this.pending.delete(id);
          resolve({ cancelled: false, timedOut: true, exitCode: null });
          dispatchDone();
        }, STALE_MS);
        this.pending.set(id, (r) => {
          clearTimeout(localTimer);
          resolve(r);
          dispatchDone();
        });
        const prefix = isWindows() && currentShell() !== "bash" ? PS_PREFIX : "";
        send(prefix + cmdLine + markerSuffix(id) + "\r");
      }));
    });
  }

  /** Ctrl+C: resolve everything pending and queued as cancelled. */
  cancel(): void {
    this.generation++;
    for (const resolve of this.pending.values()) resolve({ cancelled: true, timedOut: false, exitCode: null });
    this.pending.clear();
  }

  /** Strips completed markers from raw output and resolves their calls.
   *  Output arrives in chunks, so a marker cut off at the end of one is
   *  held back and completed by the next. */
  consume(raw: string): string {
    let out = this.carry + raw;
    this.carry = "";
    if (this.pending.size === 0) return out;
    for (const [id, resolve] of [...this.pending]) {
      const re = new RegExp(`${MARK}OXISSTEP${id}:(-?\\d+)${MARK}`, "g");
      let code: number | null = null;
      out = out.replace(re, (_m, c: string) => { code = Number(c); return ""; });
      if (code !== null) {
        this.pending.delete(id);
        resolve({ cancelled: false, timedOut: false, exitCode: code });
      }
    }
    const keep = this.partialMarkerLength(out);
    if (keep > 0) {
      this.carry = out.slice(-keep);
      out = out.slice(0, -keep);
    }
    return out;
  }

  /** Length of the end of `text` that may be an unfinished marker: the
   *  start of one, or one whose exit status or closing mark hasn't
   *  arrived yet. */
  private partialMarkerLength(text: string): number {
    let best = 0;
    for (const id of this.pending.keys()) {
      const head = `${MARK}OXISSTEP${id}:`;
      const at = text.lastIndexOf(head);
      if (at >= 0 && /^-?\d*$/.test(text.slice(at + head.length))) {
        best = Math.max(best, text.length - at);
        continue;
      }
      for (let k = Math.min(head.length - 1, text.length); k > best; k--) {
        if (text.endsWith(head.slice(0, k))) { best = k; break; }
      }
    }
    return best;
  }
}

/** Removes what OXIS added to a command line from the shell's echo of
 *  it: the marker suffix, and PowerShell's exit-code reset. */
export function stripStepEcho(line: string): string {
  return line
    .split(PS_PREFIX).join("")
    .replace(new RegExp(`; Write-Host \\("${MARK}OXIS" \\+ "STEP[a-z0-9]*:" \\+ .*? \\+ "${MARK}"\\)`, "g"), "")
    .replace(new RegExp(`; printf '%s%s:%s\\\\n' '${MARK}OXIS' 'STEP[a-z0-9]*' "\\$(?:\\?|status)"'${MARK}'`, "g"), "");
}

export const scriptRunTracker = new ScriptRunTracker();
