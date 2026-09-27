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
import { readFile, writeFile, listDir, isNativeApp, nativeHttpRequest } from "../native";

export const MARKET_BASE = "https://oxis-market.pages.dev";

/** The Market's files as they are on main, so a plugin is installable
 *  the moment its pull request is merged (the site itself only changes
 *  when it's deployed). */
const MARKET_RAW = "https://raw.githubusercontent.com/oxlaboratory/oxis/main/cloudflare";

/** The Market backend: MARKET_BASE, or a self-hosted one set in
 *  localStorage "oxis-market-base" (also how the publish flow is tested
 *  against a local server). */
export function marketBase(): string {
  try { return (localStorage.getItem("oxis-market-base") || MARKET_BASE).replace(/\/+$/, ""); }
  catch { return MARKET_BASE; }
}

/**
 * fetch() for the Market. In the desktop app the request is made by OXIS
 * itself (HTTPRequest in Go): the page's origin (wails.localhost) is one
 * the Market backend's CORS rules would otherwise have to allow, and a
 * blocked preflight surfaced only as "Failed to fetch". Returns a normal
 * Response either way.
 */
export async function marketFetch(url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
  const native = await nativeHttpRequest({
    url, method: init.method || "GET", headers,
    body: typeof init.body === "string" ? init.body : "",
    timeoutSeconds: Math.ceil(timeoutMs / 1000),
  });
  if (native) {
    const empty = native.status === 204 || native.status === 304;
    return new Response(empty ? null : native.body, { status: native.status, headers: native.headers });
  }
  return fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
}

/** Where to look for a Market file, in order. */
function marketSources(file: string): string[] {
  const base = marketBase();
  const path = file.replace(/^\/+/, "");
  return base === MARKET_BASE ? [`${MARKET_RAW}/${path}`, `${base}/${path}`] : [`${base}/${path}`];
}

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
  permissions?: string[];  // from the plugin's manifest, when it was published
  os?: string[];
  minOxisVersion?: string;
  size?: number;           // bytes of source
  comingSoon?: boolean;    // shown in the market listing, not installable yet
  oxisOwned?: boolean;     // vs. third-party — see README § Third-Party Developer Marketplace
}

let cachedIndex: MarketEntry[] | null = null;

async function fetchJSON<T>(url: string): Promise<T> {
  const res = await marketFetch(url, {}, 8000);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

/** The first source that answers. */
async function fetchFirst<T>(urls: string[], read: (res: Response) => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (const url of urls) {
    try {
      const res = await marketFetch(url, { cache: "no-store" }, 8000);
      if (res.ok) return await read(res);
      lastError = new Error(`${res.status} ${res.statusText}`);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// Plugin names become file names on disk, so entries with anything else
// are dropped.
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function isUsableEntry(e: unknown): e is MarketEntry {
  const m = e as Partial<MarketEntry> | null;
  return !!m && typeof m.name === "string" && SAFE_NAME.test(m.name) && !m.name.includes("..")
    && typeof m.file === "string";
}

/** The Market index, cached for the session. */
export async function fetchIndex(force = false): Promise<MarketEntry[]> {
  if (cachedIndex && !force) return cachedIndex;
  const entries = await fetchFirst<unknown>(marketSources("index.json"), (r) => r.json());
  cachedIndex = (Array.isArray(entries) ? entries : []).filter(isUsableEntry).map(e => ({
    ...e, desc: String(e.desc ?? ""), category: String(e.category ?? "plugin"),
  }));
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
    const counts = await fetchJSON<Record<string, number>>(`${marketBase()}/subscriber-counts?plugin=${encodeURIComponent(name)}`);
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
  return fetchFirst(marketSources(entry.file), (r) => r.text());
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
  const res = await marketFetch(`${marketBase()}/checkout`, {
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
export async function installPremium(typedName: string): Promise<{ entry: MarketEntry; loaded: boolean; loadMessage: string }> {
  const entry = await findEntry(typedName);
  if (!entry) throw new Error(`not found in marketplace: ${typedName}`);
  // The index's spelling, so the file name and plugin name match
  // whatever case was typed.
  const name = entry.name;
  if (!entry.premium) throw new Error(`${name} is free — use 'market install ${name} instead`);
  if (!isNativeApp()) throw new Error("premium plugins need the native OXIS app (local encrypted storage isn't available in browser mode)");

  const email = getLicensedEmail();
  if (!email) throw new Error("no licensed email set — run 'market license <email> first (the email you subscribed with)");

  const license = await checkLicense(name, { force: true });
  if (!license.active) throw new Error(license.error || `no active subscription for ${name} — 'market subscribe ${name} first`);

  const res = await marketFetch(`${marketBase()}/premium-plugin?plugin=${encodeURIComponent(name)}&email=${encodeURIComponent(email)}`);
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