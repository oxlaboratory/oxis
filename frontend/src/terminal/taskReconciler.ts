/**
 * taskReconciler.ts — keeps .oxis/tasks/auto-detected.lua in step with
 * the linked project whenever the workspace opens or reloads.
 *
 * A generated task the user has edited (its line no longer matches the
 * recorded hash) is never changed or removed again; it's kept verbatim.
 */

import { readFile, writeFile, statPath } from "../native";
import {
  detectProject,
  generateTasksFile,
  type DetectedTask,
  type GeneratedTasksMeta,
} from "./projectDetector";

/** name → current line for each oxis.task(...) in auto-detected.lua.
 *  Line-based, matching generateTasksFile's own output; a line rewritten
 *  in another form won't match and is treated as user-edited. */
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

/** One reconciliation pass. Returns ran:false if the workspace was
 *  never linked or auto-detected. */
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

  // Tasks whose current line no longer matches the recorded hash (or
  // is gone) were edited by the user and are left alone.
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

  // 2. For each still-generated task: same command → keep, different
  // command → update, no longer detected → remove.
  for (const [name, meta] of Object.entries(oldMeta)) {
    if (editedNames.has(name)) continue; // handled above
    const freshTask = freshByName.get(name);
    if (!freshTask) {
      removed.push(name);
      continue;
    }
    const freshLine = taskLine(freshTask);
    // Its current line equals the generated one, so comparing with the
    // fresh detection shows whether the project changed.
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

  // Rebuild: generated tasks plus the user-edited lines, verbatim, in
  // their own section.
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