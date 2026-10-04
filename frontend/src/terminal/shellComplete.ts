/**
 * shellComplete.ts — Tab in the prompt for shell commands. The prompt is
 * OXIS's own input, so the shell's completion never sees what's typed;
 * this completes the same way in bash, PowerShell, cmd or zsh: files and
 * folders where the shell is (only folders after cd), git subcommands,
 * branches, remotes and changed files, package.json scripts after
 * npm run / pnpm / yarn / bun run, and commands used before.
 */

export interface CompleteEnv {
  /** The shell's current folder (a native path). */
  cwd: string;
  windows: boolean;
  listDir(path: string): Promise<{ name: string; isDir: boolean }[]>;
  /** git's stdout in `cwd`, or "" if it failed. */
  git(args: string[]): Promise<string>;
  readFile(path: string): Promise<string>;
  /** Commands run before, newest last. */
  history: string[];
}

export interface Candidate {
  /** What replaces the word. */
  text: string;
  /** A folder: completing it doesn't end the word. */
  isDir?: boolean;
}

export interface Completion {
  /** Where the word being completed starts in the line. */
  from: number;
  /** The word as typed, without a leading quote. */
  word: string;
  candidates: Candidate[];
}

/** What to do with the candidates: the line and cursor after Tab, and
 *  whether to list them (several, and nothing more in common to add). */
export function applyCompletion(line: string, cursor: number, c: Completion): { line: string; cursor: number; list: boolean } {
  const { candidates } = c;
  if (candidates.length === 0) return { line, cursor, list: false };
  const quote = (s: string, done: boolean) => (/[\s"'&|;()<>]/.test(s) ? `"${s}${done ? '"' : ""}` : s);
  let insert: string;
  let list = false;
  if (candidates.length === 1) {
    const only = candidates[0];
    insert = quote(only.text, !only.isDir) + (only.isDir ? "" : " ");
  } else {
    const common = commonPrefix(candidates.map(x => x.text), true);
    // Keep what was typed when the candidates differ only in case from it.
    const add = common.length > c.word.length ? common : c.word;
    insert = quote(add, false);
    list = add.length <= c.word.length;
  }
  const next = line.slice(0, c.from) + insert + line.slice(cursor);
  return { line: next, cursor: c.from + insert.length, list };
}

/** The longest start every string shares (ignoring case when asked, in
 *  which case the first string's spelling is kept). */
export function commonPrefix(xs: string[], ignoreCase = false): string {
  if (!xs.length) return "";
  let p = xs[0];
  for (const x of xs.slice(1)) {
    let i = 0;
    while (i < p.length && i < x.length && (ignoreCase ? p[i].toLowerCase() === x[i].toLowerCase() : p[i] === x[i])) i++;
    p = p.slice(0, i);
  }
  return p;
}

/** The command the cursor is in, split into words, and where the last
 *  (the one being typed) starts. Quotes group words; | && || ; start a
 *  new command. */
export function wordsAt(line: string, cursor: number): { words: string[]; from: number } {
  const s = line.slice(0, cursor);
  let words: string[] = [];
  let cur = "", start = 0, quote = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = ""; else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { if (!cur) start = i; quote = ch; continue; }
    if (/\s/.test(ch)) {
      if (cur) { words.push(cur); cur = ""; }
      start = i + 1;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "&") {
      if (cur) words.push(cur);
      words = []; cur = ""; start = i + 1;
      continue;
    }
    if (!cur) start = i;
    cur += ch;
  }
  words.push(cur);
  return { words, from: cur ? start : s.length };
}

const GIT_SUBCOMMANDS = [
  "add", "am", "bisect", "blame", "branch", "checkout", "cherry-pick", "clean", "clone", "commit", "config",
  "describe", "diff", "fetch", "grep", "init", "log", "merge", "mv", "pull", "push", "rebase", "reflog",
  "remote", "reset", "restore", "revert", "rm", "show", "stash", "status", "switch", "tag", "worktree",
];
const GIT_BRANCH_ARGS = new Set(["checkout", "switch", "merge", "rebase", "branch", "log", "diff", "cherry-pick", "reset", "show", "revert"]);
const GIT_FILE_ARGS = new Set(["add", "restore", "rm", "diff", "checkout", "reset", "stage", "unstage", "blame", "mv"]);
const COMMON_COMMANDS = [
  "bun", "cargo", "cat", "cd", "code", "curl", "docker", "echo", "git", "go", "grep", "kubectl", "ls", "make",
  "mkdir", "node", "npm", "npx", "pip", "pnpm", "python", "rm", "yarn",
];
const DIR_COMMANDS = new Set(["cd", "pushd", "chdir", "set-location", "sl", "rmdir", "rd"]);

/** Candidates for the word at the cursor, or null when Tab has nothing
 *  to offer (the caller leaves the line alone). */
export async function completeShell(line: string, cursor: number, env: CompleteEnv): Promise<Completion | null> {
  const { words, from } = wordsAt(line, cursor);
  const word = words[words.length - 1];
  const args = words.slice(0, -1);
  const fold = (s: string) => (env.windows ? s.toLowerCase() : s);
  const starts = (s: string) => fold(s).startsWith(fold(word));
  const only = (xs: string[]) => [...new Set(xs)].filter(starts).sort().map(text => ({ text }));
  const done = (candidates: Candidate[]): Completion | null => (candidates.length ? { from, word, candidates } : null);

  // The command itself: ones used before and common ones, or a path to a
  // script when it looks like one.
  if (args.length === 0) {
    if (!word) return null;
    if (/[\\/]/.test(word) || word.startsWith(".")) return done(await paths(word, env, false));
    const used = env.history.map(h => wordsAt(h, h.length).words[0] ?? "").filter(w => w && !w.startsWith("'") && !/[\\/]/.test(w));
    return done(only([...used, ...COMMON_COMMANDS]));
  }

  const cmd = fold(args[0].replace(/^.*[\\/]/, "").replace(/\.(exe|cmd|bat)$/i, ""));
  if (word.startsWith("-")) return null;

  if (cmd === "git") {
    const sub = args[1];
    if (!sub) {
      const aliases = (await env.git(["config", "--get-regexp", "^alias\\."])).split("\n").map(l => l.split(" ")[0].replace(/^alias\./, "")).filter(Boolean);
      return done(only([...GIT_SUBCOMMANDS, ...aliases]));
    }
    if ((sub === "push" || sub === "pull" || sub === "fetch") && args.length === 2) {
      return done(only((await env.git(["remote"])).split("\n").filter(Boolean)));
    }
    const afterDashes = args.includes("--");
    if (!afterDashes && (GIT_BRANCH_ARGS.has(sub) || ((sub === "push" || sub === "pull") && args.length === 3))) {
      const refs = (await env.git(["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes", "refs/tags"])).split("\n").filter(r => r && !r.endsWith("/HEAD") && r !== "origin");
      // checkout/switch also take a remote branch's own name.
      const local = sub === "checkout" || sub === "switch" ? refs.map(r => r.replace(/^[^/]+\//, "")) : [];
      const branches = only([...refs, ...local]);
      if (branches.length || !GIT_FILE_ARGS.has(sub)) return done(branches);
    }
    if (GIT_FILE_ARGS.has(sub)) {
      if (sub === "add" || sub === "restore") {
        const changed = (await env.git(["status", "--porcelain", "--untracked-files=all"])).split("\n")
          .filter(Boolean).map(l => l.slice(3).replace(/^.* -> /, "").replace(/^"|"$/g, ""));
        const hits = changed.filter(starts);
        if (hits.length) return done(only(hits));
      }
      return done(await paths(word, env, false));
    }
    return done(await paths(word, env, false));
  }

  if (["npm", "pnpm", "yarn", "bun"].includes(cmd)) {
    const runs = args[1] === "run" || args[1] === "run-script";
    const direct = (cmd === "pnpm" || cmd === "yarn") && args.length === 1;
    if ((runs && args.length === 2) || direct) {
      let scripts: string[] = [];
      try { scripts = Object.keys((JSON.parse(await env.readFile(join(env.cwd, "package.json", env.windows))) as { scripts?: Record<string, string> }).scripts ?? {}); } catch { /* no package.json here */ }
      const extra = direct ? ["add", "install", "remove", "run", "test", "build", "dev"] : [];
      return done(only([...scripts, ...extra]));
    }
  }

  return done(await paths(word, env, DIR_COMMANDS.has(cmd)));
}

function join(dir: string, name: string, windows = false): string {
  const sep = windows && !dir.includes("/") ? "\\" : "/";
  return dir.replace(/[\\/]+$/, "") + sep + name.replace(/[\\/]+$/, "").replace(/[\\/]/g, sep);
}

/** Files and folders that complete `word`, a path typed relative to the
 *  shell's folder or absolute (C:\…, /c/… in Git Bash, /home/…). */
async function paths(word: string, env: CompleteEnv, dirsOnly: boolean): Promise<Candidate[]> {
  const cut = Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\"));
  const typedDir = cut >= 0 ? word.slice(0, cut + 1) : "";
  const base = word.slice(cut + 1);
  let dir: string;
  if (/^[a-zA-Z]:[\\/]?$/.test(typedDir) || /^[a-zA-Z]:[\\/]/.test(typedDir)) dir = typedDir;
  else if (env.windows && /^\/[a-zA-Z](\/|$)/.test(typedDir)) dir = `${typedDir[1].toUpperCase()}:/${typedDir.slice(3)}`;
  else if (typedDir.startsWith("/") && !env.windows) dir = typedDir;
  else dir = typedDir ? join(env.cwd, typedDir, env.windows) : env.cwd;
  let entries: { name: string; isDir: boolean }[];
  // No trailing separator, except on a root (C:/, /).
  if (!/^([a-zA-Z]:)?[\\/]$/.test(dir)) dir = dir.replace(/[\\/]+$/, "");
  try { entries = await env.listDir(dir || "/"); } catch { return []; }
  const fold = (s: string) => (env.windows ? s.toLowerCase() : s);
  const sep = word.includes("\\") && !word.includes("/") ? "\\" : "/";
  return entries
    .filter(e => (!dirsOnly || e.isDir) && fold(e.name).startsWith(fold(base)) && (base.startsWith(".") || !e.name.startsWith(".")))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(e => ({ text: typedDir + e.name + (e.isDir ? sep : ""), isDir: e.isDir }));
}
