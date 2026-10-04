/**
 * completion.ts — the editor's suggestions while typing (words already
 * in the file, and the language's keywords), and the fuzzy matching
 * they share with quick open (Ctrl+P).
 */

/** How well `query` matches `text` as a subsequence (case-insensitive),
 *  and where; null when it doesn't. Consecutive letters, the start of
 *  words (after `/ . _ -`, a space or a lower-to-upper case change) and
 *  a match at the very start score higher; long texts score a little
 *  lower. */
export function fuzzyMatch(query: string, text: string): { score: number; at: number[] } | null {
  if (!query) return { score: 0, at: [] };
  const q = query.toLowerCase(), t = text.toLowerCase();
  const at: number[] = [];
  let score = 0, ti = 0, prev = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    // Prefer the start of a word for this letter, if there's one ahead
    // before falling back to the next occurrence.
    let found = -1;
    for (let k = ti; k < t.length; k++) {
      if (t[k] !== ch) continue;
      if (found < 0) found = k;
      if (k === prev + 1) { found = k; break; }
      if (isWordStart(text, k)) { found = k; break; }
    }
    if (found < 0) return null;
    score += 1;
    if (found === prev + 1) score += 4;
    if (isWordStart(text, found)) score += 3;
    if (found === 0) score += 4;
    at.push(found);
    prev = found;
    ti = found + 1;
  }
  score -= text.length * 0.02;
  return { score, at };
}

function isWordStart(text: string, i: number): boolean {
  if (i === 0) return true;
  const c = text[i - 1], d = text[i];
  if ("/\\._- ".includes(c)) return true;
  return c >= "a" && c <= "z" && d >= "A" && d <= "Z";
}

const WORD = /[A-Za-z_$][\w$]*/g;

/** Every word of three or more characters in `text`, with how often it
 *  appears. Numbers aren't words; `$` is (JavaScript, PHP, shell). */
export function wordIndex(text: string): Map<string, number> {
  const words = new Map<string, number>();
  for (const m of text.matchAll(WORD)) {
    const w = m[0];
    if (w.length < 3 || w.length > 60) continue;
    words.set(w, (words.get(w) ?? 0) + 1);
  }
  return words;
}

const JS = "async await break case catch class const continue debugger default delete do else export extends false finally for function if import in instanceof let new null return static super switch this throw true try typeof undefined var void while yield console document window localStorage JSON Promise Array Object String Number Boolean Map Set Math Date Error RegExp setTimeout setInterval clearTimeout requestAnimationFrame addEventListener querySelector querySelectorAll getElementById createElement appendChild classList textContent innerHTML length forEach filter reduce includes indexOf startsWith endsWith toLowerCase toUpperCase trim split join slice splice push pop shift unshift keys values entries then fetch";
const TS = JS + " interface type enum implements private protected public readonly abstract declare namespace keyof infer never unknown any string number boolean void satisfies as is Record Partial Required Readonly Pick Omit ReturnType";
const REACT = " useState useEffect useMemo useCallback useRef useLayoutEffect useContext useReducer className onClick onChange children props";
const KEYWORDS: Record<string, string> = {
  js: JS, mjs: JS, cjs: JS, jsx: JS + REACT,
  ts: TS, mts: TS, cts: TS, tsx: TS + REACT,
  py: "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield print self range len enumerate isinstance dict list tuple set str int float bool open super __init__ __name__ __main__",
  go: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false string int int64 uint8 byte rune float64 bool error make len cap append copy delete panic recover println fmt Println Printf Sprintf Errorf context",
  lua: "and break do else elseif end false for function goto if in local nil not or repeat return then true until while require print pairs ipairs tostring tonumber type table string math insert concat format oxis",
  rs: "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while String Vec Option Some None Result Ok Err Box println format",
  css: "display flex grid block inline none position relative absolute fixed sticky width height margin padding border background color font-size font-weight line-height justify-content align-items gap transition transform opacity overflow z-index cursor box-shadow border-radius important inherit transparent",
  html: "div span section header footer main nav article aside button input label form select option textarea script style link meta title head body class href src type alt placeholder",
  sh: "if then else elif fi for while until do done case esac function return local export echo printf read exit source",
};
KEYWORDS.scss = KEYWORDS.css;
KEYWORDS.htm = KEYWORDS.html;
KEYWORDS.bash = KEYWORDS.zsh = KEYWORDS.sh;

const keywordCache = new Map<string, string[]>();
function keywords(ext: string): string[] {
  let list = keywordCache.get(ext);
  if (!list) { list = [...new Set((KEYWORDS[ext] ?? "").split(" ").filter(Boolean))]; keywordCache.set(ext, list); }
  return list;
}

/** Keywords that can't follow a dot. */
const STATEMENT = new Set("async await break case catch class const continue debugger default delete do else export extends false finally for function if import in instanceof let new null return static super switch this throw true try typeof undefined var void while yield interface type enum implements private protected public readonly abstract declare namespace keyof infer satisfies as is and assert def del elif except from global lambda None nonlocal not or pass raise True False with chan defer fallthrough func go goto package range select struct local nil repeat then until elseif end fn impl let loop match mod move mut pub trait unsafe use where".split(" "));

export type Suggestion = { word: string; at: number[]; keyword: boolean; detail?: string; kind?: string };

/** Up to `max` completions of `prefix`: words from the file and the
 *  language's keywords, starts-with first, then fuzzy matches. The
 *  prefix itself (and anything no longer than it) isn't suggested, nor
 *  `typing`: the half-typed word under the caret as the index saw it,
 *  unless it's also somewhere else. */
export function suggest(prefix: string, words: Map<string, number>, ext: string, typing = "", afterDot = false, max = 8): Suggestion[] {
  if (!prefix) return [];
  const seen = new Set<string>();
  const scored: Array<Suggestion & { score: number }> = [];
  const consider = (word: string, keyword: boolean, count: number) => {
    if (word.length <= prefix.length || seen.has(word)) return;
    const m = fuzzyMatch(prefix, word);
    if (!m) return;
    // A fuzzy match needs its first letter to match (typing "st" shouldn't offer "list").
    if (m.at[0] !== 0) return;
    seen.add(word);
    const prefixed = word.startsWith(prefix) ? 20 : word.toLowerCase().startsWith(prefix.toLowerCase()) ? 14 : 0;
    scored.push({ word, at: m.at, keyword, score: m.score + prefixed + Math.min(count, 20) * 0.3 + (keyword ? 0.5 : 0) });
  };
  for (const [w, n] of words) if (w !== typing || n > 1) consider(w, false, w === typing ? n - 1 : n);
  // After a dot comes a property or method, not a statement keyword.
  for (const k of keywords(ext)) if (!afterDot || !STATEMENT.has(k)) consider(k, true, 0);
  scored.sort((a, b) => b.score - a.score || a.word.localeCompare(b.word));
  return scored.slice(0, max).map(({ word, at, keyword }) => ({ word, at, keyword }));
}

/** The whole word around offset `at` in `text` ("" if none). */
export function wordAround(text: string, at: number): string {
  let s = at, e = at;
  while (s > 0 && /[\w$]/.test(text[s - 1])) s--;
  while (e < text.length && /[\w$]/.test(text[e])) e++;
  return text.slice(s, e);
}

/** The word being typed just before `caret`: its start, and the text. */
export function wordBefore(text: string, caret: number): { start: number; prefix: string } {
  let s = caret;
  while (s > 0 && /[\w$]/.test(text[s - 1])) s--;
  const prefix = text.slice(s, caret);
  // "123" or "1px" isn't the start of a word.
  return /^[A-Za-z_$]/.test(prefix) ? { start: s, prefix } : { start: caret, prefix: "" };
}

// ── Members after a dot (oxis.fs., string.) ────────────────────────
// What a library offers, with the signature shown beside each name: the
// oxis API (README § Lua API) and Lua 5.4's standard library.
export type Member = { name: string; detail: string; kind: "fn" | "tbl" | "val" };

const fn = (sig: string): Member => {
  const name = sig.slice(0, sig.indexOf("(")).trim();
  return { name, detail: sig.slice(name.length), kind: "fn" };
};
const tbl = (name: string, detail = "table"): Member => ({ name, detail, kind: "tbl" });
const val = (name: string, detail: string): Member => ({ name, detail, kind: "val" });

const LUA_MEMBERS: Record<string, Member[]> = {
  oxis: [
    fn("command(name, fn(args, rest, raw), desc)"), fn("task(name, cmd, desc)"), fn("echo(text [, kind])"),
    fn("line(text [, kind]) → l:set(text [, kind])"), fn("run(cmd)"), fn("quote(text)"), fn("cwd()"),
    fn("ask(question, fn(answer) [, { label, cancel }])"), fn("after(seconds, fn)"),
    fn("every(seconds, fn [, { foreground, stop }])"), fn("input(text)"), fn("theme(name)"),
    fn("option(key [, value])"), fn("autocmd(event, fn(info))"), fn("keymap(mode, combo, fn)"),
    fn("workflow(name, { steps, env }, desc)"), fn("workspace(path)"), fn("dashboard(config)"), fn("newTerminal()"),
    val("platform", '"windows" or "unix"'),
    tbl("fs", "files: read, write, list, watch…"), tbl("process", "spawn, list, kill"), tbl("net", "request, stream"),
    tbl("json", "encode, decode"), tbl("editor", "the open file"), tbl("store", "values kept between runs"),
    tbl("system", "info"), tbl("plugin", "enable, disable"),
  ],
  "oxis.fs": [
    fn("read(path, fn(err, content))"), fn("write(path, content, fn(err))"), fn("list(path, fn(err, entries))"),
    fn("stat(path, fn(err, info))"), fn("mkdir(path, fn(err))"), fn("remove(path, fn(err))"),
    fn("search(root, query [, opts], fn(err, result))"), fn("watch(path, fn(change) [, opts]) → h:close()"),
  ],
  "oxis.process": [
    fn("spawn({ cmd, args | shell, cwd, env, lines }, { start, stdout, stderr, exit }) → h"),
    fn("list(fn(err, processes))"), fn("kill(pid, fn(err))"),
  ],
  "oxis.net": [
    fn("request({ url, method, headers, body, timeout }, fn(err, res))"),
    fn("stream(opts, { response, data, line, event, done }) → h:close()"),
  ],
  "oxis.json": [fn("encode(value)"), fn("decode(text)")],
  "oxis.editor": [
    fn("current()"), fn("open(path [, line])"), fn("setText(text)"), fn("insert(text)"),
    fn("replaceLines(first, last, text)"), fn("select(line, col [, toLine, toCol])"),
    fn("save([fn(err, path)])"), fn("on(event, fn(info))"),
  ],
  "oxis.store": [fn("get(key)"), fn("set(key, value)")],
  "oxis.system": [fn("info(fn(err, info))")],
  "oxis.plugin": [fn("enable(name)"), fn("disable(name)")],
  string: [
    fn("format(fmt, ...)"), fn("sub(s, i [, j])"), fn("gsub(s, pattern, repl [, n])"), fn("find(s, pattern [, init, plain])"),
    fn("match(s, pattern [, init])"), fn("gmatch(s, pattern)"), fn("rep(s, n [, sep])"), fn("upper(s)"), fn("lower(s)"),
    fn("len(s)"), fn("byte(s [, i, j])"), fn("char(...)"), fn("reverse(s)"), fn("pack(fmt, ...)"), fn("unpack(fmt, s [, pos])"),
  ],
  table: [
    fn("insert(t, [pos,] value)"), fn("remove(t [, pos])"), fn("concat(t [, sep, i, j])"), fn("sort(t [, comp])"),
    fn("unpack(t [, i, j])"), fn("pack(...)"), fn("move(a1, f, e, t [, a2])"),
  ],
  math: [
    fn("floor(x)"), fn("ceil(x)"), fn("abs(x)"), fn("max(x, ...)"), fn("min(x, ...)"), fn("random([m [, n]])"),
    fn("randomseed([x])"), fn("sqrt(x)"), fn("fmod(x, y)"), fn("tointeger(x)"), fn("type(x)"), fn("log(x [, base])"),
    fn("exp(x)"), fn("sin(x)"), fn("cos(x)"), val("pi", "3.14159…"), val("huge", "infinity"),
    val("maxinteger", "largest integer"), val("mininteger", "smallest integer"),
  ],
  os: [fn("time([t])"), fn("clock()"), fn("date([format [, time]])"), fn("difftime(t2, t1)"), fn("getenv(name)")],
  io: [fn("write(...)"), fn("read(...)"), fn("open(path [, mode])  — needs fs"), fn("lines([path])  — needs fs")],
  utf8: [fn("char(...)"), fn("codepoint(s [, i, j])"), fn("len(s [, i, j])"), fn("offset(s, n [, i])"), fn("codes(s)"), val("charpattern", "pattern")],
  coroutine: [fn("create(fn)"), fn("resume(co, ...)"), fn("yield(...)"), fn("wrap(fn)"), fn("status(co)"), fn("isyieldable()"), fn("running()"), fn("close(co)")],
};

/** The members of `qualifier` (the dotted name before a dot) in a file
 *  of type `ext`, or null when it isn't a library this knows. */
export function membersOf(ext: string, qualifier: string | null): Member[] | null {
  if (!qualifier || ext !== "lua") return null;
  return LUA_MEMBERS[qualifier] ?? null;
}

/** The dotted name just before the dot at `start - 1` ("oxis.fs" in
 *  "oxis.fs.re"), or null when there's no dot there. */
export function qualifierBefore(text: string, start: number): string | null {
  if (text[start - 1] !== ".") return null;
  const m = /([A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)*)$/.exec(text.slice(Math.max(0, start - 200), start - 1));
  return m ? m[1] : null;
}

/** Completions from a library's members: all of them, in order, when
 *  nothing's typed yet; fuzzy matches of `prefix` after that. */
export function suggestMembers(prefix: string, members: Member[], max = 60): Suggestion[] {
  const out: Array<Suggestion & { score: number }> = [];
  members.forEach((m, i) => {
    if (!prefix) { out.push({ word: m.name, at: [], keyword: false, detail: m.detail, kind: m.kind, score: -i }); return; }
    const f = fuzzyMatch(prefix, m.name);
    if (!f || f.at[0] !== 0 || m.name === prefix) return;
    out.push({ word: m.name, at: f.at, keyword: false, detail: m.detail, kind: m.kind, score: f.score + (m.name.startsWith(prefix) ? 20 : 0) - i * 0.01 });
  });
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, max).map(({ score: _score, ...s }) => s);
}
