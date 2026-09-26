/**
 * terminal.ts — terminal output model: lines, escape stripping, output
 * processing, and readline word operations. No React, no PTY.
 */

// ─────────────────────────────────────────────────────────────
// ANSI / VT STRIPPER (the Go side already strips; this is a second pass)
// ─────────────────────────────────────────────────────────────
const ANSI_RE = new RegExp(
  [
    // OSC:  ESC ] ... BEL  or  ESC ] ... ST (ESC \)
    "\x1b\\][^\\x07\x1b]*(?:\\x07|\x1b\\\\)",
    // DCS:  ESC P ... ST
    "\x1bP[^\x1b]*\x1b\\\\",
    // PM / APC:  ESC ^ / ESC _ ... ST
    "\x1b[\\^_][^\x1b]*\x1b\\\\",
    // CSI:  ESC [ param... final
    "\x1b\\[[\\x30-\\x3f]*[\\x20-\\x2f]*[\\x40-\\x7e]",
    // ESC + single printable
    "\x1b[\\x20-\\x7e]",
    // Bare ESC
    "\x1b",
  ].join("|"),
  "g"
);

export function stripAnsi(s: string): string {
  return s
    .replace(ANSI_RE, "")               // remove escape sequences
    .replace(/[\x00\x07\x08]/g, "");   // NUL / BEL / BS
}

/** What a line with carriage returns shows: each bare \r returns to the
 *  start of the line, so progress output ("4%\r8%\r12%") collapses to
 *  its last state. */
export function visibleText(line: string): string {
  if (!line.includes("\r")) return line;
  const parts = line.split("\r");
  for (let i = parts.length - 1; i >= 0; i--) if (parts[i] !== "") return parts[i];
  return "";
}

// ─────────────────────────────────────────────────────────────
// LINE MODEL
// ─────────────────────────────────────────────────────────────
export type LineKind =
  | "ok" | "err" | "warn" | "info" | "dim" | "accent"
  | "cmd" | "shell" | "search";

export interface Line {
  id:    number;
  text:  string;
  kind?: LineKind;
}

let _lid = 0;
export const mkLine = (text = "", kind?: LineKind): Line =>
  ({ id: _lid++, text, kind });

export const LINE_COLORS: Record<string, string> = {
  ok:     "var(--green)",
  err:    "var(--err)",
  warn:   "var(--warn)",
  info:   "var(--text)",
  dim:    "var(--dim)",
  accent: "var(--purple)",
  cmd:    "var(--purple3)",
  shell:  "var(--text)",
  search: "var(--purple2)",
};

/** What a fresh or cleared terminal shows: one short hint line. */
export function initialLines(): Line[] {
  return [mkLine("  type 'help for OXIS commands — anything else runs in your shell", "dim")];
}

// ─────────────────────────────────────────────────────────────
// OUTPUT PROCESSOR
//
// Strips ANSI, normalises line endings and splits into completed
// lines plus a trailing partial line carried to the next chunk.
// ─────────────────────────────────────────────────────────────
export function processOutput(
  raw: string,
  pending: string,
): { completedLines: string[]; newPending: string } {
  // A trailing \r is kept in `pending` so a CRLF split across two
  // chunks still reads as one line break.
  const parts = (pending + stripAnsi(raw)).replace(/\r\n/g, "\n").split("\n");
  const newPending = parts.pop() ?? "";
  return { completedLines: parts.map(visibleText), newPending };
}
/** Appends completed lines to the buffer. Unfinished lines never
 *  reach it (the caller keeps them as `pending`), so nothing is merged. */
export function mergeOutput(prev: Line[], completedLines: string[]): Line[] {
  if (completedLines.length === 0) return prev;
  const next = prev.concat(completedLines.map(t => mkLine(t, "shell")));
  // Keep memory bounded.
  return next.length > 10_000 ? next.slice(-8_000) : next;
}

// ─────────────────────────────────────────────────────────────
// WORD / LINE EDITING PRIMITIVES
// Mirrors bash readline / Emacs editing semantics exactly.
// ─────────────────────────────────────────────────────────────

/** Move cursor to start of previous word */
export function wordLeft(s: string, pos: number): number {
  let i = pos;
  // skip trailing whitespace
  while (i > 0 && /\s/.test(s[i - 1])) i--;
  // skip word chars
  while (i > 0 && /\S/.test(s[i - 1])) i--;
  return i;
}

/** Move cursor to end of next word */
export function wordRight(s: string, pos: number): number {
  let i = pos;
  // skip leading whitespace
  while (i < s.length && /\s/.test(s[i])) i++;
  // skip word chars
  while (i < s.length && /\S/.test(s[i])) i++;
  return i;
}

export function deleteWordLeft(s: string, pos: number): { text: string; pos: number } {
  const newPos = wordLeft(s, pos);
  return { text: s.slice(0, newPos) + s.slice(pos), pos: newPos };
}

export function deleteWordRight(s: string, pos: number): { text: string; pos: number } {
  const end = wordRight(s, pos);
  return { text: s.slice(0, pos) + s.slice(end), pos };
}

/** Ctrl+U — delete from cursor to start of line */
export function deleteToLineStart(s: string, pos: number): { text: string; pos: number } {
  return { text: s.slice(pos), pos: 0 };
}

/** Ctrl+K — delete from cursor to end of line */
export function deleteToLineEnd(s: string, pos: number): { text: string; pos: number } {
  return { text: s.slice(0, pos), pos };
}

/** Ctrl+T — transpose chars before and at cursor */
export function transposeChars(s: string, pos: number): { text: string; pos: number } {
  if (pos < 2 && s.length < 2) return { text: s, pos };
  const i = pos === 0 ? 0 : pos >= s.length ? s.length - 2 : pos - 1;
  const arr = s.split("");
  [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
  return { text: arr.join(""), pos: i + 2 };
}

// ─────────────────────────────────────────────────────────────
// YANK BUFFER (Ctrl+K / Ctrl+U cut → Ctrl+Y paste)
// ─────────────────────────────────────────────────────────────
let _yankBuf = "";
export function setYankBuf(s: string): void { _yankBuf = s; }
export function getYankBuf(): string        { return _yankBuf; }

// ─────────────────────────────────────────────────────────────
// PLATFORM DETECTION
// ─────────────────────────────────────────────────────────────
let shellKind = "";
/** Which shell the terminal runs ("powershell", "bash", "fish"…), as
 *  reported by the PTY; "" until it has started. */
export function currentShell(): string { return shellKind; }
export function setCurrentShell(kind: string): void { shellKind = kind; }

export function isWindows(): boolean {
  return navigator.userAgent.toLowerCase().includes("windows");
}