#!/usr/bin/env node
/**
 * build-msi.js — Windows installer builder. Builds a WiX .msi when WiX
 * is available, otherwise an NSIS .exe installer. Run after
 * `npm run build`. Only the binary and icon are packaged; installs that
 * can't write next to the exe clone the source on first launch instead
 * (see AppDirPath in internal/wailsapp/app.go).
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
const VERSION = require(path.join(ROOT, "package.json")).version;
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

// WixUI_InstallDir needs a license RTF for its License page; this
// converts the plain-text LICENSE (escaping \ { }) into minimal RTF.
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

log(`\n→ OXIS ${VERSION} installer build`, col.magenta);

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
    // A bare name only says "it's on PATH", not where; resolve it with
    // `where` and pick the entry that has light.exe next to it (a
    // chocolatey shim may come first).
    const isBareName = !c.includes("\\") && !c.includes("/");
    if (isBareName) {
      const where = spawnSync("where", [c], { shell: false, stdio: "pipe", timeout: 3000 });
      if (!where.error && where.status === 0) {
        const paths = where.stdout.toString().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        for (const resolved of paths) {
          const dir = path.dirname(resolved);
          if (fs.existsSync(path.join(dir, "light.exe"))) return dir;
        }
      }
      continue;
    }
    try { if (fs.existsSync(c)) return path.dirname(c); } catch {}
    const r = spawnSync(c, ["--version"], { shell: false, stdio: "pipe", timeout: 3000 });
    if (!r.error && r.status === 0) return path.dirname(c);
  }
  return null;
}

// ── Generate WiX MSI (candle → light) ─────────────────────
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
  // Must never change, or upgrades install side by side.
  const UPGRADE_CODE = "4F3A9B2E-6C1D-4E8A-9F2B-1A7C5D8E9F01";

  const icoLine = fs.existsSync(ICO)
    ? `<Icon Id="OxisIcon" SourceFile="${ICO}" />\n    <Property Id="ARPPRODUCTICON" Value="OxisIcon" />`
    : "";

  const logoComponent = fs.existsSync(LOGO) ? `
          <Component Id="OxisLogoComponent" Guid="*" Win64="yes">
            <File Id="OxisLogo" Source="${LOGO}" KeyPath="yes" />
          </Component>` : "";
  const logoComponentRef = fs.existsSync(LOGO) ? `\n      <ComponentRef Id="OxisLogoComponent" />` : "";

  const product = `<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi" xmlns:util="http://schemas.microsoft.com/wix/UtilExtension">
  <Product Id="*" Name="OXIS" Language="1033" Version="${VERSION}"
           Manufacturer="OXIS" UpgradeCode="${UPGRADE_CODE}">
    <!-- x64: oxis.exe is amd64; without this, registry writes land in
         WOW6432Node. -->
    <Package InstallerVersion="500" Compressed="yes" InstallScope="perMachine" Platform="x64" />
    <MajorUpgrade DowngradeErrorMessage="A newer version of OXIS is already installed." />
    <MediaTemplate EmbedCab="yes" />
    ${icoLine}

    <!-- Standard install-location dialog, bound to INSTALLFOLDER. -->
    <UIRef Id="WixUI_InstallDir" />
    <WixVariable Id="WixUILicenseRtf" Value="${licenseRtf}" />
    <Property Id="WIXUI_INSTALLDIR" Value="INSTALLFOLDER" />

    <!-- Default INSTALLFOLDER to %USERPROFILE%\OXIS, which a normal account
         can write to without elevation. -->
    <CustomAction Id="OxisSetDefaultDir" Return="ignore" Execute="immediate" Script="vbscript">
      <![CDATA[
        Dim shell, profile
        Set shell = CreateObject("WScript.Shell")
        profile = shell.ExpandEnvironmentStrings("%USERPROFILE%")
        Session.Property("INSTALLFOLDER") = profile & "\OXIS\"
      ]]>
    </CustomAction>

    <!-- On Next from the folder page: OXIS_VALID_DIR=1 only if the chosen
         folder is under the user's own profile. -->
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

    <!-- Shown instead of advancing when the folder isn't under the profile. -->
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
      <!-- Order 10/11 runs after WixUI's own Next chain (which tops out at
           4 and only checks path syntax), so our check has the last word. -->
      <Publish Dialog="InstallDirDlg" Control="Next" Event="SpawnDialog" Value="OxisInvalidDirDlg" Order="10">OXIS_VALID_DIR = "0"</Publish>
      <Publish Dialog="InstallDirDlg" Control="Next" Event="NewDialog" Value="InstallDirDlg" Order="11">OXIS_VALID_DIR = "0"</Publish>
    </UI>


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
          <!-- Let regular users write the data folders next to the exe, wherever
               INSTALLFOLDER ends up. -->
          <Component Id="OxisFolderPermissions" Guid="*" Win64="yes">
            <CreateFolder>
              <util:PermissionEx User="Users" GenericAll="yes" />
            </CreateFolder>
            <RegistryValue Root="HKLM" Key="Software\\OXIS" Name="FolderPermissions"
                           Type="integer" Value="1" KeyPath="yes" />
          </Component>
          <Component Id="OxisExeComponent" Guid="*" Win64="yes">
            <File Id="OxisExe" Source="${EXE}" KeyPath="yes" />
          </Component>${logoComponent}
          <Component Id="OxisPathComponent" Guid="*" Win64="yes">
            <Environment Id="OxisPathEnv" Name="PATH" Value="[INSTALLFOLDER]"
                         Permanent="no" Part="last" Action="set" System="yes" />
            <RegistryValue Root="HKLM" Key="Software\\OXIS" Name="Installed"
                           Type="integer" Value="1" KeyPath="yes" />
          </Component>
          <!-- Create the data folders at install time so they're visible
               immediately. -->
          <Directory Id="WORKSPACESFOLDER" Name="workspaces">
            <Component Id="OxisWorkspacesFolder" Guid="*" Win64="yes">
              <CreateFolder />
              <RegistryValue Root="HKLM" Key="Software\\OXIS" Name="WorkspacesFolder"
                             Type="integer" Value="1" KeyPath="yes" />
            </Component>
          </Directory>
          <Directory Id="PLUGINSDATAFOLDER" Name="created-plugins">
            <Component Id="OxisPluginsFolder" Guid="*" Win64="yes">
              <CreateFolder />
              <RegistryValue Root="HKLM" Key="Software\\OXIS" Name="PluginsFolder"
                             Type="integer" Value="1" KeyPath="yes" />
            </Component>
          </Directory>
          <Directory Id="DOCUMENTSDATAFOLDER" Name="created-documents">
            <Component Id="OxisDocumentsFolder" Guid="*" Win64="yes">
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
  const icoLine = fs.existsSync(ICO) ? `Icon "${ICO}"` : "";

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
  ; Create the data folders up front, same as the MSI.
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

// Prefer a real .msi; NSIS is the fallback.
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
  log("\n✓ Installer built\n", col.magenta);
} else {
  log("\n  Installer build did not complete — see warnings above.", col.red);
  process.exit(1);
}