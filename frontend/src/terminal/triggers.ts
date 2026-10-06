/**
 * triggers.ts — 'trigger: watch the shell's output for a pattern and
 * act when a line matches it (as iTerm2's triggers do): highlight the
 * line, play a sound, and/or flash the taskbar and say so in the status
 * bar. For logs and dev servers: ERROR, FAILED, "listening on", a
 * deploy's "done".
 *
 * A pattern is plain text — found anywhere in the line, ignoring case
 * unless it has capitals in it (as find does) — or /a regular
 * expression/ with optional flags.
 */

export type TriggerColor = "err" | "warn" | "ok" | "accent";
export const TRIGGER_COLORS: TriggerColor[] = ["err", "warn", "ok", "accent"];

export interface Trigger {
  pattern: string;
  color?: TriggerColor;
  /** An event or sound name for playSound ("error", "chime"…). */
  sound?: string;
  /** Flash the taskbar (in the background) and say it in the status bar. */
  notify?: boolean;
}

const compiled = new Map<string, RegExp | null>();

/** The pattern as a RegExp, or null if it's a broken /regex/. */
export function triggerRegex(pattern: string): RegExp | null {
  if (compiled.has(pattern)) return compiled.get(pattern)!;
  let re: RegExp | null;
  const m = /^\/(.+)\/([a-z]*)$/.exec(pattern);
  try {
    re = m
      ? new RegExp(m[1], m[2].replace(/[gy]/g, ""))
      : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), /[A-Z]/.test(pattern) ? "" : "i");
  } catch {
    re = null;
  }
  compiled.set(pattern, re);
  return re;
}

/** Splits 'trigger add's words, keeping "quoted phrases" and /re ge x/
 *  together. */
export function splitTriggerArgs(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\/(?:\\.|[^/])+\/[a-z]*)|(\S+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** 'trigger add's words as a trigger, or why they aren't one. */
export function parseTrigger(words: string[]): Trigger | string {
  const [pattern, ...opts] = words;
  if (!pattern) return "usage: 'trigger add <text or /regex/> [err|warn|ok|accent] [sound=<name>] [notify]";
  if (!triggerRegex(pattern)) return `not a regular expression: ${pattern}`;
  const t: Trigger = { pattern };
  for (const o of opts) {
    const lo = o.toLowerCase();
    if ((TRIGGER_COLORS as string[]).includes(lo)) t.color = lo as TriggerColor;
    else if (lo === "notify") t.notify = true;
    else if (lo.startsWith("sound=")) t.sound = o.slice(6);
    else return `don't know "${o}" — a colour (${TRIGGER_COLORS.join(", ")}), sound=<name> or notify`;
  }
  if (!t.color && !t.sound && !t.notify) t.color = "warn"; // something must happen
  return t;
}

export interface TriggerHits {
  /** Per line index: the colour to highlight it with. */
  colors: Map<number, TriggerColor>;
  sounds: Set<string>;
  /** The matching lines of notify triggers (trimmed). */
  notices: string[];
}

/** What the triggers make of these lines of output. */
export function runTriggers(lines: string[], triggers: Trigger[]): TriggerHits {
  const hits: TriggerHits = { colors: new Map(), sounds: new Set(), notices: [] };
  if (!triggers.length) return hits;
  lines.forEach((text, i) => {
    if (!text.trim()) return;
    for (const t of triggers) {
      const re = triggerRegex(t.pattern);
      if (!re || !re.test(text)) continue;
      if (t.color && !hits.colors.has(i)) hits.colors.set(i, t.color);
      if (t.sound) hits.sounds.add(t.sound);
      if (t.notify) hits.notices.push(text.trim().slice(0, 120));
    }
  });
  return hits;
}

/** How a trigger reads in 'trigger's list. */
export function describeTrigger(t: Trigger): string {
  const does = [t.color && `highlight ${t.color}`, t.sound && `sound ${t.sound}`, t.notify && "notify"].filter(Boolean).join(", ");
  return `${t.pattern}  →  ${does}`;
}
