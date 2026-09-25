/**
 * workflowRunner.ts — chains tasks, commands, plugin calls, and shell
 * steps into one named, runnable workflow.
 *
 * Workflows are declared from a workspace's workflows/*.lua files (see
 * workspaceManager.ts), one `oxis.workflow("name", { ... }, "desc")`
 * call per workflow — the SAME oxis.* Lua API every plugin uses, not
 * a separate config format. A workflow's *definition* is plain JS data
 * (a WorkflowDef) once loaded — nothing here holds onto the Lua VM
 * that declared it, so a workflow keeps working even if the file that
 * defined it is deleted mid-session, and running one doesn't need any
 * Lua execution at all.
 *
 * Deliberately builds on what already exists instead of a second,
 * parallel execution system:
 *  - a `task` step looks up the exact command string behind an
 *    existing oxis.task()-registered task (getTaskCommand in
 *    pluginAPI.ts) and runs it the same way oxis.run() would.
 *  - a `command` step calls registry.execute() — the exact function
 *    dispatchOxisCmd in App.tsx calls for a typed '-command.
 *  - a `run` step calls the same awaitable runScript() oxis.run() has
 *    used since it became properly awaitable for this — see
 *    scriptRunTracker.ts's runAndAwait().
 *
 * ── What "parallel" actually means here ──────────────────────────
 * OXIS has exactly one real PTY shell. Two shell-touching steps
 * (`run`/`task`) sent to it at the same time is exactly the
 * corruption scriptRunTracker.ts exists to prevent (see its own
 * top-of-file comment) — so within a `parallel` group, shell-touching
 * steps still run one at a time, in the order listed. `command` steps
 * (registry.execute — synchronous, local, no PTY write) genuinely run
 * concurrently with each other and alongside whichever shell step is
 * currently running. This is documented, not hidden: claiming full
 * parallel shell execution on an architecture with one shared shell
 * would be fake.
 */

import { registry } from "../terminal/commandRegistry";
import { isWindows } from "../terminal/terminal";
import { scriptRunTracker } from "../terminal/scriptRunTracker";
import { getTaskCommand } from "./taskCommands";
import type { LuaJSValue } from "./luaRuntime";

export interface WorkflowStep {
  /** A label shown in logs/progress — auto-derived from the step's
   *  task/run/command if not given. */
  name?: string;
  /** Run an existing oxis.task()-registered task's command. */
  task?: string;
  /** Run a raw shell command/script (same as oxis.run()). */
  run?: string;
  /** Run an OXIS '-command by name (via the real command registry). */
  command?: string;
  args?: string;
  /** Extra env vars for just this step, merged over the workflow's own. */
  env?: Record<string, string>;
  /** "env:NAME" — step is skipped (not failed) if that env var (from
   *  the merged workflow+step env) is empty/unset. Intentionally
   *  minimal — this is not a general expression language. */
  condition?: string;
  /** Retry this many additional times on failure before giving up
   *  (0 = no retry, the default). */
  retry?: number;
  /** Don't stop the workflow if this step fails. */
  continueOnError?: boolean;
  /** Steps that run as a group — see "What 'parallel' actually means" above. */
  parallel?: WorkflowStep[];
}

export interface WorkflowDef {
  name: string;
  description: string;
  env: Record<string, string>;
  steps: WorkflowStep[];
}

export interface WorkflowStepResult {
  label: string;
  ok: boolean;
  skipped?: boolean;
  attempts?: number;
}

export interface WorkflowRunResult {
  ok: boolean;
  cancelled: boolean;
  steps: WorkflowStepResult[];
}

export interface WorkflowRunCtx {
  sendToShell: (data: string) => void;
  print: (text: string, kind?: "ok" | "err" | "warn" | "info" | "dim" | "accent") => void;
}

function stepLabel(step: WorkflowStep): string {
  return step.name || step.task && `task:${step.task}` || step.command && `'${step.command}` || step.run && step.run.split("\n")[0].slice(0, 40) || "step";
}

function isShellStep(step: WorkflowStep): boolean {
  return !!step.task || !!step.run;
}

/** Turns a raw Lua table (from oxis.workflow's 2nd argument) into a
 *  real WorkflowDef, tolerating a malformed/partial table rather than
 *  throwing — an invalid `steps` entry is just dropped (with a
 *  warning at registration time — see register() below), not a
 *  reason to refuse the whole workflow. */
function coerceDef(name: string, raw: LuaJSValue, description: string): { def: WorkflowDef; warnings: string[] } {
  const warnings: string[] = [];
  const obj = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw as Record<string, LuaJSValue> : {};

  const env: Record<string, string> = {};
  if (obj.env && typeof obj.env === "object" && !Array.isArray(obj.env)) {
    for (const [k, v] of Object.entries(obj.env as Record<string, LuaJSValue>)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") env[k] = String(v);
    }
  }

  const rawSteps = Array.isArray(obj.steps) ? obj.steps : [];
  const steps: WorkflowStep[] = [];
  for (const s of rawSteps) {
    const parsed = coerceStep(s, warnings);
    if (parsed) steps.push(parsed);
  }
  if (steps.length === 0) warnings.push(`workflow "${name}" has no valid steps`);

  return { def: { name, description, env, steps }, warnings };
}

function coerceStep(raw: LuaJSValue, warnings: string[]): WorkflowStep | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) { warnings.push("a step wasn't a table — skipped"); return null; }
  const o = raw as Record<string, LuaJSValue>;
  if (Array.isArray(o.parallel)) {
    const sub: WorkflowStep[] = [];
    for (const s of o.parallel) { const p = coerceStep(s, warnings); if (p) sub.push(p); }
    return { name: typeof o.name === "string" ? o.name : undefined, parallel: sub };
  }
  const step: WorkflowStep = {};
  if (typeof o.name === "string") step.name = o.name;
  if (typeof o.task === "string") step.task = o.task;
  if (typeof o.run === "string") step.run = o.run;
  if (typeof o.command === "string") step.command = o.command;
  if (typeof o.args === "string") step.args = o.args;
  if (typeof o.condition === "string") step.condition = o.condition;
  if (typeof o.retry === "number") step.retry = Math.max(0, Math.floor(o.retry));
  if (o.continueOnError === true) step.continueOnError = true;
  if (o.env && typeof o.env === "object" && !Array.isArray(o.env)) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.env as Record<string, LuaJSValue>)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") env[k] = String(v);
    }
    step.env = env;
  }
  if (!step.task && !step.run && !step.command) { warnings.push("a step had none of task/run/command — skipped"); return null; }
  return step;
}

/** Single-quotes a value for POSIX shells (sh/bash/zsh). Single quotes
 *  are the one POSIX quoting form that disables ALL substitution —
 *  `$`, `` ` ``, `\` are all literal inside them — so the only
 *  character that needs escaping is a literal `'` itself, done by
 *  closing the quote, emitting an escaped quote, and reopening it. */
function shQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/** Single-quotes a value for PowerShell. PowerShell's single-quoted
 *  strings are the equivalent literal form — no `$var`/`$(...)`
 *  expansion — and the only escape needed is doubling an embedded `'`. */
function psQuote(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** `KEY=value` pairs prepended to a shell command so the step's own
 *  env vars actually reach it — platform-appropriate syntax, and
 *  composes with runScript()'s own multi-line detection: prepending
 *  even one line turns a single-line command into a multi-line one,
 *  which is exactly what routes it through the temp-script path on
 *  native Windows instead of a raw single-line send.
 *
 *  Values are quoted with shQuote/psQuote (real shell-literal quoting),
 *  not JSON.stringify: JSON's escaping rules protect `"` and control
 *  characters, but leave `$`, backticks, and `$(...)` untouched — which
 *  are exactly the characters bash/PowerShell treat as "run this" inside
 *  a double-quoted string. A workflow env value containing `$(...)` (a
 *  price like "$(5)", a shell snippet being passed through as data,
 *  anything with that shape) would have been executed by the shell
 *  instead of exported as literal text. Single-quoting closes that off
 *  entirely, since single-quoted strings don't expand anything. */
function withEnvPrefix(cmd: string, env: Record<string, string>): string {
  const entries = Object.entries(env);
  if (entries.length === 0) return cmd;
  if (isWindows()) {
    return entries.map(([k, v]) => `$env:${k} = ${psQuote(v)}`).join("\n") + "\n" + cmd;
  }
  return entries.map(([k, v]) => `export ${k}=${shQuote(v)}`).join("\n") + "\n" + cmd;
}

class WorkflowRunner {
  private workflows = new Map<string, WorkflowDef>();
  private cancelled = false;
  private runningName: string | null = null;

  /** Called by workspaceManager.ts's load()/close() — workflows are
   *  workspace-scoped, so switching (or closing) a workspace clears
   *  every previously-loaded one before the new workspace's
   *  workflows/*.lua files (if any) load their own. This is what
   *  keeps one workspace's workflows from leaking into another's —
   *  same isolation guarantee named workspaces already give
   *  documents/plugins/tasks. */
  clear(): void {
    this.workflows.clear();
  }

  /** oxis.workflow("name", { steps = {...}, env = {...} }, "desc") —
   *  see luaRuntime.ts/pluginAPI.ts for the Lua-facing binding.
   *  Returns any warnings about malformed parts of `def` so the
   *  caller (pluginAPI.ts) can surface them instead of silently
   *  dropping a broken step. */
  register(name: string, def: LuaJSValue, description: string | undefined): string[] {
    const { def: parsed, warnings } = coerceDef(name, def, description?.trim() || `workflow: ${name}`);
    this.workflows.set(name, parsed);
    return warnings;
  }

  all(): WorkflowDef[] {
    return [...this.workflows.values()];
  }

  get(name: string): WorkflowDef | undefined {
    return this.workflows.get(name);
  }

  isRunning(): boolean {
    return this.runningName !== null;
  }

  currentlyRunning(): string | null {
    return this.runningName;
  }

  /** Stops the workflow after its current step (that step's own
   *  Ctrl+C-equivalent cancellation — scriptRunTracker.cancel() — is
   *  the caller's responsibility, same as it already is for a bare
   *  oxis.run(); App.tsx's Ctrl+C handler calls both). */
  cancel(): void {
    this.cancelled = true;
  }

  async run(name: string, ctx: WorkflowRunCtx): Promise<WorkflowRunResult> {
    const def = this.workflows.get(name);
    if (!def) return { ok: false, cancelled: false, steps: [] };
    if (this.runningName) {
      ctx.print(`  ⚠  workflow "${this.runningName}" is already running — 'workflow cancel it first`, "warn");
      return { ok: false, cancelled: false, steps: [] };
    }

    this.runningName = name;
    this.cancelled = false;
    const results: WorkflowStepResult[] = [];
    ctx.print(`  ▶  workflow ${name}${def.description ? ` — ${def.description}` : ""}`, "accent");

    try {
      const ok = await this.runSteps(def.steps, def.env, ctx, results);
      ctx.print(
        this.cancelled ? `  ⏹  workflow ${name} cancelled` : ok ? `  ✓  workflow ${name} finished` : `  ✗  workflow ${name} failed`,
        this.cancelled ? "warn" : ok ? "ok" : "err",
      );
      return { ok: ok && !this.cancelled, cancelled: this.cancelled, steps: results };
    } finally {
      this.runningName = null;
    }
  }

  private async runSteps(steps: WorkflowStep[], parentEnv: Record<string, string>, ctx: WorkflowRunCtx, results: WorkflowStepResult[]): Promise<boolean> {
    for (const step of steps) {
      if (this.cancelled) { results.push({ label: stepLabel(step), ok: false, skipped: true }); continue; }

      if (step.parallel) {
        const shellSteps = step.parallel.filter(isShellStep);
        const otherSteps = step.parallel.filter(s => !isShellStep(s));
        ctx.print(`  ⋯  ${step.name || "parallel group"} (${step.parallel.length} steps)`, "dim");
        const [otherResults, shellOk] = await Promise.all([
          Promise.all(otherSteps.map(s => this.runOne(s, parentEnv, ctx))),
          (async () => {
            let allOk = true;
            for (const s of shellSteps) {
              const r = await this.runOne(s, parentEnv, ctx);
              results.push(r);
              if (!r.ok && !s.continueOnError) { allOk = false; break; } // same stop-on-failure semantics as a plain (non-parallel) step list — a failed step without continueOnError shouldn't let the ones after it still run
            }
            return allOk;
          })(),
        ]);
        results.push(...otherResults);
        const otherOk = otherResults.every((r, i) => r.ok || otherSteps[i].continueOnError);
        if (!otherOk || !shellOk) return false;
        continue;
      }

      const r = await this.runOne(step, parentEnv, ctx);
      results.push(r);
      if (!r.ok && !r.skipped && !step.continueOnError) return false;
    }
    return true;
  }

  private async runOne(step: WorkflowStep, parentEnv: Record<string, string>, ctx: WorkflowRunCtx): Promise<WorkflowStepResult> {
    const label = stepLabel(step);
    const env = { ...parentEnv, ...step.env };

    if (step.condition?.startsWith("env:")) {
      const varName = step.condition.slice(4);
      if (!env[varName]) {
        ctx.print(`  ·  ${label} — skipped (condition ${step.condition} not met)`, "dim");
        return { label, ok: true, skipped: true };
      }
    }

    const maxAttempts = 1 + (step.retry || 0);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.cancelled) return { label, ok: false, skipped: true };
      const attemptSuffix = maxAttempts > 1 ? ` (attempt ${attempt}/${maxAttempts})` : "";
      ctx.print(`  →  ${label}${attemptSuffix}`, "dim");

      const ok = await this.execStep(step, env, ctx);
      if (ok) { ctx.print(`  ✓  ${label}`, "ok"); return { label, ok: true, attempts: attempt }; }
      if (attempt < maxAttempts) { ctx.print(`  ⚠  ${label} failed, retrying...`, "warn"); continue; }
      ctx.print(`  ✗  ${label} failed${step.continueOnError ? " (continuing — continueOnError)" : ""}`, "err");
      return { label, ok: false, attempts: attempt };
    }
    return { label, ok: false };
  }

  private async execStep(step: WorkflowStep, env: Record<string, string>, ctx: WorkflowRunCtx): Promise<boolean> {
    if (step.command) {
      try {
        const args = step.args ? step.args.split(/\s+/) : [];
        const handled = registry.execute(step.command, args, step.args || "");
        return handled !== false;
      } catch {
        return false;
      }
    }

    let cmd: string | undefined;
    if (step.task) {
      cmd = getTaskCommand(step.task);
      if (cmd === undefined) { ctx.print(`  ✗  no such task: ${step.task}`, "err"); return false; }
    } else if (step.run) {
      cmd = step.run;
    }
    if (cmd === undefined) return false;

    // Same defensive shape as the step.command branch above — this
    // branch didn't have one, for no real reason (execStep is async,
    // so a throw here already becomes a rejection rather than a raw
    // exception, but an UNCAUGHT rejection propagating all the way up
    // through runOne/runSteps/run means the workflow's own "✗ workflow
    // X failed" summary line never prints — only whatever the
    // TOP-LEVEL caller's .catch() shows instead, a worse message for
    // the same underlying failure).
    try {
      const result = await scriptRunTracker.runAndAwait(ctx.sendToShell, withEnvPrefix(cmd, env));
      if (result.cancelled) this.cancelled = true;
      return !result.cancelled && !result.timedOut;
    } catch (e) {
      ctx.print(`  ✗  ${stepLabel(step)}: ${e instanceof Error ? e.message : e}`, "err");
      return false;
    }
  }
}

export const workflowRunner = new WorkflowRunner();