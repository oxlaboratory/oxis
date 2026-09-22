/**
 * events.ts — OXIS event system
 *
 * All internal subsystems (PTY, tabs, plugins, themes, commands) communicate
 * through this bus. Lua plugins subscribe via oxis.autocmd().
 */

export type OxisEvent =
  | "terminal_open"
  | "terminal_close"
  | "tab_created"
  | "tab_closed"
  | "theme_changed"
  | "plugin_loaded"
  | "plugin_unloaded"
  | "workspace_loaded"
  | "workspace_unloaded"
  | "command_executed"
  | "command_error"
  | "shell_started"
  | "shell_exited"
  | "editor_opened"
  | "editor_closed"
  | "mode_changed"
  | "workspace_loading";

export type EventPayload = Record<string, unknown>;
export type EventHandler = (payload?: EventPayload) => void;

class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();

  on(event: OxisEvent | string, handler: EventHandler): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    // Return unsubscribe fn
    return () => this.handlers.get(event)?.delete(handler);
  }

  off(event: OxisEvent | string, handler: EventHandler): void {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event: OxisEvent | string, payload?: EventPayload): void {
    this.handlers.get(event)?.forEach(h => {
      try { h(payload); } catch (e) { console.error(`[oxis:event] ${event}`, e); }
    });
  }

  once(event: OxisEvent | string, handler: EventHandler): void {
    const unsub = this.on(event, (p) => { handler(p); unsub(); });
  }
}

export const events = new EventBus();