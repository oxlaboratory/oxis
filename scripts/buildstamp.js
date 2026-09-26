#!/usr/bin/env node
/**
 * scripts/buildstamp.js — what a build records about itself: version,
 * commit, nearest release tag, build number and dates.
 *
 * build-go.js and build-linux.sh stamp the Go binary with it
 * (internal/buildinfo) and frontend/vite.config.ts bakes the same
 * values into the page, so 'version and 'update agree with the binary.
 *
 *   node scripts/buildstamp.js            the stamp as JSON
 *   node scripts/buildstamp.js --ldflags  -X flags for `go build`
 *
 * OXIS_BUILD_STAMP (JSON from a previous call) is reused as is, so one
 * build computes it once. OXIS_CHANNEL names where the build comes from
 * (CI sets "latest-build"); anything else built from git is "source".
 */

const { spawnSync } = require("child_process");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const GO_PKG = "github.com/oxis/oxis/internal/buildinfo";

function git(args) {
  const r = spawnSync("git", args, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

const count = s => (/^\d+$/.test(s) ? Number(s) : 0);

function compute() {
  const version = require(path.join(ROOT, "package.json")).version;
  const commit = git(["rev-parse", "HEAD"]);
  // A shallow clone has no history to count or describe from.
  const history = commit !== "" && git(["rev-parse", "--is-shallow-repository"]) !== "true";
  const tag = history ? git(["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"]) : "";
  return {
    version,
    commit,
    tag,
    commitsSinceTag: tag ? count(git(["rev-list", "--count", `${tag}..HEAD`])) : 0,
    buildNumber: history ? count(git(["rev-list", "--count", "HEAD"])) : 0,
    dirty: commit !== "" && git(["status", "--porcelain", "--untracked-files=no"]) !== "",
    commitDate: commit ? git(["show", "-s", "--format=%cI", "HEAD"]) : "",
    buildDate: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    channel: process.env.OXIS_CHANNEL || (commit ? "source" : "unknown"),
  };
}

function stamp() {
  if (process.env.OXIS_BUILD_STAMP) {
    try { return JSON.parse(process.env.OXIS_BUILD_STAMP); } catch { /* recompute */ }
  }
  return compute();
}

/** -X flags for go build. None of the values contain spaces or quotes. */
function ldflags(s) {
  const vars = {
    Version: s.version,
    Commit: s.commit,
    Tag: s.tag,
    BuildNumber: String(s.buildNumber),
    Dirty: s.dirty ? "true" : "",
    CommitDate: s.commitDate,
    BuildDate: s.buildDate,
    Channel: s.channel,
  };
  return Object.entries(vars)
    .filter(([, v]) => /^[\w.:+\-]+$/.test(v))
    .map(([k, v]) => `-X ${GO_PKG}.${k}=${v}`)
    .join(" ");
}

module.exports = { stamp, ldflags };

if (require.main === module) {
  const s = stamp();
  process.stdout.write(process.argv.includes("--ldflags") ? ldflags(s) : JSON.stringify(s));
}
