/**
 * Insights.tsx — what Home can tell you about the workspace: today's
 * activity, its tasks and recent files, the project's Git state and its
 * workflow. Each is a Panel of its own, laid out by Home; a panel with
 * nothing to say isn't shown. Everything
 * follows the workspace (useInsights). Setting homeInsights hides the
 * activity side of Home.
 */

import React, { useEffect, useState } from "react";
import { runCommand } from "../native";
import { events } from "../terminal/events";
import { ago, insightsFor, onInsights, type WorkspaceInsights } from "./insightsStore";

export interface GitState {
  repo: boolean;
  branch?: string;
  changed: number;
  lastCommit?: { at: number; subject: string };
  branches: number;
  remote: boolean;
  ahead?: number;
  behind?: number;
}

/** Reads a project's Git state (all at once; null if git isn't there). */
export async function readGitState(dir: string): Promise<GitState | null> {
  const git = (args: string[]) => runCommand(dir, "git", args).then(r => (r.exitCode === 0 ? r.stdout.trim() : null), () => null);
  const inside = await git(["rev-parse", "--is-inside-work-tree"]);
  if (inside === null) {
    // Not a repository (or no git at all: then say nothing).
    const v = await git(["--version"]);
    return v === null ? null : { repo: false, changed: 0, branches: 0, remote: false };
  }
  const [branch, status, last, branches, remotes, counts] = await Promise.all([
    git(["rev-parse", "--abbrev-ref", "HEAD"]),
    git(["status", "--porcelain"]),
    git(["log", "-1", "--format=%ct%x09%s"]),
    git(["branch", "--format=%(refname:short)"]),
    git(["remote"]),
    git(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]),
  ]);
  const [ts, ...subject] = (last ?? "").split("\t");
  const [behind, ahead] = (counts ?? "").split(/\s+/).map(Number);
  return {
    repo: true,
    branch: branch ?? undefined,
    changed: status ? status.split("\n").filter(Boolean).length : 0,
    lastCommit: ts ? { at: Number(ts) * 1000, subject: subject.join("\t") } : undefined,
    branches: branches ? branches.split("\n").filter(Boolean).length : 0,
    remote: !!remotes,
    ...(counts !== null && Number.isFinite(ahead) ? { ahead, behind } : {}),
  };
}

/** A labelled panel: Home's building block. */
export function Panel({ title, note, className, children }: { title: string; note?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return (
    <section className={`hm-panel${className ? ` ${className}` : ""}`}>
      <header className="hm-panel-head"><h2>{title}</h2>{note !== undefined && <span className="hm-panel-note">{note}</span>}</header>
      <div className="hm-panel-body">{children}</div>
    </section>
  );
}

/** A row that does something: runs a command or fills the prompt. */
export function Action({ label, hint, onClick, mono = true }: { label: React.ReactNode; hint?: React.ReactNode; onClick: () => void; mono?: boolean }) {
  return (
    <button className={`hm-action${mono ? " hm-action--mono" : ""}`} onMouseDown={e => e.preventDefault()} onClick={onClick}>
      <span className="hm-action-label">{label}</span>
      {hint !== undefined && <span className="hm-action-hint">{hint}</span>}
      <span className="hm-action-go" aria-hidden="true">→</span>
    </button>
  );
}

export const fillPrompt = (text: string) => events.emit("focus_prompt", { text });

/** Git state of the project, kept fresh while Home is up. */
function useGit(dir: string | null): GitState | null {
  const [state, setState] = useState<GitState | null>(null);
  useEffect(() => {
    if (!dir) { setState(null); return; }
    let live = true, timer = 0;
    const read = () => { void readGitState(dir).then(s => { if (live) setState(s); }); };
    const soon = () => { clearTimeout(timer); timer = window.setTimeout(read, 1500); };
    read();
    const every = window.setInterval(read, 30_000);
    const offs = ["shell_command_done", "editor_saved", "git_remote_changed"].map(e => events.on(e, soon));
    return () => { live = false; clearInterval(every); clearTimeout(timer); offs.forEach(o => o()); };
  }, [dir]);
  return state;
}

export interface InsightsData {
  ins: WorkspaceInsights;
  git: GitState | null;
  now: number;
  /** A path as the project sees it. */
  rel: (p: string) => string;
}

/** Everything Home's panels show, for this workspace and project. */
export function useInsights(workspace: string, projectPath: string | null): InsightsData {
  const [, bump] = useState(0);
  useEffect(() => onInsights(() => bump(n => n + 1)), []);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const ins = insightsFor(workspace);
  const git = useGit(projectPath);
  const rel = (p: string) => {
    const root = (projectPath ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
    return root && p.toLowerCase().startsWith(root.toLowerCase() + "/") ? p.slice(root.length + 1) : p.replace(/^.*\//, "");
  };
  return { ins, git, now, rel };
}

export function GitPanel({ d, onRun }: { d: InsightsData; onRun: (cmd: string) => void }) {
  const { git, now } = d;
  if (!git) return null;
  if (!git.repo) {
    return (
      <Panel title="Git" note="not set up">
        <p className="hm-line hm-dim">This project isn&apos;t a Git repository.</p>
        <Action label="git init" onClick={() => onRun("git init")} />
      </Panel>
    );
  }
  return (
    <Panel title="Git" note={git.remote ? undefined : "no remote"}>
      <div className="hm-git">
        <span className="hm-branch">{git.branch}</span>
        <span className={`hm-badge ${git.changed ? "hm-badge--warn" : "hm-badge--ok"}`}>{git.changed ? `${git.changed} changed` : "clean"}</span>
      </div>
      <dl className="hm-facts">
        {git.lastCommit && <><dt>last commit</dt><dd title={git.lastCommit.subject}>{ago(git.lastCommit.at, now)} · {git.lastCommit.subject}</dd></>}
        <dt>branches</dt><dd>{git.branches}{git.ahead || git.behind ? ` · ↑${git.ahead ?? 0} ↓${git.behind ?? 0}` : ""}</dd>
      </dl>
      {!git.remote && <Action label="connect GitHub" hint="'workspace github" onClick={() => fillPrompt("'workspace github ")} />}
    </Panel>
  );
}

export function ActivityPanel({ d, workspace }: { d: InsightsData; workspace: string }) {
  const { ins } = d;
  const stats: Array<[number, string]> = [[ins.commands, "commands"], [ins.tasks, "tasks"], [ins.saves, "saves"], [ins.workflows, "workflows"]];
  return (
    <Panel title="Today" note={workspace}>
      <div className="hm-stats">
        {stats.map(([n, what]) => (
          <div key={what} className={`hm-stat${n ? "" : " hm-stat--zero"}`}><b>{n}</b><span>{what}</span></div>
        ))}
      </div>
    </Panel>
  );
}

export function FilesPanel({ d, onRun }: { d: InsightsData; onRun: (cmd: string) => void }) {
  // One file at a time, stepped through with the arrows: Home never scrolls.
  const files = d.ins.files.slice(0, 8);
  const [at, setAt] = useState(0);
  useEffect(() => { setAt(0); }, [files[0]]);
  if (!files.length) return null;
  const k = Math.min(at, files.length - 1);
  const f = files[k];
  const step = (n: number) => setAt((k + n + files.length) % files.length);
  return (
    <Panel title="Recent files" note={files.length > 1 ? (
      <span className="hm-pager">
        <button onMouseDown={e => e.preventDefault()} onClick={() => step(-1)} aria-label="Previous file">‹</button>
        <span>{k + 1}/{files.length}</span>
        <button onMouseDown={e => e.preventDefault()} onClick={() => step(1)} aria-label="Next file">›</button>
      </span>
    ) : undefined}>
      <Action label={d.rel(f)} onClick={() => onRun(`'edit ${f}`)} />
    </Panel>
  );
}

export function TasksPanel({ d, tasks, workflows, onRun }: {
  d: InsightsData; tasks: string[]; workflows: Array<{ name: string; steps: string[] }>; onRun: (cmd: string) => void;
}) {
  const { ins, now } = d;
  const wf = ins.lastWorkflow && workflows.find(w => w.name === ins.lastWorkflow!.name) || workflows[0];
  const lastRun = wf && ins.lastWorkflow?.name === wf.name ? ins.lastWorkflow : undefined;
  return (
    <Panel title="Tasks" note={tasks.length ? `${tasks.length} defined${ins.tasks ? ` · ${ins.tasks} run today` : ""}` : undefined}>
      {tasks.length ? (
        <div className="hm-tasks">
          {tasks.slice(0, 8).map(t => (
            <button key={t} className="hm-task" onMouseDown={e => e.preventDefault()} onClick={() => onRun(`'task ${t}`)} title={`'task ${t}`}>
              <span className="hm-task-run" aria-hidden="true">▶</span>{t}
            </button>
          ))}
        </div>
      ) : (
        <p className="hm-line hm-dim">No tasks yet. Name the commands you run most in <code>.oxis/workspace.lua</code> — <code>&apos;help task</code></p>
      )}
      {wf && (
        <div className="hm-workflow">
          <div className="hm-workflow-head">
            <span className="hm-workflow-name">workflow · {wf.name}</span>
            <span className="hm-dim">{lastRun ? <>last run {ago(lastRun.at, now)} · <span className={lastRun.ok ? "hm-ok" : "hm-err"}>{lastRun.ok ? "passed" : "failed"}</span></> : "not run yet"}</span>
          </div>
          <div className="hm-steps">
            {wf.steps.slice(0, 6).map((st, k) => <span key={k} className="hm-step">{st}</span>)}
            {wf.steps.length > 6 && <span className="hm-step hm-dim">+{wf.steps.length - 6}</span>}
            <button className="hm-step-run" onMouseDown={e => e.preventDefault()} onClick={() => onRun(`'workflow ${wf.name}`)}>Run</button>
          </div>
        </div>
      )}
    </Panel>
  );
}
