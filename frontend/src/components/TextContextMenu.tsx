/**
 * TextContextMenu.tsx — Cut / Copy / Paste / Select All for every text
 * field. The desktop build has no browser context menu, so without this
 * right-clicking an input or the editor does nothing. The terminal
 * output has its own menu.
 */

import { useCallback, useEffect, useState } from "react";
import { copyText, pasteText } from "../terminal/clipboard";
import { events } from "../terminal/events";

type Field = HTMLInputElement | HTMLTextAreaElement;

interface MenuState {
  x: number; y: number;
  el: Field;
  start: number; end: number;
}

const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "email", "password", "tel", "number", ""]);

function fieldFrom(target: EventTarget | null): Field | null {
  if (!(target instanceof HTMLElement)) return null;
  if (target.closest(".term-out")) return null;
  if (target instanceof HTMLTextAreaElement) return target;
  if (target instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(target.type)) return target;
  return null;
}

/** Inserts text at the field's selection the way typing would, so React
 *  sees the change and it can be undone. */
function insertAtSelection(el: Field, text: string): void {
  el.focus({ preventScroll: true });
  if (!document.execCommand("insertText", false, text)) {
    const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? s;
    el.setRangeText(text, s, e, "end");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

export default function TextContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);

  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      const el = fieldFrom(e.target);
      if (!el) return;
      e.preventDefault();
      setMenu({
        x: Math.min(e.clientX, window.innerWidth - 170),
        y: Math.min(e.clientY, window.innerHeight - 140),
        el,
        start: el.selectionStart ?? 0,
        end: el.selectionEnd ?? 0,
      });
    };
    // Confirm native copies (Ctrl+C / Ctrl+X in fields and the editor) the
    // same way copyText() does.
    const onCopy = (e: ClipboardEvent) => {
      const el = fieldFrom(e.target) ?? fieldFrom(document.activeElement);
      const text = el ? el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0) : "";
      if (!text) return;
      const lines = text.split("\n").length;
      events.emit("status_flash", { text: `${e.type === "cut" ? "cut" : "copied"} ${lines > 1 ? `${lines} lines` : `${text.length} chars`}` });
    };
    window.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCopy);
    return () => {
      window.removeEventListener("contextmenu", onContextMenu);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCopy);
    };
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  const run = useCallback(async (action: "cut" | "copy" | "paste" | "all") => {
    if (!menu) return;
    const { el, start, end } = menu;
    setMenu(null);
    el.focus({ preventScroll: true });
    el.setSelectionRange(start, end);
    const selected = el.value.slice(start, end);
    if (action === "copy") { await copyText(selected); return; }
    if (action === "cut") {
      if (await copyText(selected)) insertAtSelection(el, "");
      return;
    }
    if (action === "all") { el.select(); return; }
    const text = await pasteText();
    if (text === null) { events.emit("status_flash", { text: "can't read the clipboard — use Ctrl+V" }); return; }
    el.setSelectionRange(start, end);
    // Let the field's own paste handling run first (the prompt sends
    // multi-line pastes to the shell); otherwise insert the text.
    const data = new DataTransfer();
    data.setData("text/plain", text);
    const pasteEvent = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
    if (el.dispatchEvent(pasteEvent)) insertAtSelection(el, text);
  }, [menu]);

  if (!menu) return null;
  const hasSel = menu.end > menu.start;
  const editable = !menu.el.readOnly && !menu.el.disabled;
  return (
    <div
      className="term-ctx-menu"
      style={{ left: menu.x, top: menu.y }}
      onMouseDown={e => { e.stopPropagation(); e.preventDefault(); }}
    >
      <button className="term-ctx-item" disabled={!hasSel || !editable} onClick={() => void run("cut")}>
        <span>Cut</span><span className="term-ctx-key">Ctrl+X</span>
      </button>
      <button className="term-ctx-item" disabled={!hasSel} onClick={() => void run("copy")}>
        <span>Copy</span><span className="term-ctx-key">Ctrl+C</span>
      </button>
      <button className="term-ctx-item" disabled={!editable} onClick={() => void run("paste")}>
        <span>Paste</span><span className="term-ctx-key">Ctrl+V</span>
      </button>
      <button className="term-ctx-item" onClick={() => void run("all")}>Select All</button>
    </div>
  );
}
