/**
 * Insights.tsx — Home's insight cards, beside the workspace box: what's
 * been happening in this workspace (left) and what OXIS can tell you
 * about it (right). Every card follows the workspace: Git turns from
 * "connect it" into the branch and its changes, the workflow card shows
 * the last run, and the suggestions are about this project now. A card
 * with nothing to say isn't shown. Setting homeInsights hides them all.
 */

import { useEffect, useMemo, useState } from "react";
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

export interface Suggestion { text: string; label: string; run?: string; fill?: string }

/** What OXIS suggests now, most useful first (three at most). */
export function suggest(o: { git: GitState | null; hasProject: boolean; tasks: string[]; insights: WorkspaceInsights; now?: number }): Suggestion[] {
  const out: Suggestion[] = [];
  const { git, insights } = o;
  const now = o.now ?? Date.now();
  if (insights.lastFailed && now - insights.lastFailed.at < 60 * 60 * 1000) {
    const c = insights.lastFailed.command;
    out.push({ text: `${c.length > 28 ? c.slice(0, 27) + "…" : c} failed (exit ${insights.lastFailed.code}) ${ago(insights.lastFailed.at, now)}.`, label: "run it again", fill: c });
  }
  if (git?.repo && git.changed > 0) {
    out.push({ text: `You changed ${git.changed} file${git.changed === 1 ? "" : "s"} since your last commit.`, label: "'task commit", fill: "'task commit " });
  }
  if (git?.repo && (git.ahead ?? 0) > 0) out.push({ text: `${git.ahead} commit${git.ahead === 1 ? "" : "s"} not pushed yet.`, label: "git push", run: "git push" });
  if (git?.repo && (git.behind ?? 0) > 0) out.push({ text: `${git.behind} new commit${git.behind === 1 ? "" : "s"} to pull.`, label: "git pull", run: "git pull" });
  if (git?.repo && !git.remote) out.push({ text: "No Git remote is connected to this workspace.", label: "connect GitHub", fill: "'workspace github " });
  if (git && !git.repo && o.hasProject) out.push({ text: "This project isn't a Git repository yet.", label: "git init", run: "git init" });
  if (o.tasks.length === 0 && o.hasProject) out.push({ text: "No tasks yet: name the commands you run most.", label: "'help task", run: "'help task" });
  return out.slice(0, 3);
}

function Card({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="ins-card">
      <div className="ins-title"><span>{title}</span>{note && <span className="ins-note">{note}</span>}</div>
      <div className="ins-body">{children}</div>
    </div>
  );
}

const fill = (text: string) => events.emit("focus_prompt", { text });

export interface InsightsProps {
  side: "left" | "right";
  workspace: string;
  projectPath: string | null;
  tasks: string[];
  workflows: Array<{ name: string; steps: string[] }>;
  pluginsActive: number;
  onRun: (cmd: string) => void;
}

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

export function Insights({ side, workspace, projectPath, tasks, workflows, pluginsActive, onRun }: InsightsProps) {
  const [, bump] = useState(0);
  useEffect(() => onInsights(() => bump(n => n + 1)), []);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const ins = insightsFor(workspace);
  const git = useGit(side === "right" ? projectPath : null);
  const rel = (p: string) => {
    const root = (projectPath ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
    return root && p.toLowerCase().startsWith(root.toLowerCase() + "/") ? p.slice(root.length + 1) : p.replace(/^.*\//, "");
  };
  const suggestions = useMemo(() => suggest({ git, hasProject: !!projectPath, tasks, insights: ins, now }), [git, projectPath, tasks, ins, now]);

  if (side === "left") {
    const activity = [
      ins.tasks && `${ins.tasks} task${ins.tasks === 1 ? "" : "s"} run`,
      ins.saves && `${ins.saves} file${ins.saves === 1 ? "" : "s"} saved`,
      ins.workflows && `${ins.workflows} workflow${ins.workflows === 1 ? "" : "s"} run`,
      ins.commands && `${ins.commands} command${ins.commands === 1 ? "" : "s"}`,
    ].filter(Boolean) as string[];
    return (
      <div className="ins-col ins-col--left">
        <Card title="RECENT ACTIVITY" note="today">
          <div className="ins-line ins-strong">workspace “{workspace}”</div>
          {activity.length
            ? activity.map(a => <div key={a} className="ins-line"><span className="ins-bullet">•</span>{a}</div>)
            : <div className="ins-line ins-dim">nothing yet today</div>}
        </Card>
        {tasks.length > 0 && (
          <Card title="TASKS" note={`${tasks.length}${ins.tasks ? ` · ${ins.tasks} run today` : ""}`}>
            {tasks.slice(0, 5).map(t => (
              <button key={t} className="ins-action" onMouseDown={e => e.preventDefault()} onClick={() => onRun(`'task ${t}`)} title={`'task ${t}`}>
                <span className="ins-arrow">→</span>{t}
              </button>
            ))}
          </Card>
        )}
        {ins.files.length > 0 && (
          <Card title="RECENT FILES">
            {ins.files.slice(0, 5).map(f => (
              <button key={f} className="ins-action ins-file" onMouseDown={e => e.preventDefault()} onClick={() => onRun(`'edit ${f}`)} title={f}>{rel(f)}</button>
            ))}
          </Card>
        )}
      </div>
    );
  }

  const wf = ins.lastWorkflow && workflows.find(w => w.name === ins.lastWorkflow!.name) || workflows[0];
  const lastRun = wf && ins.lastWorkflow?.name === wf.name ? ins.lastWorkflow : undefined;
  return (
    <div className="ins-col ins-col--right">
      {projectPath && git && (
        <Card title="GIT" note={git.repo && git.remote ? undefined : "not connected"}>
          {!git.repo ? (
            <>
              <div className="ins-line">This project isn't a Git repository.</div>
              <button className="ins-action" onMouseDown={e => e.preventDefault()} onClick={() => onRun("git init")}><span className="ins-arrow">→</span>git init</button>
            </>
          ) : (
            <>
              <div className="ins-line ins-strong">⎇ {git.branch} · <span className={git.changed ? "ins-warn" : "ins-ok"}>{git.changed ? `${git.changed} changed` : "clean"}</span></div>
              {git.lastCommit && <div className="ins-line ins-dim" title={git.lastCommit.subject}>last commit {ago(git.lastCommit.at, now)}</div>}
              <div className="ins-line ins-dim">{git.branches} branch{git.branches === 1 ? "" : "es"}{git.ahead || git.behind ? ` · ↑${git.ahead ?? 0} ↓${git.behind ?? 0}` : ""}</div>
              {!git.remote && (
                <button className="ins-action" onMouseDown={e => e.preventDefault()} onClick={() => fill("'workspace github ")}><span className="ins-arrow">→</span>connect GitHub</button>
              )}
            </>
          )}
        </Card>
      )}
      {wf ? (
        <Card title="WORKFLOW" note={wf.name}>
          <div className="ins-line ins-strong">{wf.steps.slice(0, 4).join(" → ")}{wf.steps.length > 4 ? " → …" : ""}</div>
          <div className="ins-line ins-dim">
            {lastRun ? <>last run {ago(lastRun.at, now)} · <span className={lastRun.ok ? "ins-ok" : "ins-err"}>{lastRun.ok ? "✓ passed" : "✗ failed"}</span></> : "not run yet"}
          </div>
          <button className="ins-action" onMouseDown={e => e.preventDefault()} onClick={() => onRun(`'workflow ${wf.name}`)}><span className="ins-arrow">→</span>run it</button>
        </Card>
      ) : (
        <Card title="WORKSPACE INSIGHT">
          <div className="ins-line">{pluginsActive} plugin{pluginsActive === 1 ? "" : "s"} active</div>
          <div className="ins-line">{tasks.length} task{tasks.length === 1 ? "" : "s"} · {workflows.length} workflow{workflows.length === 1 ? "" : "s"}</div>
          <div className="ins-line ins-dim">{git === null ? "" : git.repo ? (git.remote ? "Git connected" : "Git: no remote") : "Git not set up"}</div>
        </Card>
      )}
      <Card title="OXIS SUGGESTS">
        {suggestions.length ? suggestions.map(s => (
          <div key={s.text} className="ins-suggest">
            <div className="ins-line">{s.text}</div>
            <button className="ins-action" onMouseDown={e => e.preventDefault()} onClick={() => (s.run ? onRun(s.run) : fill(s.fill ?? ""))}>
              <span className="ins-arrow">→</span>{s.label}
            </button>
          </div>
        )) : <div className="ins-line ins-dim">All clear — nothing needs you right now.</div>}
      </Card>
    </div>
  );
}
