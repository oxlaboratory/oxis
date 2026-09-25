/**
 * clipboard.ts — copy and paste that work in the desktop app and in a
 * browser tab.
 *
 * In the desktop app the native clipboard (Go) is used first, because
 * the WebView's navigator.clipboard can be missing or reject without a
 * focused document. In a browser tab navigator.clipboard is used, with
 * document.execCommand as a last resort.
 */

import { isNativeApp, writeClipboard, readClipboard } from "../native";
import { events } from "./events";

function execCommandCopy(text: string): boolean {
  const active = document.activeElement as HTMLElement | null;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  active?.focus?.({ preventScroll: true });
  return ok;
}

/** Copies text to the clipboard. Returns whether it worked, and flashes
 *  a short confirmation in the status bar. */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  let ok = false;
  if (isNativeApp()) {
    try { await writeClipboard(text); ok = true; } catch { /* try the web APIs */ }
  }
  if (!ok && navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); ok = true; } catch { /* last resort below */ }
  }
  if (!ok) ok = execCommandCopy(text);
  const lines = text.split("\n").length;
  events.emit("status_flash", {
    text: ok ? `copied ${lines > 1 ? `${lines} lines` : `${text.length} chars`}` : "copy failed",
  });
  return ok;
}

/** Reads text from the clipboard, or null if it can't be read. */
export async function pasteText(): Promise<string | null> {
  if (isNativeApp()) {
    try { return await readClipboard(); } catch { /* try the web API */ }
  }
  if (navigator.clipboard?.readText) {
    try { return await navigator.clipboard.readText(); } catch { /* not allowed */ }
  }
  return null;
}
