/**
 * commandRegistry.ts — the single registry for built-in and plugin
 * commands (oxis.command registers here).
 */

import { events } from "./events";
import { recordError } from "./diagnostics";

export type CommandHandler = (args: string[], rest: string) => unknown;

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
    // Errors are recorded for 'diagnostics and surfaced in the terminal
    // (command_error) rather than only logged to the console. Async
    // handlers are covered too.
    const fail = (e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[oxis:cmd] ${name}`, e);
      recordError(`command '${name}' failed: ${message}`, "app");
      events.emit("command_error", { name, message });
    };
    try {
      const result = cmd.handler(args, rest);
      if (result instanceof Promise) result.catch(fail);
      events.emit("command_executed", { name, args });
    } catch (e) {
      fail(e);
    }
    return true;
  }
}

export const registry = new CommandRegistry();