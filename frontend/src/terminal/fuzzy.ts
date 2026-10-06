/**
 * fuzzy.ts — fuzzy matching for pickers (the history search): the query's
 * characters must appear in order; runs of consecutive characters, word
 * starts and an early first match score higher. Smart case: a query with
 * a capital matches case; otherwise case is ignored.
 */

export interface FuzzyMatch {
  score: number;
  /** Indexes in the text of the characters that matched, for highlighting. */
  positions: number[];
}

const isWordStart = (text: string, i: number) =>
  i === 0 || /[\s/\\\-_.:'"=|&;(]/.test(text[i - 1]) || (/[a-z]/.test(text[i - 1]) && /[A-Z]/.test(text[i]));

/** How well `text` matches `query`, or null if it doesn't. Spaces in the
 *  query separate parts that may match anywhere, in order. */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.trim();
  if (!q) return { score: 0, positions: [] };
  const cased = /[A-Z]/.test(q);
  const hay = cased ? text : text.toLowerCase();
  const needle = (cased ? q : q.toLowerCase()).replace(/\s+/g, " ");
  // An exact substring is the best kind of match.
  const sub = hay.indexOf(needle);
  if (sub >= 0) {
    const positions = Array.from({ length: needle.length }, (_, k) => sub + k).filter(i => text[i] !== " " || needle[i - sub] === " ");
    return { score: 1000 + (isWordStart(text, sub) ? 200 : 0) - sub - text.length * 0.5, positions };
  }
  const positions: number[] = [];
  let score = 0, from = 0, run = 0;
  for (const ch of needle) {
    if (ch === " ") { run = 0; continue; }
    const at = hay.indexOf(ch, from);
    if (at < 0) return null;
    run = positions.length && at === positions[positions.length - 1] + 1 ? run + 1 : 0;
    score += 10 + run * 15 + (isWordStart(text, at) ? 25 : 0) - Math.min(at - from, 20);
    positions.push(at);
    from = at + 1;
  }
  return { score: score - positions[0] * 0.5 - text.length * 0.3, positions };
}

/** The items that match, best first; ties go to the newer (later) item. */
export function fuzzyFilter<T>(query: string, items: T[], text: (t: T) => string, limit = 200): Array<{ item: T; match: FuzzyMatch }> {
  const out: Array<{ item: T; match: FuzzyMatch; order: number }> = [];
  items.forEach((item, order) => {
    const match = fuzzyMatch(query, text(item));
    if (match) out.push({ item, match, order });
  });
  out.sort((a, b) => (b.match.score - a.match.score) || (b.order - a.order));
  return out.slice(0, limit).map(({ item, match }) => ({ item, match }));
}
