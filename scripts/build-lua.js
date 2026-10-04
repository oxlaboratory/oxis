#!/usr/bin/env node
/**
 * scripts/build-lua.js — builds internal/luanative/lua54.dll from the
 * Lua sources in third_party/lua (Windows only).
 *
 * On Windows OXIS runs plugins on this DLL rather than on a copy of Lua
 * compiled into oxis.exe: Lua C modules (luafilesystem, luasocket, any
 * LuaRocks package with C code) are built against lua54.dll, and they
 * only work if they find the same Lua that runs the plugin. oxis.exe
 * carries the DLL (go:embed) and writes it out on first use, so it's
 * still one file to download.
 *
 *   node scripts/build-lua.js          build it with gcc (MinGW-w64)
 *   node scripts/build-lua.js --find   print the gcc it would use
 *
 * The DLL is checked in, so a normal build doesn't need this; run it
 * after updating third_party/lua.
 */

const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "third_party", "lua", "src");
const OUT = path.join(ROOT, "internal", "luanative", "lua54.dll");

/** gcc on PATH, or a MinGW-w64 one where the usual installers put it. */
function findGcc() {
  const candidates = [
    "gcc",
    "C:\\msys64\\mingw64\\bin\\gcc.exe",
    "C:\\msys64\\ucrt64\\bin\\gcc.exe",
    "C:\\mingw64\\bin\\gcc.exe",
    "C:\\ProgramData\\mingw64\\mingw64\\bin\\gcc.exe",
    "C:\\TDM-GCC-64\\bin\\gcc.exe",
  ];
  for (const c of candidates) {
    const r = spawnSync(c, ["--version"], { stdio: "pipe" });
    if (r.status === 0 && !r.error) return c;
  }
  return null;
}

module.exports = { findGcc };

if (require.main === module) {
  const gcc = findGcc();
  if (process.argv.includes("--find")) {
    console.log(gcc || "");
    process.exit(gcc ? 0 : 1);
  }
  if (process.platform !== "win32") {
    console.error("lua54.dll is for Windows; on Linux Lua is compiled into the binary.");
    process.exit(1);
  }
  if (!gcc) {
    console.error("gcc not found: install MinGW-w64 (MSYS2: pacman -S mingw-w64-x86_64-gcc).");
    process.exit(1);
  }
  const sources = fs.readdirSync(SRC).filter(f => f.endsWith(".c")).sort().map(f => path.join(SRC, f));
  // LUA_BUILD_AS_DLL exports the API; -static-libgcc keeps the DLL free
  // of a libgcc DLL of its own; -s strips it; the fixed image base and
  // no timestamp make the same sources give the same bytes.
  const args = [
    "-O2", "-std=gnu99", "-shared", "-s", "-static-libgcc",
    "-DLUA_BUILD_AS_DLL", "-DLUA_COMPAT_5_3",
    "-Wl,--no-insert-timestamp", "-Wl,--image-base,0x63c00000",
    "-o", OUT, ...sources,
  ];
  // gcc runs its helpers (cc1, as, ld) from its own folder, which needs
  // to be on PATH for their DLLs.
  const env = { ...process.env, PATH: path.dirname(gcc) + path.delimiter + (process.env.PATH || "") };
  const r = spawnSync(gcc, args, { stdio: "inherit", env });
  if (r.status !== 0) process.exit(r.status || 1);
  console.log(`✓ ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB) with ${gcc}`);
}
