/**
 * AppBar.tsx — the bar across the top of OXIS: the mark, Home and the
 * terminal tabs (passed in as children, App owns them), the command
 * search, Themes / Plugins / Settings, and in the native window its
 * minimise and close buttons.
 *
 * In the frameless native window the bar is the titlebar: dragging
 * comes from `--wails-draggable: drag` on .appbar (CSS only), and every
 * control opts out with `no-drag`. There's no maximise button; the
 * window's size is set with 'oxis resize.
 */

import React from "react";
import logoUrl from "../assets/logo.svg";

// window.go's type is declared once, in native.ts.
import "../native";

declare global {
  interface Window {
    runtime?: {
      WindowMinimise?: () => void;
      Quit?: () => void;
      EventsOn?: (name: string, cb: (...args: unknown[]) => void) => void;
      EventsOff?: (name: string) => void;
    };
  }
}

type BoundName = "WindowMinimise" | "WindowClose";

// Calls the Go-bound method if it's ready; falls back to the JS
// runtime binding; if NEITHER is ready yet (very first paint), waits
// briefly and retries a few times before giving up quietly.
function callBound(name: BoundName, attempt = 0): void {
  const goFn = window.go?.wailsapp?.App?.[name];
  if (goFn) { goFn(); return; }

  const runtimeName = name === "WindowClose" ? "Quit" : name;
  const runtimeFn = (window.runtime as Record<string, (() => void) | undefined> | undefined)?.[runtimeName];
  if (runtimeFn) { runtimeFn(); return; }

  if (attempt < 10) {
    setTimeout(() => callBound(name, attempt + 1), 50);
  }
}

/** Line icons, 16 px on a 16 grid, drawn with currentColor. */
export function Icon({ name }: { name: "search" | "themes" | "plugins" | "settings" | "min" | "close" | "home" | "shell" | "plus" }) {
  const p = {
    search: <><circle cx="7" cy="7" r="4.25" /><path d="M10.2 10.2 13.5 13.5" /></>,
    themes: <><path d="M8 2.5a5.5 5.5 0 1 0 0 11c.9 0 1.3-.5 1.3-1.1 0-.9-.8-1.1-.8-2 0-.7.5-1.2 1.3-1.2h1.4c1.5 0 2.3-1 2.3-2.3C13.5 4.4 11.1 2.5 8 2.5Z" /><circle cx="5.2" cy="7" r=".6" /><circle cx="7.4" cy="4.9" r=".6" /><circle cx="10.4" cy="5.4" r=".6" /></>,
    plugins: <><path d="M6.2 2.5h3.6v2.2a1.3 1.3 0 1 0 2.4 0V2.5h1.3v3.6h-2.2a1.3 1.3 0 1 0 0 2.4h2.2v5H9.8v-2.2a1.3 1.3 0 1 0-2.4 0v2.2H2.5V9.8h2.2a1.3 1.3 0 1 0 0-2.4H2.5V2.5h3.7Z" /></>,
    settings: <><circle cx="8" cy="8" r="2.1" /><path d="M8 1.8v1.7M8 12.5v1.7M14.2 8h-1.7M3.5 8H1.8M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2M12.4 12.4l-1.2-1.2M4.8 4.8 3.6 3.6" /></>,
    min: <path d="M3.5 8h9" />,
    close: <path d="m4 4 8 8M12 4l-8 8" />,
    home: <><path d="M2.8 7.2 8 2.8l5.2 4.4" /><path d="M4.3 6.2v7h7.4v-7" /></>,
    shell: <><path d="m3.5 5 3 3-3 3" /><path d="M8.5 11.5h4" /></>,
    plus: <path d="M8 3.5v9M3.5 8h9" />,
  }[name];
  return <svg className="ico" viewBox="0 0 16 16" aria-hidden="true">{p}</svg>;
}

export interface AppBarProps {
  native: boolean;
  /** Home and the terminal tabs. */
  children: React.ReactNode;
  onSearch: () => void;
  onThemes: () => void;
  onPlugins: () => void;
  onSettings: () => void;
}

export default function AppBar({ native, children, onSearch, onThemes, onPlugins, onSettings }: AppBarProps) {
  // Buttons keep the focus where it was (the prompt, usually).
  const keep = (e: React.MouseEvent) => e.preventDefault();
  return (
    <header className={`appbar${native ? " appbar--native" : ""}`}>
      <div className="appbar-brand" title="OXIS">
        <img src={logoUrl} alt="" width={18} height={18} draggable={false} />
        <span className="appbar-word">OXIS</span>
      </div>
      <nav className="appbar-tabs" role="tablist" aria-label="Home and terminal tabs">{children}</nav>
      <div className="appbar-tools">
        <button className="appbar-search" onMouseDown={keep} onClick={onSearch} title="Search commands, settings and history (Ctrl+Shift+P)">
          <Icon name="search" />
          <span className="appbar-search-text">Run a command…</span>
          <kbd>Ctrl Shift P</kbd>
        </button>
        <button className="appbar-btn" onMouseDown={keep} onClick={onThemes} title="Themes" aria-label="Themes"><Icon name="themes" /></button>
        <button className="appbar-btn" onMouseDown={keep} onClick={onPlugins} title="Plugins" aria-label="Plugins"><Icon name="plugins" /></button>
        <button className="appbar-btn" onMouseDown={keep} onClick={onSettings} title="Settings (Ctrl+,)" aria-label="Settings"><Icon name="settings" /></button>
      </div>
      {native && (
        <div className="appbar-window">
          <button className="appbar-win" onClick={() => callBound("WindowMinimise")} aria-label="Minimise" title="Minimise"><Icon name="min" /></button>
          <button className="appbar-win appbar-win--close" onClick={() => callBound("WindowClose")} aria-label="Close" title="Close"><Icon name="close" /></button>
        </div>
      )}
    </header>
  );
}
