/**
 * session.ts — what OXIS brings back after it's closed or crashes: each
 * terminal tab (its directory, its name, the last lines of its output,
 * the files open in its editor) and unsaved editor text. Saved every few
 * seconds and when the window closes; restored at startup (setting
 * "restoreSession"). Programs that were running aren't: their processes
 * ended with the app.
 */

import type { Line } from "./terminal";

export interface SavedLine { text: string; kind?: Line["kind"]; spans?: Line["spans"]; status?: Line["status"] }
export interface SavedTab {
  title: string;
  cwd: string;
  lines: SavedLine[];
  files: string[];
  activeFile?: string;
}
export interface Session {
  v: 1;
  savedAt: number;
  active: number;
  tabs: SavedTab[];
  /** Unsaved editor text, by path. */
  drafts: Record<string, string>;
}

const KEY = "oxis-session-v1";
const MAX_LINES = 1000;
const MAX_BYTES = 4_000_000; // well inside localStorage's limit

/** Each open tab's snapshot, by tab id, registered by its Terminal. */
const snapshots = new Map<string, () => SavedTab>();
export function registerTabSnapshot(id: string, take: () => SavedTab): () => void {
  snapshots.set(id, take);
  return () => { if (snapshots.get(id) === take) snapshots.delete(id); };
}

export function takeLines(lines: Line[]): SavedLine[] {
  return lines.slice(-MAX_LINES).map(l => {
    const out: SavedLine = { text: l.text };
    if (l.kind) out.kind = l.kind;
    if (l.spans) out.spans = l.spans;
    if (l.status) out.status = l.status;
    return out;
  });
}

/** Saves the tabs (in `order`) and drafts. */
export function saveSession(order: string[], active: string, drafts: Record<string, string>): void {
  const tabs = order.map(id => snapshots.get(id)?.()).filter((t): t is SavedTab => !!t);
  const session: Session = { v: 1, savedAt: Date.now(), active: Math.max(0, order.indexOf(active)), tabs, drafts };
  let json = JSON.stringify(session);
  // Too big: keep the text, drop the colours, then keep fewer lines.
  if (json.length > MAX_BYTES) {
    for (const t of session.tabs) t.lines = t.lines.map(({ text, kind, status }) => ({ text, kind, status }));
    json = JSON.stringify(session);
  }
  if (json.length > MAX_BYTES) {
    for (const t of session.tabs) t.lines = t.lines.slice(-200);
    json = JSON.stringify(session);
  }
  try { localStorage.setItem(KEY, json); } catch { /* storage full or unavailable: nothing to restore next time */ }
}

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    if (s?.v !== 1 || !Array.isArray(s.tabs) || s.tabs.length === 0) return null;
    return s;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  try { localStorage.removeItem(KEY); } catch { /* nothing to clear */ }
}
