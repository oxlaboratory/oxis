#!/usr/bin/env node
/**
 * scripts/setup.js — OxiShell one-command setup
 * Usage: npm run setup
 */
const { spawnSync } = require("child_process");
const path = require("path");
const fs   = require("fs");
const os   = require("os");

const ROOT   = path.resolve(__dirname, "..");
const IS_WIN = process.platform === "win32";
const col    = { cyan:"\x1b[36m", green:"\x1b[32m", red:"\x1b[31m", grey:"\x1b[90m", yellow:"\x1b[33m", magenta:"\x1b[35m", reset:"\x1b[0m" };
const log    = (m, c=col.reset) => console.log(c+m+col.reset);
const ok     = m => log(`   ✓  ${m}`, col.green);
const warn   = m => log(`   ⚠  ${m}`, col.yellow);
const err    = m => log(`   ✗  ${m}`, col.red);
const step   = (n,m) => log(`\n→ [${n}] ${m}`, col.cyan);

function run(cmd, cwd=ROOT) {
  const r = spawnSync(cmd, { cwd, shell: true, stdio: "inherit" });
  return r.status === 0;
}

function check(cmd) {
  const r = spawnSync(cmd, { shell: true, stdio: "pipe", timeout: 5000 });
  return !r.error && r.status === 0;
}

function findGo() {
  const candidates = [
    "go",
    "/usr/local/go/bin/go",
    "/opt/homebrew/bin/go",
    "C:\\Program Files\\Go\\bin\\go.exe",
  ];
  for (const c of candidates) {
    const r = spawnSync(c, ["version"], { shell: false, stdio: "pipe", timeout: 3000 });
    if (!r.error && r.status === 0) return { bin: c, ver: r.stdout?.toString().trim() };
  }
  return null;
}

// ── Header ──────────────────────────────────────────────────
log("\n╔══════════════════════════════════════╗", col.magenta);
log("║  OXIS Setup                      ║", col.magenta);
log("╚══════════════════════════════════════╝", col.magenta);
log(`\n  Platform: ${process.platform} (${os.arch()})`);
log(`  Node:     ${process.version}`);
log(`  Root:     ${ROOT}\n`);

let allGood = true;

// ── Step 1: Node version ──────────────────────────────────
step(1, "Checking Node.js version...");
const [major] = process.versions.node.split(".").map(Number);
if (major < 24) {
  err(`Node 24+ required (got ${process.version})`);
  err("Download: https://nodejs.org");
  allGood = false;
} else {
  ok(`Node ${process.version}`);
}

// ── Step 2: Go ────────────────────────────────────────────
step(2, "Checking Go...");
const goResult = findGo();
if (!goResult) {
  err("Go not found. Install from: https://go.dev/dl/");
  allGood = false;
} else {
  ok(goResult.ver);
}

// ── Step 3: npm install ───────────────────────────────────
step(3, "Installing npm dependencies...");
if (!run("npm install", ROOT)) {
  err("npm install failed");
  allGood = false;
} else {
  ok("Root dependencies installed");
}

step(3, "Installing frontend dependencies...");
const frontendDir = path.join(ROOT, "frontend");
if (!run("npm install", frontendDir)) {
  err("Frontend npm install failed");
  allGood = false;
} else {
  ok("Frontend dependencies installed");
}

// ── Step 4: Go modules ───────────────────────────────────
step(4, "Fetching Go modules...");
if (goResult) {
  const goSum = path.join(ROOT, "go.sum");
  if (fs.existsSync(goSum)) fs.rmSync(goSum);
  if (!run(`"${goResult.bin}" mod tidy`, ROOT)) {
    err("go mod tidy failed");
    allGood = false;
  } else {
    ok("Go modules ready");
  }
}

// ── Step 5: Windows-specific checks ──────────────────────
if (IS_WIN) {
  step(5, "Checking Windows build tools...");

  // NSIS
  const nsisLocations = [
    "makensis",
    "C:\\Program Files (x86)\\NSIS\\makensis.exe",
    "C:\\Program Files\\NSIS\\makensis.exe",
  ];
  let nsisFound = false;
  for (const loc of nsisLocations) {
    try { if (fs.existsSync(loc) || check(`"${loc}" /VERSION`)) { ok(`NSIS: ${loc}`); nsisFound = true; break; } } catch {}
  }
  if (!nsisFound) {
    warn("NSIS not found — installer build won't work");
    warn("Install: winget install NSIS.NSIS");
  }

  // WiX
  const wixFound = check("candle --version") ||
    fs.existsSync("C:\\Program Files (x86)\\WiX Toolset v3.11\\bin\\candle.exe");
  if (wixFound) ok("WiX Toolset found");
  else warn("WiX not found (optional) — winget install WiXToolset.WiXToolset");
}

// ── Summary ───────────────────────────────────────────────
log("\n" + "─".repeat(44));
if (allGood) {
  log("\n  ✓  Setup complete! You can now run:\n", col.green);
  log("     npm run build          ← build the app", col.cyan);
  log("     npm run build:msi      ← build installer (Windows)", col.cyan);
  log("     .\\dist\\oxis.exe    ← run OxiShell\n", col.cyan);
} else {
  log("\n  ⚠  Setup completed with warnings.", col.yellow);
  log("     Fix the issues above, then run npm run setup again.\n", col.yellow);
}
