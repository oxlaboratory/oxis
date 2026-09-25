/**
 * workspaceState.ts — the workspace status and recent activity shown on
 * Home and in the status bar, fed by workspace, task and plugin events.
 */

import { events } from "./events";
import { registry } from "./commandRegistry";
import { pluginManager } from "../plugins/pluginManager";
import { themeManager } from "./themeManager";

export type WorkspaceStatus = "none" | "loading" | "ready";

export interface WorkspaceActivityEntry {
  text: string;
  at: number;
}

export interface WorkspaceSnapshot {
  projectName: string;   // derived from the workspace path's last segment, "" if none
  projectPath: string;   // full path passed to oxis.workspace(path), "" if none
  status: WorkspaceStatus;
  activity: WorkspaceActivityEntry[]; // most recent first, capped
}

const MAX_ACTIVITY = 6;

class WorkspaceState {
  private snapshot: WorkspaceSnapshot = {
    projectName: "",
    projectPath: "",
    status: "none",
    activity: [],
  };
  private listeners = new Set<(s: WorkspaceSnapshot) => void>();

  constructor() {
    events.on("workspace_loading", (p) => {
      const path = String((p as { path?: string })?.path ?? "");
      this.snapshot = { ...this.snapshot, status: "loading" };
      this.notify();
      void path; // path becomes authoritative once "workspace_loaded" lands below
    });
    events.on("workspace_loaded", (p) => {
      // The absolute directory workspaceManager loaded (not the "."
      // that workspace.lua passes).
      const path = String((p as { path?: string })?.path ?? "");
      const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
      this.snapshot = { ...this.snapshot, projectPath: path, projectName: name, status: "ready" };
      this.log(`workspace "${name}" loaded`);
    });
    events.on("workspace_unloaded", () => {
      this.snapshot = { ...this.snapshot, projectPath: "", projectName: "", status: "none" };
      this.log("workspace unloaded");
    });
    events.on("command_executed", (p) => {
      const name = String((p as { name?: string })?.name ?? "");
      if (name.startsWith("task:")) this.log(`task "${name.slice(5)}" run`);
    });
    events.on("theme_changed", (p) => {
      const name = String((p as { name?: string })?.name ?? themeManager.getCurrent());
      this.log(`theme switched to "${name}"`);
    });
    events.on("plugin_loaded", (p) => {
      // Bulk startup loads are silent, so this only logs real reloads.
      const name = String((p as { name?: string })?.name ?? "");
      if (name) this.log(`plugin "${name}" reloaded`);
    });
  }

  private log(text: string): void {
    this.snapshot = {
      ...this.snapshot,
      activity: [{ text, at: Date.now() }, ...this.snapshot.activity].slice(0, MAX_ACTIVITY),
    };
    this.notify();
  }

  private notify(): void {
    this.listeners.forEach((l) => l(this.snapshot));
  }

  get(): WorkspaceSnapshot {
    return this.snapshot;
  }

  /** Active plugin names, for the Home panel's "active plugins" row. */
  activePlugins(): string[] {
    return pluginManager.all().filter((p) => p.enabled).map((p) => p.name);
  }

  /** Task names defined so far (`oxis.task(...)`), for "available tasks". */
  /** Task names for Home's panel. "commit" is built in rather than
   *  registered, so it's added first (once). */
  taskNames(): string[] {
    const registered = registry.all()
      .filter((c) => c.category === "task")
      .map((c) => c.name.replace(/^task:/, ""));
    return ["commit", ...registered.filter((n) => n !== "commit")];
  }

  subscribe(fn: (s: WorkspaceSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const workspaceState = new WorkspaceState();