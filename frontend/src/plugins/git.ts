/**
 * git.ts — git for 'workspace github/gitlab and 'task commit, run as
 * real `git` processes via runCommand() (argv only, never a shell
 * string). commitAll() pushes to origin when there is one, using the
 * machine's existing SSH key or credential helper, and classifies push
 * failures.
 */

import { runCommand, cancelCommand } from "../native";

export interface GitFileChange { path: string; status: string } // status: git's own 2-char porcelain code, e.g. "M ", "??", "A "
export interface GitStatus { isRepo: true; branch: string; files: GitFileChange[]; clean: boolean }
export interface GitNotARepo { isRepo: false }

// The git call currently running for 'task commit, so Ctrl+C can
// cancel it (killing the process) from anywhere.
let activeRequestId: string | null = null;

async function git(dir: string, args: string[]) {
  const requestId = `git-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  activeRequestId = requestId;
  try {
    return await runCommand(dir, "git", args, requestId);
  } finally {
    if (activeRequestId === requestId) activeRequestId = null;
  }
}

/** Cancels the running 'task commit step. false if none is running. */
export async function cancelActiveCommit(): Promise<boolean> {
  if (!activeRequestId) return false;
  return cancelCommand(activeRequestId);
}

/** Is `dir` (or an ancestor of it) actually inside a git repo? Real
 *  check via `git rev-parse`, not just "does a .git folder exist"
 *  (handles worktrees, and directories nested inside a repo). */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const r = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
    return r.exitCode === 0 && r.stdout.trim() === "true";
  } catch { return false; }
}

export async function initRepo(dir: string): Promise<{ ok: boolean; message: string }> {
  const r = await git(dir, ["init"]);
  if (r.exitCode !== 0) return { ok: false, message: r.stderr.trim() || "git init failed" };
  return { ok: true, message: `initialized a git repository in ${dir}` };
}

/** Real `git status --porcelain` + current branch, parsed into
 *  structured data — this is what makes `task commit` able to show
 *  "what will be committed" instead of just running a blind
 *  `git commit -a`. */
export async function getStatus(dir: string): Promise<GitStatus | GitNotARepo> {
  if (!(await isGitRepo(dir))) return { isRepo: false };
  const [statusRes, branchRes] = await Promise.all([
    git(dir, ["status", "--porcelain"]),
    git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]),
  ]);
  const files: GitFileChange[] = statusRes.stdout
    .split("\n")
    .filter(l => l.length > 3)
    .map(l => ({ status: l.slice(0, 2), path: l.slice(3).trim() }));
  return {
    isRepo: true,
    branch: branchRes.stdout.trim() || "(detached HEAD)",
    files,
    clean: files.length === 0,
  };
}

export interface CommitResult { ok: boolean; message: string; hash?: string; pushed?: boolean }

/** `git add -A` and `git commit -m <message>` in `dir`, then a push to
 *  origin if one is configured. No remote isn't an error (pushed: false);
 *  the caller words the result. */
export async function commitAll(dir: string, message: string, onProgress?: (step: string) => void): Promise<CommitResult> {
  if (!message.trim()) return { ok: false, message: "commit message can't be empty" };
  const status = await getStatus(dir);
  if (!status.isRepo) return { ok: false, message: `${dir} isn't a git repository — 'workspace github or 'workspace gitlab to set one up first` };
  if (status.clean) return { ok: false, message: "nothing to commit — working tree is clean" };

  onProgress?.("staging changes…");
  const addRes = await git(dir, ["add", "-A"]);
  if (addRes.exitCode !== 0) return { ok: false, message: `git add failed: ${addRes.stderr.trim()}` };

  onProgress?.("committing…");
  const commitRes = await git(dir, ["commit", "-m", message]);
  if (commitRes.exitCode !== 0) {
    return { ok: false, message: `git commit failed: ${(commitRes.stderr || commitRes.stdout).trim()}` };
  }
  const hashRes = await git(dir, ["rev-parse", "--short", "HEAD"]);
  const hash = hashRes.stdout.trim() || undefined;
  const commitMessage = commitRes.stdout.trim();

  const remotes = await getRemotes(dir);
  if (!remotes.some(r => r.name === "origin")) {
    // No remote configured — commit-only, not an error.
    return { ok: true, message: commitMessage, hash, pushed: false };
  }

  onProgress?.("pushing to origin…");
  const pushResult = await pushCurrentBranch(dir);
  if (!pushResult.ok) {
    // The commit stands; report only the push as failed.
    return { ok: true, message: `${commitMessage}\n\ncommitted locally, but push failed: ${pushResult.message}`, hash, pushed: false };
  }
  return { ok: true, message: `${commitMessage}\n\npushed to origin`, hash, pushed: true };
}

/** Pushes the current branch to origin and classifies failures
 *  (authentication, missing remote, rejected). Never merges or rebases
 *  on its own. */
async function pushCurrentBranch(dir: string): Promise<{ ok: boolean; message: string }> {
  const branchRes = await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = branchRes.stdout.trim();
  if (!branch || branch === "HEAD") {
    return { ok: false, message: "can't push — not on a real branch (detached HEAD)" };
  }

  const pushRes = await git(dir, ["push", "origin", branch]);
  if (pushRes.exitCode === 0) return { ok: true, message: "pushed" };

  const output = `${pushRes.stderr}\n${pushRes.stdout}`;
  if (/authentication failed|could not read username|could not read password|permission denied \(publickey\)|invalid credentials/i.test(output)) {
    return { ok: false, message: "authentication failed — check your git credentials (SSH key or credential helper) for this remote" };
  }
  if (/\[rejected\]|failed to push some refs|behind its remote|non-fast-forward|fetch first/i.test(output)) {
    return { ok: false, message: "push rejected — your branch has diverged from origin. Pull/merge or rebase manually, then run 'task commit again" };
  }
  if (/could not resolve host|network is unreachable|connection (timed out|refused)/i.test(output)) {
    return { ok: false, message: "couldn't reach the remote — check your network connection" };
  }
  if (/repository not found|does not appear to be a git repository/i.test(output)) {
    return { ok: false, message: "remote repository not found — check the URL with 'workspace github/gitlab" };
  }
  return { ok: false, message: (pushRes.stderr || pushRes.stdout).trim() || "push failed for an unknown reason" };
}

export interface GitRemote { name: string; url: string }

export async function getRemotes(dir: string): Promise<GitRemote[]> {
  const r = await git(dir, ["remote", "-v"]);
  if (r.exitCode !== 0) return [];
  const seen = new Map<string, string>();
  for (const line of r.stdout.split("\n")) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)$/);
    if (m) seen.set(m[1], m[2]);
  }
  return [...seen.entries()].map(([name, url]) => ({ name, url }));
}

export interface UnlinkRemoteResult { ok: boolean; message: string; removedCompletely: boolean }

/** `'workspace github unlink`: disconnects origin without touching the
 *  project, workspace or .git. By default origin is renamed to a
 *  timestamped backup (restorable with git); removeCompletely deletes
 *  it. Either way origin is free for a new remote. */
export async function unlinkRemote(dir: string, removeCompletely = false): Promise<UnlinkRemoteResult> {
  const remotes = await getRemotes(dir);
  const origin = remotes.find(r => r.name === "origin");
  if (!origin) return { ok: false, message: "no origin remote is configured — nothing to unlink", removedCompletely: false };

  if (removeCompletely) {
    const res = await git(dir, ["remote", "remove", "origin"]);
    if (res.exitCode !== 0) return { ok: false, message: `couldn't remove the remote: ${(res.stderr || res.stdout).trim()}`, removedCompletely: false };
    return { ok: true, message: `origin (${origin.url}) removed completely`, removedCompletely: true };
  }

  const backupName = `origin-unlinked-${Date.now()}`;
  const res = await git(dir, ["remote", "rename", "origin", backupName]);
  if (res.exitCode !== 0) return { ok: false, message: `couldn't unlink: ${(res.stderr || res.stdout).trim()}`, removedCompletely: false };
  return {
    ok: true,
    message: `unlinked — origin (${origin.url}) is still there, just renamed to "${backupName}" so OXIS no longer sees it as connected. Restore it by running "git remote rename ${backupName} origin" in the shell if you want it back, or connect a different repo now.`,
    removedCompletely: false,
  };
}

export type GitProvider = "github" | "gitlab";

/** Turns `owner/repo` or a full URL into a real HTTPS remote URL for
 *  the given provider. A full URL (already has a protocol) passes
 *  through unchanged, so this also works for anyone who wants SSH
 *  (`git@github.com:owner/repo.git`) instead of the HTTPS default. */
export function normalizeRemoteUrl(provider: GitProvider, input: string): string {
  if (/^[a-z]+:\/\//i.test(input) || /^git@/i.test(input)) return input;
  const host = provider === "github" ? "github.com" : "gitlab.com";
  const cleaned = input.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  return `https://${host}/${cleaned}.git`;
}

/** Provider and owner/repo from an origin URL (HTTPS or SSH, GitHub or
 *  GitLab), for Home's workspace panel. null if unrecognised. */
export function parseGitRemote(url: string): { provider: GitProvider; repo: string } | null {
  const m = url.match(/(?:github\.com[:/]|gitlab\.com[:/])([^/]+\/[^/]+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  const provider: GitProvider = /github\.com/i.test(url) ? "github" : "gitlab";
  return { provider, repo: m[1] };
}

export interface SetupRemoteResult { ok: boolean; message: string; needsConfirmation?: { existingUrl: string } }

/** `'workspace github/gitlab`: init a repo if needed, then set origin.
 *  A different existing origin needs force (returns needsConfirmation). */
export async function setupRemote(dir: string, provider: GitProvider, repoInput: string, force = false): Promise<SetupRemoteResult> {
  if (!(await isGitRepo(dir))) {
    const init = await initRepo(dir);
    if (!init.ok) return { ok: false, message: init.message };
  }
  const url = normalizeRemoteUrl(provider, repoInput);
  const remotes = await getRemotes(dir);
  const origin = remotes.find(r => r.name === "origin");

  if (origin && origin.url !== url && !force) {
    return {
      ok: false,
      message: `"origin" is already set to ${origin.url} — this would replace it with ${url}.`,
      needsConfirmation: { existingUrl: origin.url },
    };
  }

  const args = origin ? ["remote", "set-url", "origin", url] : ["remote", "add", "origin", url];
  const r = await git(dir, args);
  if (r.exitCode !== 0) return { ok: false, message: `couldn't configure the remote: ${r.stderr.trim()}` };
  return { ok: true, message: `origin ${origin ? "updated to" : "set to"} ${url} (${provider})` };
}