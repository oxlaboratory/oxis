#!/usr/bin/env node
/**
 * oxis — npm launcher. Downloads the prebuilt binary for this platform
 * from the GitHub "latest-build" release on first run, caches it in
 * ~/.oxis/bin and runs it.
 */
const { spawn } = require("child_process");
const path  = require("path");
const fs    = require("fs");
const os    = require("os");
const https = require("https");

const RELEASE_BASE = "https://github.com/oxlaboratory/oxis/releases/download/latest-build";

// Only x64 Windows and Linux builds are published.
const ASSETS = {
  "win32-x64": "oxis.exe",
  "linux-x64": "oxis",
};

const key = `${process.platform}-${process.arch}`;
const assetName = ASSETS[key];
if (!assetName) {
  console.error(`[oxis] no prebuilt binary for ${key}. Build from source: https://github.com/oxlaboratory/oxis`);
  process.exit(1);
}

const cacheDir = path.join(os.homedir(), ".oxis", "bin");
const binPath  = path.join(cacheDir, assetName);
const url      = `${RELEASE_BASE}/${assetName}`;

function runBinary() {
  const child = spawn(binPath, process.argv.slice(2), { stdio: "inherit" });
  child.on("exit", code => process.exit(code ?? 0));
}

function download(from, to, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(from, { headers: { "User-Agent": "oxis-npm" } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects > 5) return reject(new Error("too many redirects"));
        return resolve(download(res.headers.location, to, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const file = fs.createWriteStream(to);
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
      file.on("error", reject);
    }).on("error", reject);
  });
}

if (fs.existsSync(binPath)) {
  runBinary();
} else {
  fs.mkdirSync(cacheDir, { recursive: true });
  const tmp = `${binPath}.download`;
  console.log(`[oxis] downloading ${url}`);
  download(url, tmp)
    .then(() => {
      if (fs.statSync(tmp).size < 1_000_000) throw new Error("download is too small to be a real build");
      fs.renameSync(tmp, binPath);
      if (process.platform !== "win32") fs.chmodSync(binPath, 0o755);
      runBinary();
    })
    .catch(err => {
      fs.rmSync(tmp, { force: true });
      console.error(`[oxis] download failed: ${err.message}`);
      console.error("       get a build from https://github.com/oxlaboratory/oxis/releases");
      process.exit(1);
    });
}
