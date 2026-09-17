#!/usr/bin/env node
/**
 * build-msi.js — Windows installer builder (NSIS + WiX)
 * Fixes NSIS detection by checking all known install paths.
 */
const { spawnSync } = require("child_process");
const path = require("path");
const fs   = require("fs");

const ROOT    = path.resolve(__dirname, "..");
const DIST    = path.join(ROOT, "dist");
const EXE     = path.join(DIST, "oxis.exe");
const ICO     = path.join(ROOT, "cmd", "oxi", "oxis.ico");
const VERSION = "1.2.1";
const SRC_DIR_NAME = "source"; // installed to $INSTDIR\source
const SOURCE_ABS = path.join(DIST, SRC_DIR_NAME);
// Every WiX/NSIS-generated file (scripts, intermediate .wixobj, and
// the final installer itself) lives under its own subfolder instead
// of loose in dist/ — see README § dist/ layout. dist/source (the
// bundled project source those installers package up) stays put:
// it's not itself a WiX/NSIS-authored file, just something they read.
const WIX_DIR  = path.join(DIST, "wix");
const NSIS_DIR = path.join(DIST, "nsis");

const col = {
  cyan:"\x1b[36m", green:"\x1b[32m", red:"\x1b[31m",
  grey:"\x1b[90m", magenta:"\x1b[35m", reset:"\x1b[0m"
};
const log  = (m, c=col.reset) => console.log(c+m+col.reset);
const ok   = m => log("   ✓ " + m, col.green);
const info = m => log("   → " + m, col.cyan);
const warn = m => log("   ! " + m, col.grey);
const fail = m => { log("\nERROR: " + m, col.red); process.exit(1); };

// Anything matching these (by path segment) is left out of the bundled
// source — build artifacts, VCS metadata, and anything the end user's
// own `npm install` / `go build` will regenerate anyway.
function shouldSkip(relPath) {
  const base = path.basename(relPath);
  if (base === "node_modules" || base === ".git" || base === "dist") return true;
  if (base === ".DS_Store" || base === "Thumbs.db") return true;
  if (/\.(exe|msi|zip)$/i.test(base)) return true;
  return false;
}

// ── Copy the whole project source into dist/source ─────────
// Ships with the installer so users who install OXIS get the app's
// own source code alongside the binary — see README "Source included"
// for what that's for and how to rebuild from it.
function collectSourceBundle() {
  const target = path.join(DIST, SRC_DIR_NAME);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });

  let fileCount = 0;
  function copyDir(srcDir, dstDir) {
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const srcPath = path.join(srcDir, entry.name);
      const relPath = path.relative(ROOT, srcPath);
      if (shouldSkip(relPath)) continue;
      const dstPath = path.join(dstDir, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(dstPath, { recursive: true });
        copyDir(srcPath, dstPath);
      } else if (entry.isFile()) {
        fs.mkdirSync(path.dirname(dstPath), { recursive: true });
        fs.copyFileSync(srcPath, dstPath);
        fileCount++;
      }
    }
  }
  copyDir(ROOT, target);
  ok(`source bundle: dist/${SRC_DIR_NAME}  (${fileCount} files)`);
  return target;
}

if (!fs.existsSync(EXE)) fail("dist/oxis.exe not found. Run npm run build first.");

log("\n╔══════════════════════════════════╗", col.magenta);
log("║  OXIS Installer Build        ║", col.magenta);
log("╚══════════════════════════════════╝", col.magenta);

// ── Find NSIS ──────────────────────────────────────────────
function findNSIS() {
  const candidates = [
    // PATH
    "makensis",
    "makensis.exe",
    // Standard install locations
    "C:\\Program Files (x86)\\NSIS\\makensis.exe",
    "C:\\Program Files\\NSIS\\makensis.exe",
    // Winget/scoop
    path.join(process.env.LOCALAPPDATA || "", "Programs", "NSIS", "makensis.exe"),
    path.join(process.env.ProgramFiles  || "", "NSIS", "makensis.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "", "NSIS", "makensis.exe"),
  ];
  for (const c of candidates) {
    if (!c) continue;
    // First check if file exists (faster than spawning)
    try { if (fs.existsSync(c)) { ok(`NSIS found: ${c}`); return c; } } catch {}
    // Try running it
    const r = spawnSync(c, ["/VERSION"], { shell: false, stdio: "pipe", timeout: 3000 });
    if (!r.error && r.status === 0) { ok(`NSIS found: ${c}`); return c; }
  }
  return null;
}

// ── Find WiX ──────────────────────────────────────────────
function findWiX() {
  const candidates = [
    "candle.exe",
    "C:\\Program Files (x86)\\WiX Toolset v3.11\\bin\\candle.exe",
    "C:\\Program Files (x86)\\WiX Toolset v3.14\\bin\\candle.exe",
    "C:\\Program Files\\WiX Toolset v3.11\\bin\\candle.exe",
    process.env.WIX ? path.join(process.env.WIX, "bin", "candle.exe") : "",
  ];
  for (const c of candidates) {
    if (!c) continue;
    try { if (fs.existsSync(c)) return path.dirname(c); } catch {}
    const r = spawnSync(c, ["--version"], { shell: false, stdio: "pipe", timeout: 3000 });
    if (!r.error && r.status === 0) return path.dirname(c);
  }
  return null;
}

// ── Generate WiX MSI ────────────────────────────────────────
// This is the actual `.msi` builder — the NSIS path above produces
// a `.exe` installer, which is NOT the same file format even though
// people often say "MSI" loosely for either. WiX3's standard 3-tool
// pipeline:
//   1. heat.exe   — harvests an arbitrary directory tree (dist/source)
//                    into a .wxs fragment listing every file as a
//                    <Component>, so we don't hand-author thousands
//                    of entries for the bundled source tree.
//   2. candle.exe — compiles .wxs -> .wixobj
//   3. light.exe  — links .wixobj files -> the final .msi
function buildMSI(wixBinDir) {
  const heat   = path.join(wixBinDir, "heat.exe");
  const candle = path.join(wixBinDir, "candle.exe");
  const light  = path.join(wixBinDir, "light.exe");
  if (![heat, candle, light].every(fs.existsSync)) {
    warn("WiX found but heat.exe/candle.exe/light.exe are incomplete — skipping MSI");
    return false;
  }

  const sourceDir   = collectSourceBundle();
  fs.mkdirSync(WIX_DIR, { recursive: true });
  const productWxs  = path.join(WIX_DIR, "oxis-product.wxs");
  const sourceWxs   = path.join(WIX_DIR, "oxis-source-fragment.wxs");
  const outMsi      = `oxis-${VERSION}.msi`;
  // WiX needs a stable GUID per product/upgrade-code so future
  // versions can upgrade in place instead of side-by-side installing.
  // Generated once and hardcoded (NOT regenerated per build) —
  // regenerating this every run would break upgrade detection.
  const UPGRADE_CODE = "4F3A9B2E-6C1D-4E8A-9F2B-1A7C5D8E9F01";

  info("Harvesting dist/source with heat.exe...");
  const heatArgs = [
    "dir", sourceDir,
    "-out", sourceWxs,
    "-cg", "SourceFilesGroup",
    "-dr", "SOURCEFOLDER",
    "-var", "var.SourceDir",
    "-srd", "-gg", "-sfrag", "-scom", "-sreg",
  ];
  const heatRes = spawnSync(`"${heat}"`, heatArgs, { shell: true, stdio: "pipe", cwd: WIX_DIR });
  if (heatRes.status !== 0) {
    warn("heat.exe failed to harvest dist/source — MSI build aborted");
    if (heatRes.stderr) log(heatRes.stderr.toString(), col.grey);
    return false;
  }
  ok("source harvested: dist/wix/oxis-source-fragment.wxs");

  const icoLine = fs.existsSync(ICO)
    ? `<Icon Id="OxisIcon" SourceFile="${ICO}" />\n    <Property Id="ARPPRODUCTICON" Value="OxisIcon" />`
    : "";

  const product = `<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product Id="*" Name="OXIS" Language="1033" Version="${VERSION}"
           Manufacturer="OXIS" UpgradeCode="${UPGRADE_CODE}">
    <Package InstallerVersion="500" Compressed="yes" InstallScope="perMachine" />
    <MajorUpgrade DowngradeErrorMessage="A newer version of OXIS is already installed." />
    <MediaTemplate EmbedCab="yes" />
    ${icoLine}

    <!-- Feature 1: the app itself — required, can't be unchecked -->
    <Feature Id="MainApp" Title="OXIS" Level="1" Absent="disallow">
      <ComponentRef Id="OxisExeComponent" />
      <ComponentRef Id="OxisPathComponent" />
      <ComponentRef Id="OxisShortcuts" />
    </Feature>

    <!-- Feature 2: full project source — this is the "installs the
         whole project so everything can be customized" part. Left
         checked by default but the user can deselect it in the MSI
         UI's feature tree if they only want the binary. -->
    <Feature Id="SourceCode" Title="Source code (for customizing OXIS)" Level="1">
      <ComponentGroupRef Id="SourceFilesGroup" />
    </Feature>

    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="ProgramFiles64Folder">
        <Directory Id="INSTALLFOLDER" Name="OXIS">
          <Component Id="OxisExeComponent" Guid="*">
            <File Id="OxisExe" Source="${EXE}" KeyPath="yes" />
          </Component>
          <Component Id="OxisPathComponent" Guid="*">
            <Environment Id="OxisPathEnv" Name="PATH" Value="[INSTALLFOLDER]"
                         Permanent="no" Part="last" Action="set" System="yes" />
            <RegistryValue Root="HKLM" Key="Software\\OXIS" Name="Installed"
                           Type="integer" Value="1" KeyPath="yes" />
          </Component>
          <!-- SOURCEFOLDER referenced by heat.exe's -dr flag lives here -->
          <Directory Id="SOURCEFOLDER" Name="source" />
        </Directory>
      </Directory>
      <Directory Id="ProgramMenuFolder">
        <Directory Id="AppMenuFolder" Name="OXIS">
          <Component Id="OxisShortcuts" Guid="*">
            <Shortcut Id="StartMenuShortcut" Name="OXIS"
                      Target="[INSTALLFOLDER]oxis.exe" WorkingDirectory="INSTALLFOLDER" />
            <Shortcut Id="UninstallShortcut" Name="Uninstall OXIS"
                      Target="[SystemFolder]msiexec.exe" Arguments="/x [ProductCode]" />
            <RemoveFolder Id="RemoveAppMenuFolder" On="uninstall" />
            <RegistryValue Root="HKCU" Key="Software\\OXIS" Name="StartMenuShortcut"
                           Type="integer" Value="1" KeyPath="yes" />
          </Component>
        </Directory>
      </Directory>
      <Directory Id="DesktopFolder">
        <Component Id="OxisDesktopShortcut" Guid="*">
          <Shortcut Id="DesktopShortcut" Name="OXIS"
                    Target="[INSTALLFOLDER]oxis.exe" WorkingDirectory="INSTALLFOLDER" />
          <RegistryValue Root="HKCU" Key="Software\\OXIS" Name="DesktopShortcut"
                         Type="integer" Value="1" KeyPath="yes" />
        </Component>
      </Directory>
    </Directory>
  </Product>
</Wix>`.trim();

  fs.writeFileSync(productWxs, product);
  ok("WiX product script: dist/wix/oxis-product.wxs");

  info("Compiling with candle.exe...");
  const candleRes = spawnSync(
    `"${candle}"`,
    [`-dSourceDir="${sourceDir}"`, `"${productWxs}"`, `"${sourceWxs}"`, "-out", WIX_DIR + path.sep],
    { shell: true, stdio: "inherit", cwd: ROOT }
  );
  if (candleRes.status !== 0) {
    warn("candle.exe failed — WiX scripts saved for manual build");
    log(`  candle -dSourceDir="${sourceDir}" "${productWxs}" "${sourceWxs}" -out ${WIX_DIR}${path.sep}`, col.grey);
    return false;
  }

  info("Linking with light.exe...");
  const productObj = path.join(WIX_DIR, "oxis-product.wixobj");
  const sourceObj  = path.join(WIX_DIR, "oxis-source-fragment.wixobj");
  const lightRes = spawnSync(
    `"${light}"`,
    ["-ext", "WixUtilExtension", `"${productObj}"`, `"${sourceObj}"`,
     "-out", path.join(WIX_DIR, outMsi), "-sval"],
    { shell: true, stdio: "inherit", cwd: ROOT }
  );
  if (lightRes.status !== 0) {
    warn("light.exe failed — see output above");
    return false;
  }

  ok(`dist/wix/${outMsi}  ← MSI installer ready`);
  return true;
}

// ── Generate NSIS script ───────────────────────────────────
function buildNSI(nsisBin) {
  fs.mkdirSync(NSIS_DIR, { recursive: true });
  const nsiFile  = path.join(NSIS_DIR, "oxis-setup.nsi");
  const outExe   = `oxis-${VERSION}-setup.exe`;
  const icoLine = fs.existsSync(ICO) ? `Icon "${ICO}"` : ""

  collectSourceBundle();

  const script = `
Unicode true
!define APPNAME "OXIS"
!define VERSION "${VERSION}"
Name "\${APPNAME} \${VERSION}"
OutFile "${outExe}"
InstallDir "$PROGRAMFILES64\\\\OXIS"
InstallDirRegKey HKLM "Software\\\\OXIS" "Install_Dir"
RequestExecutionLevel admin
SetCompressor /SOLID lzma
${icoLine}

!include "MUI2.nsh"
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "OXIS" SecMain
  SectionIn RO
  SetOutPath "$INSTDIR"
  File "${EXE.replace(/\\/g,"\\\\\\\\")}"
  ${fs.existsSync(ICO)?`File "${ICO.replace(/\\/g,"\\\\\\\\")}"` : ""}
  CreateDirectory "$SMPROGRAMS\\\\OXIS"
  CreateShortcut "$SMPROGRAMS\\\\OXIS\\\\OXIS.lnk" "$INSTDIR\\\\oxis.exe"
  CreateShortcut "$SMPROGRAMS\\\\OXIS\\\\Uninstall.lnk" "$INSTDIR\\\\Uninstall.exe"
  CreateShortcut "$DESKTOP\\\\OXIS.lnk" "$INSTDIR\\\\oxis.exe"
  WriteRegStr HKLM "Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Uninstall\\\\OXIS" "DisplayName" "OXIS"
  WriteRegStr HKLM "Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Uninstall\\\\OXIS" "UninstallString" "$INSTDIR\\\\Uninstall.exe"
  WriteRegStr HKLM "Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Uninstall\\\\OXIS" "DisplayVersion" "\${VERSION}"
  WriteRegStr HKLM "Software\\\\OXIS" "Install_Dir" "$INSTDIR"
  WriteUninstaller "$INSTDIR\\\\Uninstall.exe"
  ; Add to PATH
  ReadRegStr $0 HKLM "SYSTEM\\\\CurrentControlSet\\\\Control\\\\Session Manager\\\\Environment" "Path"
  WriteRegExpandStr HKLM "SYSTEM\\\\CurrentControlSet\\\\Control\\\\Session Manager\\\\Environment" "Path" "$0;$INSTDIR"
  SendMessage \${HWND_BROADCAST} \${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
SectionEnd

Section "Source code" SecSource
  ; Ships the full OXIS project source under $INSTDIR\\source, so
  ; installing OXIS also gives you the app's own code — for reading,
  ; modifying, writing plugins against, or rebuilding from scratch.
  ; See $INSTDIR\\source\\README.md for build instructions.
  SetOutPath "$INSTDIR\\\\${SRC_DIR_NAME}"
  File /r "${SOURCE_ABS.replace(/\\/g,"\\\\\\\\")}\\\\*.*"
SectionEnd

Section "Uninstall"
  Delete "$INSTDIR\\\\oxis.exe"
  Delete "$INSTDIR\\\\oxis.ico"
  Delete "$INSTDIR\\\\Uninstall.exe"
  RMDir /r "$INSTDIR\\\\${SRC_DIR_NAME}"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\\\\OXIS\\\\OXIS.lnk"
  Delete "$SMPROGRAMS\\\\OXIS\\\\Uninstall.lnk"
  RMDir "$SMPROGRAMS\\\\OXIS"
  Delete "$DESKTOP\\\\OXIS.lnk"
  DeleteRegKey HKLM "Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Uninstall\\\\OXIS"
  DeleteRegKey HKLM "Software\\\\OXIS"
SectionEnd
`.trim();

  fs.writeFileSync(nsiFile, script);
  ok("NSI script: dist/nsis/oxis-setup.nsi");

  info("Running makensis...");
  const r = spawnSync(`"${nsisBin}"`, [`"${nsiFile}"`], {
    shell: true, stdio: "inherit", cwd: NSIS_DIR
  });

  if (r.status === 0) {
    ok(`dist/nsis/${outExe}  ← installer ready`);
    return true;
  } else {
    warn("makensis failed — NSI script saved for manual build");
    log(`  makensis "${nsiFile}"`, col.grey);
    return false;
  }
}

// ── Main ───────────────────────────────────────────────────
const nsisBin = findNSIS();
const wixBin  = findWiX();

if (!nsisBin && !wixBin) {
  log("\n  Neither NSIS nor WiX found.", col.red);
  log("  For a real .msi, install WiX:  winget install WiXToolset.WiXToolset", col.grey);
  log("  For a .exe installer instead:  winget install NSIS.NSIS", col.grey);
  log("\n  Source bundle saved to dist/source — scripts saved so you can", col.grey);
  log("  build the installer manually once one of the above is installed.", col.grey);

  collectSourceBundle();

  fs.mkdirSync(NSIS_DIR, { recursive: true });
  const nsiFile = path.join(NSIS_DIR, "oxis-setup.nsi");
  fs.writeFileSync(nsiFile, `; Run: makensis oxis-setup.nsi\n; Install NSIS from: https://nsis.sourceforge.io\n`);
  process.exit(0);
}

let built = false;

// WiX (real .msi) is tried first since that's the actual ask — NSIS
// (.exe) is the fallback for machines that only have NSIS installed.
if (wixBin) {
  info("WiX found — building MSI...");
  built = buildMSI(wixBin);
}

if (nsisBin && !built) {
  info(wixBin ? "MSI build didn't complete — building NSIS .exe installer instead..."
              : "Building NSIS .exe installer...");
  built = buildNSI(nsisBin);
}

if (built) {
  log("\n╔══════════════════════════════════╗", col.magenta);
  log("║  Installer built successfully!   ║", col.magenta);
  log("╚══════════════════════════════════╝\n", col.magenta);
} else {
  log("\n  Installer build did not complete — see warnings above.", col.red);
  process.exit(1);
}