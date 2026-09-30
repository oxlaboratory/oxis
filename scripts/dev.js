#!/usr/bin/env node
/**
 * scripts/dev.js — the dev loop: the real OXIS window with its UI served
 * by Vite, so a change under frontend/src shows up at once (hot module
 * reload) while the shells keep running. Go changes (cmd/, internal/)
 * rebuild and relaunch the window; its tabs come back as they were.
 *
 * It builds a Wails dev binary (dist/oxis-dev, tags desktop,dev) and
 * starts it with -frontenddevserverurl pointing at Vite. The window
 * has its own profile, so it doesn't share settings or sessions with an
 * installed OXIS, and F12 opens the developer tools.
 */
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs   = require("fs");
const os   = require("os");
const net  = require("net");

const ROOT     = path.resolve(__dirname, "..");
const FRONTEND = path.join(ROOT, "frontend");
const IS_WIN   = process.platform === "win32";
const IS_LINUX = process.platform === "linux";
const OUT      = path.join(ROOT, "dist");
const BINARY   = path.join(OUT, IS_WIN ? "oxis-dev.exe" : "oxis-dev");
const NEXT     = path.join(OUT, IS_WIN ? "oxis-dev.next.exe" : "oxis-dev.next");
const EMBED    = path.join(ROOT, "internal", "server", "dist");
const VITE_PORT = 5173;
// Wails' own dev server (the app's bindings for a browser); required
// alongside the frontend dev server.
const WAILS_DEV = "127.0.0.1:34115";

const col = { reset:"\x1b[0m", magenta:"\x1b[35m", cyan:"\x1b[36m", red:"\x1b[31m", green:"\x1b[32m", grey:"\x1b[90m" };
const log = (m, c = col.reset) => console.log(`${col.magenta}[oxis dev]${col.reset} ${c}${m}${col.reset}`);

function findGo() {
  const candidates = [
    process.env.GO_BIN, "go", "/usr/local/go/bin/go", "/opt/homebrew/bin/go", "/usr/local/bin/go", "/snap/bin/go",
    "C:\\Program Files\\Go\\bin\\go.exe", "C:\\Go\\bin\\go.exe",
    path.join(os.homedir(), "scoop", "apps", "go", "current", "bin", "go.exe"),
  ].filter(Boolean);
  for (const c of candidates) {
    const r = spawnSync(c, ["version"], { stdio: "pipe" });
    if (r.status === 0 && !r.error) return c;
  }
  return null;
}
const GO = findGo();
if (!GO) { log("Go not found — install Go 1.22+ (https://go.dev/dl/) or set GO_BIN", col.red); process.exit(1); }
const env = { ...process.env, PATH: `${path.dirname(GO)}${IS_WIN ? ";" : ":"}${process.env.PATH ?? ""}` };

function run(cmd, args, cwd) {
  return spawnSync(cmd, args, { cwd, stdio: "inherit", env, shell: IS_WIN && cmd === "npm" }).status === 0;
}

// ── First run: dependencies, and a build to embed ──────────────
if (!fs.existsSync(path.join(FRONTEND, "node_modules"))) {
  log("installing frontend dependencies…");
  if (!run("npm", ["install"], FRONTEND)) process.exit(1);
}
// The Go server embeds internal/server/dist (go:embed), which must exist
// even though the window loads its UI from Vite.
if (!fs.existsSync(path.join(EMBED, "index.html"))) {
  log("building the frontend once for the Go embed…");
  if (!run(process.execPath, [path.join(FRONTEND, "node_modules", "vite", "bin", "vite.js"), "build", "--logLevel", "warn"], FRONTEND)) process.exit(1);
  fs.cpSync(path.join(FRONTEND, "dist"), EMBED, { recursive: true });
}

// ── Vite ───────────────────────────────────────────────────────
const vite = spawn(process.execPath, [path.join(FRONTEND, "node_modules", "vite", "bin", "vite.js"), "--port", String(VITE_PORT), "--strictPort"], {
  cwd: FRONTEND, stdio: ["ignore", "inherit", "inherit"], env,
});
vite.on("exit", code => { log(`vite stopped (${code})`, col.red); shutdown(1); });

// ── The Go binary ──────────────────────────────────────────────
const { stamp, ldflags } = require("./buildstamp");
function buildGo() {
  const tags = ["desktop", "dev"];
  if (IS_LINUX && spawnSync("pkg-config", ["--exists", "webkit2gtk-4.1"], { stdio: "pipe" }).status === 0) tags.push("webkit2_41");
  fs.mkdirSync(OUT, { recursive: true });
  const started = Date.now();
  const r = spawnSync(GO, ["build", "-tags", tags.join(","), `-ldflags=${ldflags({ ...stamp(), channel: "dev" })}`, "-o", NEXT, "./cmd/oxi"], { cwd: ROOT, stdio: "inherit", env });
  if (r.status !== 0) { log("Go build failed — fix the error above; saving a .go file retries", col.red); return false; }
  log(`Go built in ${((Date.now() - started) / 1000).toFixed(1)}s`, col.grey);
  return true;
}

let app = null;
function stopApp() {
  if (!app) return;
  const p = app;
  app = null;
  try { IS_WIN ? spawnSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" }) : p.kill(); } catch { /* already gone */ }
}
function launch() {
  stopApp();
  // Windows won't replace a running exe, so the build goes to NEXT and
  // is moved into place once the old window is gone.
  for (let i = 0; i < 20; i++) {
    try { fs.renameSync(NEXT, BINARY); break; } catch { spawnSync(process.execPath, ["-e", "setTimeout(()=>{},150)"]); }
  }
  log("starting the window…", col.cyan);
  app = spawn(BINARY, ["-frontenddevserverurl", `http://localhost:${VITE_PORT}`, "-devserver", WAILS_DEV, "-loglevel", "Warning"], {
    cwd: ROOT, stdio: "inherit", env,
  });
  const me = app;
  app.on("exit", code => {
    if (app !== me) return; // replaced by a rebuild
    app = null;
    log(`window closed${code ? ` (exit ${code})` : ""} — Ctrl+C to stop, or save a .go file to reopen`, col.grey);
  });
}

// ── Watching Go ────────────────────────────────────────────────
let timer = null, building = false, again = false;
function rebuild() {
  if (building) { again = true; return; }
  building = true;
  log("Go changed — rebuilding…", col.cyan);
  if (buildGo()) launch();
  building = false;
  if (again) { again = false; rebuild(); }
}
function onChange(dir) {
  return (_event, file) => {
    if (!file) return;
    const f = String(file);
    if (!/\.go$|(^|[\\/])go\.(mod|sum)$/.test(f) || /[\\/]server[\\/]dist[\\/]/.test(path.join(dir, f))) return;
    clearTimeout(timer);
    timer = setTimeout(rebuild, 300);
  };
}
for (const dir of [path.join(ROOT, "cmd"), path.join(ROOT, "internal")]) {
  try { fs.watch(dir, { recursive: true }, onChange(dir)); }
  catch { fs.watch(dir, onChange(dir)); } // no recursive watch (older Linux)
}
fs.watch(ROOT, onChange(ROOT)); // go.mod, go.sum

function shutdown(code = 0) {
  stopApp();
  try { vite.kill(); } catch { /* gone */ }
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// ── Start ──────────────────────────────────────────────────────
function waitForPort(port, ms) {
  const until = Date.now() + ms;
  return new Promise(resolve => {
    const tryOnce = () => {
      const s = net.connect(port, "localhost", () => { s.destroy(); resolve(true); });
      s.on("error", () => { s.destroy(); Date.now() > until ? resolve(false) : setTimeout(tryOnce, 200); });
    };
    tryOnce();
  });
}

log("building the Go side…", col.cyan);
if (!buildGo()) shutdown(1);
waitForPort(VITE_PORT, 30_000).then(up => {
  if (!up) { log(`Vite didn't start on port ${VITE_PORT}`, col.red); shutdown(1); }
  launch();
  log(`ready — edit frontend/src and the window updates in place; Go changes rebuild it. Ctrl+C stops.`, col.green);
});
