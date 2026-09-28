/**
 * codeCheck.ts — finds mistakes in a file as it's edited, for the
 * editor's squiggles, gutter marks, minimap and problems list.
 *
 * JSON is parsed by a small parser that says what's wrong in words
 * (a missing comma, a trailing one, a key without quotes); HTML by a
 * tag scanner (unclosed quotes and tags, closing tags with no opening
 * one, elements left open, duplicate ids), with its <script> and
 * <style> checked as JS and CSS; JS and TS (with JSX) by Babel's parser,
 * in a worker so a big file doesn't hold up typing; Lua by the Lua compiler OXIS
 * already has; CSS for braces and missing semicolons; other languages
 * for brackets and strings. Only mistakes that are certain are errors;
 * the rest are warnings.
 */

import { checkLuaSyntax } from "../plugins/luaRuntime";

export type Severity = "error" | "warning";

export interface Problem {
  /** Offsets into the text: the part that's wrong. */
  from: number;
  to: number;
  severity: Severity;
  message: string;
}

/** Past this size a file isn't checked (it would slow typing down). */
const MAX_CHECKED = 1_500_000;

const error = (from: number, to: number, message: string): Problem => ({ from, to: Math.max(to, from + 1), severity: "error", message });
const warning = (from: number, to: number, message: string): Problem => ({ from, to: Math.max(to, from + 1), severity: "warning", message });

/** Checks a file's text; the problems come sorted by where they are. */
export async function checkCode(text: string, path: string): Promise<Problem[]> {
  if (text.length > MAX_CHECKED) return [];
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const ext = name.includes(".") ? name.split(".").pop()! : "";
  let problems: Problem[] = [];
  switch (ext) {
    case "json":
      problems = checkJson(text, isJsonc(path, name));
      break;
    case "jsonc": case "json5":
      problems = checkJson(text, true);
      break;
    case "html": case "htm": case "xhtml":
      problems = await checkHtml(text);
      break;
    case "css": case "scss": case "less":
      problems = checkCss(text, 0, ext !== "css");
      break;
    case "js": case "mjs": case "cjs": case "jsx":
    case "ts": case "mts": case "cts": case "tsx":
      problems = await checkScript(text, ext);
      break;
    case "lua":
      problems = checkLua(text);
      break;
    case "py": case "pyw":
      problems = checkBrackets(text, PYTHON);
      break;
    case "go":
      problems = checkBrackets(text, GO);
      break;
    case "rs":
      problems = checkBrackets(text, RUST);
      break;
    case "c": case "h": case "cpp": case "cc": case "hpp": case "cxx": case "java": case "cs":
    case "kt": case "kts": case "swift": case "dart": case "scala": case "php": case "groovy":
      problems = checkBrackets(text, C_LIKE);
      break;
    case "yml": case "yaml":
      problems = checkYaml(text);
      break;
  }
  problems.push(...checkMergeConflicts(text));
  // A problem at the very end (something missing) goes on the last
  // character there is.
  for (const p of problems) {
    if (p.from >= text.length) {
      let k = text.length - 1;
      while (k > 0 && /\s/.test(text[k])) k--;
      p.from = Math.max(0, k);
      p.to = p.from + 1;
    }
    p.to = Math.min(p.to, Math.max(text.length, p.from + 1));
  }
  return problems.sort((a, b) => a.from - b.from || (a.severity === "error" ? -1 : 1));
}

/** JSON that allows comments and trailing commas (tsconfig, VS Code). */
function isJsonc(path: string, name: string): boolean {
  return /^(tsconfig|jsconfig)(\..+)?\.json$/.test(name) || /[\\/]\.vscode[\\/]/.test(path)
    || name === "devcontainer.json" || name === ".eslintrc.json" || name === ".babelrc.json";
}

// ── JSON ────────────────────────────────────────────────────────────

/** Parses JSON and reports the first mistake, in words. */
function checkJson(t: string, jsonc: boolean): Problem[] {
  let i = 0;
  const stop = (from: number, to: number, message: string): never => { throw error(from, to, message); };
  const ws = () => {
    for (;;) {
      while (i < t.length && /\s/.test(t[i])) i++;
      if (t.startsWith("//", i) || t.startsWith("/*", i)) {
        if (!jsonc) stop(i, i + 2, "comments aren't allowed in JSON");
        if (t[i + 1] === "/") { const nl = t.indexOf("\n", i); i = nl < 0 ? t.length : nl; }
        else { const end = t.indexOf("*/", i + 2); if (end < 0) stop(i, i + 2, "this comment isn't closed: */ is missing"); i = end + 2; }
        continue;
      }
      return;
    }
  };
  const word = () => /^[^\s,:{}[\]"']+/.exec(t.slice(i, i + 80))?.[0] ?? t[i] ?? "";
  const str = () => {
    const start = i++;
    while (i < t.length) {
      const c = t[i];
      if (c === '"') { i++; return; }
      if (c === "\\") { i += 2; continue; }
      if (c === "\n") break;
      i++;
    }
    stop(start, i, 'this string isn\'t closed: " is missing');
  };
  const value = (): void => {
    ws();
    const c = t[i];
    if (c === undefined) stop(Math.max(0, t.length - 1), t.length, "the JSON ends too soon: a value, ] or } is missing");
    if (c === "{") return object();
    if (c === "[") return array();
    if (c === '"') return str();
    if (c === "'") stop(i, i + 1, "strings in JSON need double quotes");
    const num = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    num.lastIndex = i;
    if (num.exec(t)) { i = num.lastIndex; return; }
    for (const lit of ["true", "false", "null"]) if (t.startsWith(lit, i)) { i += lit.length; return; }
    const w = word();
    stop(i, i + w.length, w === "undefined" || w === "NaN" || w === "Infinity" ? `${w} isn't a JSON value` : `unexpected "${w}"`);
  };
  const members = (close: "}" | "]", member: () => void) => {
    i++;
    ws();
    if (t[i] === close) { i++; return; }
    for (;;) {
      member();
      const end = i;
      ws();
      if (t[i] === ",") {
        const comma = i++;
        ws();
        if (t[i] === close) {
          if (!jsonc) stop(comma, comma + 1, `trailing comma: nothing comes after it before "${close}"`);
          i++;
          return;
        }
        continue;
      }
      if (t[i] === close) { i++; return; }
      if (t[i] === undefined) stop(Math.max(0, end - 1), end, `"${close === "}" ? "{" : "["}" isn't closed: ${close} is missing`);
      if (t[i] === '"' || /[\d\-[{tfn]/.test(t[i])) stop(Math.max(0, end - 1), end, "a comma is missing after this");
      stop(i, i + 1, `expected "," or "${close}" here`);
    }
  };
  const object = () => members("}", () => {
    ws();
    if (t[i] !== '"') {
      if (t[i] === "'") stop(i, i + 1, "keys in JSON need double quotes");
      if (/[A-Za-z_$]/.test(t[i] ?? "")) { const w = word(); stop(i, i + w.length, `the key ${w} needs double quotes`); }
      stop(i, i + 1, "expected a key in double quotes");
    }
    str();
    ws();
    if (t[i] !== ":") stop(i, i + 1, 'a ":" is missing after the key');
    i++;
    value();
  });
  const array = () => members("]", value);
  try {
    ws();
    if (i >= t.length) return [];
    value();
    ws();
    if (i < t.length) stop(i, i + word().length, "there's more after the JSON value (only one is allowed)");
    return [];
  } catch (p) {
    return [p as Problem];
  }
}

// ── HTML ────────────────────────────────────────────────────────────

const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
/** Elements whose end tag may be left out. */
const OPTIONAL_END = new Set(["p", "li", "dt", "dd", "tr", "td", "th", "thead", "tbody", "tfoot", "option", "optgroup",
  "colgroup", "caption", "rb", "rt", "rtc", "rp", "html", "head", "body"]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);

async function checkHtml(t: string): Promise<Problem[]> {
  const problems: Problem[] = [];
  const open: Array<{ name: string; from: number; to: number }> = [];
  const ids = new Map<string, number>();
  const embedded: Array<{ lang: "js" | "css" | "module"; start: number; text: string }> = [];
  const lower = t.toLowerCase();
  let i = 0;
  scan: while (i < t.length) {
    const lt = t.indexOf("<", i);
    if (lt < 0) break;
    i = lt;
    if (t.startsWith("<!--", i)) {
      const end = t.indexOf("-->", i + 4);
      if (end < 0) { problems.push(error(i, i + 4, "this comment isn't closed: --> is missing")); break; }
      i = end + 3;
      continue;
    }
    if (t.startsWith("<!", i) || t.startsWith("<?", i)) {
      const end = t.indexOf(">", i);
      i = end < 0 ? t.length : end + 1;
      continue;
    }
    const m = /^<(\/?)([A-Za-z][\w:.-]*)/.exec(t.slice(i, i + 80));
    if (!m) { i++; continue; } // a "<" in text
    const closing = m[1] === "/";
    const name = m[2].toLowerCase();
    const tagStart = i;
    const nameEnd = i + m[0].length;
    i = nameEnd;
    let closed = false, selfClosing = false, broken = false;
    const attrs = new Set<string>();
    let type = "";
    while (i < t.length) {
      while (i < t.length && /\s/.test(t[i])) i++;
      const c = t[i];
      if (c === ">") { i++; closed = true; break; }
      if (c === "/" && t[i + 1] === ">") { i += 2; closed = true; selfClosing = true; break; }
      if (c === "<") { problems.push(error(tagStart, nameEnd, `<${closing ? "/" : ""}${m[2]}> isn't closed: ">" is missing`)); broken = true; break; }
      if (c === undefined) break;
      const an = /^[^\s"'>/=<]+/.exec(t.slice(i, i + 200));
      if (!an) { i++; continue; }
      const attrStart = i;
      const attr = an[0].toLowerCase();
      i += an[0].length;
      if (attrs.has(attr)) problems.push(warning(attrStart, i, `"${an[0]}" is set twice on this tag`));
      attrs.add(attr);
      while (i < t.length && /[ \t]/.test(t[i])) i++;
      if (t[i] !== "=") continue;
      i++;
      while (i < t.length && /\s/.test(t[i])) i++;
      let value = "";
      const q = t[i];
      if (q === '"' || q === "'") {
        const end = t.indexOf(q, i + 1);
        const v = t.slice(i + 1, end < 0 ? t.length : end);
        const runsIntoTag = /\n[^\n]*<\/?[A-Za-z]/.test(v) || (end < 0);
        if (runsIntoTag) {
          problems.push(error(i, i + 1, `the value of ${an[0]} isn't closed: ${q === '"' ? '"' : "'"} is missing`));
          broken = true;
          // Carry on after the end of this line's tag, so one missing
          // quote doesn't turn the rest of the file into errors.
          const gt = t.indexOf(">", i);
          i = gt < 0 ? t.length : gt + 1;
          continue scan;
        }
        if (/<\/[A-Za-z]/.test(v)) problems.push(warning(i, end + 1, `the value of ${an[0]} contains a closing tag: is a ${q} missing before it?`));
        value = v;
        i = end + 1;
      } else {
        const uv = /^[^\s>]+/.exec(t.slice(i, i + 2000));
        value = uv?.[0] ?? "";
        i += value.length;
      }
      if (attr === "id" && value && !closing) {
        const first = ids.get(value);
        if (first !== undefined) problems.push(warning(attrStart, i, `the id "${value}" is used twice (first at line ${lineOf(t, first)})`));
        else ids.set(value, attrStart);
      }
      if (attr === "type") type = value.toLowerCase();
    }
    if (broken) continue;
    if (!closed) { problems.push(error(tagStart, nameEnd, `<${closing ? "/" : ""}${m[2]}> isn't closed: ">" is missing`)); break; }
    if (closing) {
      let at = open.length - 1;
      while (at >= 0 && open[at].name !== name) at--;
      if (at < 0) {
        if (!VOID_ELEMENTS.has(name)) problems.push(error(tagStart, i, `</${m[2]}> has no <${m[2]}> to close`));
        continue;
      }
      for (const el of open.slice(at + 1)) {
        if (!OPTIONAL_END.has(el.name)) problems.push(warning(el.from, el.to, `<${el.name}> isn't closed before </${m[2]}>`));
      }
      open.length = at;
      continue;
    }
    if (VOID_ELEMENTS.has(name) || selfClosing) continue;
    open.push({ name, from: tagStart, to: nameEnd });
    if (RAW_TEXT.has(name)) {
      const end = lower.indexOf(`</${name}`, i);
      if (end < 0) { problems.push(error(tagStart, nameEnd, `<${name}> isn't closed: </${name}> is missing`)); open.pop(); break; }
      if (name === "script" && (!type || /javascript|ecmascript|^module$/.test(type))) embedded.push({ lang: type === "module" ? "module" : "js", start: i, text: t.slice(i, end) });
      if (name === "style") embedded.push({ lang: "css", start: i, text: t.slice(i, end) });
      i = end;
    }
  }
  for (const el of open) {
    if (!OPTIONAL_END.has(el.name)) problems.push(warning(el.from, el.to, `<${el.name}> is never closed`));
  }
  for (const e of embedded) {
    const inner = e.lang === "css" ? checkCss(e.text, e.start, false) : await checkScript(e.text, e.lang === "module" ? "mjs" : "js", e.start);
    problems.push(...inner);
  }
  return problems;
}

/** 1-based line of an offset. */
function lineOf(t: string, offset: number): number {
  let n = 1;
  for (let i = t.indexOf("\n"); i >= 0 && i < offset; i = t.indexOf("\n", i + 1)) n++;
  return n;
}

// ── CSS ─────────────────────────────────────────────────────────────

/** Braces, brackets and missing semicolons. `base` is where the CSS
 *  starts in the file (a <style> block); `nested` allows SCSS/Less. */
function checkCss(t: string, base: number, nested: boolean): Problem[] {
  const problems: Problem[] = [];
  const stack: Array<{ c: string; at: number }> = [];
  const pairs: Record<string, string> = { "}": "{", ")": "(", "]": "[" };
  let i = 0;
  // Declarations since the last ; { or }, for the missing-semicolon check.
  let stmtStart = 0;
  while (i < t.length) {
    const c = t[i];
    if (c === "/" && t[i + 1] === "*") {
      const end = t.indexOf("*/", i + 2);
      if (end < 0) { problems.push(error(base + i, base + i + 2, "this comment isn't closed: */ is missing")); break; }
      i = end + 2;
      continue;
    }
    if (nested && c === "/" && t[i + 1] === "/") { const nl = t.indexOf("\n", i); i = nl < 0 ? t.length : nl; continue; }
    if (c === '"' || c === "'") {
      const start = i++;
      while (i < t.length && t[i] !== c && t[i] !== "\n") i += t[i] === "\\" ? 2 : 1;
      if (t[i] !== c) problems.push(error(base + start, base + i, "this string isn't closed"));
      i++;
      continue;
    }
    if (c === "{" || c === "(" || c === "[") stack.push({ c, at: i });
    else if (c === "}" || c === ")" || c === "]") {
      const top = stack.pop();
      if (!top) problems.push(error(base + i, base + i + 1, `"${c}" has nothing to close`));
      else if (top.c !== pairs[c]) problems.push(error(base + i, base + i + 1, `"${c}" doesn't match the "${top.c}" at line ${lineOf(t, top.at)}`));
    }
    if (c === ";" || c === "{" || c === "}") stmtStart = i + 1;
    if (c === "\n" && stack.length && stack[stack.length - 1].c === "{") {
      // "color: red" on this line and another "prop:" on the next one,
      // with no ; between them.
      const stmt = t.slice(stmtStart, i);
      const line = stmt.slice(stmt.lastIndexOf("\n") + 1);
      const next = /^\s*([-\w]+)\s*:[^:]/.exec(t.slice(i + 1, i + 200));
      if (/^\s*[-\w]+\s*:(?!:)\s*\S/.test(line) && !/[;{},(\\]\s*$/.test(line) && next && !/^[-\w]+\s*:\s*[^;{]*\{/.test(t.slice(i + 1, i + 200).trim())) {
        const end = stmtStart + stmt.length;
        const trimmed = line.trimEnd();
        problems.push(warning(base + end - (line.length - trimmed.length) - 1, base + end - (line.length - trimmed.length), 'a ";" is missing at the end of this declaration'));
      }
    }
    i++;
  }
  for (const s of stack) problems.push(error(base + s.at, base + s.at + 1, `"${s.c}" is never closed`));
  return problems;
}

// ── JS / TS ─────────────────────────────────────────────────────────

let worker: Worker | null | undefined;
let nextId = 0;
const waiting = new Map<number, (p: Problem[]) => void>();

/** The worker that parses JS/TS off the main thread, or null where there
 *  are no workers (then the parsing happens here). */
function scriptWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL("./scriptCheck.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; problems: Problem[] }>) => {
      waiting.get(e.data.id)?.(e.data.problems);
      waiting.delete(e.data.id);
    };
    worker.onerror = () => { for (const done of waiting.values()) done([]); waiting.clear(); worker = null; };
  } catch {
    worker = null;
  }
  return worker;
}

let babel: Promise<import("./scriptCheck").BabelParse> | null = null;

/** Syntax errors in JS/TS (with JSX), from Babel's parser. `base` is
 *  where the code starts in the file (a <script> block). */
async function checkScript(t: string, ext: string, base = 0): Promise<Problem[]> {
  const w = typeof Worker !== "undefined" ? scriptWorker() : null;
  if (w) {
    const id = ++nextId;
    return new Promise(resolve => {
      waiting.set(id, resolve);
      w.postMessage({ id, text: t, ext, base });
    });
  }
  babel ??= import("@babel/parser").then(m => m.parse);
  try {
    const [parse, { babelProblems }] = await Promise.all([babel, import("./scriptCheck")]);
    return babelProblems(parse, t, ext, base);
  } catch {
    babel = null;
    return [];
  }
}

// ── Lua ─────────────────────────────────────────────────────────────

function checkLua(t: string): Problem[] {
  const r = checkLuaSyntax(t);
  if (r.ok) return [];
  // [string "..."]:12: 'end' expected (to close 'function' at line 3) near <eof>
  const m = /:(\d+):\s*([\s\S]*)$/.exec(r.error);
  if (!m) return [error(0, 1, r.error)];
  const line = Number(m[1]);
  let start = 0;
  for (let n = 1; n < line && start >= 0; n++) start = t.indexOf("\n", start) + 1 || t.length;
  const end = t.indexOf("\n", start) < 0 ? t.length : t.indexOf("\n", start);
  const near = /near '([^']+)'/.exec(m[2])?.[1];
  const at = near ? t.indexOf(near, start) : -1;
  const lead = /^\s*/.exec(t.slice(start, end))?.[0].length ?? 0;
  return [at >= 0 && at < end ? error(at, at + near!.length, m[2]) : error(start + lead, Math.max(start + lead + 1, end), m[2])];
}

// ── Brackets and strings, for other languages ───────────────────────

interface Syntax {
  line: string[];
  block: Array<[string, string]>;
  /** Quotes, longest first; those in `multiline` may span lines. */
  quotes: string[];
  multiline: string[];
}

const C_LIKE: Syntax = { line: ["//"], block: [["/*", "*/"]], quotes: ['"', "'"], multiline: [] };
const GO: Syntax = { line: ["//"], block: [["/*", "*/"]], quotes: ['"', "'", "`"], multiline: ["`"] };
// A Rust lifetime ('a) looks like an unclosed character literal.
const RUST: Syntax = { line: ["//"], block: [["/*", "*/"]], quotes: ['"'], multiline: ['"'] };
const PYTHON: Syntax = { line: ["#"], block: [], quotes: ['"""', "'''", '"', "'"], multiline: ['"""', "'''"] };

function checkBrackets(t: string, syntax: Syntax): Problem[] {
  const problems: Problem[] = [];
  const stack: Array<{ c: string; at: number }> = [];
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  let i = 0;
  outer: while (i < t.length) {
    for (const l of syntax.line) if (t.startsWith(l, i)) { const nl = t.indexOf("\n", i); i = nl < 0 ? t.length : nl; continue outer; }
    for (const [open, close] of syntax.block) {
      if (t.startsWith(open, i)) {
        const end = t.indexOf(close, i + open.length);
        if (end < 0) { problems.push(error(i, i + open.length, `this comment isn't closed: ${close} is missing`)); break outer; }
        i = end + close.length;
        continue outer;
      }
    }
    for (const q of syntax.quotes) {
      if (!t.startsWith(q, i)) continue;
      const start = i;
      i += q.length;
      const multi = syntax.multiline.includes(q);
      while (i < t.length && !t.startsWith(q, i) && (multi || t[i] !== "\n")) i += t[i] === "\\" && q !== "`" ? 2 : 1;
      if (!t.startsWith(q, i)) { problems.push(error(start, Math.min(i, start + 40), `this string isn't closed: ${q} is missing`)); if (multi) break outer; continue outer; }
      i += q.length;
      continue outer;
    }
    const c = t[i];
    if (c === "(" || c === "[" || c === "{") stack.push({ c, at: i });
    else if (c === ")" || c === "]" || c === "}") {
      const top = stack.pop();
      if (!top) problems.push(error(i, i + 1, `"${c}" has nothing to close`));
      else if (top.c !== pairs[c]) {
        problems.push(error(i, i + 1, `"${c}" doesn't match the "${top.c}" at line ${lineOf(t, top.at)}`));
        break; // everything after would be off by one
      }
    }
    i++;
  }
  for (const s of stack.slice(0, 5)) problems.push(error(s.at, s.at + 1, `"${s.c}" is never closed`));
  return problems;
}

// ── YAML ────────────────────────────────────────────────────────────

function checkYaml(t: string): Problem[] {
  const problems: Problem[] = [];
  let at = 0;
  for (const line of t.split("\n")) {
    const indent = /^[ \t]*/.exec(line)![0];
    if (indent.includes("\t") && line.trim()) problems.push(error(at, at + indent.length, "YAML doesn't allow tabs for indentation"));
    at += line.length + 1;
  }
  return problems;
}

// ── Every file ──────────────────────────────────────────────────────

function checkMergeConflicts(t: string): Problem[] {
  const problems: Problem[] = [];
  const re = /^(<{7}|>{7})(?: .*)?$/gm;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    problems.push(error(m.index, m.index + m[0].length, "an unresolved merge conflict"));
  }
  return problems;
}
