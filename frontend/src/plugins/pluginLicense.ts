/**
 * pluginLicense.ts — subscription verification client.
 *
 * Talks to the OXIS Market's /verify-license endpoint (see
 * oxis-cloudflare-site/functions/verify-license.js) — the same
 * Cloudflare Pages backend that already serves index.json and
 * handles Stripe webhooks. There is no separate "licensing server";
 * this is the Market backend, consistent with README's "no separate
 * Store — use OXIS Market everywhere."
 *
 * Local licensed-email storage is deliberately simple for v1.2.2: the
 * user types the email they subscribed with once (`'market license
 * <email>`), it's cached, and every premium plugin load re-checks
 * against it. There's no separate OXIS account/password system.
 */

const MARKET_BASE = "https://oxis-market.pages.dev"; // see README § Plugin Marketplace for the live URL
const EMAIL_KEY = "oxis-license-email-v1";
const CACHE_KEY_PREFIX = "oxis-license-cache-v1:";
const CACHE_TTL_MS = 5 * 60 * 1000; // re-check every 5 min, not on every single command

export interface LicenseCheckResult {
  active: boolean;
  status: string;
  error?: string; // set on a network/config failure — treat as "can't confirm", not "definitely inactive"
}

export function getLicensedEmail(): string | null {
  return localStorage.getItem(EMAIL_KEY);
}

export function setLicensedEmail(email: string): void {
  localStorage.setItem(EMAIL_KEY, email.trim());
}

interface CacheEntry { result: LicenseCheckResult; at: number; }

function readCache(plugin: string): CacheEntry | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY_PREFIX + plugin);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function writeCache(plugin: string, result: LicenseCheckResult): void {
  try { localStorage.setItem(CACHE_KEY_PREFIX + plugin, JSON.stringify({ result, at: Date.now() })); }
  catch { /* non-fatal — just means a re-check next time instead of a cache hit */ }
}

/**
 * Check whether the locally-stored licensed email currently has an
 * active subscription for `plugin`. Caches for CACHE_TTL_MS so a
 * plugin used repeatedly doesn't hit the network on every command —
 * pass `force: true` right after a checkout to skip the stale cache.
 */
export async function checkLicense(plugin: string, opts?: { force?: boolean }): Promise<LicenseCheckResult> {
  const email = getLicensedEmail();
  if (!email) return { active: false, status: "no-email", error: "no licensed email set — run 'market license <email>" };

  if (!opts?.force) {
    const cached = readCache(plugin);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.result;
  }

  try {
    const res = await fetch(`${MARKET_BASE}/verify-license?plugin=${encodeURIComponent(plugin)}&email=${encodeURIComponent(email)}`);
    const data = await res.json();
    if (!res.ok) {
      const result: LicenseCheckResult = { active: false, status: "error", error: data?.error || `license server returned ${res.status}` };
      return result; // don't cache errors — worth retrying sooner
    }
    const result: LicenseCheckResult = { active: !!data.active, status: data.status || "unknown" };
    writeCache(plugin, result);
    return result;
  } catch (e) {
    return { active: false, status: "error", error: e instanceof Error ? e.message : "network error reaching the OXIS Market" };
  }
}
