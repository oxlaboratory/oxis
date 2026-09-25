/**
 * taskCommands.ts — the command string behind each oxis.task(), keyed
 * by task name. workflowRunner needs the raw text; kept in its own file
 * to avoid an import cycle between pluginAPI and workflowRunner.
 */

const taskCommands = new Map<string, string>();

export function setTaskCommand(name: string, cmd: string): void {
  taskCommands.set(name, cmd);
}

export function getTaskCommand(name: string): string | undefined {
  return taskCommands.get(name);
}