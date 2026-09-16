/**
 * Titlebar.tsx — custom frameless titlebar.
 *
 * OXIS runs as a native, frameless Wails window (see
 * internal/wailsapp/app.go), so it draws its own titlebar — a
 * draggable region plus close/minimise window controls. (No
 * maximise control: the window is a fixed size — Width/Height ==
 * Min == Max, DisableResize — so there's nothing to toggle into.)
 *
 * Dragging: handled entirely natively by Wails via the
 * `--wails-draggable: drag` CSS property already set on
 * .wails-titlebar / .wails-drag (see index.css) — that's the real,
 * documented Wails v2 mechanism (options.App.CSSDragProperty /
 * CSSDragValue, which default to exactly this even when unset). No
 * JS or Go call is needed or exists for this: `WindowStartDrag` was
 * checked against Wails v2's actual Go runtime package, its JS
 * runtime docs, AND its internal Frontend interface (the thing that
 * defines every real window method on both sides) — it exists in
 * none of them. An earlier version of this file called
 * window.runtime.WindowStartDrag() as a fallback on every mousedown;
 * that function doesn't exist, so it silently retried 10 times and
 * did nothing, on every single click, before giving up. Removed —
 * plain CSS is both correct and sufficient here.
 *
 * window.go.wailsapp.App.* (the Go-bound methods) is the primary path
 * for the two real buttons below; window.runtime.* is a fallback only
 * for the unlikely case the app isn't bound yet on first paint.
 */

import React from "react";

// window.go.wailsapp.App.* is declared once, globally, in native.ts —
// intentionally not redeclared here. Two separate `declare global`
// blocks describing different, incompatible shapes for the same real
// object is a TS2717 error (duplicate declarations must match
// exactly), and silently drops type-checking on this file if ignored.
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
