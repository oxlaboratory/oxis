#!/usr/bin/env node
/**
 * scripts/dev.js — watch + rebuild + relaunch loop for the native
 * Wails window.
 *
 * There's no live hot-reload here: the frontend is embedded into the
 * Go binary at compile time via go:embed, so a rebuild is the only
 * way for changes to reach the running window. This script watches
 * frontend/src, cmd/, and internal/ and, on change, reruns the full
 * `npm run build` (frontend build → embed → go build) and relaunches
 * dist/oxis(.exe), killing the previous instance first.
 *
 * Slower than true HMR, but correct — and simple enough that a
 * `go build` failure or a Wails runtime error shows up exactly like
 * it would in a normal build.
 */
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs   = require("fs");

const ROOT     = path.resolve(__dirname, "..");
const IS_WIN   = process.platform === "win32";
const BINARY   = path.join(ROOT, "dist", IS_WIN ? "oxis.exe" : "oxis");
const WATCH_DIRS = [
  path.join(ROOT, "frontend", "src"),
  path.join(ROOT, "cmd"),
  path.join(ROOT, "internal"),
];

const col = { reset:"\x1b[0m", magenta:"\x1b[35m", cyan:"\x1b[36m", red:"\x1b[31m", grey:"\x1b[90m" };
const log = (m, c=col.reset) => console.log(c+m+col.reset);

// The build itself writes into internal/server/dist (embedded frontend
// copy) and cmd/oxi/resource.syso (icon resource) — both inside
// directories we watch. Without filtering these out, every build
// triggers the fs.watch callback, which schedules another build,
// forever. Match on normalized path segments so it works with both
// "/" and "\" separators.
const IGNORE_SEGMENTS = [
  ["internal", "server", "dist"],
  ["cmd", "oxi", "resource.syso"],
];
function isIgnored(fullPath) {
  const parts = fullPath.split(/[\\/]/);
  return IGNORE_SEGMENTS.some(seg => {
    for (let i = 0; i <= parts.length - seg.length; i++) {
      if (seg.every((s, j) => parts[i + j] === s)) return true;
    }
    return false;
  });
}

let appProc   = null;
let building  = false;
let rebuildQueued = false;
let debounceTimer = null;

function killApp() {
  if (appProc && !appProc.killed) {
    try { appProc.kill(); } catch {}
  }
  appProc = null;
}

function launch() {
  killApp();
  if (!fs.existsSync(BINARY)) return;
  log(`[oxis dev] launching ${path.relative(ROOT, BINARY)}...`, col.cyan);
  appProc = spawn(BINARY, [], { cwd: ROOT, stdio: "inherit" });
  appProc.on("exit", (code) => {
    if (appProc && code !== null && code !== 0) {
      log(`[oxis dev] window exited with code ${code}`, col.red);
    }
  });
}

function build() {
  if (building) { rebuildQueued = true; return; }
  building = true;
  log("\n[oxis dev] rebuilding...", col.magenta);
  const r = spawnSync("node", [path.join(ROOT, "scripts", "build-go.js")], {
    cwd: ROOT, shell: true, stdio: "inherit",
  });
  building = false;
  if (r.status === 0) {
    launch();
  } else {
    log("[oxis dev] build failed — fix the error above, saving will retry", col.red);
  }
  if (rebuildQueued) { rebuildQueued = false; build(); }
}

function scheduleRebuild(changedPath) {
  if (changedPath && isIgnored(changedPath)) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(build, 300);
}

log("\x1b[35m[oxis dev]\x1b[0m Watching for changes (frontend/src, cmd/, internal/)...\n");

for (const dir of WATCH_DIRS) {
  if (!fs.existsSync(dir)) continue;
  const onEvent = (_eventType, filename) => {
    scheduleRebuild(filename ? path.join(dir, filename) : dir);
  };
  try {
    fs.watch(dir, { recursive: true }, onEvent);
  } catch {
    // Recursive watch isn't supported on some platforms (older Linux
    // kernels) — fall back to watching just the top-level directory.
    fs.watch(dir, onEvent);
  }
}

process.on("SIGINT", () => { killApp(); process.exit(0); });

// Initial build + launch
build();
