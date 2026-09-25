/**
 * ConfirmDialog.tsx — the in-app yes/no dialog. In the desktop app
 * window.confirm() opens a plain system box titled "wails.localhost
 * says", so everything that can wait for an answer uses this instead.
 * (Plugin permission prompts stay on window.confirm(): the Lua VM asks
 * synchronously, mid-script.)
 */

import { useEffect, useRef, useState } from "react";

interface Request {
  message: string;
  ok: string;
  danger: boolean;
  resolve: (answer: boolean) => void;
}

let show: ((req: Request) => void) | null = null;

/** Asks a yes/no question. Resolves true for OK, false for Cancel,
 *  Escape or a click outside. */
export function confirmDialog(message: string, opts: { ok?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise(resolve => {
    const req: Request = { message, ok: opts.ok ?? "OK", danger: opts.danger ?? false, resolve };
    if (show) show(req);
    else resolve(window.confirm(message));
  });
}

export default function ConfirmDialog() {
  const [req, setReq] = useState<Request | null>(null);
  const reqRef = useRef<Request | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  const answer = (value: boolean) => {
    const r = reqRef.current;
    if (!r) return;
    reqRef.current = null;
    setReq(null);
    r.resolve(value);
    returnFocus.current?.focus?.({ preventScroll: true });
  };
  const answerRef = useRef(answer);
  answerRef.current = answer;

  useEffect(() => {
    show = next => {
      reqRef.current?.resolve(false); // a newer question replaces an open one
      if (!reqRef.current) returnFocus.current = document.activeElement as HTMLElement | null;
      reqRef.current = next;
      setReq(next);
    };
    // Registered once at mount, before the app's own capture listeners,
    // so while the dialog is open no editor or app shortcut sees keys.
    const onKey = (e: KeyboardEvent) => {
      if (!reqRef.current || e.key === "Tab") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type !== "keydown") return;
      if (e.key === "Escape") answerRef.current(false);
      else if (e.key === "Enter" || e.key === " ") {
        const focused = document.activeElement;
        if (focused instanceof HTMLButtonElement && boxRef.current?.contains(focused)) focused.click();
        else answerRef.current(true);
      }
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    return () => {
      show = null;
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
    };
  }, []);

  useEffect(() => { if (req) okRef.current?.focus({ preventScroll: true }); }, [req]);

  if (!req) return null;
  return (
    <div className="confirm-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) answer(false); }}>
      <div className="confirm-box" ref={boxRef} role="alertdialog" aria-modal="true" aria-label="Confirm">
        <div className="confirm-msg">{req.message}</div>
        <div className="confirm-actions">
          <button className="confirm-btn" onClick={() => answer(false)}>Cancel</button>
          <button ref={okRef} className={`confirm-btn confirm-btn--ok${req.danger ? " confirm-btn--danger" : ""}`}
            onClick={() => answer(true)}>{req.ok}</button>
        </div>
      </div>
    </div>
  );
}
