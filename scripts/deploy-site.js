#!/usr/bin/env node
/**
 * scripts/deploy-site.js — deploys cloudflare/ (the website and the
 * Market) to Cloudflare Pages with wrangler.
 *
 * Only the public files are uploaded as static assets: index.html,
 * 404.html, _headers, index.json, assets/ and plugins/. functions/ (the private
 * Market backend, not in git) is compiled into the Pages Functions
 * worker. premium-source/, .dev.vars and wrangler.toml are never
 * uploaded, and no wrangler.toml is used, so the secrets and bindings
 * set in the Cloudflare dashboard stay as they are.
 *
 *   npx wrangler login          once (or set CLOUDFLARE_API_TOKEN)
 *   npm run deploy:site
 *
 *   --dry-run            stage and compile, but don't upload
 *   OXIS_PAGES_BRANCH    branch to deploy as (default: main, production)
 */

const { spawnSync } = require("child_process");
const fs   = require("fs");
const os   = require("os");
const path = require("path");

const ROOT   = path.resolve(__dirname, "..");
const SITE   = path.join(ROOT, "cloudflare");
const PUBLIC = ["index.html", "404.html", "_headers", "index.json", "assets", "plugins"];
const DRY    = process.argv.includes("--dry-run");
const BRANCH = process.env.OXIS_PAGES_BRANCH || "main";

const fail = m => { console.error(`\nERROR: ${m}\n`); process.exit(1); };

// The project name lives in wrangler.toml; it's only read, not used as
// a config file (see above).
const toml = fs.readFileSync(path.join(SITE, "wrangler.toml"), "utf8");
const PROJECT = (/^name\s*=\s*"([^"]+)"/m.exec(toml) || [])[1] || fail("no name in cloudflare/wrangler.toml");

if (!fs.existsSync(path.join(SITE, "functions"))) {
  fail("cloudflare/functions/ is missing. It holds the Market backend (checkout, licenses, publishing) and\n" +
       "isn't in git; deploying without it would take those endpoints offline.");
}

const git = args => {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
};

function wrangler(args, cwd) {
  // One command string: wrangler is a .cmd shim on Windows, which needs a shell.
  const local = spawnSync("wrangler --version", { shell: true, stdio: "ignore" }).status === 0;
  const line = [local ? "wrangler" : "npx --yes wrangler", ...args.map(a => (/[\s"&|<>^]/.test(a) ? `"${a}"` : a))].join(" ");
  // The stage is outside the repository; stop git (which wrangler runs)
  // from finding an enclosing repository above it.
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(cwd) };
  return spawnSync(line, { cwd, env, stdio: "inherit", shell: true }).status === 0;
}

// Stage: <tmp>/public (assets) + <tmp>/functions (compiled by wrangler).
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "oxis-site-"));
// Runs on every exit, including fail()'s.
process.on("exit", () => fs.rmSync(stage, { recursive: true, force: true }));
{
  for (const entry of PUBLIC) {
    const src = path.join(SITE, entry);
    if (!fs.existsSync(src)) fail(`cloudflare/${entry} is missing`);
    fs.cpSync(src, path.join(stage, "public", entry), { recursive: true });
  }
  fs.cpSync(path.join(SITE, "functions"), path.join(stage, "functions"), { recursive: true });

  console.log(`→ ${PROJECT}: ${PUBLIC.join(", ")} + functions/ (branch ${BRANCH})`);
  if (!wrangler(["pages", "functions", "build", "--outdir", path.join(stage, ".fn-check")], stage)) {
    fail("the Pages Functions don't compile (see above); nothing was deployed");
  }
  if (DRY) {
    console.log("✓ dry run: staged and compiled, nothing uploaded");
  } else {
    const sha = git(["rev-parse", "HEAD"]);
    const args = ["pages", "deploy", "public", "--project-name", PROJECT, "--branch", BRANCH];
    if (sha) {
      args.push("--commit-hash", sha, "--commit-message", (git(["log", "-1", "--format=%s"]) || "deploy").replace(/"/g, "'"));
      args.push(`--commit-dirty=${git(["status", "--porcelain", "--untracked-files=no", "--", "cloudflare"]) !== ""}`);
    }
    if (!wrangler(args, stage)) {
      fail("wrangler couldn't deploy. If it says you're not logged in, run `npx wrangler login` and try again.");
    }
    console.log(`\n✓ deployed — https://${PROJECT}.pages.dev  (backend check: https://${PROJECT}.pages.dev/health)`);
  }
}
