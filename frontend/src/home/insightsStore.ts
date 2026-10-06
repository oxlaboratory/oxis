/**
 * insightsStore.ts — what Home's insight cards know about each workspace:
 * today's activity (tasks run, files saved, workflows run, commands run),
 * the files opened lately, the last workflow run and the last command
 * that failed. Kept in localStorage per workspace; counts start again
 * each day. Fed by OXIS's own events (see start()).
 */

import { events } from "../terminal/events";

export interface WorkflowRun { name: string; ok: boolean; steps: string[]; at: number }
export interface FailedCommand { command: string; code: number; at: number }

export interface WorkspaceInsights {
  day: string;
  tasks: number;
  saves: number;
  workflows: number;
  commands: number;
  /** Paths opened or saved in the editor, newest first. */
  files: string[];
  lastWorkflow?: WorkflowRun;
  lastFailed?: FailedCommand;
}

const KEY = "oxis-insights-v1";
const today = () => new Date().toISOString().slice(0, 10);
const blank = (): WorkspaceInsights => ({ day: today(), tasks: 0, saves: 0, workflows: 0, commands: 0, files: [] });

let all: Record<string, WorkspaceInsights> = {};
try { all = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { all = {}; }
let current = "default";
const listeners = new Set<() => void>();

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* storage full: the cards still work this session */ }
  listeners.forEach(l => l());
}

/** This workspace's insights, the day's counts reset if it's a new day. */
export function insightsFor(workspace = current): WorkspaceInsights {
  let w = all[workspace];
  if (!w) w = all[workspace] = blank();
  if (w.day !== today()) all[workspace] = w = { ...blank(), files: w.files, lastWorkflow: w.lastWorkflow };
  return w;
}

/** The workspace new activity counts towards. */
export function setInsightsWorkspace(name: string | null): void {
  current = name || "default";
  listeners.forEach(l => l());
}

export function onInsights(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function update(change: (w: WorkspaceInsights) => void) {
  change(insightsFor());
  save();
}

function addFile(path: unknown) {
  const p = String(path ?? "").replace(/\\/g, "/");
  if (!p || /^untitled/i.test(p)) return;
  update(w => { w.files = [p, ...w.files.filter(f => f !== p)].slice(0, 8); });
}

let started = false;
/** Starts listening (once). */
export function startInsights(): void {
  if (started) return;
  started = true;
  events.on("editor_opened", p => addFile((p as { path?: string } | undefined)?.path));
  events.on("editor_saved", p => { addFile((p as { path?: string } | undefined)?.path); update(w => { w.saves++; }); });
  events.on("task_run", () => update(w => { w.tasks++; }));
  events.on("workflow_done", p => {
    const r = p as { name: string; ok: boolean; steps: string[] };
    update(w => { w.workflows++; w.lastWorkflow = { name: r.name, ok: r.ok, steps: r.steps, at: Date.now() }; });
  });
  events.on("shell_command_done", p => {
    const r = p as { command: string; code: number };
    update(w => {
      w.commands++;
      // Ctrl+C isn't a failure worth mentioning.
      if (r.code !== 0 && r.code !== 130 && r.code !== -1073741510) w.lastFailed = { command: r.command, code: r.code, at: Date.now() };
      else if (w.lastFailed && w.lastFailed.command === r.command) w.lastFailed = undefined; // it works now
    });
  });
}

/** "4m ago", "2h ago", "3d ago". */
export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
