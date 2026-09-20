/**
 * market.ts — OXIS plugin marketplace client
 *
 * Talks to the community plugin index at https://oxis-market.pages.dev.
 * Expected contract (static JSON + raw files, e.g. served straight off
 * Cloudflare Pages):
 *
 *   GET  {BASE}/index.json
 *     → [ { name, desc, category, version, author, file }, ... ]
 *
 *   GET  {BASE}/{file}          (file path as given in the index entry)
 *     → raw Lua source for that plugin
 *
 * Installed plugins are registered as ordinary user Lua plugins via
 * pluginManager.addLuaPlugin(), so once installed they behave exactly
 * like a plugin written locally with 'plugin new — written to a real
 * .lua file on disk (native window only; see isNativeApp() in
 * native.ts), manageable with 'plugin enable/disable/reload.
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

/** Fetch (and cache for this session) the marketplace index. Just the
 *  one curated index.json — 'plugin publish opens a real GitLab merge
 *  request (see cloudflare/functions/submit-plugin.js) rather than
 *  writing anywhere separate, so once a submission is reviewed and
 *  merged, it shows up in this exact same file like everything else;
 *  there's no second, self-published index to also fetch and merge. */
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

/** Download + register + persist (to a real .lua file — see
 *  pluginManager.addLuaPlugin) a marketplace plugin by name. Resolves
 *  with both the marketplace entry and whether the disk write itself
 *  succeeded — a plugin can be fully installed & working this session
 *  even if persistence to disk failed (browser mode, permissions,
 *  etc.), and callers need to tell those two outcomes apart. */
export async function install(name: string): Promise<{ entry: MarketEntry; persisted: boolean; persistError?: unknown }> {
  const entry = await findEntry(name);
  if (!entry) throw new Error(`not found in marketplace: ${name}`);
  if (entry.premium) throw new Error(`${name} is premium — 'market install routes to installPremium automatically from the terminal command; calling market.install() directly for a premium plugin is a bug`);
  const lua = await fetchPluginSource(entry);
  const { persisted, persistError } = await pluginManager.addLuaPlugin(entry.name, lua, entry.category || "market");
  return { entry, persisted, persistError };
}

// ── Premium plugins — Stripe subscription + local encryption ────
// See README § Premium Plugin Licensing & Encryption for the full
// flow this implements: subscribe (Stripe Checkout) -> webhook issues
// a license -> desktop verifies the license -> fetches source over
// HTTPS (never as a public static file, see premium-plugin.js) ->
// encrypts it for local storage -> decrypts into memory only when the
// license is confirmed active.

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

/** After a successful subscription (webhook has run, license is
 *  active): fetch the plugin's real source, encrypt it for local
 *  storage, and register it exactly like any other plugin. Requires
 *  the native app (real filesystem) — same constraint the editor and
 *  workspace files already have. */
export async function installPremium(name: string): Promise<{ entry: MarketEntry }> {
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

  await loadPremiumPlugin(name); // register it for this session immediately, don't make the user reload
  return { entry };
}

/** Loads an already-installed premium plugin: decrypts into memory
 *  (never written back to disk in plaintext) IF the subscription is
 *  still active. This is the check that makes an expired subscription
 *  stop a plugin from running while leaving the encrypted file alone
 *  on disk — see README's licensing lifecycle diagram. Called at
 *  startup for every premium package found under .oxis/premium/, and
 *  again by 'market install/'plugin reload. */
export async function loadPremiumPlugin(name: string): Promise<{ ok: boolean; message: string }> {
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

  await pluginManager.registerPremiumPlugin(name, source, "premium");
  return { ok: true, message: `${name} loaded` };
}

/** Scans .oxis/premium/ for previously-installed encrypted packages
 *  and attempts to load each — called once at startup (see App.tsx's
 *  root init effect), same idea as pluginManager's own loadAll() for
 *  ordinary plugin files. Each package independently succeeds or
 *  reports why it didn't (expired subscription, no licensed email
 *  set, etc.) via loadPremiumPlugin()'s own return value; one
 *  package's failure doesn't stop the others from loading. */
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
    const r = await loadPremiumPlugin(name);
    results.push({ name, ...r });
  }
  return results;
}