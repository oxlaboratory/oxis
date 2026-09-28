/**
 * editorDecor.ts — what the editor paints around the text: squiggles
 * under mistakes (codeCheck.ts) with the message at the end of the
 * line, find and replace matches, the bracket matching the one at the
 * caret, and the other places the word at the caret appears. They're
 * drawn in a layer of their own behind the highlighted text (the text
 * itself is transparent there), laid out exactly like it.
 */

import type { Problem } from "./codeCheck";

export type MarkKind = "find" | "find-now" | "replace" | "replace-now" | "bracket" | "word";

export interface Mark {
  from: number;
  to: number;
  kind: MarkKind;
}

/** Where each line starts; line n (0-based) is text[starts[n] …]. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

/** The 0-based line an offset is on. */
export function lineAt(starts: number[], offset: number): number {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo;
}

const escapeHtml = (s: string) => s.replace(/[&<>]/g, c => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));

/** The decoration layer's HTML: the text (transparent, for layout)
 *  with the marked parts wrapped, and each problem's message after the
 *  end of its line. */
export function decorHtml(text: string, problems: Problem[], marks: Mark[]): string {
  type Range = { from: number; to: number; cls: string };
  const ranges: Range[] = [];
  for (const p of problems) {
    let { from, to } = p;
    // A problem on nothing visible (a line break) goes on the character before it.
    if (from >= text.length || /^\s*$/.test(text.slice(from, to))) {
      let k = Math.min(from, text.length) - 1;
      while (k > 0 && /\s/.test(text[k])) k--;
      from = Math.max(0, k);
      to = from + 1;
    }
    ranges.push({ from, to: Math.min(to, text.length), cls: p.severity === "error" ? "dx-err" : "dx-warn" });
  }
  for (const m of marks) ranges.push({ from: m.from, to: Math.min(m.to, text.length), cls: `dx-${m.kind}` });

  // The message for each line with a problem: the first error, else the first warning.
  const lens = new Map<number, Problem>();
  if (problems.length) {
    const starts = lineStarts(text);
    for (const p of problems.slice(0, 500)) {
      const line = lineAt(starts, Math.min(p.from, Math.max(0, text.length - 1)));
      const cur = lens.get(line);
      if (!cur || (cur.severity === "warning" && p.severity === "error")) lens.set(line, p);
    }
  }
  const lensAt = new Map<number, Problem>(); // keyed by the offset of the line's end
  if (lens.size) {
    const starts = lineStarts(text);
    for (const [line, p] of lens) {
      const end = line + 1 < starts.length ? starts[line + 1] - 1 : text.length;
      lensAt.set(end, p);
    }
  }

  // Every point where something starts or ends, then the text between.
  const points = new Set<number>([0, text.length]);
  for (const r of ranges) { points.add(r.from); points.add(r.to); }
  for (const at of lensAt.keys()) points.add(at);
  const sorted = [...points].filter(p => p >= 0 && p <= text.length).sort((a, b) => a - b);
  ranges.sort((a, b) => a.from - b.from);
  const active: Range[] = [];
  let next = 0;
  let html = "";
  for (let k = 0; k < sorted.length; k++) {
    const at = sorted[k];
    const lensHere = lensAt.get(at);
    if (lensHere) {
      const icon = lensHere.severity === "error" ? "✗" : "⚠";
      html += `<span class="dx-lens dx-lens--${lensHere.severity}">    ${icon} ${escapeHtml(lensHere.message)}</span>`;
    }
    if (k === sorted.length - 1) break;
    const end = sorted[k + 1];
    for (let i = active.length - 1; i >= 0; i--) if (active[i].to <= at) active.splice(i, 1);
    while (next < ranges.length && ranges[next].from <= at) {
      if (ranges[next].to > at) active.push(ranges[next]);
      next++;
    }
    if (active.length) {
      html += `<span class="${[...new Set(active.map(r => r.cls))].join(" ")}">${escapeHtml(text.slice(at, end))}</span>`;
      continue;
    }
    // Unmarked text is invisible here, so only what places the next mark
    // is kept: the line breaks, and the start of the line it's on. (A
    // large file would otherwise lay out all of its text a second time.)
    const first = text.indexOf("\n", at);
    if (first < 0 || first >= end) { html += escapeHtml(text.slice(at, end)); continue; }
    const last = text.lastIndexOf("\n", end - 1);
    html += "\n".repeat(countBreaks(text, first, last + 1)) + escapeHtml(text.slice(last + 1, end));
  }
  // Like the highlight layer, a trailing newline needs a line after it;
  // and the layer is as wide as the longest line, so it scrolls sideways
  // as far as the text does.
  if (text.endsWith("\n")) html += "\n";
  return html + " ".repeat(longestLine(text));
}

function countBreaks(text: string, from: number, to: number): number {
  let n = 0;
  for (let i = text.indexOf("\n", from); i >= 0 && i < to; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

/** The longest line's length, a tab counted as 8. */
function longestLine(text: string): number {
  let most = 0, start = 0;
  for (;;) {
    const i = text.indexOf("\n", start);
    const end = i < 0 ? text.length : i;
    if (end - start > most) {
      let tabs = 0;
      for (let k = start; k < end; k++) if (text.charCodeAt(k) === 9) tabs++;
      most = Math.max(most, end - start + 7 * tabs);
    }
    if (i < 0) return most;
    start = i + 1;
  }
}

const OPEN = "([{", CLOSE = ")]}";

/** The bracket next to the caret and the one that matches it, or null.
 *  (Brackets in strings and comments aren't told apart: good enough to
 *  show where a block ends.) */
export function matchingBracket(text: string, caret: number): [number, number] | null {
  for (const at of [caret - 1, caret]) {
    const c = text[at];
    if (c === undefined) continue;
    const o = OPEN.indexOf(c), cl = CLOSE.indexOf(c);
    if (o < 0 && cl < 0) continue;
    const forward = o >= 0;
    const open = forward ? c : OPEN[cl], close = forward ? CLOSE[o] : c;
    let depth = 0;
    const limit = 200_000;
    for (let i = at, n = 0; i >= 0 && i < text.length && n < limit; i += forward ? 1 : -1, n++) {
      if (text[i] === open) depth += forward ? 1 : -1;
      else if (text[i] === close) depth += forward ? -1 : 1;
      if (depth === 0) return forward ? [at, i] : [i, at];
    }
    return null;
  }
  return null;
}

/** The other places the word at the caret appears (whole words only),
 *  or none if the caret isn't on a word or there are too many. */
export function wordOccurrences(text: string, caret: number): Array<[number, number]> {
  if (text.length > 400_000) return [];
  const isWord = (c: string | undefined) => c !== undefined && /[\w$]/.test(c);
  let s = caret, e = caret;
  while (s > 0 && isWord(text[s - 1])) s--;
  while (e < text.length && isWord(text[e])) e++;
  const word = text.slice(s, e);
  if (word.length < 2 || /^\d+$/.test(word)) return [];
  const out: Array<[number, number]> = [];
  for (let i = text.indexOf(word); i >= 0; i = text.indexOf(word, i + word.length)) {
    if (!isWord(text[i - 1]) && !isWord(text[i + word.length]) && i !== s) out.push([i, i + word.length]);
    if (out.length > 300) return [];
  }
  return out;
}
