/**
 * themeManager.ts — built-in themes, custom themes (localStorage), theme
 * files from ~/.oxis/themes, inheritance (`extends`), import/export.
 *
 * A theme is 16 core colours plus any of THEME_OPTIONS: status and
 * interface colours, syntax colours, the sky, text, shape, cursor,
 * prompt, a background image or gradient, and extra CSS. Options a
 * theme leaves out fall back to values derived from its core colours,
 * so a theme only has to say what it changes.
 */

import { events } from "./events";

export type ThemeValue = string | number | boolean;

export interface Theme {
  name?: string;
  extends?: string;   // theme inheritance
  bg: string; bg1: string; bg2: string; bg3: string; bg4: string;
  border: string; border2: string;
  text: string; muted: string; dim: string; comment: string;
  purple: string; purple2: string; purple3: string;
  grey: string; grey2: string;
  [option: string]: ThemeValue | undefined;
}

export const CORE_KEYS = [
  "bg", "bg1", "bg2", "bg3", "bg4", "border", "border2",
  "text", "muted", "dim", "comment", "purple", "purple2", "purple3", "grey", "grey2",
] as const;
export type CoreKey = typeof CORE_KEYS[number];

type OptionKind = "color" | "number" | "text" | "choice" | "toggle" | "css";

export interface ThemeOption {
  key: string;
  group: string;
  label: string;
  hint: string;
  kind: OptionKind;
  /** Used when a theme doesn't set the option. Colours may be var(--core). */
  fallback: ThemeValue;
  min?: number; max?: number; step?: number; unit?: string;
  choices?: string[];
  /** CSS variable a colour option sets. */
  cssVar?: string;
}

const DEFAULT_FONT = "'JetBrains Mono', 'Cascadia Code', Consolas, monospace";

export const THEME_OPTIONS: ThemeOption[] = [
  // Status colours
  { key: "success", group: "Status colours", label: "Success", hint: "✓ lines and success messages", kind: "color", fallback: "#7ee787", cssVar: "--green" },
  { key: "error", group: "Status colours", label: "Error", hint: "✗ lines and errors", kind: "color", fallback: "#f7768e", cssVar: "--err" },
  { key: "warning", group: "Status colours", label: "Warning", hint: "⚠ lines and warnings", kind: "color", fallback: "#ff9e64", cssVar: "--warn" },
  { key: "link", group: "Status colours", label: "Links", hint: "clickable URLs and paths in output", kind: "color", fallback: "var(--purple3)", cssVar: "--link" },

  // Interface
  { key: "selection", group: "Interface", label: "Selection", hint: "selected text background", kind: "color", fallback: "color-mix(in srgb, var(--purple) 28%, transparent)", cssVar: "--selection" },
  { key: "caret", group: "Interface", label: "Cursor", hint: "the prompt's cursor", kind: "color", fallback: "var(--purple)", cssVar: "--caret" },
  { key: "promptColor", group: "Interface", label: "Prompt label", hint: "the OXIS ❯ label", kind: "color", fallback: "var(--purple)", cssVar: "--prompt-color" },
  { key: "promptBg", group: "Interface", label: "Prompt bar", hint: "background of the command bar", kind: "color", fallback: "var(--bg2)", cssVar: "--prompt-bg" },
  { key: "promptBorder", group: "Interface", label: "Prompt border", hint: "line above the command bar", kind: "color", fallback: "var(--border2)", cssVar: "--prompt-border" },
  { key: "statusBg", group: "Interface", label: "Status bar", hint: "status bar background", kind: "color", fallback: "var(--purple2)", cssVar: "--status-bg" },
  { key: "statusText", group: "Interface", label: "Status text", hint: "status bar text", kind: "color", fallback: "var(--bg1)", cssVar: "--status-text" },
  { key: "titlebarBg", group: "Interface", label: "Title bar", hint: "window title bar background", kind: "color", fallback: "var(--bg1)", cssVar: "--titlebar-bg" },
  { key: "titlebarText", group: "Interface", label: "Title text", hint: "window title", kind: "color", fallback: "var(--muted)", cssVar: "--titlebar-text" },
  { key: "cornerMark", group: "Interface", label: "Corner mark", hint: "OXIS in the terminal's corner", kind: "color", fallback: "var(--purple)", cssVar: "--corner-mark" },
  { key: "scrollbar", group: "Interface", label: "Scrollbar", hint: "scrollbar thumb", kind: "color", fallback: "var(--bg4)", cssVar: "--scrollbar" },
  { key: "scrollbarHover", group: "Interface", label: "Scrollbar hover", hint: "scrollbar thumb under the mouse", kind: "color", fallback: "var(--grey2)", cssVar: "--scrollbar-hover" },

  // Syntax highlighting (editor)
  { key: "synKeyword", group: "Syntax", label: "Keywords", hint: "if, function, return…", kind: "color", fallback: "var(--purple)", cssVar: "--syn-keyword" },
  { key: "synString", group: "Syntax", label: "Strings", hint: "\"text\" and 'text'", kind: "color", fallback: "var(--purple3)", cssVar: "--syn-string" },
  { key: "synNumber", group: "Syntax", label: "Numbers", hint: "42, 0xff", kind: "color", fallback: "var(--purple2)", cssVar: "--syn-number" },
  { key: "synComment", group: "Syntax", label: "Comments", hint: "// and -- comments", kind: "color", fallback: "var(--comment)", cssVar: "--syn-comment" },
  { key: "synFunction", group: "Syntax", label: "Function calls", hint: "name(…)", kind: "color", fallback: "var(--text)", cssVar: "--syn-function" },

  // Sky on Home
  { key: "sun", group: "Sky", label: "Sun", hint: "daytime sun on Home", kind: "color", fallback: "#ffd24a", cssVar: "--sun" },
  { key: "cloud", group: "Sky", label: "Clouds", hint: "daytime clouds", kind: "color", fallback: "#ffffff", cssVar: "--cloud" },
  { key: "moon", group: "Sky", label: "Moon", hint: "night-time moon", kind: "color", fallback: "#ffffff", cssVar: "--moon" },
  { key: "star", group: "Sky", label: "Stars", hint: "night-time stars", kind: "color", fallback: "var(--purple3)", cssVar: "--star" },

  // Text
  { key: "font", group: "Text", label: "Font", hint: "CSS font list, e.g. 'Fira Code', monospace", kind: "text", fallback: DEFAULT_FONT },
  { key: "fontSize", group: "Text", label: "Font size", hint: "terminal and editor ('config set fontSize wins)", kind: "number", fallback: 13, min: 9, max: 28, step: 1, unit: "px" },
  { key: "lineHeight", group: "Text", label: "Line height", hint: "times the font size", kind: "number", fallback: 1.54, min: 1, max: 2.4, step: 0.02 },
  { key: "letterSpacing", group: "Text", label: "Letter spacing", hint: "extra space between characters", kind: "number", fallback: 0, min: -1, max: 4, step: 0.1, unit: "px" },
  { key: "fontWeight", group: "Text", label: "Weight", hint: "normal text weight", kind: "choice", fallback: "400", choices: ["300", "400", "500", "600", "700"] },
  { key: "ligatures", group: "Text", label: "Ligatures", hint: "join -> and != into symbols (if the font has them)", kind: "toggle", fallback: true },

  // Shape & effects
  { key: "radius", group: "Shape & effects", label: "Corner radius", hint: "buttons, inputs and panels", kind: "number", fallback: 3, min: 0, max: 14, step: 1, unit: "px" },
  { key: "padding", group: "Shape & effects", label: "Side padding", hint: "space left and right of terminal text", kind: "number", fallback: 18, min: 4, max: 64, step: 1, unit: "px" },
  { key: "scrollbarWidth", group: "Shape & effects", label: "Scrollbar width", hint: "", kind: "number", fallback: 3, min: 2, max: 14, step: 1, unit: "px" },
  { key: "glow", group: "Shape & effects", label: "Glow", hint: "neon glow on the prompt and accents", kind: "number", fallback: 0, min: 0, max: 1, step: 0.05 },

  // Cursor
  { key: "cursorStyle", group: "Cursor", label: "Shape", hint: "'config set cursorStyle wins", kind: "choice", fallback: "block", choices: ["block", "bar", "underline"] },
  { key: "cursorBlink", group: "Cursor", label: "Blink", hint: "'config set cursorBlink wins", kind: "toggle", fallback: true },

  // Prompt & Home
  { key: "promptText", group: "Prompt & Home", label: "Prompt label", hint: "up to 24 characters, e.g. λ or ~ $", kind: "text", fallback: "OXIS ❯" },
  { key: "showSky", group: "Prompt & Home", label: "Sky on Home", hint: "sun, clouds, moon and stars", kind: "toggle", fallback: true },
  { key: "showCornerMark", group: "Prompt & Home", label: "Corner mark", hint: "OXIS in the terminal's corner", kind: "toggle", fallback: true },

  // Background
  { key: "backgroundImage", group: "Background", label: "Image", hint: "https:// or data:image/ URL", kind: "text", fallback: "" },
  { key: "backgroundGradient", group: "Background", label: "Gradient", hint: "e.g. linear-gradient(160deg, #1a1b26, #3b1d4a)", kind: "text", fallback: "" },
  { key: "backgroundOpacity", group: "Background", label: "Strength", hint: "how visible the image or gradient is", kind: "number", fallback: 0.25, min: 0, max: 1, step: 0.05 },
  { key: "backgroundBlur", group: "Background", label: "Blur", hint: "", kind: "number", fallback: 0, min: 0, max: 30, step: 1, unit: "px" },
  { key: "backgroundFit", group: "Background", label: "Fit", hint: "", kind: "choice", fallback: "cover", choices: ["cover", "contain", "tile"] },

  // Advanced
  { key: "css", group: "Advanced", label: "Custom CSS", hint: "any extra CSS, applied with the theme", kind: "css", fallback: "" },
];

const OPTION_BY_KEY = new Map(THEME_OPTIONS.map(o => [o.key.toLowerCase(), o]));

export function themeOption(key: string): ThemeOption | undefined {
  return OPTION_BY_KEY.get(key.toLowerCase());
}

const SAFE_CSS_VALUE = /^[^;{}<>]{1,300}$/;

/** A theme value checked against its option, or undefined if it isn't
 *  usable (wrong type, out of range, or unsafe). */
export function normalizeOption(opt: ThemeOption, raw: unknown): ThemeValue | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  switch (opt.kind) {
    case "color":
    case "text": {
      const s = String(raw).trim();
      if (!SAFE_CSS_VALUE.test(s)) return undefined;
      if (opt.key === "promptText") return s.replace(/[\x00-\x1f]/g, "").slice(0, 24) || undefined;
      if (opt.key === "backgroundImage" && !/^(https:\/\/|data:image\/)[^"'\\\s()]+$/i.test(s)) return undefined;
      if (opt.key === "backgroundGradient" && (!/^(repeating-)?(linear|radial|conic)-gradient\(/i.test(s) || /url\s*\(/i.test(s))) return undefined;
      return s;
    }
    case "number": {
      const n = typeof raw === "number" ? raw : Number(String(raw).replace(/px$/i, ""));
      if (!Number.isFinite(n)) return undefined;
      return Math.min(opt.max ?? n, Math.max(opt.min ?? n, n));
    }
    case "choice": {
      const s = String(raw).toLowerCase();
      return opt.choices?.includes(s) ? s : undefined;
    }
    case "toggle": {
      if (typeof raw === "boolean") return raw;
      const s = String(raw).toLowerCase();
      if (["true", "on", "yes", "1"].includes(s)) return true;
      if (["false", "off", "no", "0"].includes(s)) return false;
      return undefined;
    }
    case "css":
      // @import could pull in remote stylesheets; everything else is
      // only styling.
      return String(raw).replace(/@import[^;]*;?/gi, "").slice(0, 20_000) || undefined;
  }
}

/** The value a theme ends up with for an option. */
export function optionValue(t: Theme, opt: ThemeOption): ThemeValue {
  return normalizeOption(opt, t[opt.key]) ?? opt.fallback;
}

/** A colour option's value with var(--core) resolved against the theme,
 *  for colour pickers. */
export function resolveColor(t: Theme, value: ThemeValue): string {
  const m = /^var\(--([a-z0-9]+)\)$/i.exec(String(value));
  return m && typeof t[m[1]] === "string" ? String(t[m[1]]) : String(value);
}

// Builtin theme definitions (JSON-equivalent objects)
const BUILTINS: Record<string, Theme> = {
  default: {
    bg:"#1a1b26",bg1:"#16161e",bg2:"#1f2335",bg3:"#292e42",bg4:"#31364a",
    border:"#2a2f45",border2:"#3dff64",
    text:"#c0caf5",muted:"#7a809b",dim:"#565f89",comment:"#414868",
    purple:"#3dff64",purple2:"#29d84e",purple3:"#7dff9a",grey:"#9aa5ce",grey2:"#565f89",
    success:"#3dff64",
  },
  midnight: {
    bg:"#080810",bg1:"#0d0d18",bg2:"#121220",bg3:"#1a1a2e",bg4:"#22223a",
    border:"#1e1e35",border2:"#3d2f6b",
    text:"#d0c8f0",muted:"#6a6090",dim:"#3d3660",comment:"#252240",
    purple:"#b090f0",purple2:"#7040c0",purple3:"#d0b0ff",grey:"#5a5080",grey2:"#302a50",
  },
  slate: {
    bg:"#0e1018",bg1:"#121520",bg2:"#181c28",bg3:"#202435",bg4:"#282d42",
    border:"#252a3a",border2:"#3a4070",
    text:"#c0c8e0",muted:"#6878a0",dim:"#404868",comment:"#2a3050",
    purple:"#8090d8",purple2:"#5060a8",purple3:"#a8b8f0",grey:"#5868a0",grey2:"#303850",
  },
  forest: {
    bg:"#0d1117",bg1:"#111a14",bg2:"#162019",bg3:"#1c2a1f",bg4:"#223326",
    border:"#253828",border2:"#2ea043",
    text:"#c9d1d9",muted:"#7daa7d",dim:"#3f6040",comment:"#264d29",
    purple:"#56d364",purple2:"#2ea043",purple3:"#9be9a8",grey:"#6e8e6e",grey2:"#2d472e",
  },
  ember: {
    bg:"#18100c",bg1:"#1e1410",bg2:"#261a14",bg3:"#30201a",bg4:"#3a2820",
    border:"#3d2820",border2:"#c0532a",
    text:"#e8d8c8",muted:"#b07858",dim:"#704838",comment:"#4a2e20",
    purple:"#e8825a",purple2:"#c0532a",purple3:"#ffaa80",grey:"#906050",grey2:"#503020",
  },
  rose: {
    bg:"#1a0e14",bg1:"#20121a",bg2:"#281820",bg3:"#32202a",bg4:"#3c2832",
    border:"#3d2030",border2:"#c06080",
    text:"#f0d8e8",muted:"#b07890",dim:"#704858",comment:"#4a2838",
    purple:"#f088a8",purple2:"#c06080",purple3:"#ffb0c8",grey:"#906078",grey2:"#503048",
  },
  dusk: {
    bg:"#130d1a",bg1:"#180f20",bg2:"#1e1428",bg3:"#261a32",bg4:"#2e2040",
    border:"#2a1e3d",border2:"#5a3a80",
    text:"#d8c8e8",muted:"#8068a0",dim:"#50406a",comment:"#352848",
    purple:"#c088e8",purple2:"#9050c0",purple3:"#ddb0ff",grey:"#706090",grey2:"#3e2e58",
  },
  void: {
    bg:"#080808",bg1:"#0c0c0c",bg2:"#121212",bg3:"#181818",bg4:"#202020",
    border:"#1e1e2a",border2:"#383850",
    text:"#c0b8d8",muted:"#6060a0",dim:"#404060",comment:"#282840",
    purple:"#9070d0",purple2:"#6040a8",purple3:"#c0a0f0",grey:"#585878",grey2:"#303050",
  },
  paper: {
    bg:"#f7f5ef",bg1:"#ece8de",bg2:"#f0ede4",bg3:"#e2ddd0",bg4:"#cfc8b8",
    border:"#ddd6c6",border2:"#3b6ea5",
    text:"#2f3437",muted:"#6b6f73",dim:"#8d9094",comment:"#a8a59c",
    purple:"#3b6ea5",purple2:"#2f5b8a",purple3:"#1f7a5a",grey:"#5d6166",grey2:"#b9b4a7",
    success:"#1f7a3a", error:"#b3261e", warning:"#a15c00", link:"#2f5b8a",
    statusText:"#f7f5ef", cloud:"#a9b4c2", moon:"#6b7280", sun:"#d18b00", star:"#3b6ea5",
    selection:"rgba(59,110,165,.22)",
  },
  matrix: {
    bg:"#020a04",bg1:"#010603",bg2:"#041208",bg3:"#07200e",bg4:"#0b2e15",
    border:"#0b2e15",border2:"#00ff66",
    text:"#b6ffcf",muted:"#4fbf78",dim:"#2a7a48",comment:"#1a4a2c",
    purple:"#00ff66",purple2:"#00c850",purple3:"#7dffb0",grey:"#3f9f66",grey2:"#1d5a35",
    success:"#00ff66", glow:0.6, promptText:"root@oxis ❯", cursorStyle:"underline",
    backgroundGradient:"radial-gradient(ellipse at top, #0b3d1c 0%, #020a04 70%)", backgroundOpacity:0.9,
  },
};

class ThemeManager {
  private custom: Record<string, Theme> = {};
  /** Themes loaded from ~/.oxis/themes/*.json each launch (not saved to
   *  localStorage; the files are the source of truth). */
  private external: Record<string, Theme> = {};
  private current = "default";

  constructor() {
    this.loadCustom();
    let saved = "default";
    try { saved = localStorage.getItem("oxis-theme") ?? "default"; } catch { /* storage unavailable */ }
    if (this.all()[saved]) this.current = saved;
  }

  private loadCustom(): void {
    try {
      const s = localStorage.getItem("oxis-custom-themes");
      if (s) this.custom = JSON.parse(s);
    } catch { this.custom = {}; }
  }

  private persistCustom(): void {
    try { localStorage.setItem("oxis-custom-themes", JSON.stringify(this.custom)); } catch { /* noop */ }
  }

  all(): Record<string, Theme> {
    return { ...BUILTINS, ...this.external, ...this.custom };
  }

  builtins(): Record<string, Theme> { return { ...BUILTINS }; }
  customThemes(): Record<string, Theme> { return { ...this.custom }; }
  isCustom(name: string): boolean { return !!this.custom[name]; }

  /** Re-applies the saved theme once file themes are loaded, in case it
   *  is one of them (they aren't known yet when the constructor runs). */
  restoreSaved(): void {
    let saved: string | null = null;
    try { saved = localStorage.getItem("oxis-theme"); } catch { /* storage unavailable */ }
    if (saved && saved !== this.current && this.all()[saved]) this.apply(saved);
  }

  /** Registers a theme read from a file; returns missing keys, if any. */
  addExternal(name: string, theme: Theme): string[] {
    const missing = this.validate(theme);
    if (missing.length === 0) this.external[name] = theme;
    return missing;
  }

  /** A theme with its `extends` chain applied (up to 8 levels). */
  get(name: string): Theme | undefined {
    const all = this.all();
    const chain: Theme[] = [];
    let t: Theme | undefined = all[name];
    for (let depth = 0; t && depth < 8; depth++) {
      chain.unshift(t);
      t = t.extends && t.extends !== name ? all[t.extends] : undefined;
    }
    if (!chain.length) return undefined;
    return Object.assign({}, ...chain) as Theme;
  }

  getCurrent(): string { return this.current; }

  apply(name: string): boolean {
    const t = this.get(name);
    if (!t) return false;
    this.applyRaw(t);
    this.current = name;
    try { localStorage.setItem("oxis-theme", name); } catch { /* noop */ }
    events.emit("theme_changed", { name });
    return true;
  }

  /** Apply a Theme object without saving it (live preview). */
  applyRaw(t: Theme): void {
    const root = document.documentElement;
    const r = root.style;
    for (const k of CORE_KEYS) r.setProperty(`--${k}`, t[k]);
    r.setProperty("--accent", t.purple);
    const v = (key: string) => optionValue(t, themeOption(key)!);

    for (const opt of THEME_OPTIONS) {
      if (opt.kind === "color" && opt.cssVar) r.setProperty(opt.cssVar, String(v(opt.key)));
    }

    // Text. fontSize, cursorStyle and cursorBlink are also settings; the
    // app re-applies those afterwards when the user has set them.
    const fs = Number(v("fontSize"));
    r.setProperty("--font", String(v("font")));
    r.setProperty("--fs", `${fs}px`);
    r.setProperty("--lh", `${Math.round(fs * Number(v("lineHeight")))}px`);
    r.setProperty("--ls", `${v("letterSpacing")}px`);
    r.setProperty("--fw", String(v("fontWeight")));
    r.setProperty("--ligatures", v("ligatures") ? "normal" : "none");

    // Shape & effects
    r.setProperty("--r", `${v("radius")}px`);
    r.setProperty("--term-pad", `${v("padding")}px`);
    r.setProperty("--scrollbar-w", `${v("scrollbarWidth")}px`);
    const glow = Number(v("glow"));
    r.setProperty("--glow-shadow", glow > 0
      ? `0 0 ${Math.round(4 + glow * 14)}px color-mix(in srgb, var(--purple) ${Math.round(35 + glow * 55)}%, transparent)`
      : "none");

    root.setAttribute("data-cursor-style", String(v("cursorStyle")));
    root.setAttribute("data-cursor-blink", v("cursorBlink") ? "on" : "off");

    // Prompt & Home
    const label = String(v("promptText")).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
    r.setProperty("--prompt-label", `"${label}"`);
    r.setProperty("--sky-display", v("showSky") ? "block" : "none");
    r.setProperty("--corner-mark-display", v("showCornerMark") ? "block" : "none");

    // Background: a gradient wins over an image.
    const gradient = String(v("backgroundGradient"));
    const image = String(v("backgroundImage"));
    const fit = String(v("backgroundFit"));
    const layer = gradient
      ? gradient
      : image
        ? `url("${image}") center / ${fit === "tile" ? "auto" : fit} ${fit === "tile" ? "repeat" : "no-repeat"}`
        : "none";
    r.setProperty("--bg-layer", layer);
    r.setProperty("--bg-layer-opacity", layer === "none" ? "0" : String(v("backgroundOpacity")));
    const blur = Number(v("backgroundBlur"));
    r.setProperty("--bg-layer-blur", `${blur}px`);
    r.setProperty("--bg-layer-scale", blur > 0 ? "1.06" : "1");

    // Custom CSS
    let style = document.getElementById("oxis-theme-css") as HTMLStyleElement | null;
    const css = String(v("css"));
    if (css && !style) {
      style = document.createElement("style");
      style.id = "oxis-theme-css";
      document.head.appendChild(style);
    }
    if (style) style.textContent = css;
  }

  /** Keys still missing after applying `extends`, if any. */
  validate(t: Partial<Theme>): string[] {
    const base = t.extends ? this.get(String(t.extends)) : undefined;
    if (t.extends && !base) return [`extends: unknown theme "${t.extends}"`];
    const merged = { ...base, ...t };
    return CORE_KEYS.filter(k => !merged[k]);
  }

  /** Option values in `t` that can't be used, as "key: why" lines. */
  problems(t: Partial<Theme>): string[] {
    const out: string[] = [];
    for (const [key, raw] of Object.entries(t)) {
      if (key === "name" || key === "extends" || (CORE_KEYS as readonly string[]).includes(key)) continue;
      const opt = themeOption(key);
      if (!opt) out.push(`${key}: not a theme option ('theme keys lists them)`);
      else if (raw !== undefined && raw !== "" && normalizeOption(opt, raw) === undefined) out.push(`${key}: invalid value ${JSON.stringify(raw)}`);
    }
    return out;
  }

  addCustom(name: string, theme: Theme): boolean {
    const missing = this.validate(theme);
    if (missing.length) return false;
    this.custom[name] = theme;
    this.persistCustom();
    return true;
  }

  removeCustom(name: string): boolean {
    if (!this.custom[name]) return false;
    delete this.custom[name];
    this.persistCustom();
    return true;
  }

  /**
   * `'theme set <key> <value>` on the active theme. A built-in or file
   * theme isn't changed: a custom "<name>-custom" theme extending it is
   * created (or reused) and switched to. An empty value removes the key.
   */
  setOption(key: string, raw: string): { ok: boolean; message: string } {
    const core = (CORE_KEYS as readonly string[]).find(k => k.toLowerCase() === key.toLowerCase());
    const opt = core ? undefined : themeOption(key);
    if (!core && !opt) return { ok: false, message: `unknown theme key "${key}" — 'theme keys lists them` };
    const realKey = core ?? opt!.key;
    let value: ThemeValue | undefined;
    if (raw === "") value = undefined;
    else if (core) {
      if (!SAFE_CSS_VALUE.test(raw)) return { ok: false, message: `invalid colour: ${raw}` };
      value = raw;
    } else {
      value = normalizeOption(opt!, raw);
      if (value === undefined) {
        const range = opt!.kind === "number" ? ` (${opt!.min}–${opt!.max})` : opt!.choices ? ` (${opt!.choices.join(" | ")})` : "";
        return { ok: false, message: `invalid value for ${realKey}${range}: ${raw}` };
      }
    }
    if (core && value === undefined) return { ok: false, message: `${realKey} is a core colour and can't be removed` };

    let target = this.current;
    if (!this.custom[target]) {
      target = `${this.current}-custom`;
      if (!this.custom[target]) this.custom[target] = { extends: this.current } as Theme;
    }
    const theme = { ...this.custom[target] };
    if (value === undefined) delete theme[realKey];
    else theme[realKey] = value;
    this.custom[target] = theme;
    this.persistCustom();
    this.apply(target);
    return {
      ok: true,
      message: `${target}: ${realKey} ${value === undefined ? "reset to default" : `= ${String(value).length > 60 ? String(value).slice(0, 57) + "…" : value}`}`,
    };
  }

  export(name: string): string | null {
    const t = this.all()[name] ? { ...this.all()[name] } : undefined;
    if (!t) return null;
    // Export the theme as stored (keeping `extends`), fully resolved if it
    // extends a theme the importer may not have.
    const out = t.extends && !BUILTINS[String(t.extends)] ? this.get(name)! : t;
    // `name` last so it wins over a stale internal name from an import.
    return JSON.stringify({ ...out, name }, null, 2);
  }

  import(json: string): { ok: boolean; name?: string; error?: string; warnings?: string[] } {
    try {
      const t = JSON.parse(json) as Theme & { name?: string };
      const name = t.name ?? "imported";
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) return { ok: false, error: `theme names: letters, numbers, - and _ (got "${name}")` };
      if (BUILTINS[name]) return { ok: false, error: `"${name}" is a built-in theme name — rename it in the JSON` };
      const missing = this.validate(t);
      if (missing.length) return { ok: false, error: `Missing keys: ${missing.join(", ")}` };
      this.addCustom(name, t);
      return { ok: true, name, warnings: this.problems(t) };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
}

export const themeManager = new ThemeManager();
