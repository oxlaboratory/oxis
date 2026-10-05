/**
 * terminal.ts — terminal output model: lines, escape stripping, output
 * processing, and readline word operations. No React, no PTY.
 */

import { stripSgr, type Span } from "./ansi";

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

// Kept in lines: colour codes and OSC 8 hyperlinks (ansi.ts reads both).
const SGR_ONLY_RE = /^(?:\x1b\[[0-9;:]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\))$/;

/** Like stripAnsi, but keeps colour/style sequences (see ansi.ts). */
export function stripAnsiKeepSgr(s: string): string {
  return s
    .replace(ANSI_RE, seq => (SGR_ONLY_RE.test(seq) ? seq : ""))
    .replace(/[\x00\x07\x08]/g, "");
}

/** Where the current line was erased. The PTY sends finished lines
 *  (pty/linescreen.go) so it doesn't use this any more; output from
 *  elsewhere still may. */
const LINE_ERASED = "\x1a";

/** What a line with carriage returns shows: each bare \r returns to the
 *  start of the line, so progress output ("4%\r8%\r12%") collapses to
 *  its last state, and an erased line (a finished spinner) shows only
 *  what was written after the erase. */
export function visibleText(line: string): string {
  if (!line.includes("\r") && !line.includes(LINE_ERASED)) return line;
  // Colour codes in text that gets overwritten still apply to what
  // follows, so they're kept, in order, ahead of the visible part.
  let shown = "", carried = "";
  for (const part of line.split("\r")) {
    const erased = part.lastIndexOf(LINE_ERASED);
    if (erased >= 0) {
      carried += sgrCodes(shown) + sgrCodes(part.slice(0, erased));
      shown = part.slice(erased + 1);
    } else if (stripSgr(part) !== "") {
      carried += sgrCodes(shown);
      shown = part;
    } else {
      shown += part; // only colour codes: they belong to the current text
    }
  }
  return carried + shown;
}

const sgrCodes = (s: string) => (s.includes("\x1b") ? (s.match(/\x1b\[[0-9;:]*m/g) ?? []).join("") : "");

// ─────────────────────────────────────────────────────────────
// LINE MODEL
// ─────────────────────────────────────────────────────────────
export type LineKind =
  | "ok" | "err" | "warn" | "info" | "dim" | "accent"
  | "cmd" | "shell" | "search";

export interface Line {
  id:    number;
  /** Plain text: what search, copy and every check use. */
  text:  string;
  kind?: LineKind;
  /** Colours from the shell (ansi.ts); undefined for plain lines. */
  spans?: Span[];
  /** On the line where a command was run: how it ended (from the
   *  shell's integration mark) and how long it took. */
  status?: { code: number; ms: number };
  /** On that line: the command itself, as typed (without the prompt). */
  command?: string;
  /** An inline image a program showed (OSC 1337, imgcat): the line's
   *  text is a stand-in for search, copy and a restored session. */
  image?: InlineImage;
}

export interface InlineImage {
  src: string;
  /** CSS lengths, from the program's width= and height=. */
  width?: string;
  height?: string;
  /** preserveAspectRatio=0 stretches it to both. */
  stretch?: boolean;
}

let _lid = 0;
export const mkLine = (text = "", kind?: LineKind): Line =>
  ({ id: _lid++, text, kind });

/** The id the next line will get: lines made from now on have ids at
 *  least this. */
export const nextLineId = (): number => _lid;

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
/** The command a line belongs to (the nearest command line at or above
 *  it: the ones shell integration marked with a status) and its output,
 *  up to the next command. A prompt left with nothing typed at the end
 *  isn't output. null above the first command. */
export function commandBlockAt(lines: Line[], id: number): { command: Line; output: Line[] } | null {
  const at = lines.findIndex(l => l.id === id);
  if (at < 0) return null;
  let start = at;
  while (start >= 0 && !lines[start].status) start--;
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !lines[end].status) end++;
  const command = lines[start];
  const output = lines.slice(start + 1, end);
  while (output.length) {
    const last = output[output.length - 1].text.trimEnd();
    if (last === "" || command.text.startsWith(last)) output.pop();
    else break;
  }
  return { command, output };
}

/** The output with folded commands' lines left out: each folded
 *  command line (one with a status, from shell integration) hides the
 *  lines after it up to the next command. hidden says how many each
 *  hides, for its "▸ 120 lines". */
export function foldOutput(lines: Line[], folded: ReadonlySet<number>): { lines: Line[]; hidden: Map<number, number> } {
  const hidden = new Map<number, number>();
  if (folded.size === 0) return { lines, hidden };
  const out: Line[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    out.push(l);
    if (!l.status || !folded.has(l.id)) continue;
    let j = i + 1;
    while (j < lines.length && !lines[j].status) j++;
    if (j > i + 1) hidden.set(l.id, j - i - 1);
    i = j - 1;
  }
  return { lines: out, hidden };
}

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
  // chunks still reads as one line break. Colour codes stay in the
  // lines (ansi.ts renders them); stripSgr gives the plain text.
  const parts = (pending + stripAnsiKeepSgr(raw)).replace(/\r\n/g, "\n").split("\n");
  const newPending = parts.pop() ?? "";
  return { completedLines: parts.map(visibleText), newPending };
}
/** Appends completed lines to the buffer. Unfinished lines never
 *  reach it (the caller keeps them as `pending`), so nothing is merged. */
export function mergeOutput(prev: Line[], completedLines: Array<{ text: string; spans?: Span[] }>): Line[] {
  if (completedLines.length === 0) return prev;
  const next = prev.concat(completedLines.map(l => ({ ...mkLine(l.text, "shell"), spans: l.spans })));
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

/** The shell takes PowerShell (pwsh or Windows PowerShell), not sh
 *  syntax. Git Bash on Windows doesn't; until the shell has said what it
 *  is, it's what Windows starts by default. */
export function speaksPowerShell(): boolean {
  return shellKind ? shellKind === "powershell" || shellKind === "pwsh" : isWindows();
}
/** An image's type from its first bytes (programs rarely say). */
export function sniffImageType(b: Uint8Array): string | null {
  const at = (i: number, ...xs: number[]) => xs.every((x, k) => b[i + k] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  if (at(0, 0x42, 0x4d)) return "image/bmp";
  if (at(4, 0x66, 0x74, 0x79, 0x70) && (at(8, 0x61, 0x76, 0x69, 0x66) || at(8, 0x61, 0x76, 0x69, 0x73))) return "image/avif";
  const head = new TextDecoder().decode(b.subarray(0, 256)).trimStart();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  return null;
}

/** iTerm2's width=/height= as CSS: N cells, Npx, N% or auto. */
export function imageLength(v: string | undefined, axis: "width" | "height"): string | undefined {
  if (!v || v === "auto") return undefined;
  const m = /^(\d+(?:\.\d+)?)(px|%)?$/.exec(v);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (m[2] === "px") return `${n}px`;
  if (m[2] === "%") return `${n}%`;
  return axis === "width" ? `${n}ch` : `calc(${n} * var(--lh))`;
}

/** An OSC 1337 File= mark ("1337;<args>:<base64>") as an image line, or
 *  null when it isn't an image OXIS can show. */
export function inlineImageLine(mark: string): Line | null {
  const body = mark.slice("1337;".length);
  const colon = body.indexOf(":");
  if (colon < 0) return null;
  const args = new Map(body.slice(0, colon).split(";").map(kv => {
    const i = kv.indexOf("=");
    return [i < 0 ? kv : kv.slice(0, i), i < 0 ? "" : kv.slice(i + 1)] as [string, string];
  }));
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    const bin = atob(body.slice(colon + 1).replace(/\s+/g, ""));
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch { return null; }
  const type = sniffImageType(bytes);
  if (!type) return null;
  let name = "";
  try { name = args.get("name") ? new TextDecoder().decode(Uint8Array.from(atob(args.get("name")!), c => c.charCodeAt(0))) : ""; } catch { /* unnamed */ }
  name = name.replace(/^.*[\\/]/, "");
  const src = URL.createObjectURL(new Blob([bytes], { type }));
  const line = mkLine(`[image${name ? ` ${name}` : ""}]`);
  line.image = {
    src,
    width: imageLength(args.get("width"), "width"),
    height: imageLength(args.get("height"), "height"),
    stretch: args.get("preserveAspectRatio") === "0",
  };
  return line;
}
