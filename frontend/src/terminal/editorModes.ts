/**
 * editorModes.ts — motion/edit logic for the built-in editor's
 * Normal/Insert/Visual modes (see README § Input Modes).
 *
 * Deliberately a small, honest subset of Vim's model rather than a
 * full clone: enough real modal editing (navigation without
 * inserting text, word/line motions, delete/yank, visual selection)
 * that Normal Mode is genuinely useful, without pretending to be a
 * complete implementation. Pure functions only — no DOM, no React —
 * so they're easy to reason about and to extend later. The Editor
 * component (App.tsx) owns wiring this to an actual <textarea> and
 * to Lua-registered per-mode keymaps (`oxis.keymap("normal", ...)`
 * etc. — see pluginAPI.ts).
 */

export type EditorMode = "normal" | "insert" | "visual";

export interface CursorState {
  content: string;
  pos: number;       // caret offset into content
  anchor?: number;    // visual-mode selection anchor, undefined outside visual mode
}

function lineBounds(content: string, pos: number): { start: number; end: number } {
  const start = content.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
  const nl = content.indexOf("\n", pos);
  const end = nl === -1 ? content.length : nl;
  return { start, end };
}

export function moveLeft(c: CursorState, count = 1): number {
  return Math.max(0, c.pos - count);
}

export function moveRight(c: CursorState, count = 1): number {
  const { end } = lineBounds(c.content, c.pos);
  return Math.min(end, c.pos + count);
}

export function moveDown(c: CursorState, count = 1): number {
  let pos = c.pos;
  for (let i = 0; i < count; i++) {
    const { start, end } = lineBounds(c.content, pos);
    const col = pos - start;
    if (end >= c.content.length) break;
    const nextStart = end + 1;
    const { end: nextEnd } = lineBounds(c.content, nextStart);
    pos = Math.min(nextStart + col, nextEnd);
  }
  return pos;
}

export function moveUp(c: CursorState, count = 1): number {
  let pos = c.pos;
  for (let i = 0; i < count; i++) {
    const { start } = lineBounds(c.content, pos);
    if (start === 0) break;
    const col = pos - start;
    const prevEnd = start - 1;
    const prevStart = c.content.lastIndexOf("\n", Math.max(0, prevEnd - 1)) + 1;
    pos = Math.min(prevStart + col, prevEnd);
  }
  return pos;
}

export function moveLineStart(c: CursorState): number {
  return lineBounds(c.content, c.pos).start;
}

export function moveLineEnd(c: CursorState): number {
  return lineBounds(c.content, c.pos).end;
}

export function moveDocStart(): number {
  return 0;
}

export function moveDocEnd(c: CursorState): number {
  return c.content.length;
}

const WORD_RE = /\w/;

export function moveWordForward(c: CursorState): number {
  const { content } = c;
  let i = c.pos;
  const n = content.length;
  const isWord = (ch: string) => WORD_RE.test(ch);
  if (i < n && isWord(content[i])) { while (i < n && isWord(content[i])) i++; }
  else if (i < n) { while (i < n && !isWord(content[i]) && !/\s/.test(content[i])) i++; }
  while (i < n && /\s/.test(content[i])) i++;
  return i;
}

export function moveWordBackward(c: CursorState): number {
  const { content } = c;
  let i = c.pos;
  const isWord = (ch: string) => WORD_RE.test(ch);
  while (i > 0 && /\s/.test(content[i - 1])) i--;
  if (i > 0 && isWord(content[i - 1])) { while (i > 0 && isWord(content[i - 1])) i--; }
  else { while (i > 0 && !isWord(content[i - 1]) && !/\s/.test(content[i - 1])) i--; }
  return i;
}

/** 'x' — delete the character under the cursor. */
export function deleteChar(c: CursorState): CursorState {
  const { content, pos } = c;
  if (pos >= content.length) return c;
  return { content: content.slice(0, pos) + content.slice(pos + 1), pos };
}

/** 'dd' — delete the current line (including its newline). */
export function deleteLine(c: CursorState): CursorState {
  const { content, pos } = c;
  const { start, end } = lineBounds(content, pos);
  const withNl = content.slice(end, end + 1) === "\n" ? end + 1 : end;
  const next = content.slice(0, start) + content.slice(withNl);
  return { content: next, pos: Math.min(start, next.length) };
}

/** 'dw' — delete from cursor to the start of the next word. */
export function deleteWord(c: CursorState): CursorState {
  const target = moveWordForward(c);
  const { content, pos } = c;
  return { content: content.slice(0, pos) + content.slice(target), pos };
}

/** 'o' — open a new line below and switch to insert. */
export function openLineBelow(c: CursorState): CursorState {
  const { end } = lineBounds(c.content, c.pos);
  const content = c.content.slice(0, end) + "\n" + c.content.slice(end);
  return { content, pos: end + 1 };
}

/** 'O' — open a new line above and switch to insert. */
export function openLineAbove(c: CursorState): CursorState {
  const { start } = lineBounds(c.content, c.pos);
  const content = c.content.slice(0, start) + "\n" + c.content.slice(start);
  return { content, pos: start };
}

/** Visual-mode selection range, order-independent. */
export function selectionRange(c: CursorState): [number, number] {
  const a = c.anchor ?? c.pos;
  return a <= c.pos ? [a, c.pos + 1] : [c.pos, a + 1];
}

/** Visual 'd'/'x' — delete the selected range. */
export function deleteSelection(c: CursorState): CursorState {
  const [s, e] = selectionRange(c);
  const end = Math.min(e, c.content.length);
  return { content: c.content.slice(0, s) + c.content.slice(end), pos: s };
}

/** Visual 'y' — the selected text, for clipboard yank. Content unchanged. */
export function selectedText(c: CursorState): string {
  const [s, e] = selectionRange(c);
  return c.content.slice(s, Math.min(e, c.content.length));
}
