/**
 * taskReconciler.ts — the task integrity checker (spec item 8): keeps
 * .oxis/tasks/auto-detected.lua synchronized with the project's
 * actual, current configuration whenever a workspace is opened,
 * linked, reloaded, or refreshed.
 *
 * The one rule everything else here serves: NEVER touch a task the
 * user has hand-edited, no matter what the underlying project
 * configuration has since done — explicitly requested, and the whole
 * reason GeneratedTaskMeta records a contentHash at generation time
 * (projectDetector.ts) is so this file can tell "still exactly as
 * generated" apart from "edited since" before ever regenerating
 * anything. A task the user edited stops being tracked by the
 * auto-detected metadata going forward — it's effectively a
 * user-owned task from that point on, kept in the file verbatim,
 * never removed even if its original source configuration disappears.
 */

import { readFile, writeFile, statPath } from "../native";
import {
  detectProject,
  generateTasksFile,
  type DetectedTask,
  type GeneratedTasksMeta,
} from "./projectDetector";

/** Extracts `name -> exact current line text` for every
 *  `oxis.task(...)` call in an existing auto-detected.lua — used to
 *  compare against each task's recorded contentHash. A simple,
 *  line-oriented parse (one call per line, exactly how
 *  generateTasksFile itself always writes them) rather than a real
 *  Lua parser — this file is only ever written by generateTasksFile,
 *  so it never needs to understand arbitrary Lua, only its own,
 *  narrow output format. A user who rewrites a line in some
 *  drastically different form (multi-line, a variable, etc.) simply
 *  won't match the regex — treated as "can't confirm this is
 *  unmodified," which correctly falls on the safe side (never
 *  auto-touch it) rather than the unsafe one. */
function parseExistingTaskLines(content: string): Map<string, string> {
  const lines = new Map<string, string>();
  for (const raw of content.split("\n")) {
    const m = raw.match(/^\s*oxis\.task\(\s*'((?:[^'\\]|\\.)*)'/);
    if (!m) continue;
    const name = m[1].replace(/\\(.)/g, "$1");
    lines.set(name, raw.trim());
  }
  return lines;
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function taskLine(t: DetectedTask): string {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n");
  return `oxis.task('${esc(t.name)}', '${esc(t.command)}', '${esc(t.description)}')`;
}

export interface ReconcileResult {
  ran: boolean; // false when there was nothing to reconcile against (no prior metadata — a fresh detection, not a reconciliation)
  added: string[];
  updated: string[];
  removed: string[];
  preservedEdited: string[]; // tasks left untouched because they'd been hand-edited since generation
}

const EMPTY_RESULT: ReconcileResult = { ran: false, added: [], updated: [], removed: [], preservedEdited: [] };

/** Runs one reconciliation pass against `externalDir` (the linked
 *  project's real directory) and `oxisTasksDir` (that workspace's own
 *  `.oxis/tasks`). Safe to call on every workspace open/reload — it's
 *  a no-op (returns ran:false) if this workspace was never linked to
 *  a project or was never auto-detected in the first place, so there
 *  is nothing to reconcile against yet. */
export async function reconcileDetectedTasks(externalDir: string, oxisTasksDir: string): Promise<ReconcileResult> {
  const metaPath = `${oxisTasksDir}/.auto-detected-meta.json`;
  const luaPath = `${oxisTasksDir}/auto-detected.lua`;

  const metaExists = (await statPath(metaPath).catch(() => ({ exists: false }))).exists;
  if (!metaExists) return EMPTY_RESULT; // never auto-detected here before — nothing to reconcile

  let oldMeta: GeneratedTasksMeta;
  try {
    oldMeta = JSON.parse(await readFile(metaPath));
  } catch {
    return EMPTY_RESULT; // corrupt/unreadable metadata — safer to leave the existing file alone entirely than guess
  }

  let existingContent = "";
  try { existingContent = await readFile(luaPath); } catch { /* file missing — treat as if every old task were already gone */ }
  const currentLines = parseExistingTaskLines(existingContent);

  // Which previously-tracked tasks has the user actually edited since
  // generation? Compare each one's CURRENT line in the file against
  // the hash recorded at generation time — a mismatch (or the line
  // being gone entirely, which itself could mean "user deleted it on
  // purpose") means this task is no longer this reconciler's to touch.
  const editedNames = new Set<string>();
  for (const [name, meta] of Object.entries(oldMeta)) {
    const currentLine = currentLines.get(name);
    if (currentLine === undefined || fnv1a(currentLine) !== meta.contentHash) {
      editedNames.add(name);
    }
  }

  const fresh = await detectProject(externalDir);
  const freshByName = new Map(fresh.tasks.map(t => [t.name, t]));

  const added: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];
  const preservedEdited: string[] = [];

  const finalTasks: DetectedTask[] = [];
  const newMeta: GeneratedTasksMeta = {};

  // 1. Carry forward every hand-edited task exactly as it is now,
  // permanently untracked going forward — regardless of whether its
  // original source still exists. This is the one rule that overrides
  // everything else here.
  for (const name of editedNames) {
    const currentLine = currentLines.get(name);
    if (currentLine === undefined) continue; // user deleted the line themselves — nothing to preserve
    preservedEdited.push(name);
    // Kept as a raw line, not a DetectedTask — see the final assembly
    // below, which writes preserved lines back verbatim rather than
    // re-deriving them through taskLine().
  }

  // 2. Reconcile every task that was tracked (untouched since
  // generation) against fresh detection: still present with the same
  // command → keep; still present with a different command (the
  // underlying script/target was renamed to run something else) →
  // update; no longer present → remove.
  for (const [name, meta] of Object.entries(oldMeta)) {
    if (editedNames.has(name)) continue; // handled above
    const freshTask = freshByName.get(name);
    if (!freshTask) {
      removed.push(name);
      continue;
    }
    const freshLine = taskLine(freshTask);
    // Not in editedNames means currentLines.get(name) already matches
    // meta.contentHash exactly — i.e. it's still exactly what was
    // last generated. So comparing the freshly-detected line against
    // that current line directly tells us whether the underlying
    // project configuration actually changed anything, with no need
    // to re-derive or re-parse either side further.
    if (freshLine !== currentLines.get(name)) {
      updated.push(name);
    }
    finalTasks.push(freshTask);
    newMeta[name] = { source: freshTask.source, generatedAt: meta.generatedAt, contentHash: fnv1a(freshLine) };
  }

  // 3. Anything fresh detection found that wasn't tracked before at
  // all (new script added, new project type appeared) is new.
  for (const t of fresh.tasks) {
    if (oldMeta[t.name] !== undefined) continue; // already handled above (tracked or edited)
    if (editedNames.has(t.name)) continue; // a hand-edited task happens to share this name — don't silently reclaim it
    added.push(t.name);
    finalTasks.push(t);
    newMeta[t.name] = { source: t.source, generatedAt: Date.now(), contentHash: fnv1a(taskLine(t)) };
  }

  if (added.length === 0 && updated.length === 0 && removed.length === 0) {
    return { ran: true, added, updated, removed, preservedEdited };
  }

  // Rebuild the file: generated content for everything still tracked
  // (finalTasks, via the normal generator — grouped/commented the
  // same way as a fresh detection), PLUS every hand-edited line
  // appended verbatim underneath its own clearly-labeled section so
  // it's visibly distinct from what OXIS still manages.
  let content = generateTasksFile({ projectTypes: fresh.projectTypes, tasks: finalTasks });
  if (preservedEdited.length > 0) {
    content += "\n-- Tasks below were hand-edited since they were generated —\n";
    content += "-- preserved exactly as you left them, no longer auto-managed.\n\n";
    for (const name of preservedEdited) {
      const line = currentLines.get(name);
      if (line) content += line + "\n";
    }
  }

  await writeFile(luaPath, content);
  await writeFile(metaPath, JSON.stringify(newMeta, null, 2));

  return { ran: true, added, updated, removed, preservedEdited };
}