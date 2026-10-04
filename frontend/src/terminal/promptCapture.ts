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

export const promptCapture = {
  get: (): Capture | null => current,

  /** Waits for the next line (replacing any question still open). */
  set(c: Capture): void {
    current = c;
    changed();
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
    const c = current;
    if (!c) return false;
    current = null;
    changed();
    c.onCancel?.();
    return true;
  },

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
    return () => { jobs.delete(id); };
  },

  /** Ctrl+C: stops them all; how many there were. */
  stopAll(): number {
    const all = [...jobs.values()];
    jobs.clear();
    for (const j of all) { try { j.stop(); } catch { /* already gone */ } }
    return all.length;
  },

  count: (): number => jobs.size,
};
