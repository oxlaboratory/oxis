/**
 * Titlebar.tsx — the frameless window's titlebar (native window only).
 *
 * Dragging comes from the `--wails-draggable: drag` CSS property on
 * .wails-titlebar / .wails-drag; no JS call is involved. The buttons
 * call the bound App.WindowMinimise / WindowClose, with window.runtime
 * as a fallback if the bindings aren't ready yet. There's no maximise
 * button; the size is set with 'oxis resize.
 */

import React from "react";

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

interface TitlebarProps {
  mode: "home" | "shell";
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

function minimise(): void { callBound("WindowMinimise"); }
function close(): void { callBound("WindowClose"); }

export default function Titlebar({ mode }: TitlebarProps) {
  return (
    <div className="wails-titlebar">
      <div className="wails-traffic">
        <button
          className="wails-dot wails-dot--close"
          aria-label="Close"
          onClick={close}
        />
        <button
          className="wails-dot wails-dot--min"
          aria-label="Minimise"
          onClick={minimise}
        />
      </div>

      <div className="wails-drag">
        <span className="wails-title">OXIS</span>
        <span className="wails-mode-pill">{mode === "home" ? "home" : "shell"}</span>
      </div>

      <div className="wails-spacer" aria-hidden="true" />
    </div>
  );
}
