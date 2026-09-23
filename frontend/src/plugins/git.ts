/**
 * git.ts — real git integration backing 'workspace github/gitlab and
 * `task commit`. Runs actual `git` via runCommand() (native.ts) —
 * argv-based, never a shell-interpreted string, so a commit message
 * or branch name can't break out into a second command the way
 * string-concatenated shell input could.
 *
 * commitAll() also pushes to `origin` after a successful commit, if
 * one is configured — this used to be explicitly out of scope (an
 * earlier version of this comment said so directly), which turned
 * out to be a real, reported gap: a "successful" `'task commit` that
 * never actually reached GitHub/GitLab wasn't doing what anyone
 * running that command would expect. Pushing relies on whatever
 * credentials (SSH key or a credential helper) are already set up on
 * the machine — this still doesn't manage authentication itself, it
 * just surfaces a clear, classified error (see pushCurrentBranch)
 * when there isn't a working one, rather than pretending to push
 * successfully or leaving the failure as opaque git stderr.
 */

import { runCommand, cancelCommand } from "../native";

export interface GitFileChange { path: string; status: string } // status: git's own 2-char porcelain code, e.g. "M ", "??", "A "
export interface GitStatus { isRepo: true; branch: string; files: GitFileChange[]; clean: boolean }
export interface GitNotARepo { isRepo: false }

// Tracks whichever git() call is CURRENTLY in flight (from
// commitAll's own sequence of add/commit/push, specifically — see
// cancelActiveCommit below), so a Ctrl+C during 'task commit can
// cancel whatever step is actually running right now, not just stop
// waiting on it client-side. Real cancellation — see CancelCommand in
// internal/wailsapp/app.go — was a genuine gap found while building
// this: there was previously no way to interrupt an in-flight
// RunCommand call at all, only a fixed timeout to wait out, which
// (now that commitAll can push, a real network operation) had to grow
// from 30s to several minutes to not falsely kill a legitimately slow
// push — making the lack of real cancellation matter a lot more than
// it used to. Module-level rather than passed through every call
// specifically so cancelActiveCommit() can be called from anywhere
// (App.tsx's Ctrl+C handling) without threading a cancellation token
// through the whole commitAll/pushCurrentBranch call chain.
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

/** Cancels whichever git() call is currently active (add/commit/push,
 *  whichever step 'task commit happens to be on right now) — real
 *  cancellation, not just giving up on waiting for it; see
 *  CancelCommand's own doc comment in app.go for what actually
 *  happens on the Go side (the real child process gets killed).
 *  Returns false (not an error) if nothing is currently active —
 *  nothing to cancel, not a failure. */
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

/** Stages everything in `dir` (and only `dir` — git itself already
 *  scopes `add -A` to the repo it's run in via cwd, so this can't
 *  reach outside the connected project) and commits with the given
 *  message. Real argv (`-m`, message), not a shell string — a message
 *  containing quotes, `;`, backticks, etc. is just message text here,
 *  never a way to run something else.
 *
 *  Pushes to `origin` afterward IF one is configured — this used to
 *  be explicitly out of scope (an earlier design note here said so
 *  directly), which was a real, reported gap: a "successful" commit
 *  task that never actually reached GitHub/GitLab wasn't doing what
 *  anyone asking for `'task commit` would expect. A commit with no
 *  remote configured is NOT an error — `pushed: false` with no error
 *  message, since committing locally-only is a completely normal,
 *  valid thing to do; the caller (App.tsx's runCommitTask) is what
 *  decides how to phrase "committed, nothing to push" vs "committed
 *  and pushed" vs "committed, but the push failed" for the user. */
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
    // The COMMIT itself succeeded — only report the push half as
    // failed, don't roll back or claim the whole operation failed.
    // ok stays true (the commit is real and permanent either way);
    // pushed:false plus a real error message is how the caller tells
    // "committed but not pushed" apart from "commit itself failed".
    return { ok: true, message: `${commitMessage}\n\ncommitted locally, but push failed: ${pushResult.message}`, hash, pushed: false };
  }
  return { ok: true, message: `${commitMessage}\n\npushed to origin`, hash, pushed: true };
}

/** Pushes the current branch to `origin`, classifying the specific
 *  failure rather than just surfacing raw stderr — auth failures,
 *  a missing/misconfigured remote, and diverged-history rejections
 *  all look different to a user and (per this file's own design
 *  brief) OXIS deliberately does NOT attempt an automatic merge/
 *  rebase to resolve a diverged push itself; that's a real decision
 *  a person should make, not something a "commit" task should guess
 *  at silently. */
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

/** The reverse of normalizeRemoteUrl — given whatever's actually
 *  configured as `origin` (HTTPS or SSH form, github.com or
 *  gitlab.com), extracts which provider it is and the `owner/repo`
 *  path. Used by Home's WORKSPACE panel to show real git connection
 *  status instead of just "connected: <path>" — see WorkspacePanel in
 *  App.tsx. Returns null for anything that isn't recognizably one of
 *  the two (a different host entirely, or a malformed URL) rather
 *  than guessing. */
export function parseGitRemote(url: string): { provider: GitProvider; repo: string } | null {
  const m = url.match(/(?:github\.com[:/]|gitlab\.com[:/])([^/]+\/[^/]+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  const provider: GitProvider = /github\.com/i.test(url) ? "github" : "gitlab";
  return { provider, repo: m[1] };
}

export interface SetupRemoteResult { ok: boolean; message: string; needsConfirmation?: { existingUrl: string } }

/** `'workspace github`/`'workspace gitlab`'s actual work: makes sure
 *  `dir` is a real git repo (initializing one if it isn't — a fresh
 *  project connected to OXIS is a completely normal case to start
 *  from), then configures the `origin` remote. Refuses to silently
 *  overwrite an existing DIFFERENT origin — returns needsConfirmation
 *  instead of just doing it, so the caller (the command handler) can
 *  ask before calling this again with force:true. */
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