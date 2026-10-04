/**
 * loader.ts — OXIS plugin bootstrapper
 *
 * Registers the built-in plugins (4 shortcut tables + 5 Lua plugins),
 * restores user-toggled states, loads user/market/premium Lua plugins,
 * then activates everything enabled.
 */

import { pluginManager } from "./pluginManager";
import { loadAllPremiumPlugins } from "./market";
import { shellQuote as q, type APIContext } from "./pluginAPI";
import { isWindows } from "../terminal/terminal";

// Shortcut tables pick PowerShell or POSIX commands once, at startup.
const WIN = isWindows();

// Bundled Lua plugin sources (Vite "?raw" imports).
import notesLua from "./builtins/notes.lua?raw";
import todoLua from "./builtins/todo.lua?raw";
import snippetsLua from "./builtins/snippets.lua?raw";
import httpLua from "./builtins/http.lua?raw";
import envLua from "./builtins/env.lua?raw";

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
      gc :(a)=>a?`git commit -m ${q(a)}`:`echo "usage: 'gc <msg>"`,
      gco:(a)=>a?`git checkout ${q(a)}`:`echo "usage: 'gco <branch>"`,
    }},
  { name:"npm", desc:"Node/npm shortcuts", category:"dev", builtin:true, enabled:true,
    shortcuts:{
      ni :(a)=>a?`npm install ${a}`:"npm install",
      nid:(a)=>`npm install -D ${a}`,
      nb:"npm run build", nd:"npm run dev", nt:"npm test",
      nr :(a)=>`npm run ${a}`, nls:"npm list --depth=0",
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
  { name:"files", desc:"Advanced file operations", category:"files", builtin:true, enabled:true,
    shortcuts: WIN ? {
      fsize  :(a)=>`$s=Get-ChildItem -Recurse -File -LiteralPath ${q(a||".")} -EA SilentlyContinue|Measure-Object -Property Length -Sum;Write-Host "$([math]::Round($s.Sum/1MB,2)) MB ($($s.Count) files)"`,
      fopen  :(a)=>a?`Start-Process ${q(a)}`:`echo "usage: 'fopen <file>"`,
      fhash  :(a)=>a?`Get-FileHash -LiteralPath ${q(a)} | Format-Table Algorithm,Hash`:`echo "usage: 'fhash <file>"`,
      flatest:`Get-ChildItem -Recurse -File -EA SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 10 LastWriteTime,@{N='File';E={$_.Name}} | Format-Table -AutoSize`,
      fbig   :`Get-ChildItem -Recurse -File -EA SilentlyContinue | Sort-Object Length -Descending | Select-Object -First 10 @{N='MB';E={[math]::Round($_.Length/1MB,2)}},Name | Format-Table -AutoSize`,
    } : {
      fsize  :(a)=>`du -sh ${q(a||".")}`,
      fopen  :(a)=>a?`xdg-open ${q(a)}`:`echo "usage: 'fopen <file>"`,
      fhash  :(a)=>a?`sha256sum ${q(a)}`:`echo "usage: 'fhash <file>"`,
      flatest:`find . -type f -printf '%T@ %TY-%Tm-%Td %TH:%TM  %p\n' 2>/dev/null | sort -rn | head -n 10 | cut -d' ' -f2-`,
      fbig   :`find . -type f -printf '%s\t%p\n' 2>/dev/null | sort -rn | head -n 10 | awk -F'\t' '{printf "%8.2f MB  %s\n", $1/1048576, $2}'`,
    }},
];

// The Lua plugins that ship with OXIS (builtins/*.lua): off until
// 'plugin enable <name>; built-ins are trusted, so no permission prompts.
const LUA_PLUGIN_META: Record<string, { desc: string; category: string; enabled: boolean; source: string }> = {
  notes:    { desc:"Project notes and tasks in Markdown: 'note, 'notes",                  category:"utility", enabled:false, source: notesLua },
  todo:     { desc:"Every TODO/FIXME/HACK/BUG in the project, linked: 'todo",            category:"dev",     enabled:false, source: todoLua },
  snippets: { desc:"Saved commands with arguments: 'snip",                                category:"utility", enabled:false, source: snippetsLua },
  http:     { desc:"HTTP requests with timing and laid-out JSON: 'http",                  category:"dev",     enabled:false, source: httpLua },
  env:      { desc:".env with masked values, checked against .env.example: 'dotenv",     category:"dev",     enabled:false, source: envLua },
};
const LUA_PLUGIN_NAMES = Object.keys(LUA_PLUGIN_META);

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
