/**
 * CodeMinimap.tsx — the whole file in miniature beside the editor, like
 * VS Code's: a sliver per line (its indentation and length), the part
 * on screen outlined, and markers for mistakes (red, yellow), find
 * matches and unsaved changes, so where they are is visible at a
 * glance however long the file is. The file always fits: long files
 * get thinner lines. Click or drag to scroll there.
 *
 * The lines and markers are drawn once into an offscreen canvas when
 * they change; scrolling only copies it and outlines the view, so a
 * long file scrolls smoothly.
 */

import { useCallback, useEffect, useRef } from "react";
import type { Problem } from "../terminal/codeCheck";
import { lineAt, type Mark } from "../terminal/editorDecor";
import { events } from "../terminal/events";

export const MINIMAP_WIDTH = 84;

// Theme colours, read once per theme (reading computed styles on every
// frame is slow: it can make the browser recalculate styles).
let colours: Record<string, string> | null = null;
events.on("theme_changed", () => { colours = null; });
function colour(name: string, fallback: string): string {
  if (!colours) {
    const css = getComputedStyle(document.documentElement);
    colours = {};
    for (const n of ["--text", "--purple3", "--purple", "--err", "--warn", "--border2"]) colours[n] = css.getPropertyValue(n).trim();
  }
  return colours[name] || fallback;
}

export function CodeMinimap({ text, starts, problems, marks, changedLines, textareaRef }: {
  text: string;
  /** Line starts of `text` (editorDecor.lineStarts). */
  starts: number[];
  problems: Problem[];
  marks: Mark[];
  /** 1-based lines changed since the last save. */
  changedLines?: Set<number>;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pictureRef = useRef<HTMLCanvasElement | null>(null);
  const pictureKey = useRef("");
  const frame = useRef(0);

  /** Draws the lines and markers into the offscreen picture. */
  const paint = useCallback((w: number, h: number, dpr: number) => {
    const pic = (pictureRef.current ??= document.createElement("canvas"));
    pic.width = Math.round(w * dpr);
    pic.height = Math.round(h * dpr);
    const g = pic.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = starts.length;
    const perLine = Math.min(3, h / n); // px per line: the whole file always fits
    const charW = Math.min(1, (w - 14) / 90);

    // The text: a bar per line from its indentation to its end.
    g.fillStyle = colour("--text", "#c0caf5");
    g.globalAlpha = 0.32;
    const step = perLine < 0.75 ? Math.ceil(0.75 / perLine) : 1;
    for (let i = 0; i < n; i += step) {
      const s = starts[i], e = i + 1 < n ? starts[i + 1] - 1 : text.length;
      let indent = 0;
      while (s + indent < e && (text.charCodeAt(s + indent) === 32 || text.charCodeAt(s + indent) === 9)) indent++;
      const len = Math.min(e - s, 140) - indent;
      if (len > 0) g.fillRect(6 + indent * charW, i * perLine, Math.max(1, Math.min(len * charW, w - 20)), Math.max(0.8, perLine * 0.62));
    }
    g.globalAlpha = 1;

    const tick = (line: number, fill: string, x: number, width: number) => {
      g.fillStyle = fill;
      g.fillRect(x, Math.min(line * perLine, h - 3), width, Math.max(3, perLine));
    };
    // Unsaved changes: the left edge.
    if (changedLines) { const c = colour("--purple3", "#9ece6a"); for (const l of changedLines) tick(l - 1, c, 0, 2); }
    // Find matches: the right edge.
    const accent = colour("--purple", "#bb9af7");
    for (const m of marks) tick(lineAt(starts, m.from), accent, w - 12, 5);
    // Mistakes: a band across and a marker on the far right; errors
    // drawn last, so they're on top of warnings.
    const err = colour("--err", "#f7768e"), warn = colour("--warn", "#e0af68");
    for (const p of [...problems].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? 1 : -1))) {
      const line = lineAt(starts, Math.min(p.from, Math.max(0, text.length - 1)));
      const c = p.severity === "error" ? err : warn;
      g.globalAlpha = 0.22;
      g.fillStyle = c;
      g.fillRect(0, line * perLine, w, Math.max(2, perLine));
      g.globalAlpha = 1;
      tick(line, c, w - 5, 5);
    }
  }, [text, starts, problems, marks, changedLines]);

  const draw = useCallback(() => {
    frame.current = 0;
    const canvas = canvasRef.current, ta = textareaRef.current;
    if (!canvas || !ta) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const key = `${w}x${h}@${dpr}`;
    if (pictureKey.current !== key || !pictureRef.current) { paint(w, h, dpr); pictureKey.current = key; }
    const g = canvas.getContext("2d");
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.drawImage(pictureRef.current!, 0, 0);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    // What's on screen.
    const content = starts.length * Math.min(3, h / starts.length);
    const top = (ta.scrollTop / ta.scrollHeight) * content;
    const height = Math.max(6, (ta.clientHeight / ta.scrollHeight) * content);
    g.fillStyle = colour("--text", "#c0caf5");
    g.globalAlpha = 0.09;
    g.fillRect(0, top, w, height);
    g.globalAlpha = 0.35;
    g.strokeStyle = colour("--border2", "#565f89");
    g.lineWidth = 1;
    g.strokeRect(0.5, top + 0.5, w - 1, height - 1);
    g.globalAlpha = 1;
  }, [paint, starts.length, textareaRef]);

  // New lines or markers: paint the picture again.
  useEffect(() => { pictureKey.current = ""; }, [paint]);

  const schedule = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(draw);
  }, [draw]);

  useEffect(() => { schedule(); }, [schedule]);
  useEffect(() => {
    const ta = textareaRef.current, canvas = canvasRef.current;
    if (!ta || !canvas) return;
    ta.addEventListener("scroll", schedule);
    const ro = new ResizeObserver(schedule);
    ro.observe(canvas);
    ro.observe(ta);
    return () => { ta.removeEventListener("scroll", schedule); ro.disconnect(); if (frame.current) cancelAnimationFrame(frame.current); frame.current = 0; };
  }, [schedule, textareaRef]);

  // Click or drag: the point under the mouse comes to the middle of the view.
  const scrollTo = useCallback((clientY: number) => {
    const canvas = canvasRef.current, ta = textareaRef.current;
    if (!canvas || !ta) return;
    const rect = canvas.getBoundingClientRect();
    const perLine = Math.min(3, rect.height / starts.length);
    const fraction = Math.max(0, Math.min(1, (clientY - rect.top) / (starts.length * perLine)));
    ta.scrollTop = fraction * ta.scrollHeight - ta.clientHeight / 2;
  }, [starts.length, textareaRef]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    scrollTo(e.clientY);
    const move = (ev: MouseEvent) => scrollTo(ev.clientY);
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }, [scrollTo]);

  return (
    <canvas ref={canvasRef} className="code-minimap" style={{ width: MINIMAP_WIDTH }}
      onMouseDown={onMouseDown} title="The whole file — click or drag to scroll there" />
  );
}
