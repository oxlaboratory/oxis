/**
 * sessionManager.ts — OXIS session persistence
 *
 * Saves and restores:
 *   - Open tab IDs and order
 *   - Active tab
 *   - Active theme
 *   - Enabled plugins
 *   - Working directory (per tab, best-effort)
 *   - Active workspace
 */

import { events } from "./events";

const KEY = "oxis-session-v1";

export interface TabSession {
  id: string;
  isHome: boolean;
  label?: string;
}

export interface Session {
  tabs: TabSession[];
  activeTab: string;
  theme: string;
  workspacePath?: string;
  savedAt: number;
}

class SessionManager {
  save(session: Session): void {
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...session, savedAt: Date.now() }));
      events.emit("session_saved");
    } catch { /* noop */ }
  }

  load(): Session | null {
    try {
      const s = localStorage.getItem(KEY);
      if (!s) return null;
      return JSON.parse(s) as Session;
    } catch { return null; }
  }

  clear(): void {
    try { localStorage.removeItem(KEY); } catch { /* noop */ }
  }
}

export const sessionManager = new SessionManager();
