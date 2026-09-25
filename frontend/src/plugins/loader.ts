/**
 * loader.ts — OXIS plugin bootstrapper
 *
 * Registers the built-in plugins (10 shortcut tables + 16 Lua plugins),
 * restores user-toggled states, loads user/market/premium Lua plugins,
 * then activates everything enabled.
 */

import { pluginManager } from "./pluginManager";
import { loadAllPremiumPlugins } from "./market";
import type { APIContext } from "./pluginAPI";
import { isWindows } from "../terminal/terminal";

// Shortcut tables pick PowerShell or POSIX commands once, at startup.
const WIN = isWindows();

// Bundled Lua plugin sources (Vite "?raw" imports).
import fuzzyLua from "./builtins/fuzzy.lua?raw";
import gitAdvancedLua from "./builtins/git_advanced.lua?raw";
import lspDiagLua from "./builtins/lsp_diag.lua?raw";
import httpLua from "./builtins/http.lua?raw";
import sessionNotesLua from "./builtins/session_notes.lua?raw";
import envManagerLua from "./builtins/env_manager.lua?raw";
import benchmarkLua from "./builtins/benchmark.lua?raw";
import processManagerLua from "./builtins/process_manager.lua?raw";
import projectInitLua from "./builtins/project_init.lua?raw";
import clipboardLua from "./builtins/clipboard.lua?raw";
import todoLua from "./builtins/todo.lua?raw";
import dockerComposeLua from "./builtins/docker_compose.lua?raw";
import fileOpsLua from "./builtins/file_ops.lua?raw";
import systemHealthLua from "./builtins/system_health.lua?raw";
import snippetsLua from "./builtins/snippets.lua?raw";
import sshManagerLua from "./builtins/ssh_manager.lua?raw";

type ShortcutMap = Record<string, string | ((a: string) => string)>;

interface BuiltinDef {
  name: string; desc: string; category: string;
  builtin: true; enabled: boolean;
  shortcuts: ShortcutMap;
}

const BUILTINS: BuiltinDef[] = [
  // ── dev ────────────────────────────────────────────────
  { name:"git", desc:"Git workflow shortcuts", category:"dev", builtin:true, enabled:true,
    shortcuts:{
      gs:"git status", gl:"git log --oneline -20", gd:"git diff",
      ga:"git add -A; git status", gp:"git push", gpl:"git pull",
      gb:"git branch -a", gst:"git stash",
      gc :(a)=>a?`git commit -m "${a}"`:`echo "usage: 'gc <msg>"`,
      gco:(a)=>a?`git checkout ${a}`:`echo "usage: 'gco <branch>"`,
    }},
  { name:"npm", desc:"Node/npm shortcuts", category:"dev", builtin:true, enabled:true,
    shortcuts:{
      ni :(a)=>a?`npm install ${a}`:"npm install",
      nid:(a)=>`npm install -D ${a}`,
      nb:"npm run build", nd:"npm run dev", nt:"npm test",
      nr :(a)=>`npm run ${a}`, nls:"npm list --depth=0",
    }},
  { name:"docker", desc:"Docker container management", category:"devops", builtin:true, enabled:false,
    shortcuts:{
      dps:"docker ps", dimg:"docker images",
      dup:"docker-compose up -d", ddown:"docker-compose down",
      dlog:(a)=>`docker logs --tail 100 -f ${a}`,
      dsh :(a)=>`docker exec -it ${a} /bin/sh`,
      drm :(a)=>`docker rm -f ${a}`,
    }},
  { name:"sysmon", desc:"System monitoring", category:"system", builtin:true, enabled:true,
    shortcuts: WIN ? {
      top:`Get-Process | Sort-Object CPU -Descending | Select-Object -First 20 Name,Id,@{N='CPU';E={[math]::Round($_.CPU,1)}},@{N='RAM(MB)';E={[math]::Round($_.WorkingSet/1MB,0)}} | Format-Table -AutoSize`,
      mem:`$o=Get-CimInstance Win32_OperatingSystem;Write-Host "RAM: $([math]::Round(($o.TotalVisibleMemorySize-$o.FreePhysicalMemory)/1MB,1))GB used / $([math]::Round($o.TotalVisibleMemorySize/1MB,1))GB total"`,
      cpu:`Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed | Format-List`,
      uptime:`$b=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime;$u=New-TimeSpan -Start $b;Write-Host "Uptime: $($u.Days)d $($u.Hours)h $($u.Minutes)m"`,
    } : {
      top:"ps -eo pid,comm,%cpu,%mem --sort=-%cpu | head -n 21",
      mem:"free -h",
      cpu:"lscpu | head -n 20",
      uptime:"uptime -p",
    }},
  { name:"network", desc:"Network diagnostics", category:"system", builtin:true, enabled:false,
    shortcuts: WIN ? {
      myip:`(Invoke-WebRequest -Uri 'https://api.ipify.org' -UseBasicParsing).Content`,
      wifi:`netsh wlan show interfaces`,
      ports:`Get-NetTCPConnection | Where-Object State -eq 'Listen' | Sort-Object LocalPort | Format-Table LocalPort,@{N='Process';E={(Get-Process -Id $_.OwningProcess -EA SilentlyContinue).Name}} -AutoSize`,
      ping:(a)=>`Test-Connection ${a||"8.8.8.8"} -Count 4`,
      dns :(a)=>`Resolve-DnsName ${a} | Format-Table -AutoSize`,
    } : {
      myip:"curl -s https://api.ipify.org; echo",
      wifi:"nmcli device wifi list",
      ports:"ss -tlnp",
      ping:(a)=>`ping -c 4 ${a||"8.8.8.8"}`,
      dns :(a)=>`getent hosts ${a}`,
    }},
  { name:"files", desc:"Advanced file operations", category:"files", builtin:true, enabled:true,
    shortcuts: WIN ? {
      fsize  :(a)=>`$s=Get-ChildItem -Recurse "${a||"."}" -EA SilentlyContinue|Measure-Object -Property Length -Sum;Write-Host "$([math]::Round($s.Sum/1MB,2)) MB ($($s.Count) files)"`,
      fopen  :(a)=>`Start-Process "${a}"`,
      fhash  :(a)=>`Get-FileHash "${a}" | Format-Table Algorithm,Hash`,
      flatest:`Get-ChildItem -Recurse -File -EA SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 10 LastWriteTime,@{N='File';E={$_.Name}} | Format-Table -AutoSize`,
      fbig   :`Get-ChildItem -Recurse -File -EA SilentlyContinue | Sort-Object Length -Descending | Select-Object -First 10 @{N='MB';E={[math]::Round($_.Length/1MB,2)}},Name | Format-Table -AutoSize`,
    } : {
      fsize  :(a)=>`du -sh "${a||"."}"`,
      fopen  :(a)=>`xdg-open "${a}"`,
      fhash  :(a)=>`sha256sum "${a}"`,
      flatest:`find . -type f -printf '%T@ %TY-%Tm-%Td %TH:%TM  %p\n' 2>/dev/null | sort -rn | head -n 10 | cut -d' ' -f2-`,
      fbig   :`find . -type f -printf '%s\t%p\n' 2>/dev/null | sort -rn | head -n 10 | awk -F'\t' '{printf "%8.2f MB  %s\n", $1/1048576, $2}'`,
    }},
  { name:"python", desc:"Python/pip shortcuts", category:"dev", builtin:true, enabled:false,
    shortcuts:{
      py    :(a)=>`${WIN ? "python" : "python3"} ${a}`, pip:(a)=>`pip install ${a}`,
      venv  :`${WIN ? "python" : "python3"} -m venv .venv`, act: WIN ? `.venv\Scripts\Activate.ps1` : `. .venv/bin/activate`,
      freeze:`pip freeze > requirements.txt`, pipu:`pip list --outdated`,
    }},
  { name:"go", desc:"Go development shortcuts", category:"dev", builtin:true, enabled:false,
    shortcuts:{
      gobuild:"go build ./...", gorun:(a)=>`go run ${a||"."}`,
      gotest :"go test ./...",  gotidy:"go mod tidy", govet:"go vet ./...",
    }},
  { name:"winutil", desc:"Windows power tools (Windows only)", category:"system", builtin:true, enabled:false,
    shortcuts: WIN ? {
      admin :`Start-Process powershell -Verb runAs`,
      events:`Get-EventLog -LogName System -Newest 20 | Format-Table TimeGenerated,Source,Message -AutoSize`,
      sfc   :`Start-Process powershell -ArgumentList 'sfc /scannow' -Verb runAs`,
      winver:`[System.Environment]::OSVersion.Version`,
    } : Object.fromEntries(["admin","events","sfc","winver"].map(n => [n, `echo "'${n} is Windows-only"`])) },
  { name:"rust", desc:"Rust/Cargo shortcuts", category:"dev", builtin:true, enabled:false,
    shortcuts:{
      cb:"cargo build", cr:(a)=>`cargo run${a?" -- "+a:""}`,
      ct:"cargo test",  cc:"cargo check", cbr:"cargo build --release",
    }},
];

// All Lua-based plugins that ship with OXIS
// (source is loaded from builtins/*.lua at runtime via import.meta.glob or inline)
const LUA_PLUGIN_NAMES: string[] = [
  "fuzzy",
  "git_advanced",
  "lsp_diag",
  "http",
  "session_notes",
  "env_manager",
  "benchmark",
  "process_manager",
  "project_init",
  "clipboard",
  "todo",
  "docker_compose",
  "file_ops",
  "system_health",
  "snippets",
  "ssh_manager",
];

// Descriptions for Lua plugins (shown in plugin list) and their real
// source (imported above).
const LUA_PLUGIN_META: Record<string, { desc: string; category: string; enabled: boolean; source: string }> = {
  fuzzy:           { desc:"Fuzzy file finder (like telescope.nvim)",        category:"files",   enabled:false, source: fuzzyLua },
  git_advanced:    { desc:"Advanced git: glog, gwip, grebase, gundo…",      category:"dev",     enabled:false, source: gitAdvancedLua },
  lsp_diag:        { desc:"Code diagnostics: tsc, eslint, audit…",          category:"dev",     enabled:false, source: lspDiagLua },
  http:            { desc:"HTTP client: hget, ping4, myip2…",               category:"dev",     enabled:false, source: httpLua },
  session_notes:   { desc:"Scratchpad notes: note, notenew, notels…",       category:"utility", enabled:false, source: sessionNotesLua },
  env_manager:     { desc:".env manager: envload, envshow, envcheck",        category:"dev",     enabled:false, source: envManagerLua },
  benchmark:       { desc:"Command benchmarking: time, bench",              category:"system",  enabled:false, source: benchmarkLua },
  process_manager: { desc:"Advanced processes: ptop, pnet, pwatch, pfind",  category:"system",  enabled:false, source: processManagerLua },
  project_init:    { desc:"Project scaffolding: initts, initreact, initgo…",category:"dev",     enabled:false, source: projectInitLua },
  clipboard:       { desc:"Clipboard tools: clip, clipclear, cliphex…",     category:"utility", enabled:false, source: clipboardLua },
  todo:            { desc:"TODO scanner: todos, fixmes",                    category:"dev",     enabled:false, source: todoLua },
  docker_compose:  { desc:"Docker Compose: dcup, dcdown, dclogs, dcstats…", category:"devops",  enabled:false, source: dockerComposeLua },
  file_ops:        { desc:"File ops: tree, dup, flatten, biggest, dupes",   category:"files",   enabled:false, source: fileOpsLua },
  system_health:   { desc:"Health dashboard: health, temps",                category:"system",  enabled:false, source: systemHealthLua },
  snippets:        { desc:"Snippet manager: snipset, snipget, snipls…",     category:"utility", enabled:false, source: snippetsLua },
  ssh_manager:     { desc:"SSH manager: sshls, sshadd, sshkeygen, sshcopy", category:"system",  enabled:false, source: sshManagerLua },
};

export function initPlugins(ctx: APIContext): void {
  pluginManager.init(ctx);

  // Register TypeScript shortcut built-ins
  for (const p of BUILTINS) {
    pluginManager.register(p as unknown as Parameters<typeof pluginManager.register>[0]);
  }

  // Register the shipped Lua plugins with their real source.
  for (const name of LUA_PLUGIN_NAMES) {
    const meta = LUA_PLUGIN_META[name];
    if (!meta) continue;
    pluginManager.register({
      name,
      desc:    meta.desc,
      category:meta.category,
      builtin: true,
      enabled: meta.enabled,
      lua:     meta.source,
    } as Parameters<typeof pluginManager.register>[0]);
  }

  // Restore user-toggled enable/disable states
  pluginManager.restoreState();

  // User/Market plugins load from disk asynchronously (native app only)
  // so startup isn't blocked; their commands appear a moment later.
  void pluginManager.loadUserPlugins();

  // Premium plugins are encrypted packages in .oxis/premium/, loaded and
  // license-checked separately, also asynchronously.
  void loadAllPremiumPlugins();

  // Activate all enabled built-in plugins.
  for (const p of pluginManager.all()) {
    if (p.enabled) pluginManager.load(p.name);
  }
}
