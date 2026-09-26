/**
 * projectDetector.ts — detects a linked project's type and proposes
 * tasks for what its own configuration actually defines (real
 * package.json scripts, Makefile targets, and so on).
 *
 * Tasks go to .oxis/tasks/auto-detected.lua, never to workspace.lua or
 * the user's own task files.
 */

import { readFile, statPath, listDir, runCommand, writeFile, makeDir } from "../native";

export interface DetectedTask {
  name: string;
  command: string;
  description: string;
  /** Human-readable provenance — shown in the generated file's own
   *  comments and used by taskReconciler.ts to explain itself. */
  source: string;
}

export interface ProjectDetectionResult {
  /** Labels like ["Rust (Cargo)", "Node.js (npm)"]; a project can
   *  match more than one. */
  projectTypes: string[];
  tasks: DetectedTask[];
}

async function fileExists(path: string): Promise<boolean> {
  const s = await statPath(path).catch(() => ({ exists: false, isDir: false, size: 0, modTime: 0 }));
  return s.exists && !s.isDir;
}

async function tryReadFile(path: string): Promise<string | null> {
  try { return await readFile(path); } catch { return null; }
}

async function toolExists(dir: string, name: string, args: string[]): Promise<boolean> {
  try {
    // exitCode doesn't matter here — a real tool that just printed
    // "unknown flag" and exited 1 still PROVES it exists and ran;
    // only a genuine failure to start (thrown, not returned) means
    // the binary itself isn't on PATH at all.
    await runCommand(dir, name, args);
    return true;
  } catch {
    return false;
  }
}

// ── Rust (Cargo) ────────────────────────────────────────────────
async function detectRust(dir: string): Promise<DetectedTask[]> {
  if (!(await fileExists(`${dir}/Cargo.toml`))) return [];
  const tasks: DetectedTask[] = [
    { name: "build", command: "cargo build", description: "Build the crate (debug)", source: "Cargo.toml" },
    { name: "check", command: "cargo check", description: "Type-check without producing a binary", source: "Cargo.toml" },
    { name: "test", command: "cargo test", description: "Run the test suite", source: "Cargo.toml" },
    { name: "run", command: "cargo run", description: "Build and run", source: "Cargo.toml" },
  ];
  return tasks;
}

// ── Node.js / JavaScript / TypeScript ───────────────────────────
async function detectNode(dir: string): Promise<DetectedTask[]> {
  const raw = await tryReadFile(`${dir}/package.json`);
  if (!raw) return [];
  let pkg: { scripts?: Record<string, string> };
  try { pkg = JSON.parse(raw); } catch { return []; } // malformed package.json — nothing safe to generate from it
  const scripts = pkg.scripts ?? {};
  if (Object.keys(scripts).length === 0) return [];

  // Pick the package manager from the lockfile rather than assuming npm.
  let pm = "npm";
  let runPrefix = "npm run";
  if (await fileExists(`${dir}/pnpm-lock.yaml`)) { pm = "pnpm"; runPrefix = "pnpm run"; }
  else if (await fileExists(`${dir}/yarn.lock`)) { pm = "yarn"; runPrefix = "yarn"; }
  else if (await fileExists(`${dir}/bun.lockb`)) { pm = "bun"; runPrefix = "bun run"; }

  // Only scripts the project defines, common names first (not every
  // script), since some projects have dozens.
  const priority = ["dev", "start", "build", "test", "lint", "typecheck", "format"];
  const tasks: DetectedTask[] = [];
  for (const name of priority) {
    if (scripts[name]) {
      tasks.push({ name, command: `${runPrefix} ${name}`, description: `package.json script: ${scripts[name]}`, source: `package.json (${pm})` });
    }
  }
  return tasks;
}

// ── Python ───────────────────────────────────────────────────────
async function detectPython(dir: string): Promise<DetectedTask[]> {
  const hasPyproject = await fileExists(`${dir}/pyproject.toml`);
  const hasSetupPy = await fileExists(`${dir}/setup.py`);
  const hasRequirements = await fileExists(`${dir}/requirements.txt`);
  if (!hasPyproject && !hasSetupPy && !hasRequirements) return [];

  const tasks: DetectedTask[] = [];
  if (hasRequirements) {
    tasks.push({ name: "install", command: "pip install -r requirements.txt", description: "Install dependencies from requirements.txt", source: "requirements.txt" });
  }
  if (hasPyproject) {
    const content = (await tryReadFile(`${dir}/pyproject.toml`)) ?? "";
    // A real, if simple, check for actual tool config sections rather
    // than assuming every Python project uses every popular tool.
    if (/\[tool\.pytest/.test(content) || await fileExists(`${dir}/pytest.ini`)) {
      tasks.push({ name: "test", command: "pytest", description: "Run the test suite (pytest)", source: "pyproject.toml [tool.pytest]" });
    }
    if (/\[tool\.ruff/.test(content)) {
      tasks.push({ name: "lint", command: "ruff check .", description: "Lint with ruff", source: "pyproject.toml [tool.ruff]" });
    }
    if (/\[tool\.black/.test(content)) {
      tasks.push({ name: "format", command: "black .", description: "Format with black", source: "pyproject.toml [tool.black]" });
    }
    if (/\[build-system\]/.test(content)) {
      tasks.push({ name: "build", command: "python -m build", description: "Build the package (PEP 517)", source: "pyproject.toml [build-system]" });
    }
  } else if (hasSetupPy) {
    tasks.push({ name: "build", command: "python setup.py build", description: "Build the package", source: "setup.py" });
    if (!tasks.some(t => t.name === "test")) {
      // setup.py projects without a pyproject.toml pytest section
      // still very commonly use pytest — but only propose it if the
      // tool is actually reachable, not just guessed at.
      if (await toolExists(dir, "pytest", ["--version"])) {
        tasks.push({ name: "test", command: "pytest", description: "Run the test suite (pytest)", source: "setup.py + pytest on PATH" });
      }
    }
  }
  return tasks;
}

// ── Go ───────────────────────────────────────────────────────────
async function detectGo(dir: string): Promise<DetectedTask[]> {
  if (!(await fileExists(`${dir}/go.mod`))) return [];
  return [
    { name: "build", command: "go build ./...", description: "Build all packages", source: "go.mod" },
    { name: "test", command: "go test ./...", description: "Run the test suite", source: "go.mod" },
    { name: "vet", command: "go vet ./...", description: "Run go vet", source: "go.mod" },
    { name: "run", command: "go run .", description: "Build and run the current module", source: "go.mod" },
  ];
}

// ── .NET / C# ────────────────────────────────────────────────────
async function detectDotnet(dir: string): Promise<DetectedTask[]> {
  const entries = await listDir(dir).catch((): Awaited<ReturnType<typeof listDir>> => []);
  const projectFile = entries.find(e => !e.isDir && /\.(csproj|fsproj|sln)$/i.test(e.name));
  if (!projectFile) return [];
  const target = projectFile.name;
  return [
    { name: "build", command: `dotnet build "${target}"`, description: `Build ${target}`, source: target },
    { name: "test", command: `dotnet test "${target}"`, description: `Run tests for ${target}`, source: target },
    { name: "run", command: `dotnet run --project "${target}"`, description: `Run ${target}`, source: target },
  ];
}

// ── Java (Maven / Gradle) ───────────────────────────────────────
async function detectJava(dir: string): Promise<DetectedTask[]> {
  const hasMaven = await fileExists(`${dir}/pom.xml`);
  const hasGradle = (await fileExists(`${dir}/build.gradle`)) || (await fileExists(`${dir}/build.gradle.kts`));
  if (hasMaven) {
    const wrapper = (await fileExists(`${dir}/mvnw`)) ? "./mvnw" : "mvn";
    return [
      { name: "build", command: `${wrapper} compile`, description: "Compile (Maven)", source: "pom.xml" },
      { name: "test", command: `${wrapper} test`, description: "Run the test suite (Maven)", source: "pom.xml" },
      { name: "package", command: `${wrapper} package`, description: "Build a package/jar (Maven)", source: "pom.xml" },
    ];
  }
  if (hasGradle) {
    const wrapper = (await fileExists(`${dir}/gradlew`)) ? "./gradlew" : "gradle";
    return [
      { name: "build", command: `${wrapper} build`, description: "Build (Gradle)", source: "build.gradle" },
      { name: "test", command: `${wrapper} test`, description: "Run the test suite (Gradle)", source: "build.gradle" },
      { name: "run", command: `${wrapper} run`, description: "Run (Gradle)", source: "build.gradle" },
    ];
  }
  return [];
}

// ── C / C++ ──────────────────────────────────────────────────────
async function detectCCpp(dir: string): Promise<DetectedTask[]> {
  const hasCMake = await fileExists(`${dir}/CMakeLists.txt`);
  const hasMakefile = (await fileExists(`${dir}/Makefile`)) || (await fileExists(`${dir}/makefile`));
  if (hasCMake) {
    return [
      { name: "configure", command: "cmake -B build", description: "Configure the build directory", source: "CMakeLists.txt" },
      { name: "build", command: "cmake --build build", description: "Build (CMake)", source: "CMakeLists.txt" },
    ];
  }
  if (hasMakefile) {
    // List real targets with `make -pn` instead of assuming the usual
    // names exist.
    const content = (await tryReadFile(`${dir}/Makefile`)) ?? (await tryReadFile(`${dir}/makefile`)) ?? "";
    const targets = new Set<string>();
    for (const m of content.matchAll(/^([A-Za-z0-9_-]+)\s*:(?!=)/gm)) {
      if (!m[1].startsWith(".")) targets.add(m[1]);
    }
    const tasks: DetectedTask[] = [];
    for (const name of ["build", "all", "test", "clean", "install"]) {
      if (targets.has(name)) {
        tasks.push({ name, command: `make ${name}`, description: `make ${name}`, source: "Makefile" });
      }
    }
    return tasks;
  }
  return [];
}

// ── PHP ──────────────────────────────────────────────────────────
async function detectPHP(dir: string): Promise<DetectedTask[]> {
  const raw = await tryReadFile(`${dir}/composer.json`);
  if (!raw) return [];
  let comp: { scripts?: Record<string, string> };
  try { comp = JSON.parse(raw); } catch { return []; }
  const scripts = comp.scripts ?? {};
  const tasks: DetectedTask[] = [
    { name: "install", command: "composer install", description: "Install dependencies", source: "composer.json" },
  ];
  for (const name of ["test", "lint"]) {
    if (scripts[name]) tasks.push({ name, command: `composer ${name}`, description: `composer.json script: ${scripts[name]}`, source: "composer.json" });
  }
  return tasks;
}

// ── Ruby ─────────────────────────────────────────────────────────
async function detectRuby(dir: string): Promise<DetectedTask[]> {
  if (!(await fileExists(`${dir}/Gemfile`))) return [];
  const tasks: DetectedTask[] = [
    { name: "install", command: "bundle install", description: "Install gems", source: "Gemfile" },
  ];
  if (await fileExists(`${dir}/Rakefile`)) {
    tasks.push({ name: "test", command: "bundle exec rake test", description: "Run the test suite (Rake)", source: "Rakefile" });
  }
  return tasks;
}

const DETECTORS: { label: string; detect: (dir: string) => Promise<DetectedTask[]> }[] = [
  { label: "Rust (Cargo)", detect: detectRust },
  { label: "Node.js", detect: detectNode },
  { label: "Python", detect: detectPython },
  { label: "Go", detect: detectGo },
  { label: ".NET", detect: detectDotnet },
  { label: "Java", detect: detectJava },
  { label: "C/C++", detect: detectCCpp },
  { label: "PHP", detect: detectPHP },
  { label: "Ruby", detect: detectRuby },
];

/** Runs every detector on `dir` and merges the results; a name clash
 *  gets the source's label as a suffix ("build-nodejs"). */
export async function detectProject(dir: string): Promise<ProjectDetectionResult> {
  const projectTypes: string[] = [];
  const tasks: DetectedTask[] = [];
  const usedNames = new Set<string>();

  for (const { label, detect } of DETECTORS) {
    let found: DetectedTask[];
    try { found = await detect(dir); } catch { found = []; } // a detector's own failure (bad file read, etc.) shouldn't block the others
    if (found.length === 0) continue;
    projectTypes.push(label);
    for (const t of found) {
      let name = t.name;
      if (usedNames.has(name)) {
        const suffix = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
        name = `${t.name}-${suffix}`;
      }
      usedNames.add(name);
      tasks.push({ ...t, name });
    }
  }

  return { projectTypes, tasks };
}

/** Escapes a string for a single-quoted Lua literal. */
/** Escapes text for a single-quoted Lua string. Control characters
 *  become \ddd escapes: a raw line break (\r as well as \n) would end
 *  the string and stop the whole tasks file from loading. */
export function luaEscape(s: string): string {
  return s.replace(/[\\'\x00-\x1f\x7f]/g, c =>
    c === "\\" ? "\\\\" : c === "'" ? "\\'" : "\\" + String(c.charCodeAt(0)).padStart(3, "0"));
}

/** Reverses luaEscape (for reading generated task lines back). */
export function luaUnescape(s: string): string {
  return s.replace(/\\(\d{3}|.)/g, (_, g: string) => /^\d{3}$/.test(g) ? String.fromCharCode(Number(g)) : g);
}

export const AUTO_DETECTED_TASKS_FILE = ".oxis/tasks/auto-detected.lua";
export const AUTO_DETECTED_META_FILE = ".oxis/tasks/.auto-detected-meta.json";

/** Metadata per generated task. contentHash is the generated line's
 *  hash, so the reconciler can tell whether the user has edited it. */
export interface GeneratedTaskMeta {
  source: string;
  generatedAt: number;
  contentHash: string;
}

export type GeneratedTasksMeta = Record<string, GeneratedTaskMeta>;

/** A tiny, fast, non-cryptographic string hash (FNV-1a) — good enough
 *  to detect "this line changed at all", which is all contentHash
 *  needs; nothing here is a security boundary. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function taskLine(t: DetectedTask): string {
  return `oxis.task('${luaEscape(t.name)}', '${luaEscape(t.command)}', '${luaEscape(t.description)}')`;
}

/** Builds auto-detected.lua: a header, then one oxis.task() per
 *  detected task, grouped by source. Hand edits are allowed (and kept). */
export function generateTasksFile(result: ProjectDetectionResult): string {
  const lines: string[] = [
    "-- auto-detected.lua — automatically generated by OXIS project",
    "-- detection, from the project's own actual configuration.",
    "--",
    `-- Detected project type${result.projectTypes.length === 1 ? "" : "s"}: ${result.projectTypes.join(", ") || "none"}`,
    "--",
    "-- Editing this file is fine — OXIS's task integrity checker",
    "-- tracks which tasks you've changed and won't overwrite your",
    "-- edits just because the underlying project configuration later",
    "-- changes too. It only touches tasks that are still exactly as",
    "-- generated, or removes ones whose source no longer exists.",
    "",
  ];
  let lastSource = "";
  for (const t of result.tasks) {
    if (t.source !== lastSource) {
      lines.push(`-- from ${t.source}`);
      lastSource = t.source;
    }
    lines.push(taskLine(t));
  }
  lines.push("");
  return lines.join("\n");
}

/** Writes auto-detected.lua and its metadata. The .lua is rewritten
 *  whole; the reconciler checks for hand edits before regenerating. */
export async function writeDetectedTasks(oxisTasksDir: string, result: ProjectDetectionResult): Promise<GeneratedTasksMeta> {
  await makeDir(oxisTasksDir).catch(() => {}); // may already exist — fine either way
  const content = generateTasksFile(result);
  await writeFile(`${oxisTasksDir}/auto-detected.lua`, content);

  const meta: GeneratedTasksMeta = {};
  for (const t of result.tasks) {
    meta[t.name] = { source: t.source, generatedAt: Date.now(), contentHash: fnv1a(taskLine(t)) };
  }
  await writeFile(`${oxisTasksDir}/.auto-detected-meta.json`, JSON.stringify(meta, null, 2));
  return meta;
}