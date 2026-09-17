/**
 * scriptRunTracker.ts — tracks whether a plugin script launched by
 * oxis.run() is still executing in the shell.
 *
 * The bug this fixes: oxis.run() (see pluginAPI.ts's runScript) sends
 * one line to the PTY that launches a script and waits for it to run
 * to completion — including any interactive Read-Host prompt inside
 * it, which blocks the shell on real keyboard input exactly like
 * running the .ps1 by hand. That's correct and desired *while nothing
 * else touches the same shell*. But there was no way to tell "a
 * script launched this way is still running" — so if a SECOND
 * '-command (any oxis.run()-backed one — 'healthcheck, 'tail,
 * 'sshconnect, nearly every builtin plugin) got dispatched before the
 * first script finished (e.g. the user ran 'tail right after
 * 'healthcheck without answering healthcheck's Read-Host prompt),
 * that second command's own launch line — "& "<path>"; Remove-Item
 * ..." — got sent straight into the PTY's stdin and was silently
 * consumed as the FIRST script's Read-Host answer, instead of being
 * interpreted as a new command. PowerShell then tried to use that
 * literal text as e.g. a URL, producing exactly the "Invalid URI: The
 * hostname could not be parsed" / garbled-looking output this was
 * reported against — and since nearly every builtin/market plugin
 * uses an interactive Read-Host prompt somewhere, this could break
 * effectively any of them; plugins with no prompts at all (the
 * built-in games — 8ball/guess/roll) were never affected, which is
 * why those were the ones that "worked".
 *
 * Fix: same technique as cwdTracker.ts — append an invisible marker
 * to the END of the chained launch command (after the script and its
 * Remove-Item cleanup), so it only prints once that whole line has
 * genuinely finished, Read-Host prompts included. While no marker has
 * come back yet, treat the shell as busy and refuse to launch another
 * '-command on top of it (see dispatchOxisCmd in App.tsx) — instead of
 * silently corrupting whatever's still waiting for input.
 */

const MARK = "\u2063OXISRUNDONE\u2063";
const MARK_RE = new RegExp(MARK, "g");

// Safety valve: if a script is killed in a way that skips the marker
// entirely (e.g. antivirus holding the temp file, or some exotic
// non-PowerShell shell), don't leave the terminal permanently
// "busy" — auto-clear after a generous timeout.
const STALE_MS = 3 * 60 * 1000;

class ScriptRunTracker {
  private busy = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  isBusy(): boolean {
    return this.busy;
  }

  /** Call right before sending a script-launch line to the PTY. */
  begin(): void {
    this.busy = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.busy = false; }, STALE_MS);
  }

  /** Call when the user explicitly interrupts the shell (Ctrl+C) —
   *  they're taking back control of whatever was running/prompting. */
  cancel(): void {
    this.busy = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  /** Scan a raw PTY output chunk for the completion marker, strip it
   *  (so it's invisible to the user, matching cwdTracker.consume()),
   *  and clear the busy flag if found. App.tsx's onOutput should run
   *  every chunk through this. */
  consume(raw: string): string {
    if (!raw.includes(MARK)) return raw;
    this.busy = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    return raw.replace(MARK_RE, "");
  }
}

export const scriptRunTracker = new ScriptRunTracker();

/** The exact suffix runScript appends to a script-launch command so
 *  the marker only appears once the WHOLE chained line — including
 *  any Read-Host it blocked on — has actually finished. PowerShell
 *  only reaches here after `& "<script>"` returns, whether that took
 *  no time or several minutes of waiting on real input. */
export function launchSuffix(): string {
  return `; Write-Host "${MARK}"`;
}