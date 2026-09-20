/**
 * git.ts — real git integration backing 'workspace github/gitlab and
 * `task commit`. Runs actual `git` via runCommand() (native.ts) —
 * argv-based, never a shell-interpreted string, so a commit message
 * or branch name can't break out into a second command the way
 * string-concatenated shell input could.
 *
 * Scope, deliberately: this configures remotes and makes local
 * commits. It does NOT push, authenticate, or touch CI/CD — pushing
 * needs real credentials (SSH key or a credential helper already set
 * up on the machine, which this doesn't manage), and the spec this
 * was built against explicitly says not to build push/tag/release now
 * ("keep the architecture extensible... do not automatically add
 * those future tasks now").
 */

import { runCommand } from "../native";

export interface GitFileChange { path: string; status: string } // status: git's own 2-char porcelain code, e.g. "M ", "??", "A "
export interface GitStatus { isRepo: true; branch: string; files: GitFileChange[]; clean: boolean }
export interface GitNotARepo { isRepo: false }

async function git(dir: string, args: string[]) {
  return runCommand(dir, "git", args);
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

export interface CommitResult { ok: boolean; message: string; hash?: string }

/** Stages everything in `dir` (and only `dir` — git itself already
 *  scopes `add -A` to the repo it's run in via cwd, so this can't
 *  reach outside the connected project) and commits with the given
 *  message. Real argv (`-m`, message), not a shell string — a message
 *  containing quotes, `;`, backticks, etc. is just message text here,
 *  never a way to run something else. */
export async function commitAll(dir: string, message: string): Promise<CommitResult> {
  if (!message.trim()) return { ok: false, message: "commit message can't be empty" };
  const status = await getStatus(dir);
  if (!status.isRepo) return { ok: false, message: `${dir} isn't a git repository — 'workspace github or 'workspace gitlab to set one up first` };
  if (status.clean) return { ok: false, message: "nothing to commit — working tree is clean" };

  const addRes = await git(dir, ["add", "-A"]);
  if (addRes.exitCode !== 0) return { ok: false, message: `git add failed: ${addRes.stderr.trim()}` };

  const commitRes = await git(dir, ["commit", "-m", message]);
  if (commitRes.exitCode !== 0) {
    return { ok: false, message: `git commit failed: ${(commitRes.stderr || commitRes.stdout).trim()}` };
  }
  const hashRes = await git(dir, ["rev-parse", "--short", "HEAD"]);
  return { ok: true, message: commitRes.stdout.trim(), hash: hashRes.stdout.trim() || undefined };
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