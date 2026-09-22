/**
 * commandRegistry.ts — OXIS unified command registry
 *
 * All built-in and Lua plugin commands register here.
 * Lua uses oxis.command("name", fn) which calls registerCommand internally.
 */

import { events } from "./events";
import { recordError } from "./diagnostics";

export type CommandHandler = (args: string[], rest: string) => void;

export interface CommandEntry {
  name: string;
  description: string;
  usage?: string;
  category: string;
  handler: CommandHandler;
  /** true = registered by a Lua plugin */
  fromPlugin?: string;
}

class CommandRegistry {
  private commands = new Map<string, CommandEntry>();

  register(entry: CommandEntry): void {
    this.commands.set(entry.name.toLowerCase(), entry);
  }

  unregister(name: string): void {
    this.commands.delete(name.toLowerCase());
  }

  unregisterByPlugin(pluginName: string): void {
    for (const [k, v] of this.commands) {
      if (v.fromPlugin === pluginName) this.commands.delete(k);
    }
  }

  get(name: string): CommandEntry | undefined {
    return this.commands.get(name.toLowerCase());
  }

  has(name: string): boolean {
    return this.commands.has(name.toLowerCase());
  }

  all(): CommandEntry[] {
    return [...this.commands.values()];
  }

  byCategory(): Map<string, CommandEntry[]> {
    const map = new Map<string, CommandEntry[]>();
    for (const cmd of this.commands.values()) {
      if (!map.has(cmd.category)) map.set(cmd.category, []);
      map.get(cmd.category)!.push(cmd);
    }
    return map;
  }

  execute(name: string, args: string[], rest: string): boolean {
    const cmd = this.commands.get(name.toLowerCase());
    if (!cmd) return false;
    try {
      cmd.handler(args, rest);
      events.emit("command_executed", { name, args });
    } catch (e) {
      // Found doing a broad audit: a command handler throwing here
      // used to be caught and then only ever logged to
      // console.error — completely invisible to an actual user, who
      // would just see their command silently do nothing, with zero
      // feedback that anything went wrong at all. Because this is a
      // caught exception, not an uncaught one, it also never reached
      // installGlobalErrorCapture()'s own window-level listener, so
      // it wouldn't have shown up in 'diagnostics' recent errors
      // either — a buggy command was invisible from every angle a
      // real user could actually check. Now recorded properly (same
      // 'diagnostics list every other app-level error uses) and
      // emitted as its own event so the active terminal can print
      // something the user actually sees, instead of dead silence.
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[oxis:cmd] ${name}`, e);
      recordError(`command '${name}' failed: ${message}`, "app");
      events.emit("command_error", { name, message });
    }
    return true;
  }
}

export const registry = new CommandRegistry();