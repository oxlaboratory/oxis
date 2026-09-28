/**
 * editorCommands.ts — the editor's editing commands, as functions from
 * the text and selection to the new text and selection: indent and
 * outdent, toggle comments, move, duplicate and delete lines, a new
 * line that keeps (and adds) indentation, closing brackets and quotes
 * as they're typed, smart Home, select word / next occurrence / line,
 * and formatting JSON. The editor applies the result as one undo step.
 */

export interface EditState {
  text: string;
  start: number;
  end: number;
}

const OPENERS: Record<string, string> = { "(": ")", "[": "]", "{": "}", '"': '"', "'": "'", "`": "`" };
const CLOSERS = new Set([")", "]", "}"]);

/** The indentation the file uses: a tab, or 2 or 4 spaces. */
export function indentUnit(text: string): string {
  let tabs = 0, two = 0, four = 0;
  const lines = text.split("\n", 400);
  for (const line of lines) {
    const m = /^([ \t]+)\S/.exec(line);
    if (!m) continue;
    if (m[1].startsWith("\t")) tabs++;
    else if (m[1].length % 4 === 0) four++;
    else if (m[1].length % 2 === 0) two++;
  }
  if (tabs > two + four) return "\t";
  return four > two * 2 ? "    " : "  ";
}

/** Start of the line an offset is on. */
const lineStart = (t: string, at: number) => t.lastIndexOf("\n", at - 1) + 1;
/** End of the line (the offset of its line break, or the text's end). */
const lineEnd = (t: string, at: number) => { const i = t.indexOf("\n", at); return i < 0 ? t.length : i; };

/** The whole lines the selection touches: [first line start, last line end). */
function selectedLines(s: EditState): [number, number] {
  const from = lineStart(s.text, s.start);
  // A selection ending at the start of a line doesn't include that line.
  const endAt = s.end > s.start && s.text[s.end - 1] === "\n" ? s.end - 1 : s.end;
  return [from, lineEnd(s.text, endAt)];
}

/** Applies fn to each selected line; keeps the selection on them. */
function mapLines(s: EditState, fn: (line: string) => string): EditState {
  const [from, to] = selectedLines(s);
  const before = s.text.slice(from, to).split("\n");
  const after = before.map(fn);
  const text = s.text.slice(0, from) + after.join("\n") + s.text.slice(to);
  if (s.start === s.end) {
    // A caret moves with its line's change.
    const delta = after[0].length - before[0].length;
    const pos = Math.max(from, s.start + delta);
    return { text, start: pos, end: pos };
  }
  return { text, start: from, end: from + after.join("\n").length };
}

export function indentLines(s: EditState, unit: string): EditState {
  return mapLines(s, line => (line.trim() ? unit + line : line));
}

export function outdentLines(s: EditState, unit: string): EditState {
  return mapLines(s, line => {
    if (line.startsWith("\t")) return line.slice(1);
    const spaces = /^ */.exec(line)![0].length;
    return line.slice(Math.min(spaces, unit === "\t" ? 4 : unit.length));
  });
}

/** How a line is commented out in a file of this kind. */
export function commentStyle(path: string): { line?: string; block?: [string, string] } {
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  if (["js", "jsx", "mjs", "cjs", "ts", "tsx", "go", "c", "h", "cpp", "hpp", "cs", "java", "kt", "swift", "rs", "dart", "scala", "php", "scss", "less", "jsonc"].includes(ext)) return { line: "//" };
  if (["py", "sh", "bash", "zsh", "yml", "yaml", "toml", "rb", "r", "ps1", "conf", "ini", "env", "dockerfile", "mk"].includes(ext)) return { line: "#" };
  if (["lua", "sql", "hs"].includes(ext)) return { line: "--" };
  if (ext === "css") return { block: ["/*", "*/"] };
  if (["html", "htm", "xml", "svg", "md", "vue"].includes(ext)) return { block: ["<!--", "-->"] };
  if (ext === "bat" || ext === "cmd") return { line: "REM" };
  return { line: "#" };
}

/** Comments the selected lines out, or back in if they all are. */
export function toggleComment(s: EditState, path: string): EditState {
  const style = commentStyle(path);
  const [from, to] = selectedLines(s);
  const lines = s.text.slice(from, to).split("\n");
  const content = lines.filter(l => l.trim());
  if (style.line) {
    const tok = style.line;
    const all = content.length > 0 && content.every(l => l.trimStart().startsWith(tok));
    const indent = Math.min(...content.map(l => /^\s*/.exec(l)![0].length), Infinity);
    return mapLines(s, l => {
      if (!l.trim()) return l;
      if (all) return l.replace(new RegExp(`^(\\s*)${tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} ?`), "$1");
      return l.slice(0, indent) + tok + " " + l.slice(indent);
    });
  }
  const [open, close] = style.block!;
  const all = content.length > 0 && content.every(l => l.trimStart().startsWith(open) && l.trimEnd().endsWith(close));
  return mapLines(s, l => {
    if (!l.trim()) return l;
    const lead = /^\s*/.exec(l)![0];
    if (all) return lead + l.trim().slice(open.length, -close.length).trim();
    return `${lead}${open} ${l.trim()} ${close}`;
  });
}

/** Moves the selected lines up (-1) or down (1). */
export function moveLines(s: EditState, dir: -1 | 1): EditState {
  const [from, to] = selectedLines(s);
  if (dir < 0 && from === 0) return s;
  if (dir > 0 && to >= s.text.length) return s;
  const block = s.text.slice(from, to);
  if (dir < 0) {
    const prevStart = lineStart(s.text, from - 1);
    const prev = s.text.slice(prevStart, from - 1);
    const text = s.text.slice(0, prevStart) + block + "\n" + prev + s.text.slice(to);
    const shift = -(prev.length + 1);
    return { text, start: s.start + shift, end: s.end + shift };
  }
  const nextEnd = lineEnd(s.text, to + 1);
  const next = s.text.slice(to + 1, nextEnd);
  const text = s.text.slice(0, from) + next + "\n" + block + s.text.slice(nextEnd);
  const shift = next.length + 1;
  return { text, start: s.start + shift, end: s.end + shift };
}

/** Copies the selected lines above (-1) or below (1) them; the copy is selected. */
export function duplicateLines(s: EditState, dir: -1 | 1): EditState {
  const [from, to] = selectedLines(s);
  const block = s.text.slice(from, to);
  const text = s.text.slice(0, to) + "\n" + block + s.text.slice(to);
  if (dir < 0) return { text, start: s.start, end: s.end };
  const shift = block.length + 1;
  return { text, start: s.start + shift, end: s.end + shift };
}

/** Deletes the selected lines. */
export function deleteLines(s: EditState): EditState {
  const [from, to] = selectedLines(s);
  const cutFrom = to < s.text.length ? from : Math.max(0, from - 1);
  const cutTo = to < s.text.length ? to + 1 : to;
  const text = s.text.slice(0, cutFrom) + s.text.slice(cutTo);
  const pos = Math.min(cutFrom === from ? from : lineStart(text, cutFrom), text.length);
  return { text, start: pos, end: pos };
}

/** Enter: a new line with the current line's indentation, one more after
 *  an opening bracket (or a ":" in Python/YAML, or an opening HTML tag),
 *  and the closing bracket on a line of its own when it's right there. */
export function newline(s: EditState, unit: string, path: string): EditState {
  const { text } = s;
  const ls = lineStart(text, s.start);
  const base = /^[ \t]*/.exec(text.slice(ls, s.start))![0];
  const before = text.slice(ls, s.start).trimEnd();
  const after = text.slice(s.end, lineEnd(text, s.end));
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  const last = before.slice(-1);
  let opens = /[([{]$/.test(before)
    || ((ext === "py" || ext === "yml" || ext === "yaml") && last === ":")
    || /=>\s*$/.test(before);
  const htmlOpen = /<([A-Za-z][\w-]*)(\s[^<>]*)?>$/.exec(before);
  const VOID = /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i;
  if (htmlOpen && !VOID.test(htmlOpen[1]) && !before.endsWith("/>")) opens = true;
  const closesRightAfter = (last in OPENERS && after.trimStart().startsWith(OPENERS[last]))
    || (!!htmlOpen && after.trimStart().toLowerCase().startsWith(`</${htmlOpen[1].toLowerCase()}`));
  let insert = "\n" + base + (opens ? unit : "");
  const caret = s.start + insert.length;
  if (opens && closesRightAfter) insert += "\n" + base;
  const next = text.slice(0, s.start) + insert + text.slice(s.end).replace(/^[ \t]+/, m => (opens && closesRightAfter ? "" : m));
  return { text: next, start: caret, end: caret };
}

/** Typing an opening bracket or quote: its partner goes in too (or the
 *  selection is wrapped); typing a closer that's already next is a step
 *  over it. null means type the character normally. */
export function typePair(s: EditState, ch: string): EditState | null {
  const { text } = s;
  const next = text[s.end] ?? "";
  const prev = text[s.start - 1] ?? "";
  if (s.start !== s.end && ch in OPENERS) {
    const inner = text.slice(s.start, s.end);
    return { text: text.slice(0, s.start) + ch + inner + OPENERS[ch] + text.slice(s.end), start: s.start + 1, end: s.end + 1 };
  }
  if (s.start !== s.end) return null;
  // Step over a closer (or closing quote) that's already there.
  if ((CLOSERS.has(ch) || ch === '"' || ch === "'" || ch === "`") && next === ch) {
    return { text, start: s.start + 1, end: s.start + 1 };
  }
  if (!(ch in OPENERS)) return null;
  const isQuote = ch === '"' || ch === "'" || ch === "`";
  // Pair only where it can't be meant alone: before a space, a closer
  // or the end; a quote not straight after a word (don't, it's).
  if (next && !/[\s)\]},;:]/.test(next)) return null;
  if (isQuote && /[\w$\\]/.test(prev)) return null;
  if (isQuote && prev === ch) return null;
  return { text: text.slice(0, s.start) + ch + OPENERS[ch] + text.slice(s.end), start: s.start + 1, end: s.start + 1 };
}

/** Backspace between an empty pair, "(|)" or "\"|\"", deletes both. */
export function deletePair(s: EditState): EditState | null {
  if (s.start !== s.end || s.start === 0) return null;
  const prev = s.text[s.start - 1], next = s.text[s.start];
  if (prev in OPENERS && OPENERS[prev] === next) {
    return { text: s.text.slice(0, s.start - 1) + s.text.slice(s.start + 1), start: s.start - 1, end: s.start - 1 };
  }
  return null;
}

/** Home: to the first character of the line that isn't a space, and to
 *  the very start if already there. */
export function smartHome(s: EditState): number {
  const ls = lineStart(s.text, s.start);
  const first = ls + /^[ \t]*/.exec(s.text.slice(ls, lineEnd(s.text, ls)))![0].length;
  return s.start === first ? ls : first;
}

/** Ctrl+D: select the word at the caret; with something selected, the
 *  next place it appears (from the top again at the end). */
export function selectNext(s: EditState): EditState | null {
  const { text } = s;
  if (s.start === s.end) {
    const isWord = (c: string | undefined) => c !== undefined && /[\w$]/.test(c);
    let a = s.start, b = s.start;
    while (a > 0 && isWord(text[a - 1])) a--;
    while (b < text.length && isWord(text[b])) b++;
    return a < b ? { text, start: a, end: b } : null;
  }
  const needle = text.slice(s.start, s.end);
  let at = text.indexOf(needle, s.end);
  if (at < 0) at = text.indexOf(needle);
  return at < 0 || at === s.start ? null : { text, start: at, end: at + needle.length };
}

/** Ctrl+L: select the line (and the next one each time again). */
export function selectLine(s: EditState): EditState {
  const [from, to] = selectedLines(s);
  const whole = s.start === from && (s.end === to + 1 || s.end === to);
  const endLine = whole ? lineEnd(s.text, Math.min(to + 1, s.text.length)) : to;
  return { text: s.text, start: from, end: Math.min(endLine + 1, s.text.length) };
}

/** Shift+Alt+F: formats a JSON file (the only language it knows). */
export function formatDocument(s: EditState, path: string, unit: string): { state?: EditState; error?: string } {
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  if (ext !== "json") return { error: "formatting is available for JSON files" };
  try {
    const text = JSON.stringify(JSON.parse(s.text), null, unit) + (s.text.endsWith("\n") ? "\n" : "");
    const pos = s.start >= s.text.length ? text.length : Math.min(s.start, text.length);
    return { state: { text, start: pos, end: pos } };
  } catch {
    return { error: "the JSON has a mistake to fix first (see the problems)" };
  }
}
