#!/usr/bin/env node
/**
 * build-msi.js — Windows installer builder (NSIS + WiX)
 * Fixes NSIS detection by checking all known install paths.
 *
 * Ships ONLY the binary (+ icon) — no longer bundles the whole
 * project source the way earlier versions of this script did. That
 * used to happen at INSTALL time (heat.exe harvesting dist/source
 * into the .msi itself, or NSIS's own "Source code" section) —
 * removed for two real reasons: it made every install slower and
 * heavier for something most users never touch, and — the more
 * important one — it meant `npm run build` always also produced a
 * dist/wix/ + dist/source tree regardless of whether an installer was
 * even being built. Source delivery is now the RUNNING APP's job
 * instead: on first launch, if it detects it can't write next to its
 * own exe (the real case an MSI install hits — see AppDirPath's own
 * doc comment in internal/wailsapp/app.go for the full story), it
 * clones this project's GitHub source into a writable data directory
 * under the user's own Downloads folder in the background. Simpler
 * installer, and source only ever gets fetched for someone who
 * actually needs the writable-fallback path in the first place.
 */
const { spawnSync } = require("child_process");
const path = require("path");
const fs   = require("fs");

const ROOT    = path.resolve(__dirname, "..");
const DIST    = path.join(ROOT, "dist");
const EXE     = path.join(DIST, "oxis.exe");
const ICO     = path.join(ROOT, "cmd", "oxi", "oxis.ico");
const LOGO    = path.join(DIST, "logo.png");
const LICENSE = path.join(ROOT, "LICENSE");
const VERSION = "1.2.1";
// Every WiX/NSIS-generated file (scripts, intermediate .wixobj, and
// the final installer itself) lives under its own subfolder instead
// of loose in dist/ — see README § dist/ layout.
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

// WixUI_InstallDir (the standard WiX dialog set that lets the user
// browse/change the install location — see buildMSI below) requires
// a license RTF for its License Agreement page; there's no way to
// skip straight to the directory picker without a custom dialog set,
// which is a lot more WiX authoring for what's a completely standard
// UI flow otherwise. Converts the REAL LICENSE file's actual text
// (not a summary/placeholder) into minimal valid RTF — escaping
// backslash/brace (RTF's own control characters) and turning blank
// lines into paragraph breaks is enough for a plain-text license;
// nothing here needs real RTF formatting.
function buildLicenseRtf() {
  const text = fs.existsSync(LICENSE) ? fs.readFileSync(LICENSE, "utf8") : "Apache License 2.0";
  const escaped = text
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .split(/\r?\n/)
    .map(line => line.length ? line : "\\par")
    .join("\\line\n");
  const rtfPath = path.join(WIX_DIR, "license.rtf");
  fs.mkdirSync(WIX_DIR, { recursive: true });
  fs.writeFileSync(rtfPath, `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Consolas;}}\\f0\\fs18\n${escaped}\n}`);
  return rtfPath;
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
    // A candidate that's already a real path (has a directory
    // separator) resolves its own dirname correctly. A BARE name
    // like "candle.exe" (the first candidate — checking whether it's
    // resolvable via the system PATH at all) does NOT: fs.existsSync
    // treats it as relative to the current working directory (almost
    // never where candle.exe actually lives), and spawnSync resolving
    // it via PATH doesn't tell you WHERE on PATH it was found — only
    // that it ran. path.dirname("candle.exe") is just "." either way,
    // which is not a real WiX bin directory. This was a real,
    // pre-existing bug, confirmed against an actual CI run: WiX
    // being genuinely present and on PATH still produced "candle.exe/
    // light.exe are incomplete" and skipped the MSI, because this
    // returned "." as wixBinDir and buildMSI()'s own fs.existsSync
    // check for "./candle.exe" correctly found nothing there.
    const isBareName = !c.includes("\\") && !c.includes("/");
    if (isBareName) {
      const where = spawnSync("where", [c], { shell: false, stdio: "pipe", timeout: 3000 });
      if (!where.error && where.status === 0) {
        // "where" can list more than one match (e.g. a chocolatey
        // shim earlier on PATH than the real WiX install directory) —
        // a shim is a one-off wrapper executable, not necessarily
        // sitting next to a real light.exe the way an actual WiX bin/
        // directory would be, so check each candidate directory for
        // that sibling rather than trusting the first line blindly.
        const paths = where.stdout.toString().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        for (const resolved of paths) {
          const dir = path.dirname(resolved);
          if (fs.existsSync(path.join(dir, "light.exe"))) return dir;
        }
      }
      continue; // not resolvable via PATH with a real light.exe alongside it — nothing more to check for this bare-name candidate
    }
    try { if (fs.existsSync(c)) return path.dirname(c); } catch {}
    const r = spawnSync(c, ["--version"], { shell: false, stdio: "pipe", timeout: 3000 });
    if (!r.error && r.status === 0) return path.dirname(c);
  }
  return null;
}

// ── Generate WiX MSI ────────────────────────────────────────
// This is the actual `.msi` builder — the NSIS path above produces
// a `.exe` installer, which is NOT the same file format even though
// people often say "MSI" loosely for either. Just candle.exe -> wixobj
// -> light.exe -> msi now — no heat.exe harvesting step, since there's
// no source tree to harvest anymore (see this file's own top comment).
function buildMSI(wixBinDir) {
  const candle = path.join(wixBinDir, "candle.exe");
  const light  = path.join(wixBinDir, "light.exe");
  if (![candle, light].every(fs.existsSync)) {
    warn("WiX found but candle.exe/light.exe are incomplete — skipping MSI");
    return false;
  }

  fs.mkdirSync(WIX_DIR, { recursive: true });
  const productWxs  = path.join(WIX_DIR, "oxis-product.wxs");
  const outMsi      = `oxis-${VERSION}.msi`;
  const licenseRtf  = buildLicenseRtf();
  // WiX needs a stable GUID per product/upgrade-code so future
  // versions can upgrade in place instead of side-by-side installing.
  // Generated once and hardcoded (NOT regenerated per build) —
  // regenerating this every run would break upgrade detection.
  const UPGRADE_CODE = "4F3A9B2E-6C1D-4E8A-9F2B-1A7C5D8E9F01";

  const icoLine = fs.existsSync(ICO)
    ? `<Icon Id="OxisIcon" SourceFile="${ICO}" />\n    <Property Id="ARPPRODUCTICON" Value="OxisIcon" />`
    : "";

  // logo.png ships in the LOCAL dist/ folder (build-go.js's own Step
  // 6) but was never actually part of what the MSI installs — a real
  // gap, reported: Program Files\OXIS ended up with just oxis.exe,
  // not the same file set dist/ itself has. Conditional component,
  // same "only if it exists" pattern as the icon above, so a build
  // missing logo.png for some reason doesn't fail the whole MSI over
  // one optional file.
  const logoComponent = fs.existsSync(LOGO) ? `
          <Component Id="OxisLogoComponent" Guid="*">
            <File Id="OxisLogo" Source="${LOGO}" KeyPath="yes" />
          </Component>` : "";
  const logoComponentRef = fs.existsSync(LOGO) ? `\n      <ComponentRef Id="OxisLogoComponent" />` : "";

  const product = `<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi" xmlns:util="http://schemas.microsoft.com/wix/UtilExtension">
  <Product Id="*" Name="OXIS" Language="1033" Version="${VERSION}"
           Manufacturer="OXIS" UpgradeCode="${UPGRADE_CODE}">
    <Package InstallerVersion="500" Compressed="yes" InstallScope="perMachine" />
    <MajorUpgrade DowngradeErrorMessage="A newer version of OXIS is already installed." />
    <MediaTemplate EmbedCab="yes" />
    ${icoLine}

    <!-- WixUI_InstallDir — the standard WiX dialog set with a real
         "choose install location" page (Browse... button and all),
         set to control INSTALLFOLDER below, so the person installing
         picks where OXIS (and its data — workspaces/created-plugins/
         created-documents, all created as real, visible folders
         right in that location, not lazily on first use — see the
         explicit CreateFolder components below) actually lives,
         rather than it being silently fixed to Program Files. Needs
         a license RTF for its License Agreement page — buildLicenseRtf()
         above converts the real LICENSE file, not a placeholder. -->
    <UIRef Id="WixUI_InstallDir" />
    <WixVariable Id="WixUILicenseRtf" Value="${licenseRtf}" />
    <Property Id="WIXUI_INSTALLDIR" Value="INSTALLFOLDER" />

    <!-- Defaults INSTALLFOLDER to somewhere under the CURRENT user's
         own profile (%USERPROFILE%\\OXIS) instead of Program Files —
         genuinely writable by a regular account with no ACL grant or
         elevation needed at all, which is the whole point: Program
         Files only worked because OxisFolderPermissions (below)
         explicitly grants it, a real but avoidable workaround for a
         problem a user-profile default just doesn't have in the
         first place. Read via VBScript's own environment-expansion
         (WScript.Shell.ExpandEnvironmentStrings), not through MSI's
         property table, since USERPROFILE isn't guaranteed to be
         auto-imported as an MSI property the way this needs — this
         works regardless of that. Runs before the directory dialog
         even shows (During="firstSequence"), so the field is already
         filled with a real, working path rather than the Program
         Files default from before. -->
    <CustomAction Id="OxisSetDefaultDir" Return="ignore" Execute="immediate" Script="vbscript">
      <![CDATA[
        Dim shell, profile
        Set shell = CreateObject("WScript.Shell")
        profile = shell.ExpandEnvironmentStrings("%USERPROFILE%")
        Session.Property("INSTALLFOLDER") = profile & "\OXIS\"
      ]]>
    </CustomAction>

    <!-- Runs on every "Next" click from the Destination Folder page —
         re-reads whatever INSTALLFOLDER the person just typed or
         browsed to (their own edit, or the Browse... dialog's own
         result) and sets OXIS_VALID_DIR to "1" only if it's under
         their own profile. Same ExpandEnvironmentStrings approach as
         the default above, for the same reliability reason — this is
         the actual gate: Program Files, another drive's root, another
         user's profile folder, or any other admin-owned location all
         correctly evaluate to "0" here, not just Program Files
         specifically, since the check is "is this under MY OWN
         profile", not "is this NOT Program Files" — the latter would
         still let through other locations a regular account can't
         actually write to either. -->
    <CustomAction Id="OxisValidateDir" Return="check" Execute="immediate" Script="vbscript">
      <![CDATA[
        Dim shell, profile, chosen
        Set shell = CreateObject("WScript.Shell")
        profile = LCase(shell.ExpandEnvironmentStrings("%USERPROFILE%"))
        chosen = LCase(Session.Property("INSTALLFOLDER"))
        If Left(chosen, Len(profile)) = profile Then
          Session.Property("OXIS_VALID_DIR") = "1"
        Else
          Session.Property("OXIS_VALID_DIR") = "0"
        End If
      ]]>
    </CustomAction>

    <!-- A minimal, standard WiX error dialog — shown instead of
         advancing when OxisValidateDir above found the chosen path
         isn't under the user's own profile. This IS the "warn before
         they continue" — it fires the moment Next is clicked on a
         bad path, before anything is installed, not a launch-time
         rejection after they've already clicked through every
         remaining page. -->
    <UI>
      <Dialog Id="OxisInvalidDirDlg" Width="370" Height="140" Title="OXIS Setup">
        <Control Id="Text" Type="Text" X="20" Y="15" Width="330" Height="70" NoPrefix="yes"
                 Text="That location won't work — OXIS needs somewhere under your own user profile (C:\Users\[LogonUser]\...), not Program Files or another protected location, so it can create and write its own data without needing to run as administrator every time.&#10;&#10;Please choose a folder under your own profile instead." />
        <Control Id="OK" Type="PushButton" X="145" Y="105" Width="80" Height="17" Default="yes" Cancel="yes" Text="OK">
          <Publish Event="EndDialog" Value="Return">1</Publish>
        </Control>
      </Dialog>

      <Publish Dialog="WelcomeDlg" Control="Next" Event="DoAction" Value="OxisSetDefaultDir" Order="1">NOT Installed</Publish>
      <Publish Dialog="InstallDirDlg" Control="Next" Event="DoAction" Value="OxisValidateDir" Order="1">1</Publish>
      <Publish Dialog="InstallDirDlg" Control="Next" Event="SpawnDialog" Value="OxisInvalidDirDlg" Order="2">OXIS_VALID_DIR = "0"</Publish>
      <Publish Dialog="InstallDirDlg" Control="Next" Event="NewDialog" Value="VerifyReadyDlg" Order="3">OXIS_VALID_DIR = "1"</Publish>
    </UI>

    <!-- The app itself — the only feature now; no more separate,
         deselectable "source code" feature, since there's no bundled
         source to make optional. Required, can't be unchecked. -->
    <Feature Id="MainApp" Title="OXIS" Level="1" Absent="disallow">
      <ComponentRef Id="OxisFolderPermissions" />
      <ComponentRef Id="OxisExeComponent" />
      <ComponentRef Id="OxisPathComponent" />
      <ComponentRef Id="OxisShortcuts" />
      <ComponentRef Id="OxisDesktopShortcut" />
      <ComponentRef Id="OxisWorkspacesFolder" />
      <ComponentRef Id="OxisPluginsFolder" />
      <ComponentRef Id="OxisDocumentsFolder" />${logoComponentRef}
    </Feature>

    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="ProgramFiles64Folder">
        <Directory Id="INSTALLFOLDER" Name="OXIS">
          <!-- Grants the built-in "Users" group (every regular,
               non-admin local account) full control of INSTALLFOLDER
               itself, so the RUNNING app can create workspaces/,
               created-plugins/, created-documents/ there without
               needing to run elevated. Program Files is normally
               UAC-protected against writes from a regular user
               session — this is the standard, correct fix for an app
               that wants its own data folder to live next to its exe
               anyway: the MSI (which does run elevated, installing
               to Program Files always requires that) grants the
               permission up front, once, during install, rather than
               the app trying to write there as a normal user and
               silently failing (which is the exact bug this
               replaces — see AppDirPath in internal/wailsapp/app.go,
               which still keeps its own Downloads-folder fallback as
               a safety net for the rare case this grant doesn't take,
               e.g. Group Policy overriding it, but no longer needs to
               trigger for a normal install with this in place).
               Applies equally wherever WixUI_InstallDir's directory
               picker ends up pointing INSTALLFOLDER at — not
               hardcoded to Program Files specifically. -->
          <Component Id="OxisFolderPermissions" Guid="*">
            <CreateFolder>
              <util:PermissionEx User="Users" GenericAll="yes" />
            </CreateFolder>
            <RegistryValue Root="HKLM" Key="Software\\OXIS" Name="FolderPermissions"
                           Type="integer" Value="1" KeyPath="yes" />
          </Component>
          <Component Id="OxisExeComponent" Guid="*">
            <File Id="OxisExe" Source="${EXE}" KeyPath="yes" />
          </Component>${logoComponent}
          <Component Id="OxisPathComponent" Guid="*">
            <Environment Id="OxisPathEnv" Name="PATH" Value="[INSTALLFOLDER]"
                         Permanent="no" Part="last" Action="set" System="yes" />
            <RegistryValue Root="HKLM" Key="Software\\OXIS" Name="Installed"
                           Type="integer" Value="1" KeyPath="yes" />
          </Component>
          <!-- Created explicitly, empty, at install time — the exact
               real, reported gap this closes: without these, nothing
               under INSTALLFOLDER was visible besides oxis.exe until
               the app itself lazily created a folder on first actual
               use (first plugin, first document, first workspace),
               so right after installing, Program Files\\OXIS looked
               like it had nothing in it. These are real, empty
               folders on disk from the moment install finishes —
               the running app writes into them the same way either
               way; this only changes when they first appear. -->
          <Directory Id="WORKSPACESFOLDER" Name="workspaces">
            <Component Id="OxisWorkspacesFolder" Guid="*">
              <CreateFolder />
              <RegistryValue Root="HKLM" Key="Software\\OXIS" Name="WorkspacesFolder"
                             Type="integer" Value="1" KeyPath="yes" />
            </Component>
          </Directory>
          <Directory Id="PLUGINSDATAFOLDER" Name="created-plugins">
            <Component Id="OxisPluginsFolder" Guid="*">
              <CreateFolder />
              <RegistryValue Root="HKLM" Key="Software\\OXIS" Name="PluginsFolder"
                             Type="integer" Value="1" KeyPath="yes" />
            </Component>
          </Directory>
          <Directory Id="DOCUMENTSDATAFOLDER" Name="created-documents">
            <Component Id="OxisDocumentsFolder" Guid="*">
              <CreateFolder />
              <RegistryValue Root="HKLM" Key="Software\\OXIS" Name="DocumentsFolder"
                             Type="integer" Value="1" KeyPath="yes" />
            </Component>
          </Directory>
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
    ["-ext", "WixUtilExtension", "-ext", "WixUIExtension", `"${productWxs}"`, "-out", WIX_DIR + path.sep],
    { shell: true, stdio: "inherit", cwd: ROOT }
  );
  if (candleRes.status !== 0) {
    warn("candle.exe failed — WiX script saved for manual build");
    log(`  candle -ext WixUtilExtension -ext WixUIExtension "${productWxs}" -out ${WIX_DIR}${path.sep}`, col.grey);
    return false;
  }

  info("Linking with light.exe...");
  const productObj = path.join(WIX_DIR, "oxis-product.wixobj");
  const lightRes = spawnSync(
    `"${light}"`,
    ["-ext", "WixUtilExtension", "-ext", "WixUIExtension", `"${productObj}"`,
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
  ${fs.existsSync(LOGO)?`File "${LOGO.replace(/\\/g,"\\\\\\\\")}"` : ""}
  ; Created explicitly, empty, at install time -- same reason as the
  ; MSI side (see OxisWorkspacesFolder etc. in buildMSI above): without
  ; these, $INSTDIR showed nothing but oxis.exe until the app itself
  ; lazily created a folder on first actual use.
  CreateDirectory "$INSTDIR\\\\workspaces"
  CreateDirectory "$INSTDIR\\\\created-plugins"
  CreateDirectory "$INSTDIR\\\\created-documents"
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

Section "Uninstall"
  Delete "$INSTDIR\\\\oxis.exe"
  Delete "$INSTDIR\\\\oxis.ico"
  Delete "$INSTDIR\\\\logo.png"
  Delete "$INSTDIR\\\\Uninstall.exe"
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