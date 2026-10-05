import { describe, expect, it } from "vitest";
import { applyCompletion, completeShell, wordsAt, type CompleteEnv } from "./shellComplete";

const FILES: Record<string, { name: string; isDir: boolean }[]> = {
  "C:\\proj": [
    { name: "src", isDir: true }, { name: "scripts", isDir: true }, { name: "My Docs", isDir: true },
    { name: "package.json", isDir: false }, { name: "README.md", isDir: false }, { name: ".git", isDir: true },
  ],
  "C:\\proj\\src": [{ name: "app.ts", isDir: false }, { name: "api", isDir: true }],
  "C:/Users": [{ name: "Admin", isDir: true }, { name: "Public", isDir: true }],
};

const env = (over: Partial<CompleteEnv> = {}): CompleteEnv => ({
  cwd: "C:\\proj",
  windows: true,
  listDir: async (p) => { const e = FILES[p]; if (!e) throw new Error("no such folder " + p); return e; },
  git: async (args) => {
    const a = args.join(" ");
    if (a.startsWith("for-each-ref")) return "main\nfeature/login\norigin/HEAD\norigin/main\norigin/fix-tabs\nv1.0\n";
    if (a === "remote") return "origin\nupstream\n";
    if (a.startsWith("status")) return " M src/app.ts\n?? notes.txt\n";
    if (a.startsWith("config")) return "alias.st status\n";
    return "";
  },
  readFile: async (p) => {
    if (p === "C:\\proj\\package.json") return JSON.stringify({ scripts: { dev: "vite", build: "vite build", test: "vitest" } });
    throw new Error("missing");
  },
  history: ["git status", "npm run dev", "'help", "python app.py"],
  ...over,
});

const tab = async (line: string, e = env()) => {
  const c = await completeShell(line, line.length, e);
  return c ? { ...applyCompletion(line, line.length, c), all: c.candidates.map(x => x.text) } : null;
};

describe("words at the cursor", () => {
  it("splits on spaces, keeps quoted words, restarts after | && ;", () => {
    expect(wordsAt("git checkout ma", 15)).toEqual({ words: ["git", "checkout", "ma"], from: 13 });
    expect(wordsAt('cd "My Do', 9).words).toEqual(["cd", "My Do"]);
    expect(wordsAt("npm test && git sw", 18).words).toEqual(["git", "sw"]);
    expect(wordsAt("ls ", 3)).toEqual({ words: ["ls", ""], from: 3 });
  });
});

describe("Tab for shell commands", () => {
  it("completes files and folders where the shell is", async () => {
    expect((await tab("cat pack"))?.line).toBe("cat package.json ");
    expect((await tab("ls sr"))?.line).toBe("ls src/");
    expect((await tab("ls src/a"))?.all).toEqual(["src/api/", "src/app.ts"]);
    expect((await tab("ls src/ap"))?.line).toBe("ls src/ap");
    expect((await tab("ls src/ap"))?.list).toBe(true);
  });

  it("only folders after cd, quoted when they have spaces", async () => {
    expect((await tab("cd s"))?.all).toEqual(["scripts/", "src/"]);
    expect((await tab("cd s"))?.line).toBe("cd s");
    expect((await tab("cd M"))?.line).toBe('cd "My Docs/');
    expect((await tab("cd r"))).toBeNull(); // README.md is a file
  });

  it("hides dotfiles unless asked for, and ignores case on Windows", async () => {
    expect((await tab("ls .g"))?.line).toBe("ls .git/");
    expect((await tab("cat read"))?.line).toBe("cat README.md ");
  });

  it("~ is the home folder", async () => {
    expect((await tab("cd ~/Pu", env({ home: "C:/Users" })))?.line).toBe("cd ~/Public/");
  });

  it("absolute paths, Git Bash style too", async () => {
    expect((await tab("cd C:/Users/Ad"))?.line).toBe("cd C:/Users/Admin/");
    expect((await tab("cd /c/Users/P"))?.line).toBe("cd /c/Users/Public/");
  });

  it("git: subcommands and aliases, branches, remotes, changed files", async () => {
    expect((await tab("git chec"))?.line).toBe("git checkout ");
    expect((await tab("git s"))?.all).toEqual(["show", "st", "stash", "status", "switch"]);
    expect((await tab("git checkout feat"))?.line).toBe("git checkout feature/login ");
    expect((await tab("git switch fix"))?.line).toBe("git switch fix-tabs ");
    expect((await tab("git push up"))?.line).toBe("git push upstream ");
    expect((await tab("git push origin ma"))?.line).toBe("git push origin main ");
    expect((await tab("git add no"))?.line).toBe("git add notes.txt ");
    expect((await tab("git add sr"))?.line).toBe("git add src/app.ts ");
    expect(await tab("git commit -")).toBeNull();
  });

  it("package.json scripts", async () => {
    expect((await tab("npm run b"))?.line).toBe("npm run build ");
    expect((await tab("pnpm d"))?.line).toBe("pnpm dev ");
    expect((await tab("npm run "))?.all).toEqual(["build", "dev", "test"]);
  });

  it("PowerShell's cmdlets in a PowerShell tab, any case", async () => {
    expect((await tab("get-chi", env({ shell: "pwsh" })))?.line).toBe("Get-ChildItem ");
    expect((await tab("Set-L", env({ shell: "powershell" })))?.line).toBe("Set-Location ");
    expect(await tab("get-chi", env({ shell: "bash" }))).toBeNull();
  });

  it("git's long options and stash subcommands", async () => {
    expect((await tab("git log --on"))?.line).toBe("git log --oneline ");
    expect((await tab("git push --force-w"))?.line).toBe("git push --force-with-lease ");
    expect((await tab("git stash p"))?.all).toEqual(["pop", "push"]);
    expect(await tab("git commit -m")).toBeNull();
  });

  it("subcommands of common tools", async () => {
    expect((await tab("docker ru"))?.line).toBe("docker run ");
    expect((await tab("kubectl desc"))?.line).toBe("kubectl describe ");
    expect((await tab("npm i"))?.all).toEqual(["init", "install"]);
    expect((await tab("npm run b"))?.line).toBe("npm run build ");
  });

  it("programs on PATH", async () => {
    expect((await tab("dock", env({ pathCommands: async () => ["docker", "docker-compose", "node"] })))?.all).toEqual(["docker", "docker-compose"]);
  });

  it("commands used before", async () => {
    expect((await tab("pyt"))?.line).toBe("python ");
    expect(await tab("")).toBeNull();
  });
});
