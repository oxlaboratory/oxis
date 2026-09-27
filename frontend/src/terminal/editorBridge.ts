/**
 * editorBridge.ts — lets plugins (oxis.editor.*) reach the file open in
 * the editor. The Editor component attaches its buffer while a file is
 * showing; plugins read and change it through here, and every change
 * goes through the editor's own undo history.
 */

export interface EditorBuffer {
  path: string;
  language: string;
  getText(): string;
  isDirty(): boolean;
  /** Offsets into the text; start === end is a plain cursor. */
  getSelection(): { start: number; end: number };
  setSelection(start: number, end: number): void;
  /** Replaces text[start, end) — one undo step for a run of plugin
   *  edits, such as an answer streamed in piece by piece. */
  replace(start: number, end: number, text: string): void;
  save(): Promise<boolean>;
}

let active: EditorBuffer | null = null;

export const editorBridge = {
  /** Called by the Editor; returns the detach function. */
  attach(buffer: EditorBuffer): () => void {
    active = buffer;
    return () => { if (active === buffer) active = null; };
  },
  active(): EditorBuffer | null {
    return active;
  },
};

/** 1-based line and column of an offset. */
export function offsetToLineCol(text: string, offset: number): { line: number; col: number } {
  offset = Math.max(0, Math.min(offset, text.length));
  let line = 1, lineStart = 0;
  for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) {
    line++;
    lineStart = i + 1;
  }
  return { line, col: offset - lineStart + 1 };
}

/** Offset of a 1-based line and column, clamped to the text. */
export function lineColToOffset(text: string, line: number, col = 1): number {
  let start = 0;
  for (let l = 1; l < Math.max(1, Math.floor(line)); l++) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) return text.length;
    start = nl + 1;
  }
  const end = text.indexOf("\n", start);
  const lineEnd = end === -1 ? text.length : end;
  return Math.min(start + Math.max(0, Math.floor(col) - 1), lineEnd);
}

/** Start of line `first` to the end of line `last` (1-based, inclusive),
 *  including the newline after it when there is one. */
export function lineRange(text: string, first: number, last: number): { start: number; end: number } {
  const start = lineColToOffset(text, first, 1);
  const lastStart = lineColToOffset(text, Math.max(first, last), 1);
  const nl = text.indexOf("\n", lastStart);
  return { start, end: nl === -1 ? text.length : nl + 1 };
}
