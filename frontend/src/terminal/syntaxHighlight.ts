/**
 * syntaxHighlight.ts — a small regex highlighter for the editor
 * (comments, strings, numbers, keywords, function calls). Returns
 * escaped HTML for the <pre> behind CodeArea's textarea.
 */

export type EditorLang =
  | "ts" | "js" | "go" | "lua" | "py" | "json"
  | "css" | "html" | "md" | "sh" | "yaml" | "plain";

/** Pick a highlighting language from a file path's extension. */
export function detectLang(path: string): EditorLang {
  const ext = (path.split(".").pop() || "").toLowerCase();
  switch (ext) {
    case "ts": case "tsx": return "ts";
    case "js": case "jsx": case "mjs": case "cjs": return "js";
    case "go": return "go";
    case "lua": return "lua";
    case "py": return "py";
    case "json": return "json";
    case "css": case "scss": return "css";
    case "html": case "htm": return "html";
    case "md": case "markdown": return "md";
    case "sh": case "bash": case "zsh": return "sh";
    case "yml": case "yaml": return "yaml";
    default: return "plain";
  }
}

const KEYWORDS: Record<EditorLang, string[]> = {
  ts: [
    "const","let","var","function","return","if","else","for","while","do","switch","case",
    "break","continue","class","extends","implements","interface","type","enum","import","export",
    "from","as","default","new","this","super","try","catch","finally","throw","async","await",
    "yield","typeof","instanceof","in","of","void","null","undefined","true","false","public",
    "private","protected","readonly","static","abstract","namespace","declare","module","keyof",
  ],
  js: [
    "const","let","var","function","return","if","else","for","while","do","switch","case",
    "break","continue","class","extends","import","export","from","as","default","new","this",
    "super","try","catch","finally","throw","async","await","yield","typeof","instanceof","in",
    "of","void","null","undefined","true","false","static",
  ],
  go: [
    "package","import","func","return","if","else","for","range","switch","case","break",
    "continue","default","var","const","type","struct","interface","map","chan","go","defer",
    "select","fallthrough","nil","true","false","make","new","len","cap","append","panic","recover",
  ],
  lua: [
    "and","break","do","else","elseif","end","false","for","function","goto","if","in","local",
    "nil","not","or","repeat","return","then","true","until","while",
  ],
  py: [
    "def","return","if","elif","else","for","while","break","continue","class","import","from",
    "as","pass","try","except","finally","raise","with","lambda","yield","global","nonlocal","in",
    "is","not","and","or","None","True","False","async","await","del","assert",
  ],
  sh: [
    "if","then","else","elif","fi","for","in","do","done","while","case","esac","function",
    "return","local","export","exit","break","continue",
  ],
  yaml: [],
  json: [],
  css: [],
  html: [],
  md: [],
  plain: [],
};

const LINE_COMMENT: Record<EditorLang, string | null> = {
  ts: "//", js: "//", go: "//", lua: "--", py: "#", sh: "#", yaml: "#",
  json: null, css: null, html: null, md: null, plain: null,
};

const BLOCK_COMMENT: Record<EditorLang, [string, string] | null> = {
  ts: ["/*", "*/"], js: ["/*", "*/"], go: ["/*", "*/"], css: ["/*", "*/"],
  html: ["<!--", "-->"],
  lua: null, py: null, sh: null, yaml: null, json: null, md: null, plain: null,
};

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A pattern that can never match anything, used to keep capture-group
// indices stable when a language doesn't have (say) a block comment —
// e.g. lua has no /* */ — without special-casing the exec loop below.
const NEVER = "[^\\s\\S]";

export function highlight(code: string, lang: EditorLang): string {
  const keywords      = KEYWORDS[lang];
  const lineComment   = LINE_COMMENT[lang];
  const blockComment  = BLOCK_COMMENT[lang];

  const blockPat = blockComment
    ? `${escapeRegex(blockComment[0])}[\\s\\S]*?${escapeRegex(blockComment[1])}`
    : NEVER;
  const linePat = lineComment ? `${escapeRegex(lineComment)}.*$` : NEVER;
  const keywordPat = keywords.length ? `\\b(?:${keywords.join("|")})\\b` : NEVER;

  const re = new RegExp(
    [
      `(${blockPat})`,                                    // 1: block comment
      `(${linePat})`,                                     // 2: line comment
      `("(?:\\\\.|[^"\\\\\\n])*")`,                        // 3: double-quoted string
      `('(?:\\\\.|[^'\\\\\\n])*')`,                        // 4: single-quoted string
      "(`(?:\\\\.|[^`\\\\])*`)",                           // 5: template literal
      `(\\b0x[0-9a-fA-F]+\\b|\\b\\d+\\.?\\d*(?:[eE][+-]?\\d+)?\\b)`, // 6: number
      `(${keywordPat})`,                                  // 7: keyword
      `(\\b[A-Za-z_][A-Za-z0-9_]*\\b(?=\\s*\\())`,         // 8: function call
    ].join("|"),
    "gm",
  );

  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    if (m.index > last) out += escapeHtml(code.slice(last, m.index));
    const [, block, line, dstr, sstr, tstr, num, kw, fn] = m;
    if (block !== undefined)      out += `<span class="tok-comment">${escapeHtml(block)}</span>`;
    else if (line !== undefined)  out += `<span class="tok-comment">${escapeHtml(line)}</span>`;
    else if (dstr !== undefined)  out += `<span class="tok-string">${escapeHtml(dstr)}</span>`;
    else if (sstr !== undefined)  out += `<span class="tok-string">${escapeHtml(sstr)}</span>`;
    else if (tstr !== undefined)  out += `<span class="tok-string">${escapeHtml(tstr)}</span>`;
    else if (num !== undefined)   out += `<span class="tok-number">${escapeHtml(num)}</span>`;
    else if (kw !== undefined)    out += `<span class="tok-keyword">${escapeHtml(kw)}</span>`;
    else if (fn !== undefined)    out += `<span class="tok-function">${escapeHtml(fn)}</span>`;
    last = re.lastIndex;
    // Guard against zero-width matches looping forever (shouldn't
    // happen with the patterns above, but cheap to be safe).
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  if (last < code.length) out += escapeHtml(code.slice(last));
  return out;
}