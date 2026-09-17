/**
 * App.tsx — OXIS v1.2.1
 * Complete application: terminal, editor, home, theme editor, plugin creator.
 */

import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from "react";

import { openPty }    from "./pty/ptyClient";
import type { PtySession } from "./pty/ptyClient";

import {
  mkLine, bannerLines, processOutput, mergeOutput,
  LINE_COLORS, TRAIN_BODY_LINES, trainWheelFrame, BANNER_LINE_COUNT,
  wordLeft, wordRight,
  deleteWordLeft, deleteWordRight,
  deleteToLineStart, deleteToLineEnd,
  transposeChars,
  setYankBuf, getYankBuf,
  isWindows,
} from "./terminal/terminal";
import type { Line, LineKind } from "./terminal/terminal";

import { history }                          from "./terminal/history";
import type { SearchResult }               from "./terminal/history";
import { themeManager }                     from "./terminal/themeManager";
import type { Theme }                       from "./terminal/themeManager";
import { events }                           from "./terminal/events";
import { keybinds, registerCoreKeybinds }  from "./terminal/keybinds";
import { registry }                         from "./terminal/commandRegistry";
import { sessionManager }                   from "./terminal/sessionManager";
import { workspaceState }                   from "./terminal/workspaceState";
import { workspaceManager }                 from "./terminal/workspaceManager";
import { cwdTracker, buildCwdProbe, looksLikeDirectoryChange } from "./terminal/cwdTracker";
import {
  grant as grantPermission, revoke as revokePermission, grantedTo as grantedPermissions,
  type PermissionNamespace,
} from "./plugins/permissions";
import { getLicensedEmail, setLicensedEmail, checkLicense } from "./plugins/pluginLicense";
import type { EditorMode, CursorState }     from "./terminal/editorModes";
import {
  moveLeft, moveRight, moveUp, moveDown, moveLineStart, moveLineEnd,
  moveDocStart, moveDocEnd, moveWordForward, moveWordBackward,
  deleteChar, deleteLine, deleteWord, openLineBelow, openLineAbove,
  deleteSelection, selectedText,
} from "./terminal/editorModes";
import { highlight, detectLang } from "./terminal/syntaxHighlight";
import type { EditorLang }       from "./terminal/syntaxHighlight";
import { pluginManager }                   from "./plugins/pluginManager";
import { initPlugins }                     from "./plugins/loader";
import type { LuaJSValue }                 from "./plugins/luaRuntime";
import * as market                         from "./plugins/market";
import { readFile, writeFile, isNativeApp, openUrl, checkForUpdate } from "./native";
import Titlebar from "./components/Titlebar";

// ══════════════════════════════════════════════════════════════
// SHELL CONTEXT — passed to command registry
// ══════════════════════════════════════════════════════════════
interface ShellCtx {
  send:        (cmd: string) => void;
  runLine:     (line: string) => void;
  print:       (text: string, kind?: LineKind) => void;
  clear:       () => void;
  openEditor:  (path: string) => void;
  newTerminal: () => void;
}

// ── oxis.option(key[, value]) persistence ────────────────────────
// Backs ctx.getOption/setOption in the plugin API context — used to
// be a permanent `undefined`/no-op stub (see forwardingApiCtx above),
// so any plugin option not already cached in that plugin's own VM
// session never actually persisted across a reload or app restart.
const OPTIONS_KEY = "oxis-plugin-options-v1";
function readAllOptions(): Record<string, unknown> {
  try { return JSON.parse(localStorage.getItem(OPTIONS_KEY) || "{}"); }
  catch { return {}; }
}
function readPersistedOption(key: string): LuaJSValue {
  return readAllOptions()[key] as LuaJSValue;
}
function writePersistedOption(key: string, value: LuaJSValue): void {
  const all = readAllOptions();
  all[key] = value;
  try { localStorage.setItem(OPTIONS_KEY, JSON.stringify(all)); } catch { /* storage full/unavailable — option still works for this session via the per-plugin in-memory cache in pluginAPI.ts */ }
}

// ── init flag so we only register commands once ──────────────
let _commandsRegistered = false;
// Gates the background update check to once per app run (see onReady
// below) — Terminal mounts once per tab, and there's no reason to hit
// gitlab.com again for a tab opened later in the same session.
let _updateCheckedThisRun = false;
// Stable ref so clear/print/send always call the latest Terminal instance
const _ctxRef: { current: ShellCtx | null } = { current: null };

// Live-forwarding plugin API context (fixes a real bug: pluginManager
// and workspaceManager only ever get init()'d ONCE, at root mount,
// before any shell exists — every Lua/shortcut plugin loaded at that
// point (i.e. all of them, since plugins load before any terminal
// tab opens) captured a snapshot of whatever ctx.sendToShell/print
// were at load time via `{ ...this.apiCtx, pluginName }` in
// pluginManager.load(). If that snapshot were the root's `() => {}`
// stubs, EVERY plugin command that calls oxis.run()/oxis.echo() —
// and every TypeScript shortcut plugin's command, like 'gs or 'nb —
// would silently do nothing, forever, even after a real terminal
// mounts. Fix: initPlugins()/workspaceManager.init() get this stable
// object instead, whose methods forward to _apiCtxTarget.current —
// so updating _apiCtxTarget.current when the real Terminal mounts
// (below) fixes already-loaded plugins too, not just future ones.
const _apiCtxTarget: { current: import("./plugins/pluginAPI").APIContext } = {
  current: {
    sendToShell: () => {}, print: () => {}, getCwd: () => "",
    newTerminal: () => {}, getOption: () => undefined, setOption: () => {},
    pluginName: "__core__",
  },
};
const forwardingApiCtx: import("./plugins/pluginAPI").APIContext = {
  sendToShell: (cmd) => _apiCtxTarget.current.sendToShell(cmd),
  print:       (t, k) => _apiCtxTarget.current.print(t, k),
  getCwd:      () => _apiCtxTarget.current.getCwd(),
  newTerminal: () => _apiCtxTarget.current.newTerminal(),
  getOption:   (k) => _apiCtxTarget.current.getOption(k),
  setOption:   (k, v) => _apiCtxTarget.current.setOption(k, v),
  pluginName:  "__core__", // pluginManager.load() overrides this per-plugin via spread
};

// Global "go home" trigger, set by the root App component
const _goHomeRef: { current: (() => void) | null } = { current: null };

function registerBuiltinCommands(ctx: ShellCtx): void {
  if (_commandsRegistered) return;
  _commandsRegistered = true;
  // Wrap every ctx call through the ref so stale closures never matter
  const ps   = (c: string) => _ctxRef.current?.send(c + "\r");
  const ok   = (s: string) => _ctxRef.current?.print("  ✓  " + s, "ok");
  const err  = (s: string) => _ctxRef.current?.print("  ✗  " + s, "err");
  const dim  = (s: string) => _ctxRef.current?.print("     " + s, "dim");
  const info = (s: string) => _ctxRef.current?.print("  " + s, "info");
  const sep  = ()          => _ctxRef.current?.print("  " + "─".repeat(54), "dim");
  const h    = (cmd: string, d: string) => _ctxRef.current?.print("  " + cmd.padEnd(32) + d, "info");
  const shellCmd = (winCmd: string, unixCmd: string) => isWindows() ? winCmd : unixCmd;

  // (ps/ok/err/dim/info/sep/h/shellCmd defined above via _ctxRef)

  // ── files ──────────────────────────────────────────────
  registry.register({ name:"new",    category:"files", description:"Create file",
    handler:(_,r)=>{ if(!r){err("usage: 'new <file>");return;}
      ps(shellCmd(`New-Item -ItemType File -Path "${r}" -Force | Out-Null; Write-Host "created: ${r}"`,
                  `touch "${r}" && echo "created: ${r}"`)); }});

  registry.register({ name:"touch",  category:"files", description:"Create file",
    handler:(_,r)=>{ if(!r){err("usage: 'touch <file>");return;}
      ps(shellCmd(`New-Item -ItemType File -Path "${r}" -Force | Out-Null; Write-Host "created: ${r}"`,
                  `touch "${r}" && echo "created: ${r}"`)); }});

  registry.register({ name:"mkdir",  category:"files", description:"Create directory",
    handler:(_,r)=>{ if(!r){err("usage: 'mkdir <dir>");return;}
      ps(shellCmd(`New-Item -ItemType Directory -Path "${r}" -Force | Out-Null; Write-Host "created: ${r}"`,
                  `mkdir -p "${r}" && echo "created: ${r}"`)); }});

  registry.register({ name:"rm",     category:"files", description:"Delete file/dir",
    handler:(_,r)=>{ if(!r){err("usage: 'rm <path>");return;}
      ps(shellCmd(`Remove-Item -Recurse -Force "${r}"; Write-Host "deleted: ${r}"`,
                  `rm -rf "${r}" && echo "deleted: ${r}"`)); }});

  registry.register({ name:"cat",    category:"files", description:"Read file",
    handler:(_,r)=>{ if(!r){err("usage: 'cat <file>");return;}
      ps(shellCmd(`Get-Content "${r}"`, `cat "${r}"`)); }});

  registry.register({ name:"ls",     category:"files", description:"List directory",
    handler:(_,r)=>{
      ps(shellCmd(
        `Get-ChildItem "${r||"."}" | Format-Table Mode,LastWriteTime,@{N='Size';E={if($_.PSIsContainer){'<dir>'}else{"$([math]::Round($_.Length/1KB,1))KB"}}},Name -AutoSize`,
        `ls -la "${r||"."}"`
      )); }});

  registry.register({ name:"dir",    category:"files", description:"List directory",
    handler:(_,r)=>{
      ps(shellCmd(
        `Get-ChildItem "${r||"."}" | Format-Table Mode,LastWriteTime,@{N='Size';E={if($_.PSIsContainer){'<dir>'}else{"$([math]::Round($_.Length/1KB,1))KB"}}},Name -AutoSize`,
        `ls -la "${r||"."}"`
      )); }});

  registry.register({ name:"cd",     category:"files", description:"Change directory",
    handler:(_,r)=>{
      ps(shellCmd(
        `Set-Location "${r||"~"}"; Write-Host (" > " + (Get-Location).Path)`,
        `cd "${r||"~"}" && pwd`
      )); }});

  registry.register({ name:"pwd",    category:"files", description:"Print working directory",
    handler:()=> ps(shellCmd(`Write-Host (Get-Location).Path`, `pwd`)) });

  registry.register({ name:"cp",     category:"files", description:"Copy",
    handler:(a)=>{ if(a.length<2){err("usage: 'cp <src> <dst>");return;}
      ps(shellCmd(`Copy-Item -Path "${a[0]}" -Destination "${a[1]}" -Recurse; Write-Host "copied"`,
                  `cp -r "${a[0]}" "${a[1]}" && echo "copied"`)); }});

  registry.register({ name:"mv",     category:"files", description:"Move / rename",
    handler:(a)=>{ if(a.length<2){err("usage: 'mv <src> <dst>");return;}
      ps(shellCmd(`Move-Item -Path "${a[0]}" -Destination "${a[1]}"; Write-Host "moved"`,
                  `mv "${a[0]}" "${a[1]}" && echo "moved"`)); }});

  registry.register({ name:"write",  category:"files", description:"Write text to file",
    handler:(a,r)=>{ if(!a[0]){err("usage: 'write <file> [text]");return;}
      const c=a.slice(1).join(" ");
      if(c) ps(shellCmd(`Set-Content -Path "${a[0]}" -Value '${c.replace(/'/g,"''")}' -Encoding UTF8; Write-Host "wrote: ${a[0]}"`,
                        `echo '${c}' > "${a[0]}" && echo "wrote: ${a[0]}"`));
      else  ps(shellCmd(`New-Item -ItemType File -Path "${a[0]}" -Force | Out-Null; Write-Host "created: ${a[0]}"`,
                        `touch "${a[0]}" && echo "created: ${a[0]}"`)); }});

  registry.register({ name:"append", category:"files", description:"Append text to file",
    handler:(a)=>{ if(a.length<2){err("usage: 'append <file> <text>");return;}
      ps(shellCmd(`Add-Content -Path "${a[0]}" -Value '${a.slice(1).join(" ").replace(/'/g,"''")}' -Encoding UTF8; Write-Host "appended"`,
                  `echo '${a.slice(1).join(" ")}' >> "${a[0]}" && echo "appended"`)); }});

  registry.register({ name:"hash",   category:"files", description:"SHA256 of file",
    handler:(_,r)=>{ if(!r){err("usage: 'hash <file>");return;}
      ps(shellCmd(`Get-FileHash "${r}" | Format-Table Algorithm,Hash`,
                  `sha256sum "${r}"`)); }});

  registry.register({ name:"size",   category:"files", description:"Size of path",
    handler:(_,r)=>{ if(!r){err("usage: 'size <path>");return;}
      ps(shellCmd(
        `$s=Get-ChildItem -Recurse "${r}" -EA SilentlyContinue|Measure-Object -Property Length -Sum;Write-Host "$([math]::Round($s.Sum/1MB,2)) MB ($($s.Count) files)"`,
        `du -sh "${r}"`
      )); }});

  registry.register({ name:"edit",   category:"files", description:"Open in built-in editor",
    handler:(_,r)=>{ if(!r){err("usage: 'edit <file>");return;} _ctxRef.current?.openEditor(r); ok(`opening ${r}`); }});

  registry.register({ name:"update", category:"files", description:"Check for a newer OXIS release",
    handler:()=>{
      ok("checking gitlab.com/oxidelab/oxis for a newer release...");
      checkForUpdate().then(info => {
        if (!info.available) { ok(`up to date (${info.current || "dev build"})`); return; }
        ok(`update available: ${info.current || "current"} → ${info.latest}`);
        if (info.downloadUrl) openUrl(info.downloadUrl);
        else if (info.releaseUrl) openUrl(info.releaseUrl);
      }).catch(() => err("update check failed — check your connection"));
    }});

  // ── shell ─────────────────────────────────────────────
  registry.register({ name:"clear",   category:"shell", description:"Clear terminal output",
    handler:()=>_ctxRef.current?.clear() });

  registry.register({ name:"cls",     category:"shell", description:"Clear terminal output",
    handler:()=>_ctxRef.current?.clear() });

  registry.register({ name:"home",    category:"shell", description:"Return to OXIS home screen",
    handler:()=>_goHomeRef.current?.() });

  registry.register({ name:"run",     category:"shell", description:"Run raw command",
    handler:(_,r)=>{ if(!r){err("usage: 'run <cmd>");return;} ps(r); }});

  registry.register({ name:"env",     category:"shell", description:"Environment variables",
    handler:()=> ps(shellCmd(
      `Get-ChildItem Env: | Sort-Object Name | Format-Table Name,Value -AutoSize`,
      `env | sort`
    ))});

  registry.register({ name:"ps",      category:"shell", description:"Running processes",
    handler:()=> ps(shellCmd(
      `Get-Process | Sort-Object CPU -Descending | Select-Object -First 25 Name,Id,@{N='CPU';E={[math]::Round($_.CPU,1)}},@{N='RAM(MB)';E={[math]::Round($_.WorkingSet/1MB,0)}} | Format-Table -AutoSize`,
      `ps aux --sort=-%cpu | head -26`
    ))});

  registry.register({ name:"procs",   category:"shell", description:"Running processes",
    handler:()=> registry.execute("ps",[],"") });

  registry.register({ name:"kill",    category:"shell", description:"Kill process by PID or name",
    handler:(_,r)=>{ if(!r){err("usage: 'kill <pid|name>");return;}
      ps(shellCmd(
        isNaN(+r)
          ? `Stop-Process -Name "${r}" -Force -EA SilentlyContinue; Write-Host "killed: ${r}"`
          : `Stop-Process -Id ${r} -Force -EA SilentlyContinue; Write-Host "killed PID: ${r}"`,
        `kill ${isNaN(+r)?`$(pgrep "${r}")`:`${r}`} && echo "killed: ${r}"`
      )); }});

  registry.register({ name:"ip",      category:"shell", description:"Network addresses",
    handler:()=> ps(shellCmd(
      `Get-NetIPAddress | Where-Object{$_.AddressFamily -eq 'IPv4'} | Select-Object IPAddress,InterfaceAlias | Format-Table -AutoSize`,
      `ip addr show || ifconfig`
    ))});

  registry.register({ name:"disk",    category:"shell", description:"Disk usage",
    handler:()=> ps(shellCmd(
      `Get-PSDrive -PSProvider FileSystem | Where-Object{$_.Used -ne $null} | Select-Object Name,@{N='Used(GB)';E={[math]::Round($_.Used/1GB,1)}},@{N='Free(GB)';E={[math]::Round($_.Free/1GB,1)}},@{N='Total(GB)';E={[math]::Round(($_.Used+$_.Free)/1GB,1)}} | Format-Table -AutoSize`,
      `df -h`
    ))});

  registry.register({ name:"sysinfo", category:"shell", description:"System information",
    handler:()=> ps(shellCmd(
      `$o=Get-CimInstance Win32_OperatingSystem;$c=Get-CimInstance Win32_Processor|Select -First 1;Write-Host "OS:    $($o.Caption)";Write-Host "CPU:   $($c.Name)";Write-Host "Cores: $($c.NumberOfCores)/$($c.NumberOfLogicalProcessors) logical";Write-Host "RAM:   $([math]::Round($o.TotalVisibleMemorySize/1MB,1))GB total  $([math]::Round($o.FreePhysicalMemory/1MB,1))GB free";Write-Host "Host:  $($o.CSName)"`,
      `uname -a && lscpu | head -10 && free -h`
    ))});

  registry.register({ name:"which",   category:"shell", description:"Find command in PATH",
    handler:(_,r)=>{ if(!r){err("usage: 'which <cmd>");return;}
      ps(shellCmd(`Get-Command "${r}" -EA SilentlyContinue | Select-Object -ExpandProperty Source`,
                  `which "${r}"`)); }});

  registry.register({ name:"find",    category:"shell", description:"Search files by name",
    handler:(_,r)=>
      ps(shellCmd(
        `Get-ChildItem -Recurse -EA SilentlyContinue | Where-Object Name -like '*${r||""}*' | Select-Object -First 60 -ExpandProperty FullName`,
        `find . -name '*${r||""}*' 2>/dev/null | head -60`
      ))});

  registry.register({ name:"grep",    category:"shell", description:"Search file contents",
    handler:(a,r)=>{ if(a.length<2){err("usage: 'grep <pattern> <file>");return;}
      ps(shellCmd(
        `Select-String -Pattern "${a[0]}" -Path "${a.slice(1).join(" ")}"`,
        `grep -rn "${a[0]}" ${a.slice(1).join(" ")}`
      )); }});

  registry.register({ name:"history", category:"shell", description:"Command history",
    handler:()=>{ history.recent(40).forEach((c,i)=>info(`${String(i+1).padStart(3)}  ${c}`)); }});

  registry.register({ name:"hist",    category:"shell", description:"Command history",
    handler:()=> registry.execute("history",[],"") });

  registry.register({ name:"ports",   category:"shell", description:"Listening ports",
    handler:()=> ps(shellCmd(
      `Get-NetTCPConnection | Where-Object State -eq 'Listen' | Sort-Object LocalPort | Select-Object LocalPort,@{N='Process';E={(Get-Process -Id $_.OwningProcess -EA SilentlyContinue).Name}} | Format-Table -AutoSize`,
      `ss -tlnp || netstat -tlnp 2>/dev/null | head -30`
    ))});

  registry.register({ name:"user",    category:"shell", description:"Current user",
    handler:()=> ps(shellCmd(`Write-Host "$env:USERDOMAIN\\$env:USERNAME"`, `whoami`)) });

  registry.register({ name:"path",    category:"shell", description:"PATH entries",
    handler:()=> ps(shellCmd(
      `$env:PATH -split ';' | ForEach-Object { Write-Host $_ }`,
      `echo $PATH | tr ':' '\n'`
    ))});

  registry.register({ name:"alias",   category:"shell", description:"Shell aliases",
    handler:()=> ps(shellCmd(
      `Get-Alias | Format-Table Name,ResolvedCommand -AutoSize | Select-Object -First 30`,
      `alias`
    ))});

  registry.register({ name:"open",    category:"shell", description:"Open file with default app",
    handler:(_,r)=>{ if(!r){err("usage: 'open <file>");return;}
      ps(shellCmd(`Start-Process "${r}"`,
                  `xdg-open "${r}" 2>/dev/null || open "${r}" 2>/dev/null`)); }});

  // ── theme ─────────────────────────────────────────────
  registry.register({ name:"theme",   category:"themes", description:"Manage themes",
    handler:(args,rest)=>{
      const all = themeManager.all();
      const cur = themeManager.getCurrent();
      if(!rest){ sep(); ctx.print("  Themes","accent"); sep();
        Object.keys(all).forEach(n=>ctx.print(`  ${n===cur?"●":"○"}  ${n}${n===cur?"  (active)":""}`,n===cur?"accent":"dim"));
        sep(); dim("'theme <name>  ·  'theme new <name>  ·  'theme delete <name>"); return; }
      if(args[0]==="new"){
        if(!args[1]){err("usage: 'theme new <name>");return;}
        events.emit("open_theme_editor",{name:args[1]}); return; }
      if(args[0]==="delete"||args[0]==="del"){
        if(!args[1]){err("usage: 'theme delete <name>");return;}
        if(themeManager.builtins()[args[1]]){err(`cannot delete built-in: ${args[1]}`);return;}
        themeManager.removeCustom(args[1]); ok(`theme deleted: ${args[1]}`); return; }
      if(args[0]==="export"){
        const j=themeManager.export(args[1]); if(j) ctx.print(j,"dim"); else err(`not found: ${args[1]}`); return; }
      if(themeManager.apply(rest)) ok(`theme → ${rest}`);
      else err(`not found: '${rest}' — run 'theme to list`); }});

  // ── plugins ───────────────────────────────────────────
  registry.register({ name:"plugin",  category:"plugins", description:"Manage plugins",
    handler:(args)=>{
      const sub=args[0]?.toLowerCase(); const name=args[1];
      const all=pluginManager.all();
      if(!sub||sub==="list"){
        sep(); ctx.print("  Plugins","accent"); sep();
        const cats=[...new Set(all.map(p=>p.category))];
        for(const cat of cats){
          ctx.print(`  ─ ${cat}`,"dim");
          all.filter(p=>p.category===cat).forEach(p=>
            ctx.print(`  ${p.enabled?"●":"○"}  ${p.name.padEnd(16)} ${p.desc}`,p.enabled?"accent":"dim"));
        }
        sep(); dim("'plugin enable <n>  ·  'plugin enable all  ·  'plugin disable <n>  ·  'plugin reload <n>  ·  'plugin delete <n>  ·  'plugin permissions <n>"); return; }
      if(sub==="enable"){
        if(!name){err("usage: 'plugin enable <name>");return;}
        if(name.toLowerCase()==="all"){
          const { enabled, alreadyOn, failed } = pluginManager.enableAll();
          if(enabled.length) ok(`enabled: ${enabled.join(", ")}`);
          if(alreadyOn.length) dim(`already on: ${alreadyOn.join(", ")}`);
          if(failed.length) err(`didn't load (see messages above): ${failed.join(", ")}`);
          if(!enabled.length && !alreadyOn.length && !failed.length) dim("no plugins registered");
          return; }
        if(!pluginManager.get(name)){ err(`not found: ${name}`); return; }
        pluginManager.enable(name);
        // enable() sets enabled=true optimistically, then load() may
        // set it straight back to false (exec error / undocumented
        // command) and print exactly why — check the real state
        // rather than assuming "found the plugin" means "it's working".
        if(pluginManager.get(name)?.enabled) ok(`${name} enabled`);
        else err(`${name} didn't load — see the message above for why`);
        return; }
      if(sub==="disable"){
        if(!name){err("usage: 'plugin disable <name>");return;}
        if(pluginManager.disable(name)) ok(`${name} disabled`); else err(`not found: ${name}`); return; }
      if(sub==="reload"){
        if(!name){err("usage: 'plugin reload <name>");return;}
        if(!pluginManager.get(name)){ err(`not found: ${name}`); return; }
        pluginManager.reload(name);
        if(pluginManager.get(name)?.enabled) ok(`${name} reloaded`);
        else err(`${name} didn't reload cleanly — see the message above for why`);
        return; }
      if(sub==="reloadall"){ pluginManager.reloadAll(); ok("all plugins reloaded"); return; }
      if(sub==="new"){
        if(!name){err("usage: 'plugin new <name>");return;}
        events.emit("open_plugin_creator",{name}); return; }
      if(sub==="delete"||sub==="rm"){
        if(!name){err(`usage: 'plugin ${sub} <name>`);return;}
        const p=pluginManager.get(name);
        if(!p){ err(`not found: ${name}`); return; }
        if(p.builtin){ err(`${name} is a built-in plugin — 'plugin disable it instead`); return; }
        pluginManager.remove(name).then(()=>ok(`deleted ${name}`));
        return; }
      if(sub==="permissions"||sub==="perms"){
        // 'plugin permissions <name>                 — list grants
        // 'plugin permissions <name> grant  <ns>      — grant fs/process/net/system
        // 'plugin permissions <name> revoke <ns>      — revoke it
        if(!name){err("usage: 'plugin permissions <name> [grant|revoke <fs|process|net|system>]");return;}
        const action = args[2]?.toLowerCase();
        const ns = args[3]?.toLowerCase() as PermissionNamespace | undefined;
        const VALID: PermissionNamespace[] = ["fs","process","net","system"];
        if(action==="grant"||action==="revoke"){
          if(!ns || !VALID.includes(ns)){ err(`usage: 'plugin permissions ${name} ${action} <fs|process|net|system>`); return; }
          if(action==="grant") grantPermission(name, ns); else revokePermission(name, ns);
          ok(`${name}: ${ns} ${action==="grant"?"granted":"revoked"}`);
          return;
        }
        const granted = grantedPermissions(name);
        sep(); ctx.print(`  Permissions — ${name}`,"accent"); sep();
        for(const v of VALID) ctx.print(`  ${granted.includes(v)?"●":"○"}  ${v}`, granted.includes(v)?"accent":"dim");
        sep(); dim(`'plugin permissions ${name} grant <ns>  ·  'plugin permissions ${name} revoke <ns>`);
        return; }
      err(`unknown: 'plugin ${sub}`); }});

  // ── plugin marketplace (oxis-market.pages.dev) ─────────
  registry.register({ name:"market",  category:"plugins", description:"Browse and install plugins from oxis-market.pages.dev",
    handler:(args)=>{
      const sub = args[0]?.toLowerCase();
      const rest = args.slice(1).join(" ");

      if (!sub || sub === "list") {
        market.fetchIndex().then(entries => {
          sep(); ctx.print(`  OXIS Market  ·  ${market.MARKET_BASE}`, "accent"); sep();
          if (!entries.length) { dim("(no plugins listed)"); sep(); return; }
          const cats = [...new Set(entries.map(e => e.category))];
          for (const cat of cats) {
            ctx.print(`  ─ ${cat}`, "dim");
            entries.filter(e => e.category === cat).forEach(e => {
              const badge = e.comingSoon ? "  (coming soon)" : e.premium ? `  (${e.priceDisplay || "premium"})` : "";
              ctx.print(`  ○  ${e.name.padEnd(16)} ${e.desc}${e.author ? `  (by ${e.author})` : ""}${badge}`, e.comingSoon ? "dim" : "dim");
            });
          }
          sep(); dim("'market install <n>  ·  'market search <query>  ·  'market info <n>  ·  'market open  ·  'market subscribe <n>  ·  'market license <email>");
        }).catch(e => err(`marketplace unreachable: ${e instanceof Error ? e.message : e}`));
        return;
      }

      if (sub === "search") {
        if (!rest) { err("usage: 'market search <query>"); return; }
        market.fetchIndex().then(entries => {
          const hits = market.searchIndex(entries, rest);
          sep(); ctx.print(`  Marketplace search: "${rest}"`, "accent"); sep();
          if (!hits.length) { dim("(no matches)"); sep(); return; }
          hits.forEach(e => ctx.print(`  ○  ${e.name.padEnd(16)} ${e.desc}`, "dim"));
          sep();
        }).catch(e => err(`marketplace unreachable: ${e instanceof Error ? e.message : e}`));
        return;
      }

      if (sub === "info") {
        const name = args[1];
        if (!name) { err("usage: 'market info <n>"); return; }
        market.findEntry(name).then(entry => {
          if (!entry) { err(`not found in marketplace: ${name}`); return; }
          sep(); ctx.print(`  ${entry.name}`, "accent");
          dim(entry.desc);
          dim(`category: ${entry.category}${entry.version ? `  ·  v${entry.version}` : ""}${entry.author ? `  ·  by ${entry.author}` : ""}`);
          sep(); dim(`'market install ${entry.name}`);
        }).catch(e => err(`marketplace unreachable: ${e instanceof Error ? e.message : e}`));
        return;
      }

      if (sub === "install") {
        const name = args[1];
        if (!name) { err("usage: 'market install <n>"); return; }
        info(`installing ${name}…`);
        market.findEntry(name).then(entry => {
          if (!entry) { err(`not found in marketplace: ${name}`); return; }
          if (entry.comingSoon) { dim(`${name} isn't available yet — coming in a future update`); return; }
          if (entry.premium) {
            // Premium install path: verify the Stripe-issued license,
            // fetch source over HTTPS (never a public static file —
            // see premium-plugin.js), encrypt it locally, register it.
            market.installPremium(name)
              .then(() => ok(`${name} installed & unlocked — 'plugin disable ${name} to turn off`))
              .catch(e => err(`premium install failed: ${e instanceof Error ? e.message : e}`));
            return;
          }
          market.install(name)
            .then(({ entry, persisted, persistError }) => {
              // addLuaPlugin() (inside market.install) calls load()
              // synchronously before the disk write, so by the time
              // this resolves the plugin's real final state is already
              // settled — check it instead of assuming "downloaded"
              // means "working". A plugin that fails to execute, or
              // fails the description-compliance check, disables itself
              // inside load() and already printed exactly why above.
              const p = pluginManager.get(entry.name);
              if (p?.enabled) {
                ok(`installed & enabled ${entry.name} — 'plugin disable ${entry.name} to turn off`);
                if (!persisted) {
                  dim(`  (works this session, but couldn't save to disk${persistError ? `: ${persistError}` : ""})`);
                }
              } else {
                err(`downloaded ${entry.name} but it didn't load — see the message above for why`);
              }
            })
            .catch(e => err(`install failed: ${e instanceof Error ? e.message : e}`));
        }).catch(e => err(`marketplace unreachable: ${e instanceof Error ? e.message : e}`));
        return;
      }

      // ── premium plugins — coming in v1.2.2, see README § OXIS
      // Market. The commands exist now (infrastructure is real —
      // Stripe Checkout, webhooks, KV licensing) but every listing is
      // marked comingSoon until account verification is complete.
      if (sub === "license") {
        const email = args[1];
        if (!email) {
          const cur = getLicensedEmail();
          info(cur ? `licensed email: ${cur}` : "no licensed email set — usage: 'market license <email>");
          return;
        }
        setLicensedEmail(email);
        ok(`licensed email set to ${email} — used to check premium plugin subscriptions`);
        return;
      }

      if (sub === "subscribe") {
        const name = args[1];
        if (!name) { err("usage: 'market subscribe <n>"); return; }
        market.findEntry(name).then(entry => {
          if (!entry) { err(`not found in marketplace: ${name}`); return; }
          if (!entry.premium) { err(`${name} is free — 'market install ${name}`); return; }
          if (entry.comingSoon) { dim(`${name} isn't available for subscription yet — coming in a future update`); return; }
          info(`starting checkout for ${name}…`);
          market.subscribe(name, getLicensedEmail() || undefined)
            .then(({ url }) => {
              ok(`opening checkout — complete it in your browser, then run 'market install ${name}`);
              void openUrl(url); // real system browser via Wails' BrowserOpenURL — see native.ts
            })
            .catch(e => err(`checkout failed: ${e instanceof Error ? e.message : e}`));
        }).catch(e => err(`marketplace unreachable: ${e instanceof Error ? e.message : e}`));
        return;
      }

      if (sub === "status") {
        const name = args[1];
        if (!name) { err("usage: 'market status <n>"); return; }
        checkLicense(name, { force: true }).then(r => {
          if (r.active) ok(`${name}: active (${r.status})`);
          else dim(`${name}: ${r.status}${r.error ? ` — ${r.error}` : ""}`);
        });
        return;
      }

      if (sub === "open") {
        void openUrl(market.MARKET_BASE);
        ok("opening the OXIS Market website — also bound to Ctrl+Shift+M");
        return;
      }

      err(`unknown: 'market ${sub}`); }});

  // ── task runner ───────────────────────────────────────
  registry.register({ name:"task",    category:"workspace", description:"Run a workspace task",
    handler:(args)=>{
      const name=args[0];
      if(!name){info("Usage: 'task <name>"); return;}
      if(!registry.execute(`task:${name}`,args.slice(1),args.slice(1).join(" ")))
        err(`task not found: ${name}`); }});

  // ── workspace ─────────────────────────────────────────
  // 'workspace init/info/reload/close — see workspaceManager.ts.
  // Uses the tracked shell cwd (cwdTracker) as "this directory" when
  // no explicit path is given, same directory 'edit/'open resolve
  // relative paths against.
  registry.register({ name:"workspace", category:"workspace", description:"Manage the active workspace (.oxis/workspace.lua)",
    handler:(args)=>{
      const sub = args[0]?.toLowerCase();
      const dir = args[1] || cwdTracker.get() || ".";
      if(!sub || sub==="info"){
        const r = workspaceManager.info();
        r.message.split("\n").forEach(line => (r.ok?info:dim)(line));
        if(!r.ok) dim("'workspace init to create one here");
        return; }
      if(sub==="init"){
        workspaceManager.initWorkspace(dir).then(r => (r.ok?ok:err)(r.message));
        return; }
      if(sub==="reload"){
        workspaceManager.reload(args[1]).then(r => (r.ok?ok:err)(r.message));
        return; }
      if(sub==="close"){
        const r = workspaceManager.close();
        (r.ok?ok:err)(r.message);
        return; }
      err(`unknown: 'workspace ${sub} — try init, info, reload, or close`); }});

  // ── history management ────────────────────────────────
  registry.register({ name:"histclear", category:"shell", description:"Clear command history",
    handler:()=>{ history.clear(); ok("history cleared"); }});

  // ── version / help ────────────────────────────────────
  registry.register({ name:"version", category:"info", description:"Version info",
    handler:()=>{ sep(); ctx.print("  OXIS  v1.2.1","accent");
      dim(`  Platform: ${isWindows()?"Windows / PowerShell":"Linux / bash"}`);
      dim("  Lua extensible · Browser rendered · Single binary");
      dim("  TERMINALS WERE THE BEGINNING."); sep(); }});

  registry.register({ name:"v",       category:"info", description:"Version info",
    handler:()=> registry.execute("version",[],"") });

  registry.register({ name:"help",    category:"info", description:"All commands — or 'help <plugin> for a single plugin's commands",
    handler:(args)=>{
      const pluginName = args[0];
      if (pluginName) {
        const p = pluginManager.get(pluginName);
        if (!p) { err(`no such plugin: ${pluginName} — run 'plugin list to see all`); return; }
        const cmds = registry.all()
          .filter(c => c.fromPlugin === pluginName)
          .sort((a, b) => a.name.localeCompare(b.name));
        sep(); ctx.print(`  ${p.name}  —  ${p.desc}`, "accent"); sep();
        if (!p.enabled) {
          dim(`plugin is disabled — run 'plugin enable ${p.name} to see its commands`); sep(); return;
        }
        if (!cmds.length) {
          dim("(this plugin registers no commands)"); sep(); return;
        }
        for (const c of cmds) {
          const label = c.name.startsWith("task:") ? `'task ${c.name.slice(5)}` : `'${c.name}`;
          h(label, c.description);
        }
        sep(); return;
      }
      sep(); ctx.print("  OXIS commands  (prefix: ')","accent"); sep();
      h("── files ────────────────────────────","");
      h("'ls [dir]","list directory"); h("'cd [dir]","change directory"); h("'pwd","current path");
      h("'cat <f>","read file"); h("'new / 'touch <f>","create file"); h("'mkdir <d>","create directory");
      h("'rm <p>","delete"); h("'cp <s> <d>","copy"); h("'mv <s> <d>","move/rename");
      h("'write <f> [text]","write file"); h("'append <f> <text>","append to file");
      h("'edit <f>","built-in editor"); h("'hash <f>","SHA256"); h("'size <p>","disk size"); h("'update","check for a newer release");
      info(""); h("── shell ─────────────────────────────","");
      h("'clear","clear output (keeps the banner)"); h("'run <cmd>","raw command"); h("'env","env vars");
      h("'ps","processes"); h("'kill <pid|name>","kill process"); h("'ip","network");
      h("'disk","disk usage"); h("'sysinfo","system info"); h("'which <cmd>","find command");
      h("'find [pat]","search files"); h("'grep <pat> <f>","search contents");
      h("'history","recent commands"); h("'histclear","clear history"); h("'ports","open ports");
      h("'user","current user"); h("'path","PATH entries"); h("'open <f>","open with default app");
      info(""); h("── themes ────────────────────────────","");
      h("'theme","list themes"); h("'theme <name>","switch theme");
      h("'theme new <n>","visual theme editor"); h("'theme delete <n>","delete custom theme");
      info(""); h("── plugins ───────────────────────────","");
      h("'plugin list","all plugins + status"); h("'plugin enable <n>","enable");
      h("'plugin enable all","enable every plugin"); h("'plugin disable <n>","disable"); h("'plugin reload <n>","reload");
      h("'plugin new <n>","create Lua plugin in-app");
      h("'plugin delete <n>","delete a user/market plugin's file");
      h("'help <n>","show one plugin's commands + what they do");
      h("'market list","browse the free OXIS Market"); h("'market search <q>","search the Market");
      h("'market info <n>","plugin details"); h("'market install <n>","install a Market plugin");
      info(""); h("── workspace ─────────────────────────","");
      h("'workspace init","create .oxis/workspace.lua in this directory");
      h("'workspace info","show the active workspace's state");
      h("'workspace reload","re-run .oxis/workspace.lua");
      h("'workspace close","unload the active workspace");
      h("'task <name>","run a workspace task (see .oxis/workspace.lua)");
      h("'version","version + platform info");
      sep(); dim(`Platform: ${isWindows()?"Windows":"Linux"} · Plugin shortcuts: gs, nb, dps, top…`); sep(); }});

  registry.register({ name:"?",       category:"info", description:"All commands",
    handler:()=> registry.execute("help",[],"") });
}

// ══════════════════════════════════════════════════════════════
// BUILT-IN EDITOR
// ══════════════════════════════════════════════════════════════
interface EditorFile { path: string; content: string; dirty: boolean; loading: boolean; loadError?: string; }

// ══════════════════════════════════════════════════════════════
// ERROR BOUNDARY — a render-time crash anywhere below this should
// never produce a silently blank pane (see the Editor's Normal-mode
// investigation: a blank screen with no error is much harder to
// diagnose than one that at least shows what threw). Wraps the
// Editor and PluginCreator, the two full-pane views most likely to
// hit an edge case (arbitrary file content, arbitrary Lua source).
// ══════════════════════════════════════════════════════════════
class ErrorBoundary extends React.Component<
  { children: React.ReactNode; onClose?: () => void },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode; onClose?: () => void }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[oxis:render-crash]", error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="editor">
          <div className="editor-bar">
            <div className="editor-bar-left">
              <span className="editor-icon">✗</span>
              <span className="editor-path">something crashed rendering this view</span>
            </div>
            <div className="editor-bar-right">
              {this.props.onClose && (
                <button className="editor-btn editor-btn--close" onClick={() => { this.setState({ error: null }); this.props.onClose?.(); }}>×</button>
              )}
            </div>
          </div>
          <div className="editor-error">
            {this.state.error.message}
            <span className="editor-error-detail">{this.state.error.stack}</span>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ══════════════════════════════════════════════════════════════
// CODE AREA — shared syntax-highlighted text area used by both the
// Editor and the Plugin Creator (see syntaxHighlight.ts). Classic
// "highlighted textarea" trick: a <pre> with highlighted spans sits
// behind a real <textarea> whose text is transparent but whose caret
// and selection stay visible, so typing/selecting/vim-motions keep
// working exactly as before — only the paint underneath changes.
// ══════════════════════════════════════════════════════════════
const CodeArea = React.forwardRef<HTMLTextAreaElement, {
  value: string;
  lang: EditorLang;
  className?: string;
  onChange?: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}>(function CodeArea({ value, lang, className, onChange, onKeyDown }, ref) {
  const preRef = useRef<HTMLPreElement>(null);

  const html = useMemo(() => {
    const h = highlight(value, lang);
    // Match a trailing newline so the highlight layer's height/scroll
    // extent lines up with the textarea's (otherwise the last empty
    // line makes them drift out of sync by one row).
    return value.endsWith("\n") ? h + "\n" : h;
  }, [value, lang]);

  const syncScroll = useCallback((e: React.UIEvent<HTMLTextAreaElement>) => {
    const pre = preRef.current;
    if (!pre) return;
    pre.scrollTop  = e.currentTarget.scrollTop;
    pre.scrollLeft = e.currentTarget.scrollLeft;
  }, []);

  return (
    <div className="code-area">
      <pre ref={preRef} className="code-area-highlight" aria-hidden="true">
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
      <textarea
        ref={ref}
        className={`code-area-input ${className ?? ""}`}
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onScroll={syncScroll}
        spellCheck={false}
        autoComplete="off" autoCorrect="off" autoCapitalize="off"
      />
    </div>
  );
});

function Editor({ file, onClose, onSave }: {
  file:    EditorFile;
  onClose: () => void;
  onSave:  (path: string, content: string) => void;
}) {
  const [content, setContent] = useState(file.content);
  const [dirty,   setDirty]   = useState(false);
  // Modal editing — Normal Mode is the default (see README § Input
  // Modes); 'i'/'a'/'o'/etc. drop into Insert, Escape returns to
  // Normal, 'v' starts Visual selection. Existing behavior (typing
  // immediately inserts text) now lives in Insert Mode.
  const [mode, setMode] = useState<EditorMode>("normal");
  const [anchor, setAnchor] = useState<number | null>(null);
  const pendingKeyRef = useRef<string>(""); // for two-key commands: dd, dw, gg
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Re-sync local content when a *different* file is opened, or when
  // the async ReadFile for the current file finishes loading. Watching
  // only file.path would miss the load-finished transition, since the
  // editor opens immediately with empty content while the read is
  // still in flight (see openEditor in the root component).
  useEffect(() => { setContent(file.content); setDirty(false); setMode("normal"); setAnchor(null); }, [file.path, file.loading]);
  useEffect(() => { if (!file.loading) setTimeout(() => taRef.current?.focus(), 40); }, [file.loading]);
  // Mode changes are visible to Lua plugins too (see README § Input
  // Modes — "Mode transitions fire events that plugins can subscribe
  // to"), and drive which `oxis.keymap(mode, ...)` binds are live.
  useEffect(() => {
    events.emit("mode_changed", { mode, context: "editor" });
    keybinds.setActiveMode(mode);
    return () => { keybinds.setActiveMode("normal"); }; // don't leak editor mode to the rest of the app on close
  }, [mode]);

  const save = useCallback(() => { onSave(file.path, content); setDirty(false); }, [file.path, content, onSave]);

  const setPos = useCallback((pos: number, keepAnchor = false) => {
    const ta = taRef.current;
    if (!ta) return;
    if (keepAnchor) {
      // Visual mode — extend the *real* browser selection from the
      // anchor to `pos` so the selected range is actually visible
      // (via ::selection) instead of only being tracked invisibly in
      // React state. `direction` records which end is the "active"
      // side so the next motion can recover the true cursor position
      // back out of selectionStart/selectionEnd (see handleModalKey).
      const a = anchor ?? pos;
      if (pos >= a) {
        requestAnimationFrame(() => ta.setSelectionRange(a, Math.min(pos + 1, content.length), "forward"));
      } else {
        requestAnimationFrame(() => ta.setSelectionRange(pos, Math.min(a + 1, content.length), "backward"));
      }
    } else {
      requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = pos; });
      setAnchor(null);
    }
  }, [anchor, content]);

  const applyEdit = useCallback((next: CursorState, opts?: { toInsert?: boolean }) => {
    setContent(next.content);
    if (next.content !== content) setDirty(true);
    requestAnimationFrame(() => {
      const ta = taRef.current; if (!ta) return;
      ta.selectionStart = ta.selectionEnd = next.pos;
    });
    if (opts?.toInsert) setMode("insert");
  }, [content]);

  // ── Normal / Visual mode command dispatch ────────────────────
  const handleModalKey = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Ctrl/Cmd combos (copy, select-all, browser/OXIS shortcuts, etc.)
    // are never Normal/Visual-mode commands here — only bare keys and
    // Shift are. Ctrl+S is handled a level up in onKeyDown before this
    // is even called.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const ta = taRef.current!;
    // In Visual mode, selectionStart/selectionEnd are a real range now
    // (see setPos), so the "current cursor" isn't always
    // selectionStart — it's whichever end is the active one, per
    // selectionDirection. Outside Visual mode there's never an active
    // range, so selectionStart alone is the caret as before.
    const pos = mode === "visual" && ta.selectionStart !== ta.selectionEnd
      ? (ta.selectionDirection === "backward" ? ta.selectionStart : ta.selectionEnd - 1)
      : ta.selectionStart;
    const cur: CursorState = { content, pos, anchor: mode === "visual" ? (anchor ?? pos) : undefined };
    const pending = pendingKeyRef.current;

    // Two-key sequences: dd / dw / gg
    if (pending === "d") {
      pendingKeyRef.current = "";
      e.preventDefault();
      if (e.key === "d") { applyEdit(deleteLine(cur)); return; }
      if (e.key === "w") { applyEdit(deleteWord(cur)); return; }
      return; // unrecognised — drop the pending 'd'
    }
    if (pending === "g") {
      pendingKeyRef.current = "";
      e.preventDefault();
      if (e.key === "g") { setPos(moveDocStart()); return; }
      return;
    }

    switch (e.key) {
      case "Escape":
        e.preventDefault();
        if (mode === "visual") { setPos(pos); setMode("normal"); return; }
        if (dirty && !confirm("Discard unsaved changes?")) return;
        onClose();
        return;
      case "i": e.preventDefault(); setMode("insert"); return;
      case "a": e.preventDefault(); setPos(moveRight(cur)); setMode("insert"); return;
      case "A": e.preventDefault(); setPos(moveLineEnd(cur)); setMode("insert"); return;
      case "I": e.preventDefault(); setPos(moveLineStart(cur)); setMode("insert"); return;
      case "o": e.preventDefault(); applyEdit(openLineBelow(cur), { toInsert: true }); return;
      case "O": e.preventDefault(); applyEdit(openLineAbove(cur), { toInsert: true }); return;
      case "v":
        if (e.ctrlKey || e.metaKey) return; // let Ctrl/Cmd+V paste through
        e.preventDefault();
        if (mode === "visual") { setPos(pos); setMode("normal"); }
        else { setAnchor(pos); setMode("visual"); }
        return;
      case "h": case "ArrowLeft":  e.preventDefault(); setPos(moveLeft(cur),  mode === "visual"); return;
      case "l": case "ArrowRight": e.preventDefault(); setPos(moveRight(cur), mode === "visual"); return;
      case "j": case "ArrowDown":  e.preventDefault(); setPos(moveDown(cur),  mode === "visual"); return;
      case "k": case "ArrowUp":    e.preventDefault(); setPos(moveUp(cur),    mode === "visual"); return;
      case "0": e.preventDefault(); setPos(moveLineStart(cur), mode === "visual"); return;
      case "$": e.preventDefault(); setPos(moveLineEnd(cur),   mode === "visual"); return;
      case "G": e.preventDefault(); setPos(moveDocEnd(cur),    mode === "visual"); return;
      case "w": e.preventDefault(); setPos(moveWordForward(cur), mode === "visual"); return;
      case "b": e.preventDefault(); setPos(moveWordBackward(cur), mode === "visual"); return;
      case "g": e.preventDefault(); pendingKeyRef.current = "g"; return;
      case "x":
        e.preventDefault();
        if (mode === "visual") { applyEdit(deleteSelection(cur)); setMode("normal"); setAnchor(null); }
        else applyEdit(deleteChar(cur));
        return;
      case "d":
        e.preventDefault();
        if (mode === "visual") { applyEdit(deleteSelection(cur)); setMode("normal"); setAnchor(null); }
        else pendingKeyRef.current = "d";
        return;
      case "y":
        if (mode === "visual") {
          e.preventDefault();
          navigator.clipboard?.writeText(selectedText(cur)).catch(() => { /* clipboard unavailable */ });
          setPos(pos); setMode("normal");
        }
        return;
      case "Tab": {
        e.preventDefault();
        const s = ta.selectionStart, en = ta.selectionEnd;
        const next = content.slice(0, s) + "  " + content.slice(en);
        setContent(next); setDirty(true);
        requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = s + 2; });
        return;
      }
      default:
        // Swallow ordinary characters in Normal/Visual mode — this is
        // the whole point of the mode: typing "hello" navigates
        // (h, then nothing bound to 'e'/'l'/'o' — a fuller
        // implementation would map more keys) rather than inserting
        // text. Ctrl/Alt/Meta combos and function keys pass through
        // untouched so shortcuts like Ctrl+S below still work.
        if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) e.preventDefault();
        return;
    }
  }, [content, mode, anchor, dirty, onClose, applyEdit, setPos]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.ctrlKey && e.key === "s") { e.preventDefault(); save(); return; }

    if (mode !== "insert") { handleModalKey(e); return; }

    // Insert Mode — ordinary typing, same behavior as before modes existed.
    if (e.key === "Escape") {
      e.preventDefault();
      const ta = taRef.current!;
      setPos(Math.max(0, ta.selectionStart - 1));
      setMode("normal");
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const ta = taRef.current!;
      const s = ta.selectionStart, en = ta.selectionEnd;
      const next = content.slice(0, s) + "  " + content.slice(en);
      setContent(next); setDirty(true);
      requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = s + 2; });
    }
  }, [save, mode, handleModalKey, content, setPos]);

  if (file.loading) {
    return (
      <div className="editor">
        <div className="editor-bar">
          <div className="editor-bar-left">
            <span className="editor-icon">◻</span>
            <span className="editor-path">{file.path}</span>
          </div>
          <div className="editor-bar-right">
            <button className="editor-btn editor-btn--close" onClick={onClose}>×</button>
          </div>
        </div>
        <div className="editor-loading">loading…</div>
      </div>
    );
  }

  if (file.loadError) {
    return (
      <div className="editor">
        <div className="editor-bar">
          <div className="editor-bar-left">
            <span className="editor-icon">◻</span>
            <span className="editor-path">{file.path}</span>
          </div>
          <div className="editor-bar-right">
            <button className="editor-btn editor-btn--close" onClick={onClose}>×</button>
          </div>
        </div>
        <div className="editor-error">
          ✗  couldn't open {file.path}
          <span className="editor-error-detail">{file.loadError}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="editor">
      <div className="editor-bar">
        <div className="editor-bar-left">
          <span className="editor-icon">◻</span>
          <span className="editor-path">{file.path}</span>
          {dirty && <span className="editor-dirty">●</span>}
        </div>
        <div className="editor-bar-right">
          <span className={`editor-mode editor-mode--${mode}`}>{mode.toUpperCase()}</span>
          <span className="editor-meta">{content.split("\n").length} lines</span>
          <button className="editor-btn" onClick={save}>save</button>
          <button className="editor-btn editor-btn--close" onClick={() => {
            if (dirty && !confirm("Discard unsaved changes?")) return;
            onClose();
          }}>×</button>
        </div>
      </div>
      <CodeArea ref={taRef} className={`editor-ta editor-ta--${mode}`} value={content}
        lang={detectLang(file.path)}
        onChange={e => { if (mode === "insert") { setContent(e.target.value); setDirty(true); } }}
        onKeyDown={onKeyDown} />
      <div className="editor-footer">
        {mode === "insert" && <><span>Esc  normal mode</span><span>Ctrl+S  save</span><span>Tab  2 spaces</span></>}
        {mode === "normal" && <><span>i/a/o  insert</span><span>hjkl  move</span><span>v  visual</span><span>dd/dw/x  delete</span><span>Esc  close</span></>}
        {mode === "visual" && <><span>hjkl  extend</span><span>d/x  delete</span><span>y  yank</span><span>Esc  cancel</span></>}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// PLUGIN CREATOR — create Lua plugins inside OXIS
// ══════════════════════════════════════════════════════════════
const PLUGIN_TEMPLATE = (name: string) =>
`-- ${name}.lua — OXIS Lua plugin
-- Created in OXIS · edit and save, then run 'plugin reload ${name}

-- Register a command  (invoked with '${name})
oxis.command("${name}", function()
  oxis.echo("Hello from ${name}!")
end)

-- Run a shell command
oxis.command("${name}run", function()
  oxis.run("echo running ${name}")
end)

-- Listen to events
oxis.autocmd("ShellOpen", function()
  oxis.echo("${name} plugin ready")
end)

-- Define a keymap  (optional)
-- oxis.keymap("normal", "<C-1>", function()
--   oxis.run("echo keymap triggered")
-- end)

-- Define a task  (run with 'task ${name})
-- oxis.task("${name}-build", "npm run build")
`;

function PluginCreator({ name: initName, onClose }: { name: string; onClose: () => void }) {
  const [name,    setName]    = useState(initName);
  const [source,  setSource]  = useState(() => PLUGIN_TEMPLATE(initName));
  const [err,     setErr]     = useState("");
  const [saved,   setSaved]   = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { setTimeout(() => taRef.current?.focus(), 40); }, []);

  const save = () => {
    if (!name.trim()) { setErr("Plugin name required"); return; }
    if (!/^[a-z0-9_-]+$/i.test(name)) { setErr("Name: letters, numbers, - _ only"); return; }
    setErr("");
    pluginManager.addLuaPlugin(name, source).then(({ persisted, persistError }) => {
      if (persisted) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } else {
        setErr(persistError
          ? `Works this session, but couldn't save to disk: ${persistError}`
          : "Works this session, but couldn't save to disk (browser mode has no file access)");
      }
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.ctrlKey && e.key === "s") { e.preventDefault(); save(); return; }
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key === "Tab") {
      e.preventDefault();
      const ta = taRef.current!;
      const s = ta.selectionStart, en = ta.selectionEnd;
      const next = source.slice(0, s) + "  " + source.slice(en);
      setSource(next);
      requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = s + 2; });
    }
  };

  return (
    <div className="plugin-creator">
      <div className="editor-bar">
        <div className="editor-bar-left">
          <span className="editor-icon">⬡</span>
          <span className="editor-path">Plugin Creator</span>
        </div>
        <div className="editor-bar-right">
          <input className="pc-name-input" value={name}
            onChange={e => { setName(e.target.value); setSource(PLUGIN_TEMPLATE(e.target.value)); }}
            placeholder="plugin-name" maxLength={32} />
          {saved && <span className="pc-saved">✓ saved</span>}
          {err   && <span className="pc-err">{err}</span>}
          <button className="editor-btn" style={{color:"var(--purple3)"}} onClick={save}>save &amp; load</button>
          <button className="editor-btn editor-btn--close" onClick={onClose}>×</button>
        </div>
      </div>
      <CodeArea ref={taRef} className="editor-ta pc-ta" value={source} lang="lua"
        onChange={e => setSource(e.target.value)} onKeyDown={onKeyDown} />
      <div className="editor-footer">
        <span>Ctrl+S  save &amp; load</span>
        <span>Esc  close</span>
        <span>Tab  2 spaces</span>
        <span style={{color:"var(--dim)"}}>saved to localStorage · reload with 'plugin reload {name}</span>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// THEME EDITOR — fixed, fully functional
// ══════════════════════════════════════════════════════════════
const THEME_FIELDS: [keyof Theme, string, string][] = [
  ["bg",      "Background",        "bg"],
  ["bg1",     "Background 1",      "titlebar/tabs"],
  ["bg2",     "Background 2",      "cards/inputs"],
  ["bg3",     "Background 3",      "hover/buttons"],
  ["bg4",     "Background 4",      "scrollbars"],
  ["border",  "Border",            "subtle borders"],
  ["border2", "Border Accent",     "active/focus borders"],
  ["text",    "Text",              "primary text"],
  ["muted",   "Muted",             "secondary text"],
  ["dim",     "Dim",               "placeholders"],
  ["comment", "Comment",           "faint/disabled text"],
  ["purple",  "Accent",            "banner, prompts, active tabs"],
  ["purple2", "Accent 2",          "active borders, status bar"],
  ["purple3", "Accent 3",          "ok messages, highlights"],
  ["grey",    "Grey",              "neutral text"],
  ["grey2",   "Grey 2",            "neutral dark"],
];

function ThemeEditor({ name: initName, onClose }: { name: string; onClose: () => void }) {
  const base = themeManager.get(themeManager.getCurrent()) ?? themeManager.get("default")!;
  const [name, setName] = useState(initName || "custom");
  const [vals, setVals] = useState<Theme>({ ...base });
  const [err,  setErr]  = useState("");
  const [ok,   setOk]   = useState(false);

  // Live preview on any change
  useEffect(() => { themeManager.applyRaw(vals); }, [vals]);

  // Restore theme on cancel
  const savedTheme = useRef(themeManager.getCurrent());
  const handleClose = useCallback(() => {
    themeManager.apply(savedTheme.current);
    onClose();
  }, [onClose]);

  const setColor = (k: keyof Theme, v: string) =>
    setVals(prev => ({ ...prev, [k]: v }));

  const save = () => {
    if (!name.trim()) { setErr("Name required"); return; }
    if (!/^[a-z0-9_-]+$/i.test(name)) { setErr("Letters, numbers, - _ only"); return; }
    const missing = themeManager.validate(vals);
    if (missing.length) { setErr(`Missing: ${missing.join(", ")}`); return; }
    themeManager.addCustom(name, vals);
    themeManager.apply(name);
    setErr(""); setOk(true);
    setTimeout(() => { setOk(false); onClose(); }, 800);
  };

  return (
    <div className="theme-editor">
      <div className="te-header">
        <span className="te-title">Theme Editor</span>
        <div className="te-header-right">
          <input
            className="te-name-input"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="theme-name"
            maxLength={32}
          />
          <button className="editor-btn editor-btn--close" onClick={handleClose}>×</button>
        </div>
      </div>

      <div className="te-scroll">
        {THEME_FIELDS.map(([key, label, hint]) => (
          <div className="te-row" key={key}>
            <div className="te-swatch" style={{ background: vals[key] as string }} />
            <input
              type="color"
              className="te-color"
              value={/^#[0-9a-f]{6}$/i.test(String(vals[key])) ? String(vals[key]) : "#000000"}
              onChange={e => setColor(key, e.target.value)}
            />
            <div className="te-label-group">
              <span className="te-label">{label}</span>
              <span className="te-hint">{hint}</span>
            </div>
            <input
              type="text"
              className="te-hex"
              value={vals[key] as string}
              onChange={e => setColor(key, e.target.value)}
              maxLength={9}
              spellCheck={false}
            />
          </div>
        ))}
      </div>

      <div className="te-footer">
        {err && <span className="te-err">{err}</span>}
        {ok  && <span className="te-ok">✓ saved</span>}
        <button className="te-btn te-btn--cancel" onClick={handleClose}>cancel</button>
        <button className="te-btn te-btn--save"   onClick={save}>save theme</button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// TERMINAL — fully polished input engine
// ══════════════════════════════════════════════════════════════
interface TermProps {
  id:          string;
  isActive:    boolean;
  onReady:     () => void;
  onNewTab:    () => void;
  onCloseTab:  () => void;
  onSwitchTab: (n: number) => void;
}

interface InputState { value: string; cursor: number; }

let _pluginsInited = false;

/**
 * ChimneySmoke / renderTrainRow
 *
 * The smoke used to be a separate absolutely-positioned block, sized
 * and offset by hand (ch units for `left`, row-height arithmetic for
 * `top`) to land on the chimney glyph ("[]") in whichever ASCII row
 * held it. That math had to be re-derived per call site (different
 * font-size, line-height, and even letter-spacing each time) and kept
 * coming out wrong in some context or other.
 *
 * Anchoring directly to the glyph sidesteps all of that: the "[]" is
 * wrapped in its own `position: relative; display: inline-block` span
 * (.oxis-chimney), and the smoke stack is rendered as an absolutely
 * positioned CHILD of that span, centered on it via `left:50%;
 * transform:translateX(-50%)` and anchored to its top edge via
 * `bottom:100%`. Wherever the browser lays out that "[]" — at any
 * font-size, any letter-spacing, any row height — the smoke lands
 * exactly there, because it's positioned relative to the glyph
 * itself rather than a guess about where the glyph will end up.
 */
function ChimneySmoke({ height }: { height: number }) {
  return (
    <span className="oxis-smoke-stack" style={{ height }} aria-hidden="true">
      <span className="puff puff-1">o</span>
      <span className="puff puff-2">O</span>
      <span className="puff puff-3">o</span>
      <span className="puff puff-4">O</span>
      <span className="puff puff-5">o</span>
      <span className="puff puff-6">O</span>
    </span>
  );
}

/** Renders one row of train ASCII art, splicing in ChimneySmoke at the
 *  "[]" if this row has one. `smokeHeight` controls how tall a plume
 *  ("how high the smoke can rise") fits the context — the shell boot
 *  banner's smaller art uses a shorter one (90) than the home screen
 *  and startup splash (110), which now share the same larger art size. */
function renderTrainRow(text: string, smokeHeight: number): React.ReactNode {
  const i = text.indexOf("[]");
  if (i === -1) return text || "\u00a0";
  return (
    <>
      {text.slice(0, i)}
      <span className="oxis-chimney">
        {"[]"}
        <ChimneySmoke height={smokeHeight} />
      </span>
      {text.slice(i + 2)}
    </>
  );
}

function Terminal({ id, isActive, onReady, onNewTab, onCloseTab, onSwitchTab }: TermProps) {
  // ── output state ─────────────────────────────────────────
  const [lines,      setLines]      = useState<Line[]>(() => bannerLines());
  const [ready,      setReady]      = useState(false);
  const [connErr,    setConnErr]    = useState("");

  // ── input visual state ────────────────────────────────────
  const [inputVal,    setInputVal]    = useState("");
  const [inputCursor, setInputCursor] = useState(0);

  // ── search state ──────────────────────────────────────────
  const [searching,    setSearching]    = useState(false);
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);

  // ── editor / plugin creator ───────────────────────────────
  const [editorFile,    setEditorFile]    = useState<EditorFile | null>(null);
  const [pluginCreator, setPluginCreator] = useState<string | null>(null);

  // ── refs ──────────────────────────────────────────────────
  const outRef        = useRef<HTMLDivElement>(null);
  const ghostRef      = useRef<HTMLTextAreaElement>(null);
  const session       = useRef<PtySession | null>(null);
  const pending       = useRef("");
  const mounted       = useRef(false);
  const inputRef      = useRef<InputState>({ value: "", cursor: 0 });
  const userScrolled  = useRef(false);
  const ctxRef        = useRef<ShellCtx | null>(null);
  const linesRef       = useRef<Line[]>(bannerLines());
  const suppressOutput = useRef(false);
  const bannerWheelId  = useRef<number | null>(null);

  // Capture the boot banner's wheel-row line id once, from whatever
  // was actually used to initialise `lines`, so the spin effect below
  // can target the right row without re-deriving the banner.
  useEffect(() => {
    const wheelLine = lines.find(l => l.kind === "banner-wheel");
    if (wheelLine) bannerWheelId.current = wheelLine.id;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "The train is moving" — cycle the boot banner's wheel glyphs
  // while the shell tab is visible, so the startup train reads as
  // rolling rather than parked (the home screen train stays static —
  // see .oxis-ascii-wheels in index.css).
  useEffect(() => {
    if (!isActive) return;
    let frame = 0;
    const t = setInterval(() => {
      frame++;
      const id = bannerWheelId.current;
      if (id == null) return;
      setLines(prev => {
        const idx = prev.findIndex(l => l.id === id);
        if (idx === -1) return prev;
        const next = prev.slice();
        next[idx] = { ...next[idx], text: trainWheelFrame(frame) };
        return next;
      });
    }, 130);
    return () => clearInterval(t);
  }, [isActive]);

  // ── restore scroll + focus when tab becomes visible ─────────
  useEffect(() => {
    if (!isActive) {
      userScrolled.current = false;
      return;
    }
    // Poll until scrollHeight > 0 (display:none → flex is async in the browser)
    let attempts = 0;
    const tryScroll = () => {
      const el = outRef.current;
      if (el && el.scrollHeight > 50) {
        el.scrollTop = el.scrollHeight;
        ghostRef.current?.focus({ preventScroll: true });
      } else if (attempts++ < 10) {
        requestAnimationFrame(tryScroll);
      }
    };
    requestAnimationFrame(tryScroll);
  }, [isActive]);

  // ── input sync ────────────────────────────────────────────
  const syncInput = useCallback((val: string, cur: number) => {
    inputRef.current = { value: val, cursor: cur };
    setInputVal(val);
    setInputCursor(cur);
  }, []);

  const clearInput = useCallback(() => syncInput("", 0), [syncInput]);

  // ── scroll ────────────────────────────────────────────────
  const scrollToBottom = useCallback((force = false) => {
    if (!force && userScrolled.current) return;
    requestAnimationFrame(() => {
      const el = outRef.current;
      if (el && el.scrollHeight > 0) el.scrollTop = el.scrollHeight;
    });
  }, []);

  const handleScroll = useCallback(() => {
    const el = outRef.current;
    if (!el) return;
    userScrolled.current = (el.scrollHeight - el.scrollTop - el.clientHeight) > 60;
  }, []);

  // ── output helpers ────────────────────────────────────────
  const addLine = useCallback((text: string, kind?: LineKind) => {
    setLines(prev => {
      const next = prev.length >= 10_000 ? prev.slice(-8_000) : prev;
      const result = [...next, mkLine(text, kind)];
      linesRef.current = result;
      return result;
    });
    scrollToBottom();
  }, [scrollToBottom]);

  const clear = useCallback(() => {
    // Keep the boot banner (the train ascii) -- only the scrollback below
    // it gets wiped. Filtering (rather than rebuilding a fresh banner)
    // preserves the exact same line objects/ids already tracked by the
    // wheel-spin effect above, so the animation just keeps going
    // uninterrupted instead of restarting or needing its ref re-pointed.
    setLines(prev => {
      const kept = prev.filter(l => l.kind === "banner" || l.kind === "banner-wheel");
      linesRef.current = kept;
      return kept;
    });
    pending.current      = "";
    userScrolled.current = false;
    // Also clear the PTY shell buffer (Ctrl+L)
    suppressOutput.current = true;
    setTimeout(() => { suppressOutput.current = false; }, 400);
    session.current?.write("");
    scrollToBottom(true);
  }, [scrollToBottom]);

  const sendToShell = useCallback((data: string) => {
    session.current?.write(data);
  }, []);

  const focusGhost = useCallback(() => {
    ghostRef.current?.focus({ preventScroll: true });
  }, []);

  // Refocus the hidden input on a plain click anywhere in the terminal
  // (output scrollback included) — but not when the mousedown/up was
  // actually a text-selection drag, so copy still works normally.
  const refocusUnlessSelecting = useCallback(() => {
    const sel = window.getSelection?.();
    if (sel && sel.toString().length > 0) return;
    focusGhost();
  }, [focusGhost]);

  // Restore focus to the input when the OS window regains focus
  // (alt-tab back in, click on the window from the taskbar) — without
  // this, the window can appear active but typing goes nowhere until
  // the terminal itself is clicked.
  useEffect(() => {
    if (!isActive) return;
    const onWindowFocus = () => {
      if (!editorFile && !pluginCreator) {
        setTimeout(() => ghostRef.current?.focus({ preventScroll: true }), 30);
      }
    };
    window.addEventListener("focus", onWindowFocus);
    return () => window.removeEventListener("focus", onWindowFocus);
  }, [isActive, editorFile, pluginCreator]);

  // ── PTY output ────────────────────────────────────────────
  const onOutput = useCallback((raw: string) => {
    // Always strip the cwd probe marker first — see cwdTracker.ts —
    // so it happens even during a suppressOutput window (startup
    // noise) instead of just being silently thrown away with it.
    raw = cwdTracker.consume(raw);
    if (suppressOutput.current) { pending.current = ""; return; }
    if (!raw) return;
    const { completedLines, newPending } = processOutput(raw, pending.current);
    pending.current = newPending;
    if (!completedLines.length) return;
    setLines(prev => {
      const next = mergeOutput(prev, completedLines);
      linesRef.current = next;
      return next;
    });
    scrollToBottom();
  }, [scrollToBottom]);

  // ── OXIS command dispatcher ───────────────────────────────
  const dispatchOxisCmd = useCallback((raw: string): boolean => {
    let body = raw.trim();
    if      (body.startsWith("'"))            body = body.slice(1).trimStart();
    else if (/^oxi(\s|$)/i.test(body))        body = body.replace(/^oxi\s*/i, "");
    else return false;

    if (!body) { addLine("  OXIS · type 'help for commands", "accent"); return true; }

    const parts = body.split(/\s+/);
    const verb  = parts[0].toLowerCase();
    const args  = parts.slice(1);
    const rest  = args.join(" ");
    // Keep ctx callbacks current before dispatch
    if (ctxRef.current) {
      ctxRef.current.send  = sendToShell;
      ctxRef.current.print = addLine;
      ctxRef.current.clear = clear;
    }
    return registry.execute(verb, args, rest);
  }, [addLine, sendToShell, clear]);

  // ── Run one command line through the same dispatch that real typed
  // Enter uses: checks for the "'"/"oxi" OXIS-command prefix and
  // routes to dispatchOxisCmd (with the same echo line), otherwise
  // forwards to the actual PTY shell. Shared by submit() (below) and
  // by ShellCtx.runLine, which is what the Home screen's command bar
  // now calls — it used to call ctxRef.current.send() directly, which
  // is the RAW PTY-write path with no OXIS-prefix handling at all, so
  // typing e.g. `'help` on the home screen sent the literal text
  // `'help` to the real OS shell (which has no idea what that means)
  // Send an invisible cwd probe (see cwdTracker.ts) and briefly
  // suppress rendered output so the probe's own echoed input line
  // doesn't show up in the scrollback. onOutput strips the marker
  // *before* checking suppressOutput, so the probe's actual answer
  // still gets through even during this window.
  const probeCwd = useCallback(() => {
    suppressOutput.current = true;
    sendToShell(buildCwdProbe(isWindows()) + "\r");
    setTimeout(() => { suppressOutput.current = false; }, 250);
  }, [sendToShell]);

  // instead of running the built-in help command.
  const runLine = useCallback((raw: string) => {
    const cmd = raw.trim();
    if (!cmd) { sendToShell("\r"); return; }
    history.push(cmd);

    const isOxis = cmd.startsWith("'") || /^oxi(\s|$)/i.test(cmd);
    if (isOxis) {
      const disp = cmd.startsWith("'")
        ? cmd.slice(1)
        : cmd.replace(/^oxi\s*/i, "");
      addLine("  '" + disp, "cmd");
      if (!dispatchOxisCmd(cmd)) addLine("  ✗  unknown command — type 'help", "err");
    } else {
      sendToShell(cmd + "\r");
      // Re-probe cwd after anything that plausibly changed it (cd,
      // Set-Location, pushd/popd, z…) — see README § Workspace System,
      // "OXIS must automatically detect and load a workspace when
      // entering/opening a project". A short delay lets the shell
      // actually finish the directory change first.
      if (looksLikeDirectoryChange(cmd)) setTimeout(probeCwd, 400);
    }
    scrollToBottom(true);
  }, [sendToShell, addLine, dispatchOxisCmd, scrollToBottom, probeCwd]);


  // ── PTY connect ───────────────────────────────────────────
  useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;

    session.current = openPty({
      cols: 220, rows: 50, onOutput,
      onReady: () => {
        pending.current = "";
        suppressOutput.current = true;
        setTimeout(() => { suppressOutput.current = false; }, 300);
        setReady(true);
        onReady();
        setTimeout(focusGhost, 60);
        events.emit("shell_started", { id });
        // Initial cwd probe — this is what makes automatic workspace
        // detection on launch actually automatic instead of requiring
        // the user to run 'workspace reload by hand.
        setTimeout(probeCwd, 500);

        // Background update check — once per app run, well after
        // startup (see _updateCheckedThisRun) so a slow/offline
        // gitlab.com never delays the shell becoming usable. Silent
        // when up to date; a single line (not a popup) when not, same
        // as every other passive notice in this terminal.
        if (!_updateCheckedThisRun) {
          _updateCheckedThisRun = true;
          setTimeout(() => {
            checkForUpdate().then(info => {
              if (info.available) {
                addLine(`  ↑  OXIS ${info.latest} is available (you're on ${info.current || "an older build"}) — run 'update to open it`, "info");
              }
            }).catch(() => {}); // silent — a background check should never surface as an error
          }, 2000);
        }
      },
      onExit: code => {
        if (code !== -1) setConnErr(`shell exited (code ${code})`);
        events.emit("shell_exited", { id, code });
      },
      onError: msg => setConnErr(msg),
    });
    return () => session.current?.kill();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── PTY resize ────────────────────────────────────────────
  useEffect(() => {
    const el = outRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const cols = Math.max(10, Math.floor(el.clientWidth  / 7.8));
      const rows = Math.max(5,  Math.floor(el.clientHeight / 20));
      session.current?.resize(cols, rows);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Plugin/command init (once ever) ──────────────────────
  useEffect(() => {
    // Wire real callbacks — overrides the stub set at root init
    ctxRef.current = {
      send: sendToShell,
      runLine,
      print: addLine,
      clear,
      openEditor: path => {
        setEditorFile({ path, content: "", dirty: false, loading: true });
        readFile(path)
          .then(content => setEditorFile(f => (f && f.path === path) ? { ...f, content, loading: false } : f))
          .catch(e => setEditorFile(f => (f && f.path === path)
            ? { ...f, loading: false, loadError: e instanceof Error ? e.message : String(e) }
            : f));
      },
      newTerminal: onNewTab,
    };
    _ctxRef.current = ctxRef.current;

    // Point the live-forwarding plugin API context at this real shell
    // (see forwardingApiCtx's comment above) — this is what actually
    // makes oxis.run()/oxis.echo() and every shortcut plugin's
    // commands work, for plugins that were already loaded before this
    // Terminal existed, not just ones loaded from here on.
    _apiCtxTarget.current = {
      sendToShell: sendToShell,
      print:       addLine,
      getCwd:      () => cwdTracker.get(),
      newTerminal: onNewTab,
      getOption:   readPersistedOption,
      setOption:   writePersistedOption,
      pluginName:  "__core__",
    };

    // Re-register commands with real ctx now that shell is live
    _commandsRegistered = false;
    registerBuiltinCommands(ctxRef.current);

    // Listen for open_plugin_creator event
    const unsub = events.on("open_plugin_creator", p => {
      if (p?.name) setPluginCreator(String(p.name));
    });
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep ctx callbacks fresh — also update module-level _ctxRef
  useEffect(() => {
    if (ctxRef.current) {
      ctxRef.current.send    = sendToShell;
      ctxRef.current.runLine = runLine;
      ctxRef.current.print   = addLine;
      ctxRef.current.clear   = clear;
    }
    _ctxRef.current = ctxRef.current;
  }, [sendToShell, runLine, addLine, clear]);

  useEffect(() => {
    const u1 = events.on("plugin_enable_request",  p => { if (p?.name) pluginManager.enable(String(p.name)); });
    const u2 = events.on("plugin_disable_request", p => { if (p?.name) pluginManager.disable(String(p.name)); });
    return () => { u1(); u2(); };
  }, []);

  // ── Submit ────────────────────────────────────────────────
  const submit = useCallback(() => {
    const cmd = inputRef.current.value.trim();
    clearInput();
    history.resetNav();
    runLine(cmd);
  }, [clearInput, runLine]);

  // ── Search helpers ────────────────────────────────────────
  const enterSearch = useCallback(() => {
    history.enterSearch();
    setSearching(true);
    setSearchResult(null);
  }, []);

  const exitSearch = useCallback((commit: boolean) => {
    if (commit && searchResult) {
      syncInput(searchResult.match, searchResult.match.length);
    }
    history.exitSearch();
    setSearching(false);
    setSearchResult(null);
  }, [searchResult, syncInput]);

  // ══════════════════════════════════════════════════════════
  // KEYBOARD ENGINE
  // Complete readline/bash/Emacs keybinding set
  // ══════════════════════════════════════════════════════════
  const onKey = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    const k    = e.key;
    const ctrl = e.ctrlKey  && !e.altKey;
    const alt  = e.altKey   && !e.ctrlKey;
    const { value: val, cursor: cur } = inputRef.current;

    // ── REVERSE SEARCH MODE ──────────────────────────────
    if (searching) {
      e.preventDefault();
      if (k === "Escape" || (ctrl && k.toLowerCase() === "g")) { exitSearch(false); return; }
      if (k === "Enter")                                        { exitSearch(true); submit(); return; }
      if (ctrl && k.toLowerCase() === "r")                     { const r = history.searchOlder(); if (r) setSearchResult(r); return; }
      if (k === "Backspace")  { setSearchResult(history.searchBackspace()); return; }
      if (k.length === 1)     { setSearchResult(history.searchAppend(k));   return; }
      return;
    }

    // ── TAB SWITCHING (global — works in any mode) ────────
    if (ctrl && k === "t") { e.preventDefault(); onNewTab();   return; }
    if (ctrl && k === "w") { e.preventDefault(); onCloseTab(); return; }
    if (ctrl && k >= "1" && k <= "9") { e.preventDefault(); onSwitchTab(+k - 1); return; }

    // ── PASSTHROUGH when input empty (program is running) ─
    if (!val) {
      const passSeq: Record<string, string> = {
        ArrowUp:"\x1b[A", ArrowDown:"\x1b[B", ArrowRight:"\x1b[C", ArrowLeft:"\x1b[D",
        Home:"\x1b[H", End:"\x1b[F",
        Delete:"\x1b[3~", PageUp:"\x1b[5~", PageDown:"\x1b[6~",
        Tab:"\t", Escape:"\x1b",
        F1:"\x1bOP",F2:"\x1bOQ",F3:"\x1bOR",F4:"\x1bOS",
        F5:"\x1b[15~",F6:"\x1b[17~",F7:"\x1b[18~",F8:"\x1b[19~",
        F9:"\x1b[20~",F10:"\x1b[21~",F11:"\x1b[23~",F12:"\x1b[24~",
      };
      if (passSeq[k]) { e.preventDefault(); sendToShell(passSeq[k]); return; }
    }

    // ── CTRL BINDINGS ─────────────────────────────────────
    if (ctrl) {
      switch (k.toLowerCase()) {
        // Interrupt / EOF / suspend
        case "c": e.preventDefault(); sendToShell("\x03"); clearInput(); history.resetNav(); return;
        case "d": e.preventDefault(); sendToShell("\x04"); return;
        case "z": e.preventDefault(); sendToShell("\x1a"); return;
        case "\\": e.preventDefault(); sendToShell("\x1c"); return;

        // Line editing
        case "a": e.preventDefault(); syncInput(val, 0);          return; // BOL
        case "e": e.preventDefault(); syncInput(val, val.length); return; // EOL
        case "f": e.preventDefault(); syncInput(val, Math.min(val.length, cur + 1)); return; // fwd char
        case "b": e.preventDefault(); syncInput(val, Math.max(0, cur - 1));          return; // back char
        case "h": e.preventDefault(); // Ctrl+H = Backspace
          if (cur > 0) syncInput(val.slice(0, cur - 1) + val.slice(cur), cur - 1);
          return;

        case "k": { // kill to end of line — save to yank buf
          e.preventDefault();
          const r = deleteToLineEnd(val, cur);
          setYankBuf(val.slice(cur));
          syncInput(r.text, r.pos);
          return;
        }
        case "u": { // kill to start of line — save to yank buf
          e.preventDefault();
          const r = deleteToLineStart(val, cur);
          setYankBuf(val.slice(0, cur));
          syncInput(r.text, r.pos);
          return;
        }
        case "w": { // delete word left — save to yank buf
          e.preventDefault();
          const r = deleteWordLeft(val, cur);
          setYankBuf(val.slice(wordLeft(val, cur), cur));
          syncInput(r.text, r.pos);
          return;
        }
        case "y": { // yank (paste from kill buffer)
          e.preventDefault();
          const yank = getYankBuf();
          if (!yank) return;
          syncInput(val.slice(0, cur) + yank + val.slice(cur), cur + yank.length);
          return;
        }
        case "t": { // transpose chars
          e.preventDefault();
          const r = transposeChars(val, cur);
          syncInput(r.text, r.pos);
          return;
        }
        case "l": e.preventDefault(); clear(); return; // clear screen

        case "r": e.preventDefault(); enterSearch(); return; // reverse search

        case "p": // previous history (like up arrow)
          e.preventDefault();
          { const p = history.prev(val); syncInput(p, p.length); return; }
        case "n": // next history (like down arrow)
          e.preventDefault();
          { const n = history.next(); syncInput(n, n.length); return; }

        case "v": return; // allow paste passthrough
      }
      return;
    }

    // ── ALT BINDINGS (word movement) ──────────────────────
    if (alt) {
      switch (k.toLowerCase()) {
        case "f":         e.preventDefault(); syncInput(val, wordRight(val, cur)); return;
        case "b":         e.preventDefault(); syncInput(val, wordLeft(val, cur));  return;
        case "d":         e.preventDefault(); { const r = deleteWordRight(val, cur); setYankBuf(val.slice(cur, wordRight(val, cur))); syncInput(r.text, r.pos); return; }
        case "backspace": e.preventDefault(); { const r = deleteWordLeft(val, cur);  setYankBuf(val.slice(wordLeft(val, cur), cur)); syncInput(r.text, r.pos); return; }
        case "<":         e.preventDefault(); syncInput(val, 0);          return; // BOF
        case ">":         e.preventDefault(); syncInput(val, val.length); return; // EOF
        case "t": { // transpose words
          e.preventDefault();
          const ls = wordLeft(val, cur);
          const le = wordRight(val, ls);
          const rs = wordLeft(val, wordRight(val, cur));
          const re = wordRight(val, rs);
          if (ls === rs) return;
          const w1 = val.slice(ls, le);
          const w2 = val.slice(rs, re);
          const next = val.slice(0, ls) + w2 + val.slice(le, rs) + w1 + val.slice(re);
          syncInput(next, re - (w1.length - w2.length));
          return;
        }
        case "u": { // uppercase word
          e.preventDefault();
          const end = wordRight(val, cur);
          syncInput(val.slice(0, cur) + val.slice(cur, end).toUpperCase() + val.slice(end), end);
          return;
        }
        case "l": { // lowercase word
          e.preventDefault();
          const end = wordRight(val, cur);
          syncInput(val.slice(0, cur) + val.slice(cur, end).toLowerCase() + val.slice(end), end);
          return;
        }
        case "c": { // capitalise word
          e.preventDefault();
          const end = wordRight(val, cur);
          const word = val.slice(cur, end);
          syncInput(val.slice(0, cur) + word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() + val.slice(end), end);
          return;
        }
      }
      return;
    }

    // ── NAVIGATION KEYS ───────────────────────────────────
    if (k === "ArrowLeft") {
      e.preventDefault();
      syncInput(val, e.ctrlKey ? wordLeft(val, cur) : Math.max(0, cur - 1));
      return;
    }
    if (k === "ArrowRight") {
      e.preventDefault();
      syncInput(val, e.ctrlKey ? wordRight(val, cur) : Math.min(val.length, cur + 1));
      return;
    }
    if (k === "ArrowUp") {
      e.preventDefault();
      const p = history.prev(val);
      syncInput(p, p.length);
      return;
    }
    if (k === "ArrowDown") {
      e.preventDefault();
      const n = history.next();
      syncInput(n, n.length);
      return;
    }
    if (k === "Home")   { e.preventDefault(); syncInput(val, 0);          return; }
    if (k === "End")    { e.preventDefault(); syncInput(val, val.length); return; }
    if (k === "Delete") {
      e.preventDefault();
      if (cur < val.length) syncInput(val.slice(0, cur) + val.slice(cur + 1), cur);
      return;
    }
    if (k === "PageUp")   { e.preventDefault(); outRef.current?.scrollBy(0, -300); return; }
    if (k === "PageDown") { e.preventDefault(); outRef.current?.scrollBy(0,  300); return; }

    if (k === "Tab") {
      e.preventDefault();
      // If buffer empty, pass tab to shell for completion
      if (!val) { sendToShell("\t"); return; }
      const next = val.slice(0, cur) + "  " + val.slice(cur);
      syncInput(next, cur + 2);
      return;
    }

    if (k === "Enter") {
      e.preventDefault();
      submit();
      return;
    }

    if (k === "Escape") {
      e.preventDefault();
      sendToShell("\x1b");
      return;
    }

    if (k === "Backspace") {
      e.preventDefault();
      if (cur > 0) {
        const next = val.slice(0, cur - 1) + val.slice(cur);
        syncInput(next, cur - 1);
        history.setDraft(next);
      }
      return;
    }

    // ── PRINTABLE ─────────────────────────────────────────
    if (k.length === 1 && !e.ctrlKey && !e.metaKey) {
      const next = val.slice(0, cur) + k + val.slice(cur);
      syncInput(next, cur + 1);
      history.setDraft(next);
    }
  }, [
    searching, searchResult, exitSearch, enterSearch, submit,
    syncInput, clearInput, sendToShell, addLine, clear,
    onNewTab, onCloseTab, onSwitchTab, scrollToBottom,
  ]);

  // ── Paste handler ─────────────────────────────────────────
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text");
    if (!text) return;
    if (text.includes("\n")) {
      const lns = text.split(/\r?\n/).filter(Boolean);
      if (lns.length > 1 && !window.confirm(`Paste ${lns.length} lines to shell?`)) return;
      clearInput();
      sendToShell(text);
      return;
    }
    const { value: val, cursor: cur } = inputRef.current;
    const next = val.slice(0, cur) + text + val.slice(cur);
    syncInput(next, cur + text.length);
  }, [syncInput, clearInput, sendToShell]);

  // ── Editor save — native file write, no PTY round-trip ────
  const editorSave = useCallback(async (path: string, content: string): Promise<boolean> => {
    try {
      await writeFile(path, content);
      addLine(`  ✓  saved: ${path}`, "ok");
      events.emit("editor_closed", { path });
      return true;
    } catch (e) {
      addLine(`  ✗  save failed: ${e instanceof Error ? e.message : String(e)}`, "err");
      return false;
    }
  }, [addLine]);

  // ── Render ────────────────────────────────────────────────
  // bannerEnd MUST be computed unconditionally, before the editor/
  // plugin-creator early returns below — it's a hook, and calling it
  // only on the "normal" render path (skipped whenever editorFile or
  // pluginCreator is set) violates the Rules of Hooks: React sees a
  // different hook count between renders and throws, which is what
  // was producing the blank screen when opening 'edit.
  const bannerEnd = useMemo(() => {
    let i = 0;
    while (i < lines.length && (lines[i].kind === "banner" || lines[i].kind === "banner-wheel")) i++;
    return i;
  }, [lines]);

  if (pluginCreator !== null) {
    return (
      <div className="app-pane">
        <ErrorBoundary onClose={() => setPluginCreator(null)}>
          <PluginCreator name={pluginCreator} onClose={() => { setPluginCreator(null); setTimeout(focusGhost, 50); }} />
        </ErrorBoundary>
      </div>
    );
  }

  if (editorFile) {
    return (
      <div className="app-pane">
        <ErrorBoundary onClose={() => setEditorFile(null)}>
          <Editor
            file={editorFile}
            onClose={() => { setEditorFile(null); setTimeout(focusGhost, 50); }}
            onSave={(p, c) => {
              editorSave(p, c).then(saved => {
                if (saved) setEditorFile(f => (f && f.path === p) ? { ...f, content: c, dirty: false } : f);
              });
            }}
          />
        </ErrorBoundary>
      </div>
    );
  }

  const beforeCursor = inputVal.slice(0, inputCursor);
  const atCursor     = inputVal[inputCursor] ?? "";
  const afterCursor  = inputVal.slice(inputCursor + (atCursor ? 1 : 0));
  const cursorChar   = atCursor || "\u00a0";

  // Boot banner (if 'clear hasn't wiped it) is always a contiguous
  // run at the very start of `lines` — see bannerLines()/clear().
  // It's split out into its own .term-banner-block wrapper (fit-content
  // width, so the centered rows don't stretch full-width) rather than
  // rendering directly in .term-out — see .oxis-chimney in index.css
  // for how the smoke itself anchors (to the "[]" glyph, not this
  // wrapper).
  const bannerPart = bannerEnd > 0 ? lines.slice(0, bannerEnd) : null;
  const restPart    = bannerEnd > 0 ? lines.slice(bannerEnd) : lines;

  return (
    <div className="term" onMouseUp={refocusUnlessSelecting}>
      {connErr && <div className="term-error">⚠ {connErr}</div>}

      <div className="term-out" ref={outRef} onScroll={handleScroll} tabIndex={-1}>
        {bannerPart && (
          <div className="term-banner-block">
            {bannerPart.map(line => (
              <div key={line.id} className="term-line term-line--banner"
                style={{ color: line.kind ? LINE_COLORS[line.kind] : undefined }}>
                {renderTrainRow(line.text, 90)}
              </div>
            ))}
          </div>
        )}
        {restPart.map(line => (
          <div key={line.id}
            className="term-line"
            style={{ color: line.kind ? LINE_COLORS[line.kind] : undefined }}>
            {line.text || "\u00a0"}
          </div>
        ))}

        {searching && (
          <div className="term-search-bar">
            <span className="term-search-label">reverse-i-search</span>
            <span className="term-search-sep">›</span>
            <span className="term-search-query">
              {history.getSearchQuery() || <span className="term-search-ph">type to search…</span>}
            </span>
            {searchResult && (
              <>
                <span className="term-search-sep">›</span>
                <span className="term-search-match">{searchResult.match}</span>
                <span className="term-search-count">{searchResult.rank}/{searchResult.total}</span>
              </>
            )}
            <span className="term-search-hint">Enter ·  Esc cancel · Ctrl+R older</span>
          </div>
        )}

        {!searching && (
          <div className="term-input-row">
            <span className="term-prompt">❯{"\u00a0"}</span>
            <span className="term-input-pre">{beforeCursor}</span>
            <span className={`term-caret ${ready ? "term-caret--on" : "term-caret--off"}`}>{cursorChar}</span>
            <span className="term-input-post">{afterCursor}</span>
          </div>
        )}
      </div>

      <textarea ref={ghostRef} className="term-ghost"
        value={inputVal} onChange={() => {}}
        onKeyDown={onKey} onPaste={handlePaste}
        spellCheck={false} autoComplete="off" autoCorrect="off" autoCapitalize="off"
        rows={1} tabIndex={0} aria-label="terminal input"
        onFocus={() => { /* keep ghost focused */ }}
        onBlur={e => {
          // An overlay (editor / plugin creator) legitimately owns focus —
          // this component isn't even rendering the ghost in that case,
          // but guard anyway in case of a same-render toggle.
          if (editorFile || pluginCreator) return;
          const next = e.relatedTarget as HTMLElement | null;
          // Don't steal focus from something the user deliberately
          // clicked into elsewhere (a real input/textarea/select/button —
          // e.g. the theme editor, plugin search box, titlebar controls).
          if (next && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(next.tagName)) return;
          setTimeout(() => ghostRef.current?.focus({ preventScroll: true }), 50);
        }} />
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// HOME — hub
// ══════════════════════════════════════════════════════════════
function ThemeTile({ name, theme, active, isCustom, onClick, onDelete }: {
  name: string; theme: Theme; active: boolean; isCustom?: boolean;
  onClick: () => void; onDelete?: () => void;
}) {
  return (
    <div className={`theme-tile ${active ? "theme-tile--on" : ""}`} onClick={onClick}>
      <div className="theme-tile-preview" style={{ background: theme.bg, borderColor: theme.border }}>
        <div className="theme-tile-bar" style={{ background: theme.bg1 }}>
          <span style={{ color: theme.purple, fontSize: 7, fontWeight: 700 }}>OXIS</span>
        </div>
        <div className="theme-tile-body">
          <span style={{ color: theme.purple, fontSize: 8 }}>❯ </span>
          <span style={{ color: theme.text, fontSize: 8 }}>ls</span>
          <br />
          <span style={{ color: theme.purple2, fontSize: 8 }}>'</span>
          <span style={{ color: theme.dim, fontSize: 8 }}>help</span>
        </div>
      </div>
      <div className="theme-tile-name" style={{ color: active ? "var(--purple3)" : "var(--muted)" }}>
        <span>{name}{active && <span style={{ color: "var(--purple)" }}> ✓</span>}</span>
        {isCustom && onDelete && (
          <button className="theme-tile-del" onClick={e => { e.stopPropagation(); onDelete(); }}
            title="Delete theme">×</button>
        )}
      </div>
    </div>
  );
}

function PluginCard({ p, onToggle }: {
  p: ReturnType<typeof pluginManager.all>[0];
  onToggle: (name: string, enabled: boolean) => void;
}) {
  const shortcuts = p.shortcuts ? Object.keys(p.shortcuts) : [];
  return (
    <div className="plugin-card">
      <div className="plugin-card-status" style={{ background: p.enabled ? "var(--purple2)" : "var(--bg4)" }} />
      <div className="plugin-card-body">
        <div className="plugin-card-top">
          <span className="plugin-card-name">{p.name}</span>
          <span className="plugin-card-cat">{p.category}</span>
          {p.builtin && <span className="plugin-card-builtin">built-in</span>}
          {p.lua && !p.builtin && <span className="plugin-card-builtin" style={{color:"var(--purple3)"}}>lua</span>}
        </div>
        <div className="plugin-card-desc">{p.desc}</div>
        {shortcuts.length > 0 && (
          <div className="plugin-card-keys">
            {shortcuts.slice(0, 8).map(s => <code key={s} className="plugin-key">{s}</code>)}
            {shortcuts.length > 8 && <span className="plugin-more">+{shortcuts.length - 8}</span>}
          </div>
        )}
      </div>
      <button className={`plugin-tog ${p.enabled ? "plugin-tog--on" : ""}`}
        onClick={() => onToggle(p.name, !p.enabled)}>
        {p.enabled ? "on" : "off"}
      </button>
    </div>
  );
}

// ── Sky widget: ASCII sun/clouds by day, ASCII moon/stars by night ──
function getMoonPhase(date: Date): number {
  // Returns 0-7 (new moon → waxing → full → waning)
  const synodic = 29.53058867;
  const known = new Date(Date.UTC(2000, 0, 6, 18, 14));
  const days = (date.getTime() - known.getTime()) / 86400000;
  const phase = ((days % synodic) + synodic) % synodic;
  return Math.floor((phase / synodic) * 8) % 8;
}

// Pure ASCII moon phases — width-matched 3-line glyphs
const MOON_ASCII: string[][] = [
  ["()"],          // new moon
  ["()"],          // waxing crescent
  ["|)"],          // first quarter
  ["()"],          // waxing gibbous
  ["(_)"],       // full moon (drawn as circle below)
  ["()"],          // waning gibbous
  ["()"],       // last quarter
  ["(("],          // waning crescent
];

const MOON_FULL = ["  _  ", " ( ) ", "  -  "];

// ── Startup splash — the train, rolling in ──────────────────
// Shown once on launch (see `.startup-anim` fade in index.css). Uses
// the same train art as the home screen / shell boot banner, but
// spins the wheels for the ~1.8s the splash is visible so it reads
// as the train arriving — the home screen shows the identical art
// parked (no spin) once you land there.
function StartupSplash({ onClick }: { onClick: () => void }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setFrame(f => f + 1), 120);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    // Match .startup-anim's 16s CSS fade (index.css) — auto-dismiss
    // once it's finished fading rather than leaving the splash
    // (and its wheel-spin interval) mounted forever if the user
    // never clicks to skip it early.
    //
    // Deliberately NOT depending on `onClick`: the parent passes a
    // fresh arrow function every render (`onClick={() =>
    // setShowAnim(false)}`), so depending on it here would reset
    // this timer on every parent re-render (e.g. the home screen's
    // clock ticking) and the splash might never auto-dismiss. The
    // underlying setState call it wraps is referentially stable
    // across renders regardless of which render's closure calls it,
    // so capturing the mount-time closure once is correct.
    const t = setTimeout(onClick, 16000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="startup-anim" onClick={onClick}>
      <div className="startup-logo">
        {TRAIN_BODY_LINES.map((l, i) => <div key={i}>{renderTrainRow(l, 110)}</div>)}
        <div>{trainWheelFrame(frame)}</div>
      </div>
    </div>
  );
}

function SkyWidget() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);
  const hour = now.getHours();
  const isDay = hour >= 6 && hour < 18;
  const moonPhase = getMoonPhase(now);

  if (isDay) {
    return (
      <div className="sky-widget sky-widget--day">
        <pre className="sky-ascii sky-sun">{"  \\ | /\n -- O --\n  / | \\"}</pre>
        <pre className="sky-ascii sky-cloud sky-cloud--1">{" .--.  \n(____) "}</pre>
        <pre className="sky-ascii sky-cloud sky-cloud--2">{" .-.\n(_-_)"}</pre>
      </div>
    );
  }
  const moonGlyph = moonPhase === 4 ? MOON_FULL.join("\n") : MOON_ASCII[moonPhase].join("\n");
  return (
    <div className="sky-widget sky-widget--night">
      <pre className="sky-ascii sky-moon">{moonGlyph}</pre>
      <span className="sky-star sky-star--1">*</span>
      <span className="sky-star sky-star--2">.</span>
      <span className="sky-star sky-star--3">*</span>
      <span className="sky-star sky-star--4">.</span>
      <span className="sky-star sky-star--5">*</span>
    </div>
  );
}

// ── Persistent command line — defined OUTSIDE Home so it never remounts ──
const HomeCmdLine = React.memo(function HomeCmdLine({
  value, onChange, onKeyDown, inputRef,
}: {
  value: string;
  onChange: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  inputRef: React.RefObject<HTMLInputElement>;
}) {
  return (
    <div className="oxis-cmdline">
      <span className="oxis-cmdline-label">Shell </span>
      <span className="oxis-cmdline-mode">&lt;command-mode&gt; </span>
      <input
        ref={inputRef}
        className="oxis-cmdline-input"
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Type Here"
        spellCheck={false}
        autoComplete="off"
      />
    </div>
  );
});

function Home({ onNew, currentTheme, onTheme, onOpenThemeEditor, onOpenPluginCreator, onCommand }: {
  onNew: () => void; currentTheme: string; onTheme: (n: string) => void;
  onOpenThemeEditor: (n: string) => void; onOpenPluginCreator: () => void; onCommand: (cmd: string) => void;
}) {
  const [input, setInput] = useState("");
  const [view, setView] = useState<"home" | "themes" | "plugins">("home");
  const [plugins, setPlugins] = useState(() => pluginManager.all());
  const [psearch, setPsearch] = useState("");
  const [ws, setWs] = useState(() => workspaceState.get());
  const inputRef = useRef<HTMLInputElement>(null);

  // Home is always mounted (see root App — it's hidden, not unmounted,
  // when the shell is active), so 'support (and anything else that
  // wants to jump straight to one of Home's internal panels) reaches
  // it via this event instead of a prop, regardless of whether Home
  // happens to be the visible view right now.
  useEffect(() => events.on("home_view_request", (p) => {
    const v = (p as { view?: string })?.view;
    if (v === "home" || v === "themes" || v === "plugins") setView(v);
  }), []);

  useEffect(() => workspaceState.subscribe(setWs), []);

  // Keep focus on the input — re-focus only if focus was lost to something
  // other than another interactive element (prevents stealing focus from buttons)
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 40);
    return () => clearTimeout(t);
  }, [view]);

  const refresh = () => setPlugins(pluginManager.all());
  useEffect(() => { if (view === "plugins") refresh(); }, [view]);

  // Keep the plugin count/list live instead of a one-time snapshot —
  // useState(() => pluginManager.all()) above only ever reflects
  // whatever was registered at the exact instant Home first rendered,
  // which is BEFORE initPlugins()'s effect in the root App component
  // has run at all (state initializers run during render; plugin
  // registration happens in an effect, which fires after). That's why
  // the workspace panel always showed "0 plugins" — every plugin,
  // built-in or market-installed, finishes registering strictly after
  // this snapshot was taken, and nothing ever told this component to
  // look again unless the user happened to open the Plugins tab (see
  // the effect above). plugin_loaded/plugin_unloaded (emitted by
  // pluginManager.load()/unload() — see pluginManager.ts) fire for
  // every one of those registrations, on startup and later, so
  // subscribing here keeps this accurate everywhere it's shown, not
  // just inside the Plugins tab.
  useEffect(() => {
    const u1 = events.on("plugin_loaded", refresh);
    const u2 = events.on("plugin_unloaded", refresh);
    return () => { u1(); u2(); };
  }, []);

  const allThemes = useMemo(() => themeManager.all(), [currentTheme]);
  const fp = useMemo(() => {
    const q = psearch.toLowerCase().trim();
    return q ? plugins.filter(p =>
      p.name.toLowerCase().includes(q) || p.desc.toLowerCase().includes(q) || p.category.toLowerCase().includes(q)
    ) : plugins;
  }, [plugins, psearch]);
  const ec = plugins.filter(p => p.enabled).length;
  const tog = (name: string, en: boolean) => { if (en) pluginManager.enable(name); else pluginManager.disable(name); refresh(); };

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") { setInput(""); return; }
    if (e.key === "Enter") {
      const cmd = input.trim();
      setInput("");
      if (!cmd) { onNew(); return; }
      onCommand(cmd);
    }
  }, [input, onNew, onCommand]);

  const handleChange = useCallback((v: string) => {
    setInput(v);
    if (v === "t") { setView("themes"); setInput(""); }
    if (v === "p") { setView("plugins"); setInput(""); }
    if (v === "n") { setInput(""); onNew(); }
  }, [onNew]);

  if (view === "themes") return (
    <div className="home" onMouseDown={e => { if (e.target === e.currentTarget) inputRef.current?.focus(); }}>
      <div className="oxis-home">
        <div className="nv-panel">
          <div className="nv-panel-header"><span className="nv-panel-title">◉ Themes</span><button className="nv-back" onClick={() => setView("home")}>← back</button></div>
          <div className="themes-grid">
            {Object.entries(allThemes).map(([name, t]) => (
              <ThemeTile key={name} name={name} theme={t} active={name === currentTheme}
                isCustom={!!themeManager.customThemes()[name]}
                onClick={() => { themeManager.apply(name); onTheme(name); }}
                onDelete={() => {
                  if (!confirm(`Delete "${name}"?`)) return;
                  themeManager.removeCustom(name);
                  if (currentTheme === name) { themeManager.apply("default"); onTheme("default"); }
                  else onTheme(currentTheme);
                }} />
            ))}
            <div className="theme-tile theme-tile--new" onClick={() => onOpenThemeEditor("custom")}>
              <div className="theme-tile-preview theme-tile-add"><span>+</span></div>
              <div className="theme-tile-name" style={{ color: "var(--dim)" }}>new theme</div>
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <HomeCmdLine value={input} onChange={handleChange} onKeyDown={handleKeyDown} inputRef={inputRef} />
          </div>
        </div>
      </div>
    </div>
  );

  if (view === "plugins") return (
    <div className="home" onMouseDown={e => { if (e.target === e.currentTarget) inputRef.current?.focus(); }}>
      <div className="oxis-home">
        <div className="nv-panel">
          <div className="nv-panel-header">
            <span className="nv-panel-title">⬡ Plugins <span className="nv-count">{ec}/{plugins.length}</span></span>
            <div className="nv-panel-actions"><button className="nv-action-btn" onClick={onOpenPluginCreator}>+ new</button><button className="nv-back" onClick={() => setView("home")}>← back</button></div>
          </div>
          <div className="nv-search-wrap">
            <span className="nv-search-icon">⌕</span>
            <input className="nv-search-input" placeholder="filter plugins…" value={psearch} onChange={e => setPsearch(e.target.value)} spellCheck={false} autoFocus />
            {psearch && <button className="nv-search-clear" onClick={() => setPsearch("")}>×</button>}
          </div>
          <div className="nv-plugin-list">
            {fp.length === 0 ? <div className="nv-empty">no results for "{psearch}"</div> : fp.map(p => (
              <div key={p.name} className="nv-plugin-row">
                <span className={`nv-plugin-dot${p.enabled ? " nv-plugin-dot--on" : ""}`}>●</span>
                <span className="nv-plugin-name">{p.name}</span>
                <span className="nv-plugin-cat">{p.category}</span>
                <span className="nv-plugin-desc">{p.desc}</span>
                <button className={`nv-plugin-tog${p.enabled ? " nv-plugin-tog--on" : ""}`} onClick={() => tog(p.name, !p.enabled)}>{p.enabled ? "on" : "off"}</button>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 10 }}>
            <HomeCmdLine value={input} onChange={handleChange} onKeyDown={handleKeyDown} inputRef={inputRef} />
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="home" onMouseDown={e => { if (e.target === e.currentTarget) inputRef.current?.focus(); }}>
      <SkyWidget />
      <div className="oxis-home">
        <div className="oxis-train-wrap">
          <div className="oxis-ascii">

  <div className="oxis-ascii-row" style={{ color: "var(--purple3)" }}>
{String.raw`   _     __  __    ___     ___                              `}
  </div>
                      
  <div className="oxis-ascii-row" style={{ color: "var(--purple3)" }}>
{String.raw`  /_\    \ \/ /   |_ _|   / __|                               `}
  </div>

  <div className="oxis-ascii-row" style={{ color: "var(--purple3)" }}>
{String.raw` |(_)|    >  <     | |    \__ \     ____            `}
  </div>

  <div className="oxis-ascii-row" style={{ color: "var(--purple)" }}>
    {renderTrainRow(String.raw`,\___/, ,/_/\_\, ,|___|, ,|___/,____|[]|___||_______.   `, 110)}
  </div>

  <div className="oxis-ascii-row" style={{ color: "var(--purple2)" }}>
{String.raw`|#####|_|######|_|#####|_|#####|_____|__|###|_______|}`}
  </div>

  <div className="oxis-ascii-row oxis-ascii-wheels" style={{ color: "var(--dim)" }}>
    {"`-"}
    <span className="wheel">0</span>{"-"}
    <span className="wheel">0</span>
    {"-'*"}

    {"`-"}
    <span className="wheel">0</span>{"-"}
    <span className="wheel">0</span>
    {"-'*"}

    {"`-"}
    <span className="wheel">0</span>{"-"}
    <span className="wheel">0</span>
    {"-'*"}

    {"`-"}
    <span className="wheel">0</span>{"-"}
    <span className="wheel">0</span>
    {"-"}
    <span className="wheel">0</span>
    {"+++"}
    <span className="wheel">0</span>{"-"}
    <span className="wheel">0</span>
    {"'"}
    {"`-"}
    <span className="wheel">0</span>{"-"}
    <span className="wheel">0</span>
    {"-'*"}
    {"`-"}
    <span className="wheel">0</span>{"-"}
    <span className="wheel">0</span>
    {"-'"}
  </div>

</div>
        </div>   <div className="oxis-sub-row">
  <span><strong className="oxis-letter">O</strong>pen</span>
  <span><strong className="oxis-letter">X</strong>enial</span>
  <span><strong className="oxis-letter">I</strong>ntelligent</span>
  <span><strong className="oxis-letter">S</strong>hell</span>
</div>
        <div className="oxis-ver-row"><span className="oxis-ver-label">OXIS</span><span className="oxis-ver-num">v1.2.1</span></div>
        <WorkspacePanel ws={ws} plugins={plugins} onOpenMarket={() => setView("plugins")} />
        <div className="oxis-box oxis-help-box">
          <div className="oxis-help-row"><span className="oht">Type</span> <span className="ohc">&apos;help</span><span className="ohr"> if you need some help</span></div>
          <div className="oxis-help-row"><span className="oht">Type</span> <span className="ohc">&apos;edit</span> <span className="oha">&lt;file&gt;</span><span className="ohr"> to open the built-in editor</span></div>
          <div className="oxis-help-row"><span className="oht">Type</span> <span className="ohc">&apos;market list</span><span className="ohr"> to browse plugins you can install</span></div>
          <div className="oxis-help-row"><span className="oht">Type</span> <span className="ohc">&apos;theme</span><span className="ohr"> to see and switch color themes</span></div>
          <div className="oxis-help-row"><span className="oht">Press</span> <span className="ohc">Ctrl+Shift+M</span><span className="ohr"> to open the OXIS Market website in your browser</span></div>
        </div>
        <HomeCmdLine value={input} onChange={handleChange} onKeyDown={handleKeyDown} inputRef={inputRef} />
      </div>
    </div>
  );
}

// ── Workspace panel — Home screen, replaces the old permanent
// donation box (see README § Home Screen & Workspace Panel).
// Read-only: reflects workspaceState/pluginManager, doesn't accept
// input itself, so it never competes with Command Mode for focus.
function WorkspacePanel({ ws, plugins, onOpenMarket }: {
  ws: ReturnType<typeof workspaceState.get>;
  plugins: ReturnType<typeof pluginManager.all>;
  onOpenMarket: () => void;
}) {
  const active = plugins.filter(p => p.enabled);
  const tasks = workspaceState.taskNames();
  return (
    <div className="oxis-box oxis-workspace-box">
      <div className="oxis-box-row oxis-workspace-header">
        <span className="oxis-wl">WORKSPACE</span>
        <span className={`oxis-workspace-status oxis-workspace-status--${ws.status}`}>
          {ws.status === "ready" ? "● ready" : ws.status === "loading" ? "◐ loading" : "○ no workspace"}
        </span>
      </div>
      <div className="oxis-box-row"><span className="oxis-wl">project</span><span className="oxis-we"> = </span><span className="oxis-wa">{ws.projectName || "no project loaded"}</span></div>
      {ws.projectPath && (
        <div className="oxis-box-row"><span className="oxis-wl">path</span><span className="oxis-we"> = </span><span className="oxis-wa">{ws.projectPath}</span></div>
      )}
      <div className="oxis-box-row"><span className="oxis-wl">plugins</span><span className="oxis-we"> = </span><span className="oxis-wa">{active.length} active{active.length ? `  (${active.slice(0, 4).map(p => p.name).join(", ")}${active.length > 4 ? "…" : ""})` : ""}</span></div>
      <div className="oxis-box-row"><span className="oxis-wl">tasks</span><span className="oxis-we"> = </span><span className="oxis-wa">{tasks.length ? tasks.join(", ") : "none defined"}</span></div>
      {ws.activity.length > 0 && (
        <div className="oxis-box-row"><span className="oxis-wl">recent</span><span className="oxis-we"> = </span><span className="oxis-wa">{ws.activity[0].text}</span></div>
      )}
      <div className="oxis-box-row oxis-workspace-footer">
        {ws.status === "none"
          ? <span className="oxis-workspace-hint">no workspace here — try <code>&apos;workspace init</code></span>
          : <button className="oxis-workspace-support-link" onClick={onOpenMarket}>browse the OXIS Market →</button>}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// STATUS BAR
// ══════════════════════════════════════════════════════════════
function StatusBar({ mode, count, idx, ready, theme, project, updateMsg }: {
  mode: string; count: number; idx: number; ready: boolean; theme: string;
  project?: string; updateMsg?: string;
}) {
  const [time, setTime] = useState(() => new Date().toLocaleTimeString());
  useEffect(() => {
    const t = setInterval(() => setTime(new Date().toLocaleTimeString()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="statusline">
      <div className="sl-mode">{mode === "home" ? "HOME" : "SHELL"}</div>
      <div className="sl-sep" />
      <div className="sl-mid">
        {ready ? "● connected" : "○ connecting"}
        {project && <><span className="sl-dot"> · </span><span className="sl-project">{project}</span></>}
        {updateMsg && <span className="sl-update"> · ⬆ {updateMsg}</span>}
      </div>
      <div className="sl-right">
        <span className="sl-theme">{theme}</span>
        {count > 0 && <span className="sl-pos">{idx + 1}/{count}</span>}
        <span className="sl-time">{time}</span>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// ROOT APP — inside the native Wails window (frameless), <Titlebar>
// draws the custom draggable titlebar + window controls. OXIS can
// also be opened directly in a plain browser at http://127.0.0.1:1420
// (see server.Listen in internal/server/server.go) — there's no
// native frameless window to control there, just an ordinary browser
// tab with its own chrome, so the custom titlebar has nothing to do
// and is skipped entirely (isNativeApp() — see native.ts).
// ══════════════════════════════════════════════════════════════
export default function App() {
  const [view,      setView]      = useState<"home" | "shell">("home");
  const [ready,     setReady]     = useState(false);
  const [curTheme,  setCurTheme]  = useState(() => themeManager.getCurrent());
  const [themeEditorName,  setThemeEditorName]  = useState<string | null>(null);
  const [activeProject, setActiveProject] = useState(() => workspaceState.get().projectName);
  const [updateMsg,     setUpdateMsg]     = useState("");
  const [showAnim, setShowAnim] = useState(true);
  const pendingHomeCmd = useRef<string>("");
  const shellMounted   = useRef(false); // shell only ever mounts once, then stays alive forever

  // activeProject used to be dead state — declared, passed to <StatusBar>,
  // but nothing ever called setActiveProject. workspaceState is the thing
  // that actually listens for oxis.workspace(path)/"workspace_loaded" (see
  // workspaceState.ts + the Home screen's Workspace panel).
  useEffect(() => workspaceState.subscribe((s) => setActiveProject(s.projectName)), []);

  // Init on mount — apply theme, init plugins immediately (before any terminal opens)
  useEffect(() => {
    themeManager.apply(curTheme);
    sessionManager.clear();
    const animT = setTimeout(() => setShowAnim(false), 1800);
    const checkUpdate = async () => {
      try {
        const r = await fetch("https://gitlab.com/api/v4/projects/YOUR_PROJECT_ID/releases?per_page=1", { signal: AbortSignal.timeout(4000) });
        if (!r.ok) return;
        const [rel] = await r.json() as Array<{ tag_name: string }>;
        if (rel && rel.tag_name.replace(/^v/i, "") !== "1.2.1") setUpdateMsg(`v${rel.tag_name} available`);
      } catch { /* offline or placeholder URL — replace YOUR_PROJECT_ID */ }
    };
    checkUpdate();

    // Init plugins at root level so they show up in Home before any shell opens
    if (!_pluginsInited) {
      _pluginsInited = true;
      const stubCtx: ShellCtx = {
        send:        () => {},
        runLine:     () => {},
        print:       (t, k) => console.log("[oxis]", t),
        clear:       () => {},
        openEditor:  () => {},
        newTerminal: () => {},
      };
      _ctxRef.current = stubCtx;
      initPlugins(forwardingApiCtx);
      workspaceManager.init(forwardingApiCtx);
      registerBuiltinCommands(stubCtx);
    }
    return () => clearTimeout(animT);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Event listeners
  // Note: "open_plugin_creator" is deliberately NOT listened to here.
  // The Terminal component already renders the Plugin Creator in the
  // exact same full-pane slot it renders the file Editor in (see
  // Terminal's `if (pluginCreator !== null) { ... }` early return) —
  // that's the one, main Plugin Creator. A second listener used to
  // live at this root level too, popping up its own overlay copy on
  // top of it, which is why two editors would show up at once for
  // every 'plugin new. See onOpenPluginCreator below for how Home's
  // "+ new" button now reaches that single instance instead.
  useEffect(() => {
    const u1 = events.on("open_theme_editor", p => { if (p?.name) setThemeEditorName(String(p.name)); });
    const u2 = events.on("theme_changed",     p => { if (p?.name) setCurTheme(String(p.name)); });
    return () => { u1(); u2(); };
  }, []);

  // Persist minimal session state
  useEffect(() => {
    sessionManager.save({
      tabs:      [],
      activeTab: view,
      theme:     curTheme,
      savedAt:   Date.now(),
    });
  }, [view, curTheme]);

  // "go home" — wired to the 'home command via _goHomeRef
  const goHome = useCallback(() => setView("home"), []);
  useEffect(() => { _goHomeRef.current = goHome; }, [goHome]);

  // Open shell — either from home's typed command, or Ctrl+T
  const openShell = useCallback(() => {
    shellMounted.current = true;
    setView("shell");
  }, []);

  useEffect(() => {
    registerCoreKeybinds({
      newTab:        openShell,
      closeTab:      () => { if (view === "shell") setView("home"); },
      switchTab:     () => {},
      clearTerminal: () => events.emit("clear_terminal"),
      openMarket:    () => { void openUrl(market.MARKET_BASE); },
    });
    const handler = (e: KeyboardEvent) => keybinds.handle(e);
    window.addEventListener("keydown", handler, true);
    // Steals Ctrl+R/L/W/T/F/N away from the OS chrome and redirects
    // them to OXIS's own terminal shortcuts. That's the right thing to
    // do inside the native frameless window (there's no address bar,
    // no tab strip — none of those shortcuts have anywhere else useful
    // to go), but genuinely hostile in a plain browser tab (see
    // isNativeApp() in native.ts): trapping Ctrl+W so the user can't
    // close the tab, or Ctrl+R so they can't refresh, isn't something
    // OXIS should be doing to someone's ordinary browser session just
    // because they pointed it at http://127.0.0.1:1420.
    const blockBrowser = (e: KeyboardEvent) => {
      if (!isNativeApp()) return;
      if (!e.ctrlKey) return;
      const k = e.key.toLowerCase();
      if (["r","l","w","t","f","n"].includes(k)) {
        e.preventDefault(); e.stopPropagation();
        const ghost = document.querySelector(".term-ghost") as HTMLTextAreaElement | null;
        if (ghost) ghost.dispatchEvent(new KeyboardEvent("keydown", {
          key: e.key, ctrlKey: true, shiftKey: e.shiftKey, altKey: e.altKey, bubbles: true, cancelable: true,
        }));
      }
    };
    window.addEventListener("keydown", blockBrowser, true);
    return () => {
      window.removeEventListener("keydown", handler, true);
      window.removeEventListener("keydown", blockBrowser, true);
    };
  }, [openShell, view]);

  const isHome = view === "home";

  return (
    <div className={`app${isNativeApp() ? "" : " app--browser"}`}>
      {isNativeApp() && <Titlebar mode={isHome ? "home" : "shell"} />}
      {showAnim && <StartupSplash onClick={() => setShowAnim(false)} />}

      <div className="app-body">
        {/* Overlays — always on top */}
        {themeEditorName && (
          <div className="overlay">
            <ThemeEditor name={themeEditorName} onClose={() => setThemeEditorName(null)} />
          </div>
        )}
        {/* Home page — hidden (not unmounted) when shell active */}
        <div style={{ display: isHome ? "flex" : "none", flex: 1, minHeight: 0, overflow: "hidden" }}>
          <Home
            onNew={openShell}
            currentTheme={curTheme}
            onTheme={n => { themeManager.apply(n); setCurTheme(n); }}
            onOpenThemeEditor={n => setThemeEditorName(n)}
            // Routed through the shell's own "plugin new <name>" command
            // (same as typing it) rather than a separate root-level
            // overlay, so there's exactly one Plugin Creator — the one
            // Terminal renders in its main editor slot. Mirrors onCommand
            // just below.
            onOpenPluginCreator={() => {
              const cmd = "plugin new myplugin";
              if (ready) {
                openShell();
                setTimeout(() => _ctxRef.current?.runLine(cmd), 60);
              } else {
                pendingHomeCmd.current = cmd;
                openShell();
              }
            }}
            onCommand={cmd => {
              if (ready) {
                openShell();
                setTimeout(() => _ctxRef.current?.runLine(cmd), 60);
              } else {
                pendingHomeCmd.current = cmd;
                openShell();
              }
            }}
          />
        </div>

        {/* Single persistent shell session — mounts once, never unmounts */}
        {shellMounted.current && (
          <div className="app-pane" style={{ display: !isHome ? "flex" : "none" }}>
            <Terminal
              id="main"
              isActive={!isHome}
              onReady={() => {
                setReady(true);
                const cmd = pendingHomeCmd.current;
                if (cmd) { pendingHomeCmd.current = ""; setTimeout(() => _ctxRef.current?.runLine(cmd), 400); }
              }}
              onNewTab={openShell}
              onCloseTab={() => setView("home")}
              onSwitchTab={() => {}}
              
            />
          </div>
        )}
      </div>

      <StatusBar mode={isHome ? "home" : "shell"}
        count={0} idx={0}
        ready={ready} theme={curTheme}
        project={!isHome ? (activeProject || undefined) : undefined}
        updateMsg={updateMsg || undefined} />
    </div>
  );
}