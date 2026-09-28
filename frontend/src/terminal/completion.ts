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

export type Suggestion = { word: string; at: number[]; keyword: boolean };

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
