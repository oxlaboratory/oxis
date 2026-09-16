/**
 * keybinds.ts — OXIS keybind system
 *
 * Built-in keybinds + user-overridable mappings.
 * Lua: oxis.keymap("normal", "<C-t>", function() ... end)
 */

export type KeyHandler = (e: KeyboardEvent) => boolean | void;

export interface Keybind {
  key: string;       // e.g. "t", "w", "1"
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  description: string;
  handler: KeyHandler;
  /** true = registered by Lua */
  fromLua?: boolean;
  /**
   * Input mode this bind is scoped to ("normal" | "insert" | "visual",
   * see README § Input Modes and `oxis.keymap(mode, key, fn)`).
   * Undefined = fires regardless of mode (core app shortcuts like
   * Ctrl+T always behave this way).
   */
  mode?: string;
}

class KeybindManager {
  private binds: Keybind[] = [];
  // What mode is currently "live" for mode-scoped binds — set by
  // whichever surface owns modal input right now (currently just the
  // built-in editor; see its `mode` state in App.tsx). Global binds
  // (bind.mode undefined) ignore this entirely.
  private activeMode = "normal";

  register(bind: Keybind): void {
    // Remove existing binding for same combo *within the same mode*
    // scope — a "normal"-mode keymap and an "insert"-mode keymap on
    // the same key are meant to coexist, not overwrite each other.
    this.binds = this.binds.filter(b => !this.matches(b, bind));
    this.binds.push(bind);
  }

  unregisterByLua(): void {
    this.binds = this.binds.filter(b => !b.fromLua);
  }

  setActiveMode(mode: string): void { this.activeMode = mode; }
  getActiveMode(): string { return this.activeMode; }

  private matches(a: Keybind, b: Keybind): boolean {
    return a.key === b.key &&
      !!a.ctrl === !!b.ctrl &&
      !!a.alt === !!b.alt &&
      !!a.shift === !!b.shift &&
      a.mode === b.mode;
  }

  handle(e: KeyboardEvent): boolean {
    for (const bind of this.binds) {
      if (bind.mode && bind.mode !== this.activeMode) continue;
      if (
        e.key.toLowerCase() === bind.key.toLowerCase() &&
        !!e.ctrlKey === !!bind.ctrl &&
        !!e.altKey === !!bind.alt &&
        !!e.shiftKey === !!bind.shift
      ) {
        const result = bind.handler(e);
        if (result !== false) return true;
      }
    }
    return false;
  }

  all(): Keybind[] { return [...this.binds]; }
}

export const keybinds = new KeybindManager();

/** Register core app keybinds. Called once at startup. */
export function registerCoreKeybinds(actions: {
  newTab: () => void;
  closeTab: () => void;
  switchTab: (n: number) => void;
  clearTerminal: () => void;
  openMarket: () => void;
}): void {
  keybinds.register({ key: "t", ctrl: true, description: "New terminal tab", handler: (e) => { e.preventDefault(); actions.newTab(); } });
  keybinds.register({ key: "w", ctrl: true, description: "Close current tab", handler: (e) => { e.preventDefault(); actions.closeTab(); } });
  keybinds.register({ key: "l", ctrl: true, description: "Clear terminal", handler: (e) => { e.preventDefault(); actions.clearTerminal(); } });
  // Ctrl+Shift+M — open the OXIS Market website in the system's
  // default browser. Shift avoids colliding with any single-letter
  // Ctrl shortcut above or any Lua-registered global keymap using
  // plain Ctrl+M.
  keybinds.register({ key: "m", ctrl: true, shift: true, description: "Open the OXIS Market website", handler: (e) => { e.preventDefault(); actions.openMarket(); } });
  for (let i = 1; i <= 9; i++) {
    const n = i;
    keybinds.register({ key: String(n), ctrl: true, description: `Switch to tab ${n}`, handler: (e) => { e.preventDefault(); actions.switchTab(n - 1); } });
  }
}
