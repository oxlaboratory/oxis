// One-line hints for tabs and split panes, printed in a fresh terminal
// until they've been seen a few times.

const KEY = "oxis-hints-v1";
const SHOW = 3;

type Seen = { start: number; tab: number; pane: number; used: boolean; tip: number };

function read(): Seen {
  const none = { start: 0, tab: 0, pane: 0, used: false, tip: 0 };
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

// One tip per fresh terminal, each shown once, about things that are
// easy to miss.
const TIPS = [
  "  tip: Tab completes files, git branches, npm scripts and programs · → takes the dim suggestion",
  "  tip: right-click a command's output to run it again or copy it · ▾ on its line folds it",
  "  tip: 'shell gitbash (or wsl, cmd…) opens a tab with another shell — or right-click +",
  "  tip: click src/app.ts:12 in an error to open the editor at that line",
  "  tip: right-click a tab to rename, duplicate or close it · drag tabs to reorder",
  "  tip: Ctrl+Shift+Space labels the URLs, paths and hashes on screen — type a label to copy it",
  "  tip: 'record saves this tab as an asciinema cast, for bug reports and docs — 'record stop",
  // Windows-only features, told only there.
  ...(typeof navigator !== "undefined" && /Windows/.test(navigator.userAgent) ? [
    "  tip: Win+` brings OXIS to the front from any program, and away again ('config set summonKey)",
    "  tip: right-click a folder in Explorer → Open in OXIS opens it here (installed OXIS) · or oxis <folder>",
  ] : []),
];

/** The next tip not yet shown, or null once they all have been. */
export function tipHint(): string | null {
  const seen = read();
  if (seen.tip >= TIPS.length) return null;
  const text = TIPS[seen.tip];
  write({ ...seen, tip: seen.tip + 1 });
  return text;
}
