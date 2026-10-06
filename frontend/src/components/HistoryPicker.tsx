/**
 * HistoryPicker.tsx — Ctrl+R: every command you've run, newest first,
 * narrowed as you type (fuzzy: the letters in order). Enter puts the one
 * picked in the prompt to edit; Ctrl+Enter runs it at once; Shift+Delete
 * forgets it. Opens with what's already typed as the search.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { fuzzyFilter } from "../terminal/fuzzy";

export interface HistoryPickerProps {
  /** Oldest first, as history.all() gives them. */
  entries: string[];
  initialQuery: string;
  onPick: (cmd: string, run: boolean) => void;
  onForget: (cmd: string) => void;
  onClose: () => void;
}

function Highlighted({ text, positions }: { text: string; positions: number[] }) {
  if (!positions.length) return <>{text}</>;
  const set = new Set(positions);
  const out: JSX.Element[] = [];
  let run = "", on = false;
  const flush = (k: number) => { if (run) out.push(on ? <mark key={k} className="hp-hit">{run}</mark> : <span key={k}>{run}</span>); run = ""; };
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    if (hit !== on) { flush(i); on = hit; }
    run += text[i];
  }
  flush(text.length);
  return <>{out}</>;
}

export default function HistoryPicker({ entries, initialQuery, onPick, onForget, onClose }: HistoryPickerProps) {
  const [query, setQuery] = useState(initialQuery);
  const [selected, setSelected] = useState(0);
  const [forgotten, setForgotten] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const selRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 20); }, []);

  // Each command once, at its newest.
  const unique = useMemo(() => {
    const seen = new Set<string>(), out: string[] = [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const c = entries[i];
      if (!seen.has(c) && !forgotten.has(c)) { seen.add(c); out.push(c); }
    }
    return out.reverse(); // oldest first again, so fuzzyFilter's ties go to the newest
  }, [entries, forgotten]);

  const results = useMemo(() => {
    if (!query.trim()) return unique.slice().reverse().slice(0, 300).map(item => ({ item, match: { score: 0, positions: [] as number[] } }));
    return fuzzyFilter(query, unique, s => s, 300);
  }, [query, unique]);

  useEffect(() => { setSelected(0); }, [query]);
  useEffect(() => { selRef.current?.scrollIntoView({ block: "nearest" }); }, [selected]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const pick = results[selected]?.item;
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key.toLowerCase() === "n")) { e.preventDefault(); setSelected(s => Math.min(results.length - 1, s + 1)); return; }
    if (e.key === "ArrowUp" || (e.ctrlKey && e.key.toLowerCase() === "p")) { e.preventDefault(); setSelected(s => Math.max(0, s - 1)); return; }
    // Ctrl+R again: the next match down, as the shell's Ctrl+R steps back.
    if (e.ctrlKey && e.key.toLowerCase() === "r") { e.preventDefault(); setSelected(s => Math.min(results.length - 1, s + 1)); return; }
    if (e.key === "PageDown") { e.preventDefault(); setSelected(s => Math.min(results.length - 1, s + 10)); return; }
    if (e.key === "PageUp") { e.preventDefault(); setSelected(s => Math.max(0, s - 10)); return; }
    if (e.key === "Enter" && pick) { e.preventDefault(); onPick(pick, e.ctrlKey || e.metaKey); return; }
    if (e.key === "Tab" && pick) { e.preventDefault(); onPick(pick, false); return; }
    if (e.key === "Delete" && e.shiftKey && pick) {
      e.preventDefault();
      onForget(pick);
      setForgotten(f => new Set(f).add(pick));
    }
  };

  return (
    <div className="cmdp-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cmdp hp">
        <div className="cmdp-input-row">
          <span className="cmdp-icon">↺</span>
          <input ref={inputRef} className="cmdp-input" placeholder="Search the commands you've run…" value={query}
            onChange={e => setQuery(e.target.value)} onKeyDown={onKeyDown} spellCheck={false} />
          <span className="cmdp-hint">{results.length} · ↵ edit · ctrl+↵ run · shift+del forget</span>
        </div>
        <div className="cmdp-list">
          {results.length === 0 && <div className="cmdp-empty">{unique.length ? `nothing you've run matches “${query}”` : "no history yet"}</div>}
          {results.map((r, i) => (
            <div key={r.item} ref={i === selected ? selRef : undefined}
              className={`cmdp-item hp-item${i === selected ? " cmdp-item--selected" : ""}`}
              onMouseEnter={() => setSelected(i)}
              onMouseDown={e => { e.preventDefault(); onPick(r.item, e.ctrlKey || e.metaKey); }}
              title={r.item}>
              <span className="hp-cmd"><Highlighted text={r.item} positions={r.match.positions} /></span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
