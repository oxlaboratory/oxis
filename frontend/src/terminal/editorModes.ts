/**
 * editorModes.ts — pure motion/edit functions for the editor's
 * Normal/Insert/Visual modes: a small subset of Vim (motions,
 * delete/yank, visual selection). App.tsx wires them to the textarea.
 */

export type EditorMode = "normal" | "insert" | "visual";

export interface CursorState {
  content: string;
  pos: number;       // caret offset into content
  anchor?: number;    // visual-mode selection anchor, undefined outside visual mode
}

function lineBounds(content: string, pos: number): { start: number; end: number } {
  // lastIndexOf treats a negative fromIndex as 0 and would find a
  // newline at offset 0, so position 0 is handled on its own.
  const start = pos === 0 ? 0 : content.lastIndexOf("\n", pos - 1) + 1;
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

/** Column of pos within its line. */
export function columnOf(content: string, pos: number): number {
  return pos - lineBounds(content, pos).start;
}

/** j and k keep the column they started from (or `want`, the column an
 *  earlier j/k started from) across shorter lines on the way. */
export function moveDown(c: CursorState, count = 1, want?: number): number {
  let pos = c.pos;
  const col = want ?? columnOf(c.content, pos);
  for (let i = 0; i < count; i++) {
    const { end } = lineBounds(c.content, pos);
    if (end >= c.content.length) break;
    const nextStart = end + 1;
    const { end: nextEnd } = lineBounds(c.content, nextStart);
    pos = Math.min(nextStart + col, nextEnd);
  }
  return pos;
}

export function moveUp(c: CursorState, count = 1, want?: number): number {
  let pos = c.pos;
  const col = want ?? columnOf(c.content, pos);
  for (let i = 0; i < count; i++) {
    const { start } = lineBounds(c.content, pos);
    if (start === 0) break;
    const prevEnd = start - 1;
    const prevStart = prevEnd === 0 ? 0 : c.content.lastIndexOf("\n", prevEnd - 1) + 1;
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

/** 'e' — the end of this word (or the next one, from its end). */
export function moveWordEnd(c: CursorState): number {
  const { content } = c;
  const n = content.length;
  const isWord = (ch: string) => WORD_RE.test(ch);
  let i = Math.min(c.pos + 1, n);
  while (i < n && /\s/.test(content[i])) i++;
  if (i < n && isWord(content[i])) { while (i + 1 < n && isWord(content[i + 1])) i++; }
  else { while (i + 1 < n && !isWord(content[i + 1]) && !/\s/.test(content[i + 1])) i++; }
  return Math.min(i, Math.max(0, n - 1));
}

/** '^' — the first character on the line that isn't a space or tab. */
export function moveFirstNonBlank(c: CursorState): number {
  const { start, end } = lineBounds(c.content, c.pos);
  let i = start;
  while (i < end && (c.content[i] === " " || c.content[i] === "\t")) i++;
  return i;
}

/** What 'y'/'d' put away for 'p': whole lines, or a run of characters. */
export interface Register { text: string; linewise: boolean }

/** The `count` lines from the cursor's, each with its newline. */
export function lineRange(c: CursorState, count = 1): { start: number; end: number } {
  const { start } = lineBounds(c.content, c.pos);
  let end = start;
  for (let i = 0; i < count; i++) {
    const nl = c.content.indexOf("\n", end);
    if (nl === -1) { end = c.content.length; break; }
    end = nl + 1;
  }
  return { start, end };
}

/** 'yy' — the line (or `count` lines), as a register. */
export function yankLines(c: CursorState, count = 1): Register {
  const { start, end } = lineRange(c, count);
  let text = c.content.slice(start, end);
  if (!text.endsWith("\n")) text += "\n";
  return { text, linewise: true };
}

/** 'dd' with a count — the lines go, and into the register. The cursor
 *  lands on the first non-blank of the line that takes their place. */
export function deleteLines(c: CursorState, count = 1): { state: CursorState; register: Register } {
  const register = yankLines(c, count);
  const { start, end } = lineRange(c, count);
  // The last lines have no newline after them: the one before goes instead.
  const lastLines = end === c.content.length && !c.content.slice(start, end).endsWith("\n") && start > 0;
  const from = lastLines ? start - 1 : start;
  const content = c.content.slice(0, from) + c.content.slice(end);
  const lineStart = !lastLines ? start : from === 0 ? 0 : content.lastIndexOf("\n", from - 1) + 1;
  return { state: { content, pos: moveFirstNonBlank({ content, pos: Math.min(lineStart, content.length) }) }, register };
}

/** 'p' / 'P' — the register after (or before) the cursor: below or
 *  above the line when it holds lines. */
export function paste(c: CursorState, reg: Register, before: boolean): CursorState {
  if (!reg.text) return c;
  if (reg.linewise) {
    const { start, end } = lineBounds(c.content, c.pos);
    if (before) return { content: c.content.slice(0, start) + reg.text + c.content.slice(start), pos: start };
    const atEnd = end >= c.content.length;
    const insertAt = atEnd ? c.content.length : end + 1;
    const text = atEnd ? "\n" + reg.text.replace(/\n$/, "") : reg.text;
    return { content: c.content.slice(0, insertAt) + text + c.content.slice(insertAt), pos: atEnd ? insertAt + 1 : insertAt };
  }
  const at = before ? c.pos : Math.min(c.pos + 1, lineBounds(c.content, c.pos).end);
  return { content: c.content.slice(0, at) + reg.text + c.content.slice(at), pos: at + reg.text.length - 1 };
}

/** 'D' — from the cursor to the end of the line; the cursor ends on
 *  the line's new last character. */
export function deleteToLineEnd(c: CursorState): { state: CursorState; register: Register } {
  const { start, end } = lineBounds(c.content, c.pos);
  return {
    state: { content: c.content.slice(0, c.pos) + c.content.slice(end), pos: Math.max(start, c.pos - 1) },
    register: { text: c.content.slice(c.pos, end), linewise: false },
  };
}

/** 'cc' — the line emptied (its indentation kept), ready to type. */
export function changeLine(c: CursorState): CursorState {
  const { start, end } = lineBounds(c.content, c.pos);
  const indent = /^[ \t]*/.exec(c.content.slice(start, end))![0];
  return { content: c.content.slice(0, start) + indent + c.content.slice(end), pos: start + indent.length };
}

/** 'cw' / 'ce' — to the end of the word, ready to type. */
export function changeWord(c: CursorState): CursorState {
  const ch = c.content[c.pos];
  const end = ch === undefined || /\s/.test(ch) ? moveWordForward(c) : moveWordEnd({ ...c, pos: Math.max(0, c.pos - 1) }) + 1;
  return { content: c.content.slice(0, c.pos) + c.content.slice(Math.max(c.pos, end)), pos: c.pos };
}

/** 'r' — the character under the cursor replaced. */
export function replaceChar(c: CursorState, ch: string): CursorState {
  if (c.pos >= c.content.length || c.content[c.pos] === "\n") return c;
  return { content: c.content.slice(0, c.pos) + ch + c.content.slice(c.pos + 1), pos: c.pos };
}

/** 'J' — the next line joined onto this one with a space. */
export function joinLines(c: CursorState): CursorState {
  const { end } = lineBounds(c.content, c.pos);
  if (end >= c.content.length) return c;
  const rest = c.content.slice(end + 1).replace(/^[ \t]+/, "");
  const head = c.content.slice(0, end).replace(/[ \t]+$/, "");
  const sep = rest.startsWith(")") || head === "" ? "" : " ";
  return { content: head + sep + rest, pos: head.length };
}

/** '~' — the case of the character under the cursor flipped, then on. */
export function toggleCase(c: CursorState): CursorState {
  const ch = c.content[c.pos];
  if (ch === undefined || ch === "\n") return c;
  const flipped = ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase();
  const content = c.content.slice(0, c.pos) + flipped + c.content.slice(c.pos + 1);
  return { content, pos: Math.min(c.pos + 1, lineBounds(content, c.pos).end) };
}

/** '>>' / '<<' — the line indented or outdented by `unit`. */
export function shiftLine(c: CursorState, unit: string, out: boolean): CursorState {
  const { start, end } = lineBounds(c.content, c.pos);
  const line = c.content.slice(start, end);
  let next = line;
  if (!out) next = unit + line;
  else if (line.startsWith(unit)) next = line.slice(unit.length);
  else next = line.replace(/^[ \t]{1,8}/, m => m.slice(Math.min(m.length, unit.length)));
  const content = c.content.slice(0, start) + next + c.content.slice(end);
  return { content, pos: moveFirstNonBlank({ content, pos: start }) };
}

/** 'n' / 'N' — the next (or previous) place `query` appears, wrapping
 *  around; null if it doesn't. Case-insensitive, like the find bar. */
export function findNext(c: CursorState, query: string, backward: boolean): number | null {
  if (!query) return null;
  const hay = c.content.toLowerCase(), q = query.toLowerCase();
  if (!backward) {
    const at = hay.indexOf(q, c.pos + 1);
    return at >= 0 ? at : (hay.indexOf(q) >= 0 ? hay.indexOf(q) : null);
  }
  const at = c.pos > 0 ? hay.lastIndexOf(q, c.pos - 1) : -1;
  return at >= 0 ? at : (hay.lastIndexOf(q) >= 0 ? hay.lastIndexOf(q) : null);
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
