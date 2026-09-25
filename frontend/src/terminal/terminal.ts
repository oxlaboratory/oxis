/**
 * terminal.ts — OXIS terminal core
 * Line model · ANSI · output processing · word ops · virtual scroll
 * Zero React. Zero PTY. Zero UI.
 */

// ─────────────────────────────────────────────────────────────
// ANSI / VT STRIPPER
// Full VT100 / VT220 / xterm / ANSI SGR coverage.
// Strips everything the Go backend missed (double-pass safety).
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
    .replace(ANSI_RE, "")          // remove escape sequences
    .replace(/\r\n/g, "\n")        // normalise CRLF → LF
    .replace(/\r(?!\n)/g, "\n")    // bare CR → LF
    .replace(/[\x00\x07\x08]/g, ""); // NUL / BEL / BS
}

// ─────────────────────────────────────────────────────────────
// LINE MODEL
// ─────────────────────────────────────────────────────────────
export type LineKind =
  | "ok" | "err" | "warn" | "info" | "dim" | "accent"
  | "cmd" | "shell" | "banner" | "banner-wheel" | "search";

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
  banner: "var(--purple)",
  "banner-wheel": "var(--purple)",
  search: "var(--purple2)",
};

// ─────────────────────────────────────────────────────────────
// BANNER — the OXIS train
//
// Same art used on the home screen (App.tsx), shared from here so
// the two never drift apart. The body rows are static; the wheel row
// is a template with placeholder wheel glyphs that gets re-rendered
// through a few frames (see TRAIN_WHEEL_FRAME_CHARS / trainWheelFrame)
// to fake a spinning-wheel "the train is moving" effect on boot. The
// home screen renders the same template but never advances the
// frame, so it reads as parked.
//
// IMPORTANT — width padding:
// Both render sites (shell boot banner, startup splash) lay the
// banner out as one <div> per row inside a `text-align: center`
// container. CSS centers each row INDEPENDENTLY based on that row's
// own width. The raw art rows are NOT equal length (the train's
// silhouette is naturally uneven — roof vs. wheels vs. carriages), so
// centering them independently would shift each row by a different
// amount and visibly warp the train left/right, row to row.
// Padding every row to the same fixed width up front means
// independent-per-row centering produces the exact same result as
// centering the whole block once — the shape's internal alignment is
// preserved. Do this here, once, at the source, so every consumer
// (shell banner, startup splash) is correct automatically and can't
// regress by rendering the raw arrays directly.
// ─────────────────────────────────────────────────────────────
// The old boot banner rendered a multi-row ASCII train (plus a
// spinning-wheel animation frame) at the top of every new shell tab.
// Removed per the terminal-UX pass: it ate vertical space, delayed
// the shell feeling "live" while it printed, and had nothing to do
// with the actual terminal session starting. Replaced with a single
// plain line — no ASCII art, no animation to replace it with (the
// "OXIS" wordmark now lives in the terminal's own top-right corner
// instead, rendered once in the Terminal component's JSX, not as
// scrollback text).
export function bannerLines(): Line[] {
  return [
    mkLine("  OXIS · type 'help for commands · shell is live", "banner"),
    mkLine("", "banner"),
  ];
}

// The banner occupies exactly this many lines.
// Output from the shell is NEVER merged into a banner line.
export const BANNER_LINE_COUNT = 2;

// ─────────────────────────────────────────────────────────────
// OUTPUT PROCESSOR
//
// Rules:
//   1. Strip ANSI.
//   2. Normalise line endings.
//   3. Split into completed lines + a trailing pending fragment.
//   4. The first completed line is appended to the last output
//      line ONLY if that line is a "shell" kind AND the buffer
//      is past the banner section — never merged into banner.
// ─────────────────────────────────────────────────────────────
export function processOutput(
  raw: string,
  pending: string,
): { completedLines: string[]; newPending: string } {
  const clean    = stripAnsi(raw);
  const combined = pending + clean;
  const norm     = combined.replace(/\r\n/g, "\n").replace(/\r(?!\n)/g, "\n");
  const parts    = norm.split("\n");
  const newPending = parts.pop() ?? "";
  return { completedLines: parts, newPending };
}

/**
 * Merge completed lines into the existing line buffer.
 * Handles the banner-guard and append-to-last-line logic.
 */
export function mergeOutput(
  prev: Line[],
  completedLines: string[],
): Line[] {
  if (completedLines.length === 0) return prev;

  const next = [...prev];
  const last = next[next.length - 1];

  // Only append first chunk to last line when:
  //  - The last line is a shell output line (not banner/cmd/ok etc.)
  //  - We are past the fixed banner section
  const pastBanner = next.length > BANNER_LINE_COUNT;
  const canMerge   = pastBanner && last && (last.kind === "shell" || last.kind == null) && last.text !== "";

  if (canMerge) {
    next[next.length - 1] = mkLine(last.text + completedLines[0], "shell");
  } else {
    next.push(mkLine(completedLines[0], "shell"));
  }

  for (let i = 1; i < completedLines.length; i++) {
    next.push(mkLine(completedLines[i], "shell"));
  }

  // Evict old lines to keep memory bounded (keep last 8000)
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
export function isWindows(): boolean {
  return navigator.userAgent.toLowerCase().includes("windows");
}