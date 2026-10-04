/**
 * promptCapture.ts — a plugin taking over the prompt for a moment.
 *
 * oxis.ask(question, fn) makes the next line typed in the prompt the
 * plugin's answer instead of a command; the prompt's label shows whose
 * question it is. oxis.every(…, { foreground = true }) starts something
 * that runs until it's stopped. Ctrl+C cancels the question and stops
 * every foreground job, the same key that stops a program in the shell.
 */

import { events } from "./events";

export interface Capture {
  /** The plugin asking. */
  owner: string;
  /** Shown as the prompt's label while it waits, e.g. "blackjack". */
  label: string;
  onLine: (line: string) => void;
  onCancel?: () => void;
}

let current: Capture | null = null;
const changed = () => events.emit("prompt_capture", { label: current?.label ?? "" });

// Lines typed while a plugin's foreground job runs (a game's animation,
// a live view) and nothing is asking yet: like type-ahead in a terminal,
// they go to the question that follows, or, if none comes once the jobs
// have ended, they run as typed. Ctrl+C throws them away.
// Each line remembers whose jobs were running, so only their question
// gets it.
const typeAhead: { line: string; owners: Set<string> }[] = [];
let unclaimed: ((line: string) => void) | null = null;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
// How long after the last job ends a question may still come (on native
// Lua the plugin asks after a round trip).
const QUESTION_GRACE_MS = 400;

export const promptCapture = {
  get: (): Capture | null => current,

  /** Waits for the next line (replacing any question still open). */
  set(c: Capture): void {
    current = c;
    changed();
    if (typeAhead.length && typeAhead[0].owners.has(c.owner)) {
      const { line } = typeAhead.shift()!;
      setTimeout(() => { if (current === c) promptCapture.take(line); }, 0);
    }
  },

  /** Hands a typed line to the question, if there is one. The question
   *  is closed first, so the answer's handler can ask the next one. */
  take(line: string): boolean {
    const c = current;
    if (!c) return false;
    current = null;
    changed();
    c.onLine(line);
    return true;
  },

  /** Ctrl+C: drops the question. */
  cancel(): boolean {
    typeAhead.length = 0;
    const c = current;
    if (!c) return false;
    current = null;
    changed();
    c.onCancel?.();
    return true;
  },

  /** Holds a line typed while a foreground job runs and nothing is
   *  asking (see typeAhead); false when no job runs. */
  holdIfBusy(line: string): boolean {
    if (jobs.size === 0) return false;
    typeAhead.push({ line, owners: new Set([...jobs.values()].map(j => j.owner)) });
    return true;
  },

  /** Where held lines go when no question claims them: run as typed. */
  onUnclaimed(run: (line: string) => void): void { unclaimed = run; },

  /** A plugin unloading drops its own question, quietly. */
  release(owner: string): void {
    if (current?.owner !== owner) return;
    current = null;
    changed();
  },
};

/** What a plugin runs in the foreground (a live view, a game loop). */
const jobs = new Map<number, { owner: string; stop: () => void }>();
let nextJob = 1;

export const foregroundJobs = {
  /** Registers a job; returns a function that removes it (when the job
   *  ends on its own). */
  add(owner: string, stop: () => void): () => void {
    const id = nextJob++;
    jobs.set(id, { owner, stop });
    return () => {
      if (!jobs.delete(id) || jobs.size > 0) return;
      // The last job is done: if no question takes what was typed
      // meanwhile, it runs.
      clearTimeout(flushTimer);
      flushTimer = setTimeout(() => {
        if (current || jobs.size > 0) return;
        while (typeAhead.length) unclaimed?.(typeAhead.shift()!.line);
      }, QUESTION_GRACE_MS);
    };
  },

  /** Ctrl+C: stops them all; how many there were. */
  stopAll(): number {
    typeAhead.length = 0;
    const all = [...jobs.values()];
    jobs.clear();
    for (const j of all) { try { j.stop(); } catch { /* already gone */ } }
    return all.length;
  },

  count: (): number => jobs.size,
};
