#!/usr/bin/env node
/**
 * scripts/build-go.js — full OXIS build (frontend + Go binary).
 * Requires Node >= 24 and Go >= 1.22. On Linux also GTK3 and WebKitGTK
 * development packages (see build-linux.sh).
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

const ROOT     = path.resolve(__dirname, "..");
const FRONTEND = path.join(ROOT, "frontend");

if (!fs.existsSync(path.join(ROOT, "go.mod"))) {
  console.error("\nERROR: run this from the project root, not from frontend/\n");
  console.error("  cd " + ROOT);
  console.error("  npm run build\n");
  process.exit(1);
}
const EMBED_DIST = path.join(ROOT, "internal", "server", "dist");
const OUT        = path.join(ROOT, "dist");
const IS_WIN     = process.platform === "win32";
const IS_LINUX   = process.platform === "linux";
const VERSION    = require(path.join(ROOT, "package.json")).version;

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

log(`\n→ OXIS ${VERSION} build`, col.magenta);

const GO = process.env.GO_BIN || findGo();
if (!GO) {
  log("\nERROR: Go not found.", col.red);
  log("  Install Go 1.22+: https://go.dev/dl/", col.cyan);
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
run(`"${GO}" mod download`, ROOT, { PATH:augmentedPath });
ok("go modules ready");

// ── Step 4: Windows icon embedding ───────────────────────────
if (IS_WIN) {
  step(4, "Embedding icon into .exe (goversioninfo)...");
  if (fs.existsSync(path.join(ROOT, "cmd", "oxi", "oxis.ico"))) {
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

// Version and BuildCommit feed 'update (internal/update). Without
// BuildCommit a build never reports an available update.
const buildCommit = (() => {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd:ROOT, stdio:"pipe" });
  return r.status === 0 ? r.stdout.toString().trim() : "";
})();
const xflags  = `-X github.com/oxis/oxis/internal/wailsapp.Version=${VERSION} -X github.com/oxis/oxis/internal/update.BuildCommit=${buildCommit}`;
const ldflags = IS_WIN ? `"-s -w -H windowsgui ${xflags}"` : `"-s -w ${xflags}"`;

// Wails needs the "desktop" tag or the binary refuses to start;
// "production" drops dev-mode logging. Ubuntu 24.04+ only ships
// WebKitGTK 4.1, which also needs webkit2_41.
const tags = ["desktop", "production"];
const hasWebkit41 = IS_LINUX && spawnSync("pkg-config", ["--exists", "webkit2gtk-4.1"], { stdio:"pipe" }).status === 0;
if (hasWebkit41) tags.push("webkit2_41");
run(`"${GO}" build -tags ${tags.join(",")} -ldflags=${ldflags} -o "${outBinary}" ./cmd/oxi`, ROOT, { PATH:augmentedPath });

const sizeMB = (fs.statSync(outBinary).size / 1024 / 1024).toFixed(1);
ok(`dist/${binaryName} (${sizeMB} MB)`);

// ── Step 6: Copy icon alongside binary ────────────────────────
const logoSrc = path.join(FRONTEND, "public", "logo.png");
if (fs.existsSync(logoSrc)) {
  fs.copyFileSync(logoSrc, path.join(OUT, "logo.png"));
  ok("dist/logo.png");
}

// ── Step 7: .deb + portable tarball (Linux) ───────────────────
if (IS_LINUX) {
  const hasDpkg = spawnSync("dpkg-deb", ["--version"], {shell:true, stdio:"pipe"}).status === 0;
  if (hasDpkg) {
    step(5, "Building .deb package...");
    const debStage = path.join(OUT, "deb", `oxis_${VERSION}_amd64`);
    fs.rmSync(debStage, { recursive:true, force:true });
    const usrBin   = path.join(debStage, "usr", "bin");
    const debDir   = path.join(debStage, "DEBIAN");
    const appsDir  = path.join(debStage, "usr", "share", "applications");
    const iconsDir = path.join(debStage, "usr", "share", "icons", "hicolor", "256x256", "apps");
    [usrBin, debDir, appsDir, iconsDir].forEach(d => fs.mkdirSync(d, { recursive:true }));

    fs.copyFileSync(outBinary, path.join(usrBin, "oxis"));
    fs.chmodSync(path.join(usrBin, "oxis"), 0o755);
    if (fs.existsSync(logoSrc)) fs.copyFileSync(logoSrc, path.join(iconsDir, "oxis.png"));
    try { fs.symlinkSync("/usr/bin/oxis", path.join(usrBin, "oxi")); } catch { /* already there */ }

    fs.writeFileSync(path.join(debDir, "control"),
`Package: oxis
Version: ${VERSION}
Section: utils
Priority: optional
Architecture: amd64
Depends: libgtk-3-0, ${hasWebkit41 ? "libwebkit2gtk-4.1-0" : "libwebkit2gtk-4.0-37"}
Maintainer: OXIS <noreply@oxlaboratory.dev>
Homepage: https://github.com/oxlaboratory/oxis
Description: OXIS — Open Xenial Intelligent Shell
 A native desktop terminal with Lua plugins, workspaces and a
 built-in editor.
`);
    fs.writeFileSync(path.join(appsDir, "oxis.desktop"),
`[Desktop Entry]
Name=OXIS
Comment=Open Xenial Intelligent Shell
Exec=/usr/bin/oxis
Icon=oxis
Terminal=false
Type=Application
Categories=System;TerminalEmulator;
StartupWMClass=oxis
`);
    // /usr/bin isn't user-writable, so data goes to ~/Downloads/OXIS
    // (AppDirPath in internal/wailsapp/app.go).
    const postinst = path.join(debDir, "postinst");
    fs.writeFileSync(postinst, [
      "#!/bin/sh",
      "update-desktop-database /usr/share/applications 2>/dev/null || true",
      "gtk-update-icon-cache /usr/share/icons/hicolor 2>/dev/null || true",
      "echo",
      "echo 'OXIS installed to /usr/bin/oxis.'",
      "echo 'Workspaces, plugins and documents are stored in ~/Downloads/OXIS.'",
      "echo",
      "exit 0",
      "",
    ].join("\n"));
    fs.chmodSync(postinst, 0o755);

    const debFile = path.join(OUT, "deb", `oxis_${VERSION}_amd64.deb`);
    run(`dpkg-deb --build --root-owner-group "${debStage}" "${debFile}"`, ROOT);
    ok(`dist/deb/oxis_${VERSION}_amd64.deb`);

    // Portable tarball: extract and run, data stays next to the binary.
    const portableDir = path.join(OUT, "oxis-portable");
    fs.rmSync(portableDir, { recursive: true, force: true });
    ["workspaces", "created-plugins", "created-documents"].forEach(d =>
      fs.mkdirSync(path.join(portableDir, d), { recursive: true }));
    fs.copyFileSync(outBinary, path.join(portableDir, "oxis"));
    fs.chmodSync(path.join(portableDir, "oxis"), 0o755);
    const tarballName = `oxis-${VERSION}-linux-portable.tar.gz`;
    run(`tar -czf "${tarballName}" -C "${OUT}" oxis-portable`, OUT);
    fs.rmSync(portableDir, { recursive: true, force: true });
    ok(`dist/${tarballName}`);
  } else {
    log("   (skipping .deb — dpkg-deb not found)", col.grey);
  }
}

// The Windows installer is a separate step: npm run build:msi

log("\n✓ Build complete", col.magenta);
log(`  Binary:  dist/${binaryName} (${sizeMB} MB)`, col.green);
log(`  Run:     ${IS_WIN ? ".\\dist\\oxis.exe" : "./dist/oxis"}`, col.cyan);
log("");
