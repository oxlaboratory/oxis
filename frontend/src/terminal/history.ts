/**
 * history.ts — OXIS command history
 *
 * One shared history for the global prompt: 2,000 entries persisted to
 * localStorage, consecutive duplicates dropped, Up/Down with the typed
 * draft preserved, prefix-filtered Up, and Ctrl+R reverse-i-search.
 */

const KEY = "oxis-cmd-history-v2";
const MAX = 2_000;

export interface SearchResult {
  match: string;
  idx:   number; // index in entries[]
  rank:  number; // 1-based display rank among filtered results
  total: number; // total filtered results
}

class HistoryManager {
  private entries: string[] = [];
  private navIdx   = -1;   // -1 = at draft
  private draft    = "";
  private prefix   = "";   // locked when user first presses Up

  // reverse-i-search state
  private rsActive = false;
  private rsQuery  = "";
  private rsPos    = -1;   // index into entries[] of current match

  constructor() { this._load(); }

  // ── persistence ─────────────────────────────────────────
  private _load(): void {
    try {
      const s = localStorage.getItem(KEY);
      if (s) this.entries = JSON.parse(s) as string[];
    } catch { this.entries = []; }
  }

  private _save(): void {
    try { localStorage.setItem(KEY, JSON.stringify(this.entries)); }
    catch { /* quota — ignore */ }
  }

  // ── push ────────────────────────────────────────────────
  push(cmd: string): void {
    const c = cmd.trim();
    if (!c) return;
    if (this.entries[this.entries.length - 1] === c) return; // dedup
    this.entries.push(c);
    if (this.entries.length > MAX) this.entries.shift();
    this._save();
    this.resetNav();
  }

  // ── normal navigation ────────────────────────────────────
  /** Call before modifying input so draft is preserved */
  setDraft(s: string): void {
    if (this.navIdx === -1) this.draft = s;
  }

  /** Up: the previous entry. If text was typed before the first Up,
   *  only entries starting with it are visited (like bash's
   *  history-search-backward); at the oldest match it stays put. */
  prev(currentInput: string): string {
    if (this.entries.length === 0) return currentInput;

    if (this.navIdx === -1) {
      this.draft  = currentInput;
      this.prefix = currentInput.trim();
      this.navIdx = this.entries.length;
    }

    for (let i = this.navIdx - 1; i >= 0; i--) {
      if (!this.prefix || this.entries[i].startsWith(this.prefix)) {
        this.navIdx = i;
        return this.entries[i];
      }
    }
    // Nothing older: stay on the current entry (or the draft if Up
    // found nothing at all).
    return this.navIdx < this.entries.length ? this.entries[this.navIdx] : this.draft;
  }

  /** Down: the next newer entry, then back to the draft. */
  next(): string {
    if (this.navIdx === -1) return this.draft;

    for (let i = this.navIdx + 1; i < this.entries.length; i++) {
      if (!this.prefix || this.entries[i].startsWith(this.prefix)) {
        this.navIdx = i;
        return this.entries[i];
      }
    }
    const draft = this.draft;
    this.navIdx = -1;
    this.prefix = "";
    return draft;
  }

  isNavigating(): boolean { return this.navIdx !== -1; }

  resetNav(): void {
    this.navIdx = -1;
    this.draft  = "";
    this.prefix = "";
    this.exitSearch();
  }

  // ── reverse-i-search ────────────────────────────────────
  enterSearch(): void {
    this.rsActive = true;
    this.rsQuery  = "";
    this.rsPos    = this.entries.length - 1;
  }

  exitSearch(): void {
    this.rsActive = false;
    this.rsQuery  = "";
    this.rsPos    = -1;
  }

  isSearching():    boolean { return this.rsActive; }
  getSearchQuery(): string  { return this.rsQuery;  }

  /** Refines the search from the current match (like bash): stays on
   *  it if it still matches, otherwise moves to the next older one. */
  searchAppend(ch: string): SearchResult | null {
    this.rsQuery += ch;
    return this._findFrom(this.rsPos);
  }

  searchBackspace(): SearchResult | null {
    this.rsQuery = this.rsQuery.slice(0, -1);
    if (!this.rsQuery) return null;
    return this._findFrom(this.rsPos);
  }

  /** Ctrl+R again — older match */
  searchOlder(): SearchResult | null {
    if (this.rsPos <= 0) return null;
    return this._findFrom(this.rsPos - 1);
  }

  private _findFrom(startIdx: number): SearchResult | null {
    if (!this.rsQuery) return null;
    const q       = this.rsQuery.toLowerCase();
    const matches: number[] = [];
    for (let i = 0; i < this.entries.length; i++) {
      if (this.entries[i].toLowerCase().includes(q)) matches.push(i);
    }
    if (matches.length === 0) return null;

    // Find newest match at or before startIdx
    let best = -1;
    for (let i = matches.length - 1; i >= 0; i--) {
      if (matches[i] <= startIdx) { best = i; break; }
    }
    if (best === -1) best = matches.length - 1;

    this.rsPos = matches[best];
    return {
      match: this.entries[this.rsPos],
      idx:   this.rsPos,
      rank:  best + 1,
      total: matches.length,
    };
  }

  // ── read ────────────────────────────────────────────────
  all(): string[] { return [...this.entries]; }

  recent(n = 30): string[] {
    return this.entries.slice(-n).reverse();
  }

  clear(): void {
    this.entries = [];
    this.resetNav();
    this._save();
  }
}

export const history = new HistoryManager();