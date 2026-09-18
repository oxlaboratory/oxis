/**
 * taskCommands.ts — raw command strings behind oxis.task()-registered
 * tasks, keyed by task name (not "task:name").
 *
 * workflowRunner.ts needs the actual command text to build a `task`
 * step (with env vars prepended, run through the same awaitable
 * scriptRunTracker path oxis.run() uses) — registry.ts's generic
 * CommandHandler closures don't expose that. This lives in its own
 * tiny file, rather than on pluginAPI.ts (which registers oxis.task()
 * in the first place), specifically so pluginAPI.ts can import
 * workflowRunner.ts (for the oxis.workflow() binding) without a
 * circular import: workflowRunner.ts importing straight back from
 * pluginAPI.ts to reach this map would create exactly that cycle.
 */

const taskCommands = new Map<string, string>();

export function setTaskCommand(name: string, cmd: string): void {
  taskCommands.set(name, cmd);
}

export function getTaskCommand(name: string): string | undefined {
  return taskCommands.get(name);
}