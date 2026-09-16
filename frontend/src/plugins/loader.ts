/**
 * loader.ts — OXIS plugin bootstrapper
 *
 * Registers all 25 built-in plugins (TypeScript shortcut tables),
 * restores user-toggled states, loads user Lua plugins, then
 * activates all enabled plugins.
 */

import { pluginManager } from "./pluginManager";
import { loadAllPremiumPlugins } from "./market";
import type { APIContext } from "./pluginAPI";

// Real Lua source for every shipped Lua plugin — see the "?raw" Vite
// import suffix, which inlines the file's exact text content as a
// string at build time. These used to be replaced with a fake
// one-line stub at registration time (`oxis.command(name+"_info", ...)`)
// because there was no real Lua interpreter to run the actual files —
// see luaRuntime.ts for why that's no longer true.
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
      ga:"git add -A && git status", gp:"git push", gpl:"git pull",
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
    shortcuts:{
      top:`Get-Process | Sort-Object CPU -Descending | Select-Object -First 20 Name,Id,@{N='CPU';E={[math]::Round($_.CPU,1)}},@{N='RAM(MB)';E={[math]::Round($_.WorkingSet/1MB,0)}} | Format-Table -AutoSize`,
      mem:`$o=Get-CimInstance Win32_OperatingSystem;Write-Host "RAM: $([math]::Round(($o.TotalVisibleMemorySize-$o.FreePhysicalMemory)/1MB,1))GB used / $([math]::Round($o.TotalVisibleMemorySize/1MB,1))GB total"`,
      cpu:`Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed | Format-List`,
      uptime:`$b=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime;$u=New-TimeSpan -Start $b;Write-Host "Uptime: $($u.Days)d $($u.Hours)h $($u.Minutes)m"`,
    }},
  { name:"network", desc:"Network diagnostics", category:"system", builtin:true, enabled:false,
    shortcuts:{
      myip:`(Invoke-WebRequest -Uri 'https://api.ipify.org' -UseBasicParsing).Content`,
      wifi:`netsh wlan show interfaces`,
      ports:`Get-NetTCPConnection | Where-Object State -eq 'Listen' | Sort-Object LocalPort | Format-Table LocalPort,@{N='Process';E={(Get-Process -Id $_.OwningProcess -EA SilentlyContinue).Name}} -AutoSize`,
      ping:(a)=>`Test-Connection ${a||"8.8.8.8"} -Count 4`,
      dns :(a)=>`Resolve-DnsName ${a} | Format-Table -AutoSize`,
    }},
  { name:"files", desc:"Advanced file operations", category:"files", builtin:true, enabled:true,
    shortcuts:{
      fsize  :(a)=>`$s=Get-ChildItem -Recurse "${a||"."}" -EA SilentlyContinue|Measure-Object -Property Length -Sum;Write-Host "$([math]::Round($s.Sum/1MB,2)) MB ($($s.Count) files)"`,
      fopen  :(a)=>`Start-Process "${a}"`,
      fhash  :(a)=>`Get-FileHash "${a}" | Format-Table Algorithm,Hash`,
      flatest:`Get-ChildItem -Recurse -File -EA SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 10 LastWriteTime,@{N='File';E={$_.Name}} | Format-Table -AutoSize`,
      fbig   :`Get-ChildItem -Recurse -File -EA SilentlyContinue | Sort-Object Length -Descending | Select-Object -First 10 @{N='MB';E={[math]::Round($_.Length/1MB,2)}},Name | Format-Table -AutoSize`,
    }},
  { name:"python", desc:"Python/pip shortcuts", category:"dev", builtin:true, enabled:false,
    shortcuts:{
      py    :(a)=>`python ${a}`, pip:(a)=>`pip install ${a}`,
      venv  :`python -m venv .venv`, act:`.venv\\Scripts\\Activate.ps1`,
      freeze:`pip freeze > requirements.txt`, pipu:`pip list --outdated`,
    }},
  { name:"go", desc:"Go development shortcuts", category:"dev", builtin:true, enabled:false,
    shortcuts:{
      gobuild:"go build ./...", gorun:(a)=>`go run ${a||"main.go"}`,
      gotest :"go test ./...",  gotidy:"go mod tidy", govet:"go vet ./...",
    }},
  { name:"winutil", desc:"Windows power tools", category:"system", builtin:true, enabled:false,
    shortcuts:{
      admin :`Start-Process powershell -Verb runAs`,
      events:`Get-EventLog -LogName System -Newest 20 | Format-Table TimeGenerated,Source,Message -AutoSize`,
      sfc   :`Start-Process powershell -ArgumentList 'sfc /scannow' -Verb runAs`,
      winver:`[System.Environment]::OSVersion.Version`,
    }},
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

  // Load user/market Lua plugins from disk (native window only — see
  // isNativeApp() in native.ts) and activate any that are enabled.
  // Async — not awaited here deliberately: this function's own
  // signature stays synchronous (its caller doesn't await it either),
  // and loadUserPlugins() calls pluginManager.load() itself for each
  // plugin once its file arrives, so those plugins' commands appear in
  // the registry moments after startup rather than blocking it.
  void pluginManager.loadUserPlugins();

  // Premium plugins (see README § Premium Plugin Licensing &
  // Encryption) live under .oxis/premium/ as encrypted packages, not
  // as plain .lua files, so they're not picked up by
  // loadUserPlugins() above — scanned and license-checked separately.
  // Also async/not-awaited for the same startup-latency reason.
  void loadAllPremiumPlugins();

  // Activate all enabled built-in plugins.
  for (const p of pluginManager.all()) {
    if (p.enabled) pluginManager.load(p.name);
  }
}
