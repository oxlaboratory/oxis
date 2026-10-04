/**
 * macKeys.ts — ⌘ shortcuts on macOS. OXIS's shortcuts are written for
 * Ctrl, which on a Mac belongs to the shell (Ctrl+C interrupts, Ctrl+A
 * is the line's start). So on macOS ⌘+key is handed to OXIS as its
 * Ctrl+key for the app's own shortcuts — tabs, splits, zoom, the
 * palette, and in the editor save, find, undo… — and ⌘C ⌘V ⌘X ⌘A stay
 * the system's.
 */

export interface KeyLike { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }

// The app's own shortcuts, anywhere.
const APP = new Set(["t", "w", "=", "+", "-", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "b"]);
const APP_SHIFT = new Set(["p", "m", "w", "f", "o", "\\", "|"]);
// The editor's, while it has the keyboard.
const EDITOR = new Set(["s", "f", "h", "p", "g", "z", "y", "/", "d", "l", "]", "[", "enter", " "]);
const EDITOR_SHIFT = new Set(["k", "enter", "z"]);

/** The Ctrl+key OXIS should see for this ⌘+key, or null to leave it to
 *  the system. */
export function macShortcut(e: KeyLike, inEditor: boolean): { key: string; shiftKey: boolean } | null {
  if (!e.metaKey || e.ctrlKey || e.altKey) return null;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
  if (e.shiftKey) {
    // ⌘⇧Z is redo on a Mac: the editor's Ctrl+Y.
    if (inEditor && k === "z") return { key: "y", shiftKey: false };
    if (APP_SHIFT.has(k) || (inEditor && EDITOR_SHIFT.has(k))) return { key: e.key, shiftKey: true };
    return null;
  }
  if (inEditor && EDITOR.has(k)) return { key: e.key, shiftKey: false };
  // In the terminal: ⌘K clears (Ctrl+L), ⌘F searches the output.
  if (!inEditor && k === "k") return { key: "l", shiftKey: false };
  if (!inEditor && k === "f") return { key: "F", shiftKey: true };
  if (APP.has(k)) return { key: e.key, shiftKey: false };
  return null;
}

export const isMac = (): boolean =>
  typeof navigator !== "undefined" && /mac/i.test((navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || "");

/** On macOS, turns ⌘ shortcuts into the Ctrl ones OXIS handles. */
let installed = false;
export function installMacShortcuts(clipboard?: { read(): Promise<string>; write(text: string): Promise<void> }): void {
  if (installed || !isMac()) return;
  installed = true;
  const rt = (window as { runtime?: { EventsOn?: (name: string, cb: (...args: unknown[]) => void) => void } }).runtime;
  if (clipboard) rt?.EventsOn?.("menu_edit", (action) => { void macEditAction(String(action), clipboard); });
  window.addEventListener("keydown", (e) => {
    const target = e.target as Element | null;
    const inEditor = !!target?.closest?.(".editor");
    const to = macShortcut(e, inEditor);
    if (!to || !target) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    target.dispatchEvent(new KeyboardEvent("keydown", {
      key: to.key, code: e.code, ctrlKey: true, shiftKey: to.shiftKey, altKey: false, metaKey: false,
      bubbles: true, cancelable: true, composed: true,
    }));
  }, true);
}

type Editable = HTMLInputElement | HTMLTextAreaElement;
const editable = (el: Element | null): el is Editable => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;

/** What the macOS Edit menu asks for (internal/wailsapp/menu_darwin.go):
 *  done here, so undo is the editor's and the clipboard is OXIS's. */
export async function macEditAction(action: string, clipboard: { read(): Promise<string>; write(text: string): Promise<void> }): Promise<void> {
  const el = document.activeElement;
  const selected = (): string => editable(el)
    ? el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0)
    : window.getSelection()?.toString() ?? "";
  switch (action) {
    case "copy": case "cut": {
      const text = selected();
      if (!text) return;
      await clipboard.write(text);
      if (action === "cut" && editable(el) && !el.readOnly) document.execCommand("insertText", false, "");
      return;
    }
    case "paste": {
      if (!editable(el)) return;
      const text = await clipboard.read();
      if (!text) return;
      // Through the paste event first: the prompt confirms several lines.
      const data = new DataTransfer();
      data.setData("text/plain", text);
      if (el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }))) {
        document.execCommand("insertText", false, text);
      }
      return;
    }
    case "selectAll":
      if (editable(el)) el.select(); else document.execCommand("selectAll");
      return;
    case "undo": case "redo":
      // The editor has its own history (Ctrl+Z / Ctrl+Y); elsewhere the
      // field's own. Never Ctrl+Z to the prompt: that suspends the program.
      if (el?.closest(".editor")) {
        el.dispatchEvent(new KeyboardEvent("keydown", { key: action === "undo" ? "z" : "y", ctrlKey: true, bubbles: true, cancelable: true }));
      } else if (editable(el)) {
        document.execCommand(action);
      }
      return;
  }
}
