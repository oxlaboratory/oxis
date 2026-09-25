/**
 * market.ts — client for the plugin Market (oxis-market.pages.dev):
 *
 *   GET {BASE}/index.json  → [{ name, desc, category, version, author, file }]
 *   GET {BASE}/{file}      → the plugin's Lua source
 *
 * Installed plugins are ordinary Lua plugins (pluginManager.addLuaPlugin).
 */

import { pluginManager } from "./pluginManager";
import { getLicensedEmail, checkLicense } from "./pluginLicense";
import { encryptPluginPackage, decryptPluginPackage, getDeviceId, type EncryptedPluginPackage } from "./pluginEncryption";
import { readFile, writeFile, listDir, isNativeApp } from "../native";

export const MARKET_BASE = "https://oxis-market.pages.dev";

export interface MarketEntry {
  name: string;
  desc: string;
  category: string;
  version?: string;
  author?: string;
  file: string;
  /** Coming in v1.2.2 — see README § OXIS Market. Absent/false on
   *  every plugin actually available in v1.2.1. */
  premium?: boolean;
  priceDisplay?: string;   // e.g. "$4.99/mo" — display only, real price lives in the Stripe Price
  comingSoon?: boolean;    // shown in the market listing, not installable yet
  oxisOwned?: boolean;     // vs. third-party — see README § Third-Party Developer Marketplace
}

let cachedIndex: MarketEntry[] | null = null;

async function fetchJSON<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

/** The Market index, cached for the session. */
export async function fetchIndex(force = false): Promise<MarketEntry[]> {
  if (cachedIndex && !force) return cachedIndex;
  const entries = await fetchJSON<MarketEntry[]>(`${MARKET_BASE}/index.json`);
  cachedIndex = Array.isArray(entries) ? entries : [];
  return cachedIndex;
}

export async function findEntry(name: string): Promise<MarketEntry | undefined> {
  const idx = await fetchIndex();
  return idx.find(e => e.name.toLowerCase() === name.toLowerCase());
}

/** Active subscribers for a premium plugin, from the server. null when
 *  it can't be determined (so it isn't shown as a false zero). */
export async function fetchSubscriberCount(name: string): Promise<number | null> {
  try {
    const counts = await fetchJSON<Record<string, number>>(`${MARKET_BASE}/subscriber-counts?plugin=${encodeURIComponent(name)}`);
    const n = counts[name];
    return typeof n === "number" ? n : null;
  } catch {
    return null;
  }
}

export function searchIndex(entries: MarketEntry[], query: string): MarketEntry[] {
  const q = query.toLowerCase();
  if (!q) return entries;
  return entries.filter(e =>
    e.name.toLowerCase().includes(q) ||
    e.desc.toLowerCase().includes(q) ||
    e.category.toLowerCase().includes(q));
}

/** Download a plugin's Lua source from the marketplace. */
export async function fetchPluginSource(entry: MarketEntry): Promise<string> {
  const res = await fetch(`${MARKET_BASE}/${entry.file.replace(/^\/+/, "")}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

/** Downloads, registers and saves a Market plugin. Reports separately
 *  whether saving to disk worked (a plugin can run this session even if
 *  it couldn't be saved). */
export async function install(name: string): Promise<{ entry: MarketEntry; persisted: boolean; persistError?: unknown }> {
  const entry = await findEntry(name);
  if (!entry) throw new Error(`not found in marketplace: ${name}`);
  if (entry.premium) throw new Error(`${name} is premium — 'market install routes to installPremium automatically from the terminal command; calling market.install() directly for a premium plugin is a bug`);
  const lua = await fetchPluginSource(entry);
  const { persisted, persistError } = await pluginManager.addLuaPlugin(entry.name, lua, entry.category || "market");
  return { entry, persisted, persistError };
}

// ── Premium plugins: Stripe subscription → license → source fetched
// over HTTPS → stored encrypted → decrypted into memory while the
// license is active. ──

/** Starts a Stripe Checkout session for a premium plugin and returns
 *  the URL to open in a browser — Checkout is a hosted Stripe page,
 *  it can't run inside the terminal itself. */
export async function subscribe(name: string, email?: string): Promise<{ url: string }> {
  const res = await fetch(`${MARKET_BASE}/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plugin: name, customerEmail: email }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `checkout failed (${res.status})`);
  return { url: data.url };
}

const encryptedPluginPath = (name: string) => `.oxis/premium/${name}.oxispkg`;

/** Fetches, encrypts, stores and loads a premium plugin once its
 *  license is active (native app only). */
export async function installPremium(name: string): Promise<{ entry: MarketEntry; loaded: boolean; loadMessage: string }> {
  const entry = await findEntry(name);
  if (!entry) throw new Error(`not found in marketplace: ${name}`);
  if (!entry.premium) throw new Error(`${name} is free — use 'market install ${name} instead`);
  if (!isNativeApp()) throw new Error("premium plugins need the native OXIS app (local encrypted storage isn't available in browser mode)");

  const email = getLicensedEmail();
  if (!email) throw new Error("no licensed email set — run 'market license <email> first (the email you subscribed with)");

  const license = await checkLicense(name, { force: true });
  if (!license.active) throw new Error(license.error || `no active subscription for ${name} — 'market subscribe ${name} first`);

  const res = await fetch(`${MARKET_BASE}/premium-plugin?plugin=${encodeURIComponent(name)}&email=${encodeURIComponent(email)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `couldn't fetch premium source (${res.status})`);

  const pkg = await encryptPluginPackage(name, data.source, getDeviceId());
  await writeFile(encryptedPluginPath(name), JSON.stringify(pkg));

  // Report whether it actually loaded: the encrypted package is saved
  // either way (so a retry doesn't re-download), but "installed" and
  // "loaded" are different results.
  const loadResult = await loadPremiumPlugin(name);
  return { entry, loaded: loadResult.ok, loadMessage: loadResult.message };
}

/** Loads an installed premium plugin into memory if its subscription is
 *  still active; the encrypted file is left alone either way. Called at
 *  startup and by 'market install / 'plugin reload. */
export async function loadPremiumPlugin(name: string, silent = false): Promise<{ ok: boolean; message: string }> {
  if (!isNativeApp()) return { ok: false, message: "premium plugins need the native OXIS app" };
  const email = getLicensedEmail();
  if (!email) return { ok: false, message: `${name}: no licensed email set — 'market license <email>` };

  let raw: string;
  try {
    raw = await readFile(encryptedPluginPath(name));
  } catch {
    return { ok: false, message: `${name}: not installed — 'market subscribe ${name} first` };
  }

  const license = await checkLicense(name);
  if (!license.active) {
    // The encrypted package stays on disk untouched — this is exactly
    // the "expired subscription doesn't delete anything, it just
    // won't run" behavior the README specifies.
    return { ok: false, message: `${name}: subscription not active (${license.status}${license.error ? ` — ${license.error}` : ""}) — the encrypted package is still here, it just won't run until the subscription is active again` };
  }

  let pkg: EncryptedPluginPackage;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return { ok: false, message: `${name}: encrypted package is corrupt — try 'market subscribe ${name} again` };
  }

  let source: string;
  try {
    source = await decryptPluginPackage(pkg, getDeviceId());
  } catch (e) {
    return { ok: false, message: `${name}: ${e instanceof Error ? e.message : e}` };
  }

  await pluginManager.registerPremiumPlugin(name, source, "premium", silent);
  return { ok: true, message: `${name} loaded` };
}

/** Loads every package in .oxis/premium/ at startup; each succeeds or
 *  reports why independently. */
export async function loadAllPremiumPlugins(): Promise<{ name: string; ok: boolean; message: string }[]> {
  if (!isNativeApp()) return [];
  let entries;
  try {
    entries = await listDir(".oxis/premium");
  } catch {
    return []; // no .oxis/premium directory yet — nothing installed, not an error
  }
  const results = [];
  for (const e of entries) {
    if (e.isDir || !e.name.endsWith(".oxispkg")) continue;
    const name = e.name.replace(/\.oxispkg$/, "");
    const r = await loadPremiumPlugin(name, true); // silent — bulk startup load, see pluginManager.load()'s own doc comment
    results.push({ name, ...r });
  }
  return results;
}