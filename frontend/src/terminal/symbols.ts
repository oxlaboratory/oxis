/**
 * symbols.ts — the functions, classes, types and headings in a file, for
 * the editor's Go to symbol (Ctrl+Shift+O). Found line by line with
 * patterns per language, not a parser: quick, and good enough to jump
 * around a file.
 */

export type SymbolKind = "function" | "method" | "class" | "type" | "const" | "heading" | "rule";
export interface CodeSymbol { name: string; kind: SymbolKind; line: number; col: number; depth: number }

type Rule = [RegExp, SymbolKind];

const JS: Rule[] = [
  [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, "function"],
  [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, "class"],
  [/^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, "type"],
  [/^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/, "type"],
  [/^\s*(?:export\s+)?(?:const\s+|declare\s+)?enum\s+([A-Za-z_$][\w$]*)/, "type"],
  [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/, "function"],
  [/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, "const"],
  [/^\s+(?:(?:public|private|protected|static|async|readonly|override|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^)]*\)?\s*(?::[^{]+)?\{\s*$/, "method"],
];
const GO: Rule[] = [
  [/^func\s+\([^)]*\)\s*([A-Za-z_]\w*)/, "method"],
  [/^func\s+([A-Za-z_]\w*)/, "function"],
  [/^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/, "class"],
  [/^type\s+([A-Za-z_]\w*)/, "type"],
  [/^(?:const|var)\s+([A-Za-z_]\w*)/, "const"],
];
const PY: Rule[] = [
  [/^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/, "function"],
  [/^(\s*)class\s+([A-Za-z_]\w*)/, "class"],
];
const LUA: Rule[] = [
  [/^\s*(?:local\s+)?function\s+([\w.:]+)/, "function"],
  [/^\s*(?:local\s+)?([\w.]+)\s*=\s*function\b/, "function"],
];
const RS: Rule[] = [
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/, "function"],
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|union)\s+([A-Za-z_]\w*)/, "class"],
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:trait|type)\s+([A-Za-z_]\w*)/, "type"],
  [/^\s*impl(?:<[^>]*>)?\s+(?:[\w:<>]+\s+for\s+)?([A-Za-z_][\w:]*)/, "class"],
];
const CSS: Rule[] = [[/^\s*([^\s{}@/][^{}]*?)\s*\{\s*$/, "rule"], [/^\s*(@media[^{]*?)\s*\{/, "rule"]];

const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "function", "else", "do", "with", "try", "constructor"]);

function rulesFor(ext: string): Rule[] | null {
  switch (ext) {
    case "js": case "jsx": case "mjs": case "cjs": case "ts": case "tsx": case "mts": case "cts": return JS;
    case "go": return GO;
    case "py": return PY;
    case "lua": return LUA;
    case "rs": return RS;
    case "css": case "scss": case "less": return CSS;
    default: return null;
  }
}

/** The symbols in `text` (a file with extension `ext`), in order. */
export function findSymbols(text: string, ext: string): CodeSymbol[] {
  const out: CodeSymbol[] = [];
  const lines = text.split("\n");
  if (ext === "md" || ext === "markdown") {
    let fence = false;
    lines.forEach((l, i) => {
      if (/^\s*(```|~~~)/.test(l)) fence = !fence;
      const m = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
      if (m) out.push({ name: m[2], kind: "heading", line: i + 1, col: m[1].length + 1, depth: m[1].length - 1 });
    });
    return out;
  }
  const rules = rulesFor(ext);
  if (!rules) return out;
  let inComment = false;
  lines.forEach((raw, i) => {
    const l = raw.replace(/\r$/, "");
    // Skip block comments (/* … */) and lines that are only comments.
    if (inComment) { if (l.includes("*/")) inComment = false; return; }
    if (/^\s*\/\*/.test(l) && !l.includes("*/")) { inComment = true; return; }
    if (/^\s*(\/\/|#(?!include)|--|\*)/.test(l) && ext !== "css") return;
    for (const [re, kind] of rules) {
      const m = re.exec(l);
      if (!m) continue;
      // Python's pattern captures the indentation first.
      const name = (rules === PY ? m[2] : m[1]).trim();
      if (!name || KEYWORDS.has(name)) break;
      const indent = rules === PY ? m[1].length : (/^\s*/.exec(l)?.[0].length ?? 0);
      const pyKind: SymbolKind = rules === PY && kind === "function" && indent > 0 ? "method" : kind;
      out.push({ name, kind: pyKind, line: i + 1, col: Math.max(0, l.indexOf(name)), depth: indent > 0 ? 1 : 0 });
      break;
    }
  });
  return out;
}

export const SYMBOL_LABEL: Record<SymbolKind, string> = {
  function: "fn", method: "m", class: "C", type: "T", const: "k", heading: "#", rule: "{}",
};
