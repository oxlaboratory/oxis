#!/usr/bin/env node
/**
 * scripts/build-go.js — OxiShell full build
 * Requires Node >= 24.0.0 and Go >= 1.21
 */

const { spawnSync } = require("child_process");
const path          = require("path");
const fs            = require("fs");
const os            = require("os");

const [nodeMajor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 24) {
  console.error(`\n  ERROR: Node >= 24.0.0 required (got ${process.version})\n  https://nodejs.org\n`);
  process.exit(1);
}

const ROOT       = path.resolve(__dirname, "..");
const FRONTEND   = path.join(ROOT, "frontend");

// Guard: make sure we are running from the project root, not from frontend/
if (!fs.existsSync(path.join(ROOT, "go.mod"))) {
  console.error("\nERROR: Run this from the project root (oxi-go-fixed/), not from frontend/\n");
  console.error("  cd " + ROOT);
  console.error("  npm run build\n");
  process.exit(1);
}
const EMBED_DIST = path.join(ROOT, "internal", "server", "dist");
const OUT        = path.join(ROOT, "dist");
const IS_WIN     = process.platform === "win32";
const VERSION    = "1.2.1";

const col = {
  reset:"\x1b[0m", magenta:"\x1b[35m", cyan:"\x1b[36m",
  green:"\x1b[32m", red:"\x1b[31m", grey:"\x1b[90m",
};
const log  = (m, c=col.reset) => console.log(c+m+col.reset);
const step = (n,m) => log(`\n→ [${n}] ${m}`, col.cyan);
const ok   = m => log(`   ✓ ${m}`, col.green);
const fail = m => { log(`\nERROR: ${m}`, col.red); process.exit(1); };

function run(cmd, cwd=ROOT, extraEnv={}) {
  const r = spawnSync(cmd, { cwd, shell:true, stdio:"inherit", env:{...process.env,...extraEnv} });
  if (r.status !== 0) fail(`Command failed: ${cmd}`);
}

function findGo() {
  const candidates = [
    "go",
    "/usr/local/go/bin/go",
    "/opt/homebrew/bin/go",
    "/usr/local/bin/go",
    "/snap/bin/go",
    path.join(os.homedir(),".local","share","mise","shims","go"),
    path.join(os.homedir(),".asdf","shims","go"),
    "C:\\Program Files\\Go\\bin\\go.exe",
    "C:\\Go\\bin\\go.exe",
    path.join(os.homedir(),"scoop","apps","go","current","bin","go.exe"),
  ];
  for (const c of candidates) {
    const r = spawnSync(c, ["version"], { shell:false, stdio:"pipe" });
    if (r.status === 0 && !r.error) return c;
  }
  return null;
}

function copyDir(src, dest) {
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive:true });
  fs.mkdirSync(dest, { recursive:true });
  for (const e of fs.readdirSync(src, { withFileTypes:true })) {
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    e.isDirectory() ? copyDir(s,d) : fs.copyFileSync(s,d);
  }
}

log("\n╔══════════════════════════════════╗", col.magenta);
log("║  OXIS build                  ║", col.magenta);
log("╚══════════════════════════════════╝", col.magenta);

const GO = process.env.GO_BIN || findGo();
if (!GO) {
  log("\nERROR: Go not found.", col.red);
  log("  Install Go 1.21+: https://go.dev/dl/", col.cyan);
  log("  Then open a new terminal and re-run: npm run build", col.reset);
  process.exit(1);
}

const goDir         = path.dirname(GO);
const pathSep       = IS_WIN ? ";" : ":";
const augmentedPath = `${goDir}${pathSep}${process.env.PATH ?? ""}`;
const goVer         = spawnSync(GO, ["version"], {stdio:"pipe"}).stdout?.toString().trim() ?? "";
const npmVer        = spawnSync("npm", ["--version"], {shell:true, stdio:"pipe"}).stdout.toString().trim();
ok(`Node ${process.version}  npm ${npmVer}  ${goVer}  platform: ${process.platform}`);

// ── Step 1: Frontend ──────────────────────────────────────────
step(1, "Installing frontend dependencies...");
run("npm install", FRONTEND);
ok("node_modules ready");

step(1, "Building frontend (Vite)...");
run("npm run build", FRONTEND);
ok("frontend/dist/ ready");

// ── Step 2: Embed ─────────────────────────────────────────────
step(2, "Embedding frontend into Go server...");
const feDist = path.join(FRONTEND, "dist");
if (!fs.existsSync(feDist)) fail("frontend/dist/ not found");
copyDir(feDist, EMBED_DIST);
ok("internal/server/dist/ ready");

// ── Step 3: Go deps ───────────────────────────────────────────
step(3, "Fetching Go dependencies...");
const goSumPath = path.join(ROOT, "go.sum");
if (fs.existsSync(goSumPath)) { fs.rmSync(goSumPath); log("   (go.sum removed — regenerating)", col.grey); }
run(`"${GO}" mod tidy`, ROOT, { PATH:augmentedPath });
ok("go modules ready");

// ── Step 4: Windows icon embedding ───────────────────────────
if (IS_WIN) {
  step(4, "Embedding icon into .exe (goversioninfo)...");
  const icoSrc  = path.join(ROOT, "cmd", "oxi", "oxis.ico");
  const sysoOut = path.join(ROOT, "cmd", "oxi", "resource.syso");

  // Install goversioninfo if not present
  const gvi = spawnSync(`"${GO}" run github.com/josephspurrier/goversioninfo/cmd/goversioninfo@latest -help`,
    { shell:true, stdio:"pipe", cwd:path.join(ROOT,"cmd","oxi"), env:{...process.env,PATH:augmentedPath} });

  if (fs.existsSync(icoSrc)) {
    const r = spawnSync(
      `"${GO}" run github.com/josephspurrier/goversioninfo/cmd/goversioninfo@latest -icon=oxis.ico -o=resource.syso`,
      { shell:true, stdio:"inherit", cwd:path.join(ROOT,"cmd","oxi"), env:{...process.env,PATH:augmentedPath} }
    );
    if (r.status === 0) ok("resource.syso generated (icon embedded)");
    else log("   (icon embedding skipped — goversioninfo unavailable)", col.grey);
  } else {
    log("   (oxis.ico not found — skipping icon)", col.grey);
  }
}

// ── Step 5: Build binary ──────────────────────────────────────
step(IS_WIN ? 5 : 4, `Compiling Go binary for ${process.platform}...`);
fs.mkdirSync(OUT, { recursive:true });

const binaryName = IS_WIN ? "oxis.exe" : "oxis";
const outBinary  = path.join(OUT, binaryName);
const ldflags    = IS_WIN ? `"-s -w -H windowsgui"` : `"-s -w"`;
// Wails v2 requires the "desktop" build tag (selects its native webview
// bindings) — a plain `go build` without it links, but the resulting
// binary refuses to start and shows an error dialog pointing at `wails
// build`. "production" additionally strips Wails' dev-mode banner and
// asset-server debug logging. See internal/wailsapp/app.go.
run(`"${GO}" build -tags desktop,production -ldflags=${ldflags} -o "${outBinary}" ./cmd/oxi`, ROOT, { PATH:augmentedPath });

const sizeMB = (fs.statSync(outBinary).size / 1024 / 1024).toFixed(1);
ok(`dist/${binaryName} (${sizeMB} MB)`);

// ── Step 6: Copy icon assets alongside binary ─────────────────
const logoSrc = path.join(FRONTEND, "public", "logo.png");
if (fs.existsSync(logoSrc)) {
  fs.copyFileSync(logoSrc, path.join(OUT, "logo.png"));
  ok("dist/logo.png");
}

// ── Step 7: .deb (Linux only) ─────────────────────────────────
if (!IS_WIN) {
  const hasDpkg = spawnSync("dpkg-deb", ["--version"], {shell:true, stdio:"pipe"}).status === 0;
  if (hasDpkg) {
    step(5, "Building .deb package...");
    const debStage = path.join(OUT, "deb", `oxis_${VERSION}_amd64`);
    const usrBin   = path.join(debStage, "usr", "bin");
    const debDir   = path.join(debStage, "DEBIAN");
    const appsDir  = path.join(debStage, "usr", "share", "applications");
    const iconsDir = path.join(debStage, "usr", "share", "icons", "hicolor", "256x256", "apps");
    [usrBin, debDir, appsDir, iconsDir].forEach(d => fs.mkdirSync(d, { recursive:true }));

    fs.copyFileSync(outBinary, path.join(usrBin, "oxis"));
    fs.chmodSync(path.join(usrBin, "oxis"), 0o755);

    // Install icon for Linux
    if (fs.existsSync(logoSrc)) {
      fs.copyFileSync(logoSrc, path.join(iconsDir, "oxis.png"));
    }

    const symlink = path.join(usrBin, "oxi");
    try { if (!fs.existsSync(symlink)) fs.symlinkSync("/usr/bin/oxis", symlink); } catch {}

    fs.writeFileSync(path.join(debDir, "control"),
`Package: oxis
Version: ${VERSION}
Section: utils
Priority: optional
Architecture: amd64
Maintainer: OxiShell <oxis@gitlab.com>
Description: OxiShell terminal
 A Lua-configurable native desktop terminal, built with Wails.
`);
    fs.writeFileSync(path.join(appsDir, "oxis.desktop"),
`[Desktop Entry]
Name=OxiShell
Comment=Lua-configurable native desktop terminal
Exec=/usr/bin/oxis
Icon=oxis
Terminal=false
Type=Application
Categories=System;TerminalEmulator;
`);
    const postinst = path.join(debDir, "postinst");
    fs.writeFileSync(postinst, "#!/bin/sh\nupdate-desktop-database /usr/share/applications 2>/dev/null || true\ngtk-update-icon-cache /usr/share/icons/hicolor 2>/dev/null || true\nexit 0\n");
    fs.chmodSync(postinst, 0o755);

    const debFile = path.join(OUT, `oxis_${VERSION}_amd64.deb`);
    run(`dpkg-deb --build --root-owner-group "${debStage}" "${debFile}"`, ROOT);
    ok(`dist/oxis_${VERSION}_amd64.deb`);
  } else {
    log("   (skipping .deb — dpkg-deb not found)", col.grey);
  }
}

// ── Step 8: Windows installer (bundles full source) ────────────
// Runs automatically as part of `npm run build` on Windows — not a
// separate opt-in step — since the whole point is that building OXIS
// also produces something the user can hand to someone else that
// installs both the app AND the full editable source in one go (see
// scripts/build-msi.js: WiX -> real .msi if available, NSIS .exe as
// a fallback). Non-fatal: if neither WiX nor NSIS is installed, this
// just prints instructions instead of failing the whole build — the
// binary above is already built and usable either way.
if (IS_WIN) {
  step(6, "Building Windows installer (dist/oxis.exe + full source)...");
  const msiScript = path.join(__dirname, "build-msi.js");
  const r = spawnSync("node", [`"${msiScript}"`], { cwd: ROOT, shell: true, stdio: "inherit" });
  if (r.status !== 0) {
    log("   (installer not built — see messages above; binary itself is fine)", col.grey);
    log("   Run manually once WiX or NSIS is installed:  npm run build:msi", col.grey);
  }
}

log("\n╔══════════════════════════════════╗", col.magenta);
log("║  Build complete!                 ║", col.magenta);
log("╚══════════════════════════════════╝", col.magenta);
log(`\n  Binary:  dist/${binaryName} (${sizeMB} MB)`, col.green);
log(`  Run:     ${IS_WIN ? ".\\dist\\oxis.exe" : "./dist/oxis"}`, col.cyan);
log("");