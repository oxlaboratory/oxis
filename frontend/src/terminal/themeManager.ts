/**
 * themeManager.ts — OXIS theme manager
 *
 * Loads themes from JSON definitions (builtins inline + custom via localStorage).
 * Supports hot-reload, import/export, inheritance, and validation.
 */

import { events } from "./events";

export interface Theme {
  name?: string;
  extends?: string;   // theme inheritance
  bg: string; bg1: string; bg2: string; bg3: string; bg4: string;
  border: string; border2: string;
  text: string; muted: string; dim: string; comment: string;
  purple: string; purple2: string; purple3: string;
  grey: string; grey2: string;
}

const REQUIRED_KEYS: (keyof Theme)[] = [
  "bg","bg1","bg2","bg3","bg4","border","border2",
  "text","muted","dim","comment","purple","purple2","purple3","grey","grey2",
];

// Builtin theme definitions (JSON-equivalent objects)
const BUILTINS: Record<string, Theme> = {
  default: {
    bg:"#1a1b26",bg1:"#16161e",bg2:"#1f2335",bg3:"#292e42",bg4:"#31364a",
    border:"#2a2f45",border2:"#3dff64",
    text:"#c0caf5",muted:"#7a809b",dim:"#565f89",comment:"#414868",
    purple:"#3dff64",purple2:"#29d84e",purple3:"#7dff9a",grey:"#9aa5ce",grey2:"#565f89",
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
};

class ThemeManager {
  private custom: Record<string, Theme> = {};
  private current = "default";

  constructor() {
    this.loadCustom();
    const saved = localStorage.getItem("oxis-theme") ?? "default";
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
    return { ...BUILTINS, ...this.custom };
  }

  builtins(): Record<string, Theme> { return { ...BUILTINS }; }
  customThemes(): Record<string, Theme> { return { ...this.custom }; }

  get(name: string): Theme | undefined {
    const all = this.all();
    const t = all[name];
    if (!t) return undefined;
    // Handle inheritance
    if (t.extends && all[t.extends]) {
      return { ...all[t.extends], ...t };
    }
    return t;
  }

  getCurrent(): string { return this.current; }

  apply(name: string): boolean {
    const t = this.get(name);
    if (!t) return false;
    const r = document.documentElement.style;
    r.setProperty("--bg",      t.bg);
    r.setProperty("--bg1",     t.bg1);
    r.setProperty("--bg2",     t.bg2);
    r.setProperty("--bg3",     t.bg3);
    r.setProperty("--bg4",     t.bg4);
    r.setProperty("--border",  t.border);
    r.setProperty("--border2", t.border2);
    r.setProperty("--text",    t.text);
    r.setProperty("--muted",   t.muted);
    r.setProperty("--dim",     t.dim);
    r.setProperty("--comment", t.comment);
    r.setProperty("--purple",  t.purple);
    r.setProperty("--purple2", t.purple2);
    r.setProperty("--purple3", t.purple3);
    r.setProperty("--grey",    t.grey);
    r.setProperty("--grey2",   t.grey2);
    r.setProperty("--accent",  t.purple);
    this.current = name;
    try { localStorage.setItem("oxis-theme", name); } catch { /* noop */ }
    events.emit("theme_changed", { name });
    return true;
  }

  /** Apply a raw Theme object without saving — used for live preview */
  applyRaw(t: Theme): void {
    const r = document.documentElement.style;
    r.setProperty("--bg",      t.bg);
    r.setProperty("--bg1",     t.bg1);
    r.setProperty("--bg2",     t.bg2);
    r.setProperty("--bg3",     t.bg3);
    r.setProperty("--bg4",     t.bg4);
    r.setProperty("--border",  t.border);
    r.setProperty("--border2", t.border2);
    r.setProperty("--text",    t.text);
    r.setProperty("--muted",   t.muted);
    r.setProperty("--dim",     t.dim);
    r.setProperty("--comment", t.comment);
    r.setProperty("--purple",  t.purple);
    r.setProperty("--purple2", t.purple2);
    r.setProperty("--purple3", t.purple3);
    r.setProperty("--grey",    t.grey);
    r.setProperty("--grey2",   t.grey2);
    r.setProperty("--accent",  t.purple);
  }

  validate(t: Partial<Theme>): string[] {
    return REQUIRED_KEYS.filter(k => !t[k]);
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

  export(name: string): string | null {
    const t = this.get(name);
    if (!t) return null;
    // `name` last — not first — so it always wins over whatever `t`
    // itself might carry as its own internal `name` field (imported
    // themes retain this from their original JSON; see import()
    // below). Object spread lets a later key silently override an
    // earlier one with the same name — { name, ...t } would export
    // under t's own possibly-stale internal name instead of the name
    // this function was actually asked to export under, whenever the
    // two diverge. Reproduced concretely before fixing: a theme
    // looked up under one key but still carrying a different internal
    // name exported under the wrong one.
    return JSON.stringify({ ...t, name }, null, 2);
  }

  import(json: string): { ok: boolean; name?: string; error?: string } {
    try {
      const t = JSON.parse(json) as Theme & { name?: string };
      const name = t.name ?? "imported";
      const missing = this.validate(t);
      if (missing.length) return { ok: false, error: `Missing keys: ${missing.join(", ")}` };
      this.addCustom(name, t);
      return { ok: true, name };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
}

export const themeManager = new ThemeManager();