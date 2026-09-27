/**
 * ansi.ts — colours and text styles in shell output.
 *
 * The PTY passes SGR sequences (ESC [ … m) through and strips every
 * other escape (pty.go). This turns them into styled spans: the 16
 * base colours come from the theme (--ansi-0 … --ansi-15, the
 * "Terminal colours" theme keys), the 256-colour cube and 24-bit
 * colours are exact. A style carries across lines, as it does in a
 * real terminal, until a reset.
 */

export interface Span {
  t: string;
  /** Inline CSS for this span; undefined for plain text. */
  s?: string;
}

interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strike?: boolean;
  hidden?: boolean;
}

const SGR_RE = /\x1b\[([0-9;:]*)m/g;
const HAS_SGR = /\x1b\[[0-9;:]*m/;

/** Removes colour codes, leaving the text. */
export function stripSgr(s: string): string {
  return s.includes("\x1b") ? s.replace(SGR_RE, "") : s;
}

const base = (n: number) => `var(--ansi-${n})`;

function xterm256(n: number): string {
  if (n < 16) return base(n);
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const level = (c: number) => (c === 0 ? 0 : 55 + c * 40);
  return `rgb(${level(Math.floor(i / 36))},${level(Math.floor(i / 6) % 6)},${level(i % 6)})`;
}

const clampByte = (v: number) => Math.max(0, Math.min(255, v | 0));

/** Reads an extended colour (38/48 …) starting at params[i]; returns the
 *  colour and how many params it used. */
function extendedColor(params: string[], i: number): [string | undefined, number] {
  // Colon form arrives as one param: "38:2::255:0:0" or "38:5:208".
  if (params[i].includes(":")) {
    const p = params[i].split(":").map(x => (x === "" ? NaN : Number(x)));
    if (p[1] === 5 && Number.isFinite(p[2])) return [xterm256(p[2]), 1];
    if (p[1] === 2) {
      const rgb = p.slice(2).filter(Number.isFinite).slice(-3);
      if (rgb.length === 3) return [`rgb(${rgb.map(clampByte).join(",")})`, 1];
    }
    return [undefined, 1];
  }
  const kind = Number(params[i + 1]);
  if (kind === 5 && params[i + 2] !== undefined) return [xterm256(Number(params[i + 2])), 3];
  if (kind === 2 && params[i + 4] !== undefined) {
    return [`rgb(${[params[i + 2], params[i + 3], params[i + 4]].map(v => clampByte(Number(v))).join(",")})`, 5];
  }
  return [undefined, 1];
}

function apply(st: Style, paramText: string): Style {
  const params = paramText === "" ? ["0"] : paramText.split(";");
  let next: Style = { ...st };
  for (let i = 0; i < params.length; i++) {
    const head = params[i].split(":")[0];
    const code = head === "" ? 0 : Number(head);
    if (code === 0) next = {};
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = params[i] !== "4:0";
    else if (code === 7) next.inverse = true;
    else if (code === 8) next.hidden = true;
    else if (code === 9) next.strike = true;
    else if (code === 21 || code === 22) { next.bold = false; next.dim = false; }
    else if (code === 23) next.italic = false;
    else if (code === 24) next.underline = false;
    else if (code === 27) next.inverse = false;
    else if (code === 28) next.hidden = false;
    else if (code === 29) next.strike = false;
    else if (code >= 30 && code <= 37) next.fg = base(code - 30);
    else if (code === 39) next.fg = undefined;
    else if (code >= 40 && code <= 47) next.bg = base(code - 40);
    else if (code === 49) next.bg = undefined;
    else if (code >= 90 && code <= 97) next.fg = base(code - 90 + 8);
    else if (code >= 100 && code <= 107) next.bg = base(code - 100 + 8);
    else if (code === 38 || code === 48) {
      const [color, used] = extendedColor(params, i);
      if (color) { if (code === 38) next.fg = color; else next.bg = color; }
      i += used - 1;
    }
  }
  return next;
}

function css(st: Style): string | undefined {
  let fg = st.fg, bg = st.bg;
  if (st.inverse) {
    fg = st.bg ?? "var(--bg)";
    bg = st.fg ?? "var(--text)";
  }
  const out: string[] = [];
  if (st.hidden) out.push("color:transparent");
  else if (fg) out.push(`color:${fg}`);
  if (bg) out.push(`background-color:${bg}`);
  if (st.bold) out.push("font-weight:700");
  if (st.dim) out.push("opacity:.62");
  if (st.italic) out.push("font-style:italic");
  const deco = [st.underline && "underline", st.strike && "line-through"].filter(Boolean).join(" ");
  if (deco) out.push(`text-decoration:${deco}`);
  return out.length ? out.join(";") : undefined;
}

/** Turns shell output lines into text plus styled spans. One per
 *  terminal: it remembers the style still in effect at the end of the
 *  previous line. */
export class AnsiParser {
  private style: Style = {};

  reset(): void { this.style = {}; }

  /** parse() without keeping the style it ends with (a line that may
   *  still change, like the prompt). */
  preview(line: string): { text: string; spans?: Span[] } {
    const saved = this.style;
    try { return this.parse(line); } finally { this.style = saved; }
  }

  /** Undefined spans means the line is plain (the common case). */
  parse(line: string): { text: string; spans?: Span[] } {
    const styled = css(this.style) !== undefined;
    if (!HAS_SGR.test(line)) {
      return styled && line ? { text: line, spans: [{ t: line, s: css(this.style) }] } : { text: line };
    }
    const spans: Span[] = [];
    let last = 0;
    SGR_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SGR_RE.exec(line)) !== null) {
      if (m.index > last) spans.push({ t: line.slice(last, m.index), s: css(this.style) });
      this.style = apply(this.style, m[1]);
      last = SGR_RE.lastIndex;
    }
    if (last < line.length) spans.push({ t: line.slice(last), s: css(this.style) });
    // Merge neighbours with the same style.
    const merged: Span[] = [];
    for (const sp of spans) {
      const prev = merged[merged.length - 1];
      if (prev && prev.s === sp.s) prev.t += sp.t;
      else merged.push({ ...sp });
    }
    const text = merged.map(s => s.t).join("");
    return merged.some(s => s.s) ? { text, spans: merged } : { text };
  }
}
