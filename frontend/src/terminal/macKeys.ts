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
export function installMacShortcuts(): void {
  if (installed || !isMac()) return;
  installed = true;
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
