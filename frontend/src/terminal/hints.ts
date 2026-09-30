// One-line hints for tabs and split panes, printed in a fresh terminal
// until they've been seen a few times.

const KEY = "oxis-hints-v1";
const SHOW = 3;

type Seen = { start: number; tab: number; pane: number; used: boolean };

function read(): Seen {
  const none = { start: 0, tab: 0, pane: 0, used: false };
  try { return { ...none, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") }; }
  catch { return none; }
}

function write(seen: Seen) {
  try { localStorage.setItem(KEY, JSON.stringify(seen)); } catch { /* private window: hints just repeat */ }
}

/** Counts one showing of a hint; null once it's been shown enough. */
function take(kind: "start" | "tab" | "pane", text: string): string | null {
  const seen = read();
  if (seen[kind] >= SHOW) return null;
  seen[kind]++;
  write(seen);
  return text;
}

/** The first terminal: how to open a tab or split, until one has been. */
export function startHint(): string | null {
  if (read().used) return null;
  return take("start", "  Ctrl+T new tab · Ctrl+Shift+\\ split · right-click for more");
}

/** A new tab: how to get around them. */
export function tabHint(): string | null {
  markUsed();
  return take("tab", "  new tab · Ctrl+Tab next · Ctrl+1…9 go to one · Ctrl+Shift+W close");
}

/** A new pane beside ("row") or below ("column") the one it split from. */
export function paneHint(split: "row" | "column"): string | null {
  markUsed();
  const keys = split === "row" ? "←→" : "↑↓";
  return take("pane", `  Alt+${keys} switch · Alt+Shift+${keys} resize · Ctrl+Shift+W close`);
}

function markUsed() {
  const seen = read();
  if (!seen.used) write({ ...seen, used: true });
}
