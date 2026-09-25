/**
 * userConfig.ts — the per-user ~/.oxis folder.
 *
 *   ~/.oxis/config.lua      run once at startup with the full oxis.* API
 *                           (trusted, like a workspace.lua): set a theme,
 *                           enable plugins, add commands, keymaps, tasks
 *   ~/.oxis/themes/*.json   extra themes, available to 'theme by name
 *
 * Native app only; a browser tab has no filesystem access.
 */

import { isNativeApp, userConfigDir, listDir, readFile, statPath } from "../native";
import { themeManager, type Theme } from "./themeManager";
import { loadLuaPlugin, type LoadedLuaPlugin } from "../plugins/luaRuntime";
import { buildLuaAPI, type APIContext } from "../plugins/pluginAPI";
import { recordError } from "./diagnostics";
import { registry } from "./commandRegistry";

let configPlugin: LoadedLuaPlugin | null = null;

export interface UserConfigResult {
  dir: string;
  themes: string[];
  problems: string[];
  configLoaded: boolean;
}

/** Loads user themes, then runs config.lua. Safe to call again
 *  ('config reload): the previous config.lua VM is disposed first. */
export async function loadUserConfig(apiCtx: APIContext): Promise<UserConfigResult | null> {
  if (!isNativeApp()) return null;
  const dir = (await userConfigDir()).replace(/\\/g, "/");
  const result: UserConfigResult = { dir, themes: [], problems: [], configLoaded: false };

  // Themes first, so config.lua can switch to one of them.
  let entries: Awaited<ReturnType<typeof listDir>> = [];
  try { entries = await listDir(`${dir}/themes`); } catch { /* no themes folder */ }
  for (const e of entries) {
    if (e.isDir || !e.name.toLowerCase().endsWith(".json")) continue;
    try {
      const theme = JSON.parse(await readFile(`${dir}/themes/${e.name}`)) as Theme;
      const name = theme.name || e.name.replace(/\.json$/i, "");
      const missing = themeManager.addExternal(name, theme);
      if (missing.length) result.problems.push(`themes/${e.name}: missing ${missing.join(", ")}`);
      else result.themes.push(name);
    } catch (err) {
      result.problems.push(`themes/${e.name}: ${err instanceof Error ? err.message : err}`);
    }
  }

  themeManager.restoreSaved();

  configPlugin?.dispose();
  configPlugin = null;
  registry.unregisterByPlugin("__config__");
  const configPath = `${dir}/config.lua`;
  const stat = await statPath(configPath).catch(() => null);
  if (stat?.exists) {
    try {
      const source = await readFile(configPath);
      const loaded = loadLuaPlugin(source, buildLuaAPI({ ...apiCtx, pluginName: "__config__", isTrusted: true }));
      if (loaded.ok) {
        configPlugin = loaded.plugin;
        result.configLoaded = true;
      } else {
        result.problems.push(`config.lua: ${loaded.error}`);
      }
    } catch (err) {
      result.problems.push(`config.lua: ${err instanceof Error ? err.message : err}`);
    }
  }

  for (const p of result.problems) recordError(`~/.oxis/${p}`, "app");
  return result;
}
