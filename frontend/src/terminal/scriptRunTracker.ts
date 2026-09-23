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
  // Serializes actual DISPATCH, not just completion-tracking — see
  // runAndAwait()'s own doc comment for the real bug this fixes:
  // tracking alone let a second call's launch line collide with a
  // still-running first one in the same PTY.
  private queue: Promise<void> = Promise.resolve();
  // Bumped by cancel() below. Each runAndAwait() call captures the
  // generation it was QUEUED under; if that's changed by the time its
  // turn comes to actually dispatch, a cancel() happened in between
  // and it resolves as cancelled without ever calling send() — a
  // generation counter rather than a plain boolean specifically so
  // there's no "when do I reset this back to false" ambiguity to get
  // wrong: a call only ever compares against whatever generation was
  // current AT THE MOMENT IT WAS QUEUED, which is unambiguous however
  // many cancellations happen before or after.
  private generation = 0;

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
   *  A REAL BUG lived here, reported directly with a screenshot: two
   *  garbled, colliding script-launch lines in the same terminal
   *  output. `pending` was only ever used to TRACK which markers to
   *  watch for and resolve — nothing here actually stopped a SECOND
   *  call from being dispatched (i.e. actually calling `send(...)`)
   *  while a FIRST one was still pending. `dispatchOxisCmd` in
   *  App.tsx checks isBusy() before launching a new top-level
   *  '-command, but that check only runs BETWEEN separate commands —
   *  it can't help when a SINGLE plugin's own Lua code calls
   *  oxis.run() more than once inside the same command handler
   *  invocation, which is a completely normal thing to write (check
   *  disk space, THEN check network, THEN check git status, as three
   *  separate oxis.run() calls) and which Lua has no way to serialize
   *  itself: oxis.run() is fire-and-forget from Lua's own perspective
   *  (see OxisBindings.run's own doc comment) — there's no `await` a
   *  Lua script can write. Both calls fired their `send(...)`
   *  immediately, back to back, into the one real shared PTY, and the
   *  second script's launch line landed on top of the first one still
   *  running — exactly the corruption this file's own top comment
   *  already described for a different trigger (a second USER-typed
   *  command), just never closed for this one.
   *
   *  Fixed by actually queuing dispatch, not just tracking it: each
   *  call chains onto `queue` and only calls `send(...)` once
   *  whatever was queued before it has actually resolved (successfully,
   *  cancelled, or timed out — any terminal state), so two oxis.run()
   *  calls from the same plugin now genuinely run one after the other
   *  in the shell, exactly like two sequential lines in a real script
   *  would, instead of both landing in the PTY at once. */
  runAndAwait(send: (line: string) => void, cmdLine: string): Promise<{ cancelled: boolean; timedOut: boolean }> {
    const marker = `\u2063OXISSTEP${Math.random().toString(36).slice(2)}\u2063`;
    const queuedGeneration = this.generation;
    const result = new Promise<{ cancelled: boolean; timedOut: boolean }>((resolve) => {
      // Wait for whatever's already queued (if anything) before this
      // call actually dispatches — .catch(()=>{}) so one call's own
      // internal failure can't break the chain for everything queued
      // after it; every branch below resolves normally regardless.
      this.queue = this.queue.catch(() => {}).then(() => new Promise<void>((dispatchDone) => {
        if (this.generation !== queuedGeneration) {
          // cancel() ran while this call was still waiting in line —
          // it never actually sent anything, so there's nothing to
          // interrupt; just resolve as cancelled and let the queue move on.
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
        const suffix = isWindows() ? `; Write-Host "${marker}"` : `; printf '%s\\n' '${marker}'`;
        send(cmdLine + suffix + "\r");
      }));
    });
    return result;
  }

  /** Call when the user explicitly interrupts the shell (Ctrl+C) —
   *  they're taking back control of whatever was running/prompting.
   *  Every pending runAndAwait() resolves too (as cancelled, not
   *  succeeded) — otherwise a cancelled step would just hang forever,
   *  since its marker can now never come back. Also bumps `generation`
   *  so anything still QUEUED (not yet dispatched — see runAndAwait's
   *  own doc comment) resolves as cancelled too instead of going
   *  ahead and sending its own command once its turn comes, which
   *  would otherwise mean Ctrl+C only stopped the currently-active
   *  step of a plugin's multi-step oxis.run() sequence, not the whole
   *  thing. */
  cancel(): void {
    this.generation++;
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