/**
 * QuickOpen.tsx — Ctrl+P in the editor: type part of a file's name (or
 * its path, letters in order: "apts" finds App.tsx, "srcterm" the
 * terminal folder) and Enter opens it. Searches the project the open
 * file is in, skipping dependency and build folders; files open in tabs
 * are listed first.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { listDir } from "../native";
import { fuzzyMatch } from "../terminal/completion";

const SKIP = new Set(["node_modules", "dist", "build", "out", "target", "vendor", "bin", "obj", "__pycache__", "venv", "coverage"]);
const MAX_FILES = 30_000;

/** Every file under `root` (as `root/…` paths), reported in batches as
 *  folders are read; stops when `stop()` says so. */
async function walk(root: string, onFiles: (paths: string[]) => void, stop: () => boolean): Promise<void> {
  const queue = [root];
  let count = 0;
  while (queue.length && !stop() && count < MAX_FILES) {
    // A few folders at a time: reading them is most of the wait.
    const dirs = queue.splice(0, 8);
    const listed = await Promise.all(dirs.map(d => listDir(d).then(es => ({ d, es })).catch(() => ({ d, es: [] }))));
    const files: string[] = [];
    for (const { d, es } of listed) {
      for (const e of es) {
        if (e.name.startsWith(".")) continue;
        const p = `${d}/${e.name}`;
        if (e.isDir) { if (!SKIP.has(e.name)) queue.push(p); }
        else files.push(p);
      }
    }
    count += files.length;
    if (files.length && !stop()) onFiles(files);
  }
}

export function QuickOpen({ root, openPaths, onOpen, onClose }: {
  /** The folder to search. */
  root: string;
  /** Files open in tabs, listed first. */
  openPaths: string[];
  onOpen: (path: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const selRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 10); }, []);

  useEffect(() => {
    let stopped = false;
    const pending: string[] = [];
    let frame = 0;
    walk(root, found => {
      pending.push(...found);
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; const add = pending.splice(0); setFiles(f => f.concat(add)); });
    }, () => stopped).finally(() => { if (!stopped) setDone(true); });
    return () => { stopped = true; cancelAnimationFrame(frame); };
  }, [root]);

  const rel = (p: string) => p.startsWith(root + "/") ? p.slice(root.length + 1) : p;

  const results = useMemo(() => {
    const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
    const open = new Set(openPaths.map(norm));
    const q = query.replace(/\s+/g, "");
    const out: Array<{ path: string; score: number; at: number[]; open: boolean }> = [];
    const seen = new Set<string>();
    for (const p of [...openPaths, ...files]) {
      const key = norm(p);
      if (seen.has(key)) continue;
      seen.add(key);
      const r = rel(p);
      const isOpen = open.has(key);
      if (!q) { if (out.length < 60) out.push({ path: p, score: isOpen ? 1 : 0, at: [], open: isOpen }); continue; }
      // The file's name counts most; the folders help tell apart files
      // with the same name.
      const nameStart = r.lastIndexOf("/") + 1;
      const inName = fuzzyMatch(q, r.slice(nameStart));
      const inPath = inName ? null : fuzzyMatch(q, r);
      if (!inName && !inPath) continue;
      const score = inName ? inName.score + 12 : inPath!.score;
      const at = inName ? inName.at.map(i => i + nameStart) : inPath!.at;
      out.push({ path: p, score: score + (isOpen ? 2 : 0) - r.split("/").length * 0.3, at, open: isOpen });
    }
    return q ? out.sort((a, b) => b.score - a.score).slice(0, 60) : out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, files, openPaths, root]);

  useEffect(() => { setSel(0); }, [query]);
  useEffect(() => { selRef.current?.scrollIntoView({ block: "nearest" }); }, [sel]);

  const open = (p: string | undefined) => { if (p) { onOpen(p); onClose(); } };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); return; }
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key.toLowerCase() === "n")) { e.preventDefault(); setSel(i => Math.min(i + 1, results.length - 1)); return; }
    if (e.key === "ArrowUp" || (e.ctrlKey && e.key.toLowerCase() === "p")) { e.preventDefault(); setSel(i => Math.max(i - 1, 0)); return; }
    if (e.key === "Enter") { e.preventDefault(); open(results[sel]?.path); }
  };

  return (
    <div className="cmdp-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cmdp quickopen">
        <div className="cmdp-input-row">
          <span className="cmdp-icon">⌕</span>
          <input ref={inputRef} className="cmdp-input" placeholder="Go to file…" value={query}
            onChange={e => setQuery(e.target.value)} onKeyDown={onKeyDown}
            spellCheck={false} autoComplete="off" />
          <span className="cmdp-hint">{done ? `${files.length.toLocaleString()} files` : `searching… ${files.length.toLocaleString()}`}</span>
        </div>
        <div className="cmdp-list">
          {results.length === 0 && <div className="cmdp-empty">{done || query ? "no matching files" : "reading the folder…"}</div>}
          {results.map((r, i) => {
            const path = rel(r.path);
            const cut = path.lastIndexOf("/") + 1;
            const marked = new Set(r.at);
            const piece = (from: number, to: number) => [...path.slice(from, to)].map((ch, k) =>
              marked.has(from + k) ? <b key={k}>{ch}</b> : ch);
            return (
              <div key={r.path} ref={i === sel ? selRef : undefined}
                className={`cmdp-item quickopen-item${i === sel ? " cmdp-item--selected" : ""}`}
                onMouseEnter={() => setSel(i)}
                onMouseDown={e => { e.preventDefault(); open(r.path); }}>
                <span className="quickopen-name">{piece(cut, path.length)}</span>
                <span className="quickopen-dir">{piece(0, Math.max(0, cut - 1))}</span>
                {r.open && <span className="cmdp-item-cat">open</span>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
