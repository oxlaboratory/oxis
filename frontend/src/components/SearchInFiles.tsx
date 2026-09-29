/**
 * SearchInFiles.tsx — Ctrl+Shift+F in the editor: every line in the
 * project that matches, grouped by file, the match picked out. ↑/↓ and
 * Enter (or a click) open the file with the match selected. Alt+C, Alt+W
 * and Alt+R switch on matching case, whole words and regular
 * expressions. The search runs in Go (internal/wailsapp/search.go) as
 * you type.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { searchFiles, type NativeSearchMatch, type NativeSearchOptions, type NativeSearchResult } from "../native";

const SHOWN = 500; // rows drawn at most; the count says how many there are

export function SearchInFiles({ root, initialQuery = "", onOpen, onClose }: {
  /** The folder to search. */
  root: string;
  /** What's selected in the editor, to start with. */
  initialQuery?: string;
  onOpen: (path: string, line: number, col: number, len: number) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [opts, setOpts] = useState<NativeSearchOptions>({ caseSensitive: false, wholeWord: false, regex: false });
  const [result, setResult] = useState<NativeSearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const selRef = useRef<HTMLDivElement | null>(null);
  const request = useRef(0);

  useEffect(() => { setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 10); }, []);

  // Search once typing pauses; only the newest answer is shown.
  useEffect(() => {
    const id = ++request.current;
    if (!query) { setResult(null); setBusy(false); setError(""); return; }
    setBusy(true);
    const t = setTimeout(() => {
      searchFiles(root, query, opts)
        .then(r => {
          if (id !== request.current || r.superseded) return;
          setError(r.error ?? "");
          setResult(r.error ? null : r);
          setSel(0);
        })
        .catch(e => { if (id === request.current) setError(e instanceof Error ? e.message : String(e)); })
        .finally(() => { if (id === request.current) setBusy(false); });
    }, 180);
    return () => clearTimeout(t);
  }, [query, opts, root]);

  const matches = result?.matches ?? [];
  const shown = matches.slice(0, SHOWN);
  const files = useMemo(() => new Set(matches.map(m => m.path)).size, [matches]);
  useEffect(() => { selRef.current?.scrollIntoView({ block: "nearest" }); }, [sel]);

  const open = (m: NativeSearchMatch | undefined) => {
    if (!m) return;
    onOpen(m.path, m.line, m.col, m.len);
    onClose();
  };
  const toggle = (key: keyof Omit<NativeSearchOptions, "maxResults">) => setOpts(o => ({ ...o, [key]: !o[key] }));

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setSel(i => Math.min(i + 1, shown.length - 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setSel(i => Math.max(i - 1, 0)); return; }
    if (e.key === "Enter") { e.preventDefault(); open(shown[sel]); return; }
    if (e.altKey && !e.ctrlKey) {
      const k = e.key.toLowerCase();
      if (k === "c") { e.preventDefault(); toggle("caseSensitive"); }
      else if (k === "w") { e.preventDefault(); toggle("wholeWord"); }
      else if (k === "r") { e.preventDefault(); toggle("regex"); }
    }
  };

  const rel = (p: string) => (p.startsWith(root.replace(/\\/g, "/") + "/") ? p.slice(root.replace(/\\/g, "/").length + 1) : p);
  const summary = error ? error
    : busy && !result ? "searching…"
    : result ? `${matches.length.toLocaleString()}${result.truncated ? "+" : ""} result${matches.length === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}`
    : "";

  // Rows: a heading per file, then its matches.
  const rows: React.ReactNode[] = [];
  let lastPath = "";
  shown.forEach((m, i) => {
    if (m.path !== lastPath) {
      lastPath = m.path;
      const path = rel(m.path);
      const cut = path.lastIndexOf("/") + 1;
      const count = matches.filter(x => x.path === m.path).length;
      rows.push(
        <div key={`f${i}`} className="sif-file">
          <span className="sif-file-name">{path.slice(cut)}</span>
          <span className="sif-file-dir">{path.slice(0, Math.max(0, cut - 1))}</span>
          <span className="sif-file-count">{count}</span>
        </div>,
      );
    }
    // Leading indentation isn't worth showing.
    const lead = m.text.length - m.text.trimStart().length;
    const at = Math.max(0, m.at - lead);
    const text = m.text.slice(lead);
    rows.push(
      <div key={i} ref={i === sel ? selRef : undefined}
        className={`sif-row${i === sel ? " sif-row--sel" : ""}`}
        onMouseEnter={() => setSel(i)} onMouseDown={e => { e.preventDefault(); open(m); }}>
        <span className="sif-line">{m.line}</span>
        <span className="sif-text">{text.slice(0, at)}<b>{text.slice(at, at + m.len)}</b>{text.slice(at + m.len)}</span>
      </div>,
    );
  });

  return (
    <div className="cmdp-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cmdp sif">
        <div className="cmdp-input-row">
          <span className="cmdp-icon">⌕</span>
          <input ref={inputRef} className="cmdp-input" placeholder="Search in files…" value={query}
            onChange={e => setQuery(e.target.value)} onKeyDown={onKeyDown} spellCheck={false} autoComplete="off" />
          <button className={`sif-opt${opts.caseSensitive ? " sif-opt--on" : ""}`} title="Match case (Alt+C)"
            onMouseDown={e => { e.preventDefault(); toggle("caseSensitive"); }}>Aa</button>
          <button className={`sif-opt sif-opt--word${opts.wholeWord ? " sif-opt--on" : ""}`} title="Whole words (Alt+W)"
            onMouseDown={e => { e.preventDefault(); toggle("wholeWord"); }}>ab</button>
          <button className={`sif-opt${opts.regex ? " sif-opt--on" : ""}`} title="Regular expression (Alt+R)"
            onMouseDown={e => { e.preventDefault(); toggle("regex"); }}>.*</button>
        </div>
        <div className={`sif-summary${error ? " sif-summary--err" : ""}`}>
          {summary}{matches.length > SHOWN ? ` · showing the first ${SHOWN}` : ""}
        </div>
        <div className="cmdp-list sif-list">
          {query && !busy && !error && result && matches.length === 0 && <div className="cmdp-empty">no matches</div>}
          {rows}
        </div>
      </div>
    </div>
  );
}
