/**
 * fullScreen.ts — a real terminal grid for full-screen programs: vim,
 * less, htop, lazygit, fzf, Microsoft Edit… They switch the terminal to
 * its alternate screen and draw with cursor moves, which the line view
 * can't show. The Go side sends their output untouched between
 * "screen-start" and "screen-end" (internal/pty, screenSplitter); this
 * draws it with xterm.js and sends keys, mouse and size back.
 *
 * xterm.js is loaded the first time a full-screen program runs, so it
 * costs nothing at startup.
 */

import type { Terminal as XTerm, ITheme } from "@xterm/xterm";

export interface FullScreenView {
  write(data: string): void;
  /** Fits the grid to its box; returns the new size, or null if it
   *  didn't change. */
  fit(): { cols: number; rows: number } | null;
  focus(): void;
  dispose(): void;
}

export interface FullScreenOptions {
  cols: number;
  rows: number;
  /** Keys, pastes and mouse reports, for the program. */
  onData: (data: string) => void;
}

/** The theme's colours, read from its CSS variables (themeManager). */
function themeFromCss(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const ansi = (i: number, fallback: string) => v(`--ansi-${i}`, fallback);
  return {
    background: v("--bg", "#0c0a12"),
    foreground: v("--text", "#e8e6f0"),
    cursor: v("--caret", v("--purple", "#3dff64")),
    cursorAccent: v("--bg", "#0c0a12"),
    selectionBackground: v("--selection", "rgba(61,255,100,.25)"),
    black: ansi(0, "#414868"), red: ansi(1, "#f7768e"), green: ansi(2, "#9ece6a"), yellow: ansi(3, "#e0af68"),
    blue: ansi(4, "#7aa2f7"), magenta: ansi(5, "#bb9af7"), cyan: ansi(6, "#7dcfff"), white: ansi(7, "#c0caf5"),
    brightBlack: ansi(8, "#565f89"), brightRed: ansi(9, "#ff7a93"), brightGreen: ansi(10, "#b9f27c"),
    brightYellow: ansi(11, "#ff9e64"), brightBlue: ansi(12, "#7da6ff"), brightMagenta: ansi(13, "#c9a7ff"),
    brightCyan: ansi(14, "#0db9d7"), brightWhite: ansi(15, "#ffffff"),
  };
}

export async function openFullScreen(host: HTMLElement, opts: FullScreenOptions): Promise<FullScreenView> {
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    import("@xterm/xterm/css/xterm.css"),
  ]);
  const css = getComputedStyle(document.documentElement);
  const term: XTerm = new Terminal({
    cols: opts.cols,
    rows: opts.rows,
    fontFamily: css.getPropertyValue("--font").trim() || "monospace",
    fontSize: parseFloat(css.getPropertyValue("--fs")) || 13,
    lineHeight: 1.1,
    cursorBlink: true,
    scrollback: 0,           // the alternate screen has none
    allowTransparency: false,
    theme: themeFromCss(),
  });
  const fitter = new FitAddon();
  term.loadAddon(fitter);
  term.open(host);
  const sub = term.onData(opts.onData);
  const bin = term.onBinary(opts.onData); // mouse reports in some modes

  let last = { cols: term.cols, rows: term.rows };
  return {
    write: (data) => term.write(data),
    fit: () => {
      try { fitter.fit(); } catch { return null; }
      if (term.cols === last.cols && term.rows === last.rows) return null;
      last = { cols: term.cols, rows: term.rows };
      return last;
    },
    focus: () => term.focus(),
    dispose: () => { sub.dispose(); bin.dispose(); term.dispose(); },
  };
}

/** True while a key event belongs to a full-screen program (so OXIS's
 *  own shortcuts leave it alone). */
export function inFullScreen(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest(".term-screen");
}
