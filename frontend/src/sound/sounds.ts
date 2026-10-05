/**
 * sounds.ts — OXIS's sound effects.
 *
 * Each event (a command failing, a long one finishing, a program's bell,
 * a new tab…) plays a sound chosen by its setting: one of the presets
 * below, synthesised on the spot with Web Audio (so nothing ships as
 * files), "none", or the path of your own sound file (wav, mp3, ogg…).
 * 'sound lists them, plays them and changes them; `sounds` turns them
 * all off and `soundVolume` sets how loud.
 */

import { readAudio } from "../native";

export interface SoundEvent {
  event: string;
  setting: string;
  default: string;
  what: string;
}

export const SOUND_EVENTS: SoundEvent[] = [
  { event: "error",   setting: "soundError",   default: "bonk",    what: "a command fails" },
  { event: "done",    setting: "soundDone",    default: "chime",   what: "a command that ran 3 seconds or more finishes" },
  { event: "bell",    setting: "soundBell",    default: "bell",    what: "a program rings the terminal bell" },
  { event: "notify",  setting: "soundNotify",  default: "ping",    what: "a plugin wants your attention" },
  { event: "install", setting: "soundInstall", default: "sparkle", what: "a plugin is installed" },
  { event: "tab",     setting: "soundTab",     default: "pop",     what: "a terminal tab opens" },
  { event: "copy",    setting: "soundCopy",    default: "tick",    what: "something is copied" },
  { event: "start",   setting: "soundStart",   default: "none",    what: "OXIS starts" },
  { event: "key",     setting: "soundKey",     default: "none",    what: "you type in the prompt" },
];

type Voice = (ctx: AudioContext, out: AudioNode, t: number) => void;

/** A note: an oscillator through a quick attack and an exponential fade. */
function tone(ctx: AudioContext, out: AudioNode, t: number, freq: number, dur: number,
  { type = "sine" as OscillatorType, gain = 0.5, glide = 0, attack = 0.005 } = {}): void {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (glide) osc.frequency.exponentialRampToValueAtTime(glide, t + dur * 0.8);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(out);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

/** A burst of filtered noise: clicks and ticks. */
function noise(ctx: AudioContext, out: AudioNode, t: number, dur: number, { gain = 0.4, freq = 3500 } = {}): void {
  const len = Math.max(1, Math.round(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(hp).connect(g).connect(out);
  src.start(t);
}

export const PRESETS: Record<string, { about: string; voice: Voice }> = {
  chime:   { about: "two bright notes, rising", voice: (c, o, t) => { tone(c, o, t, 880, 0.35, { gain: 0.35 }); tone(c, o, t + 0.09, 1318.5, 0.5, { gain: 0.3 }); } },
  bonk:    { about: "a soft low thud, falling", voice: (c, o, t) => { tone(c, o, t, 220, 0.2, { type: "triangle", gain: 0.55, glide: 150 }); tone(c, o, t + 0.11, 165, 0.28, { type: "triangle", gain: 0.45, glide: 120 }); } },
  bell:    { about: "a small bell", voice: (c, o, t) => { tone(c, o, t, 1046.5, 0.9, { gain: 0.3 }); tone(c, o, t, 2093, 0.5, { gain: 0.09 }); tone(c, o, t, 3136, 0.3, { gain: 0.04 }); } },
  ping:    { about: "one clear high note", voice: (c, o, t) => { tone(c, o, t, 1568, 0.3, { gain: 0.3 }); tone(c, o, t, 3136, 0.15, { gain: 0.05 }); } },
  sparkle: { about: "a quick rising arpeggio", voice: (c, o, t) => { [1046.5, 1318.5, 1568, 2093].forEach((f, i) => tone(c, o, t + i * 0.055, f, 0.28, { gain: 0.22 })); } },
  pop:     { about: "a little bubble pop", voice: (c, o, t) => tone(c, o, t, 620, 0.09, { gain: 0.4, glide: 260 }) },
  tick:    { about: "a dry tick", voice: (c, o, t) => noise(c, o, t, 0.018, { gain: 0.5, freq: 4000 }) },
  click:   { about: "a keyboard click", voice: (c, o, t) => { noise(c, o, t, 0.012, { gain: 0.35, freq: 2500 }); tone(c, o, t, 1800, 0.015, { type: "square", gain: 0.03 }); } },
  blip:    { about: "a retro blip", voice: (c, o, t) => tone(c, o, t, 880, 0.07, { type: "square", gain: 0.2 }) },
  coin:    { about: "an arcade coin", voice: (c, o, t) => { tone(c, o, t, 987.8, 0.08, { type: "square", gain: 0.17 }); tone(c, o, t + 0.08, 1318.5, 0.35, { type: "square", gain: 0.17 }); } },
  soft:    { about: "a gentle low note", voice: (c, o, t) => tone(c, o, t, 392, 0.3, { gain: 0.35, attack: 0.02 }) },
  success: { about: "a short major chord", voice: (c, o, t) => { [523.3, 659.3, 784].forEach((f, i) => tone(c, o, t + i * 0.04, f, 0.45, { gain: 0.18 })); } },
};

export const PRESET_NAMES = [...Object.keys(PRESETS), "none"];

/** Is this a file path rather than a preset name? */
export function isSoundFile(value: string): boolean {
  return /[\\/]/.test(value) || /\.(wav|mp3|ogg|oga|opus|flac|m4a|aac|webm)$/i.test(value);
}

// ── Playing ───────────────────────────────────────────────

type Get = (key: string) => string | number | boolean;
let get: Get = () => "";
/** Where the settings come from (App.tsx's getSetting). */
export function configureSounds(getter: Get): void { get = getter; }

let ctx: AudioContext | null = null;
function audio(): AudioContext | null {
  if (ctx) return ctx;
  try { ctx = new AudioContext(); } catch { return null; }
  return ctx;
}

const volume = () => Math.max(0, Math.min(100, Number(get("soundVolume")) || 0)) / 100;

const fileCache = new Map<string, Promise<string>>();
const lastPlayed = new Map<string, number>();
const failedFiles = new Set<string>();
let onFileError: (msg: string) => void = () => {};
/** Told once per file that can't be played. */
export function onSoundFileError(fn: (msg: string) => void): void { onFileError = fn; }

/** Plays a preset, or a sound file, at the volume setting. Rejects when a
 *  file can't be played. */
export async function playValue(value: string): Promise<void> {
  value = value.trim();
  if (!value || value === "none") return;
  const v = volume();
  if (v <= 0) return;
  if (isSoundFile(value)) {
    let url = fileCache.get(value);
    if (!url) { url = readAudio(value); fileCache.set(value, url); }
    let src: string;
    try { src = await url; } catch (e) { fileCache.delete(value); throw e; }
    const el = new Audio(src);
    el.volume = Math.min(1, v);
    await el.play();
    return;
  }
  const preset = PRESETS[value.toLowerCase()];
  if (!preset) throw new Error(`no such sound: ${value} — one of ${PRESET_NAMES.join(", ")}, or a sound file's path`);
  const c = audio();
  if (!c) return;
  if (c.state === "suspended") await c.resume().catch(() => {});
  const out = c.createGain();
  out.gain.value = v * 0.9;
  out.connect(c.destination);
  preset.voice(c, out, c.currentTime + 0.01);
  setTimeout(() => out.disconnect(), 2000);
}

/** The sound an event plays now (its setting, or the default). */
export function soundFor(event: string): string {
  const def = SOUND_EVENTS.find(e => e.event === event);
  if (!def) return "";
  const v = get(def.setting);
  return typeof v === "string" ? v : def.default;
}

/** Plays an event's sound (or a preset by name, for plugins), unless
 *  sounds are off. Never throws; a sound repeating faster than it can
 *  be heard plays once. */
export function playSound(eventOrPreset: string): void {
  if (get("sounds") === false) return;
  const isEvent = SOUND_EVENTS.some(e => e.event === eventOrPreset);
  const value = isEvent ? soundFor(eventOrPreset) : eventOrPreset;
  const now = performance.now();
  const gap = eventOrPreset === "key" ? 25 : 120;
  if (now - (lastPlayed.get(eventOrPreset) ?? -1e9) < gap) return;
  lastPlayed.set(eventOrPreset, now);
  void playValue(value).catch(e => {
    if (failedFiles.has(value)) return;
    failedFiles.add(value);
    onFileError(`can't play ${value}: ${e instanceof Error ? e.message : e}`);
  });
}

/** For a finished shell command: an error sound when it failed (not
 *  when Ctrl+C stopped it), a done sound when it took a while. */
export function soundForCommand(code: number, ms: number): void {
  if (code === 130 || code === -1073741510) return; // Ctrl+C (bash, Windows)
  if (code !== 0) playSound("error");
  else if (ms >= 3000) playSound("done");
}
