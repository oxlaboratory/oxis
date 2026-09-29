/**
 * SymbolPicker.tsx — Ctrl+Shift+O in the editor: the file's functions,
 * classes, types and headings (terminal/symbols.ts). Type to filter
 * (letters in order); ↑/↓ move and show each one in the editor as you
 * go; Enter keeps it, Esc goes back to where you were.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { fuzzyMatch } from "../terminal/completion";
import { SYMBOL_LABEL, type CodeSymbol } from "../terminal/symbols";

export function SymbolPicker({ symbols, onPreview, onPick, onCancel }: {
  symbols: CodeSymbol[];
  onPreview: (s: CodeSymbol) => void;
  onPick: (s: CodeSymbol) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const selRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 10); }, []);

  const results = useMemo(() => {
    if (!query) return symbols.map(s => ({ s, at: [] as number[] }));
    return symbols
      .map(s => ({ s, m: fuzzyMatch(query, s.name) }))
      .filter(r => r.m)
      .sort((a, b) => b.m!.score - a.m!.score || a.s.line - b.s.line)
      .map(r => ({ s: r.s, at: r.m!.at }));
  }, [query, symbols]);

  useEffect(() => { setSel(0); }, [query]);
  useEffect(() => {
    selRef.current?.scrollIntoView({ block: "nearest" });
    const r = results[sel];
    if (r) onPreview(r.s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, results]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setSel(i => Math.min(i + 1, results.length - 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setSel(i => Math.max(i - 1, 0)); return; }
    if (e.key === "Enter") { e.preventDefault(); const r = results[sel]; if (r) onPick(r.s); }
  };

  return (
    <div className="cmdp-backdrop symp-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="cmdp symp">
        <div className="cmdp-input-row">
          <span className="cmdp-icon">@</span>
          <input ref={inputRef} className="cmdp-input" placeholder="Go to symbol…" value={query}
            onChange={e => setQuery(e.target.value)} onKeyDown={onKeyDown} spellCheck={false} autoComplete="off" />
          <span className="cmdp-hint">{symbols.length} in this file</span>
        </div>
        <div className="cmdp-list">
          {results.length === 0 && <div className="cmdp-empty">{symbols.length ? "no matching symbols" : "no symbols found in this file"}</div>}
          {results.map((r, i) => {
            const marked = new Set(r.at);
            return (
              <div key={`${r.s.line}:${r.s.name}`} ref={i === sel ? selRef : undefined}
                className={`cmdp-item symp-item${i === sel ? " cmdp-item--selected" : ""}`}
                style={{ paddingLeft: 14 + (query ? 0 : r.s.depth * 16) }}
                onMouseEnter={() => setSel(i)} onMouseDown={e => { e.preventDefault(); onPick(r.s); }}>
                <span className={`symp-kind symp-kind--${r.s.kind}`}>{SYMBOL_LABEL[r.s.kind]}</span>
                <span className="symp-name">{[...r.s.name].map((ch, k) => marked.has(k) ? <b key={k}>{ch}</b> : ch)}</span>
                <span className="symp-line">{r.s.line}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
