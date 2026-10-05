// Quick select (Ctrl+Shift+Space): every URL, path, git hash, IP and the
// like on screen gets a label; typing it copies that text (an upper-case
// label puts it in the prompt instead). No mouse, no careful dragging.

export interface Target { start: number; end: number; text: string }

// Most specific first: a URL's path isn't also offered on its own.
const PATTERNS: RegExp[] = [
  /\b(?:https?|ftp|file):\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}]/g,          // URLs
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,   // UUIDs
  /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g,                            // IPv4 (and port)
  /(?:[A-Za-z]:)?(?:[\\/]|~[\\/]|\.{1,2}[\\/])?(?:[\w.@+-]+[\\/])+[\w.@+-]+(?::\d+){0,2}/g, // paths with a folder
  /\b[\w-]+\.(?:[jt]sx?|mjs|cjs|go|rs|py|rb|lua|java|kt|cs|cpp|cc|c|h|hpp|json|ya?ml|toml|md|txt|html|css|scss|sh|ps1|sql|lock|log|env)(?::\d+){0,2}\b/g, // file names
  /\b[0-9a-f]{7,40}\b/g,                                                   // git hashes
  /\b\d{4,}\b/g,                                                           // ports, PIDs, long numbers
];

const isHash = (s: string) => /^[0-9a-f]+$/.test(s);

/** What on this line is worth picking, left to right, not overlapping. */
export function findTargets(line: string): Target[] {
  const taken: Target[] = [];
  const overlaps = (s: number, e: number) => taken.some(t => s < t.end && e > t.start);
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(line); m; m = re.exec(line)) {
      let text = m[0];
      // A hash needs a digit and a letter: "deadline" or "1234567" isn't one.
      if (re === PATTERNS[5] && !(isHash(text) && /\d/.test(text) && /[a-f]/.test(text))) continue;
      // Paths: not a bare fraction or date (1/2, 2024/10/05).
      if (re === PATTERNS[3] && /^[\d/\\.:]+$/.test(text)) continue;
      text = text.replace(/[.,;:]+$/, "");
      const start = m.index, end = m.index + text.length;
      if (text.length < 3 || overlaps(start, end)) continue;
      taken.push({ start, end, text });
    }
  }
  return taken.sort((a, b) => a.start - b.start);
}

const KEYS = "asdfghjklqwertyuiopzxcvbnm";

/** n labels, the easiest keys first; two letters once one isn't enough
 *  (the first letters of two-letter labels aren't labels themselves). */
export function makeLabels(n: number): string[] {
  if (n <= KEYS.length) return [...KEYS.slice(0, n)];
  // s singles leave 26 - s prefixes of 26 each: s + 26(26 - s) >= n.
  const singles = Math.max(0, Math.floor((KEYS.length * KEYS.length - n) / (KEYS.length - 1)));
  const out = [...KEYS.slice(0, singles)];
  for (const a of KEYS.slice(singles)) {
    for (const b of KEYS) {
      if (out.length >= n) return out;
      out.push(a + b);
    }
  }
  return out.slice(0, n);
}

interface Placed { label: string; text: string; rects: DOMRect[] }

/** The targets inside `out`'s visible lines, each with where it is. */
function collect(out: HTMLElement): Omit<Placed, "label">[] {
  const view = out.getBoundingClientRect();
  const found: Omit<Placed, "label">[] = [];
  for (const line of out.querySelectorAll<HTMLElement>(".term-line")) {
    const r = line.getBoundingClientRect();
    if (r.bottom < view.top || r.top > view.bottom || line.closest(".term-sticky-wrap")) continue;
    // The line's text, and which text node each character is in.
    const nodes: { node: Text; at: number }[] = [];
    let text = "";
    const walk = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (n.parentElement?.closest("[aria-hidden=true], .term-fold")) continue;
      nodes.push({ node: n as Text, at: text.length });
      text += n.textContent ?? "";
    }
    const locate = (i: number): [Text, number] => {
      let k = nodes.length - 1;
      while (k > 0 && nodes[k].at > i) k--;
      return [nodes[k].node, i - nodes[k].at];
    };
    for (const t of findTargets(text)) {
      const range = document.createRange();
      range.setStart(...locate(t.start));
      const [endNode, endOff] = locate(t.end - 1);
      range.setEnd(endNode, endOff + 1);
      const rects = [...range.getClientRects()].filter(q => q.width > 0 && q.bottom > view.top && q.top < view.bottom);
      if (rects.length) found.push({ text: t.text, rects });
    }
  }
  return found;
}

/** Labels the output; resolves with the picked text and whether it goes
 *  in the prompt, null when Esc (or anything else) is pressed, or
 *  undefined straight away when there's nothing to pick. */
export function quickSelect(out: HTMLElement): Promise<{ text: string; paste: boolean } | null | undefined> {
  const targets = collect(out);
  if (!targets.length) return Promise.resolve(undefined);
  // The labels nearest the prompt are the shortest.
  const labels = makeLabels(targets.length);
  const placed: Placed[] = targets.map((t, i) => ({ ...t, label: labels[targets.length - 1 - i] }));

  const layer = document.createElement("div");
  layer.className = "qs-layer";
  const marks = new Map<string, HTMLElement>();
  for (const p of placed) {
    for (const r of p.rects) {
      const hl = document.createElement("div");
      hl.className = "qs-hl";
      Object.assign(hl.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      layer.appendChild(hl);
    }
    const tag = document.createElement("span");
    tag.className = "qs-label";
    tag.textContent = p.label;
    Object.assign(tag.style, { left: `${p.rects[0].left}px`, top: `${p.rects[0].top}px` });
    layer.appendChild(tag);
    marks.set(p.label, tag);
  }
  const hint = document.createElement("div");
  hint.className = "qs-hint";
  hint.textContent = "type a label to copy · Shift+label puts it in the prompt · Esc cancels";
  layer.appendChild(hint);
  document.body.appendChild(layer);

  return new Promise(resolve => {
    let typed = "";
    let shifted = false;
    const done = (v: { text: string; paste: boolean } | null) => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onMouse, true);
      out.removeEventListener("scroll", onMouse);
      layer.remove();
      resolve(v);
    };
    const onMouse = () => done(null);
    const onKey = (e: KeyboardEvent) => {
      if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      const k = e.key.toLowerCase();
      if (e.key.length !== 1 || !KEYS.includes(k) || e.ctrlKey || e.altKey || e.metaKey) { done(null); return; }
      shifted ||= e.shiftKey;
      typed += k;
      const hit = placed.find(p => p.label === typed);
      if (hit) { done({ text: hit.text, paste: shifted }); return; }
      const left = placed.filter(p => p.label.startsWith(typed));
      if (!left.length) { done(null); return; }
      for (const [label, tag] of marks) tag.classList.toggle("qs-label--out", !label.startsWith(typed));
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onMouse, true);
    out.addEventListener("scroll", onMouse, { once: true });
  });
}
