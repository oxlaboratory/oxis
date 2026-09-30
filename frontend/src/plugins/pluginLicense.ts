/**
 * pluginLicense.ts — asks the Market backend (/verify-license) whether an
 * email has an active subscription for a plugin, and activates this
 * device for it (a license runs on up to 3 devices; 'market devices
 * lists them and 'market deactivate frees one). The email is set once
 * with 'market license <email>; there are no OXIS accounts.
 *
 * Offline, a license confirmed in the last 30 days still counts, so a
 * laptop on a plane or a server that's down doesn't stop a plugin that
 * was paid for.
 */

import { marketBase, marketFetch } from "./market";
import { getDeviceId } from "./pluginEncryption";

const EMAIL_KEY = "oxis-license-email-v1";
const CACHE_KEY_PREFIX = "oxis-license-cache-v1:";
const CACHE_TTL_MS = 5 * 60 * 1000; // re-check every 5 min, not on every single command
export const OFFLINE_GRACE_DAYS = 30;

export interface LicenseCheckResult {
  active: boolean;
  status: string;
  /** Whether this device is activated for the license (unknown from an
   *  older server). */
  activated?: boolean;
  devices?: number;
  maxDevices?: number;
  /** The server couldn't be reached; this is the last confirmed answer,
   *  good for graceDaysLeft more days. */
  offline?: boolean;
  graceDaysLeft?: number;
  error?: string; // set on a network/config failure — treat as "can't confirm", not "definitely inactive"
}

export function getLicensedEmail(): string | null {
  return localStorage.getItem(EMAIL_KEY);
}

export function setLicensedEmail(email: string): void {
  localStorage.setItem(EMAIL_KEY, email.trim());
}

/** A name for this device in 'market devices: its OS and the start of
 *  its random id (nothing that identifies the machine). */
export function deviceName(): string {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? "Windows" : /Mac/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "device";
  return `${os} · ${getDeviceId().slice(0, 8)}`;
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

/** The last confirmed answer, if the server can't be reached now and it
 *  was an active, activated license less than OFFLINE_GRACE_DAYS ago. */
function offlineAnswer(plugin: string, error: string): LicenseCheckResult {
  const cached = readCache(plugin);
  const age = cached ? Date.now() - cached.at : Infinity;
  const grace = OFFLINE_GRACE_DAYS * 86_400_000;
  if (cached?.result.active && cached.result.activated !== false && age < grace) {
    return { ...cached.result, status: "offline", offline: true, graceDaysLeft: Math.max(1, Math.ceil((grace - age) / 86_400_000)), error };
  }
  return { active: false, status: "error", error };
}

/**
 * Whether the stored email has an active subscription for `plugin`, and
 * whether this device is activated for it. Cached for CACHE_TTL_MS;
 * `force` bypasses the cache (e.g. right after checkout).
 */
export async function checkLicense(plugin: string, opts?: { force?: boolean }): Promise<LicenseCheckResult> {
  const email = getLicensedEmail();
  if (!email) return { active: false, status: "no-email", error: "no licensed email set — run 'market license <email>" };

  if (!opts?.force) {
    const cached = readCache(plugin);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.result;
  }

  try {
    const q = `plugin=${encodeURIComponent(plugin)}&email=${encodeURIComponent(email)}&device=${encodeURIComponent(getDeviceId())}&name=${encodeURIComponent(deviceName())}`;
    const res = await marketFetch(`${marketBase()}/verify-license?${q}`);
    const data = await res.json();
    if (!res.ok) {
      // The server is up but failing: the last good answer still counts.
      return res.status >= 500 ? offlineAnswer(plugin, data?.error || `license server returned ${res.status}`)
        : { active: false, status: "error", error: data?.error || `license server returned ${res.status}` };
    }
    const result: LicenseCheckResult = {
      active: !!data.active, status: data.status || "unknown",
      activated: data.activated, devices: data.devices, maxDevices: data.maxDevices,
    };
    if (result.active && result.activated === false) {
      result.error = `not activated on this device: the license is on ${data.devices} of ${data.maxDevices} devices — 'market devices ${plugin} to see them, 'market deactivate ${plugin} <device> to free one`;
    }
    writeCache(plugin, result);
    return result;
  } catch (e) {
    return offlineAnswer(plugin, e instanceof Error ? e.message : "network error reaching the OXIS Market");
  }
}

export interface LicenseDevice { id: string; name: string; at: number }

/** The devices a license is activated on. */
export async function listDevices(plugin: string): Promise<{ devices: LicenseDevice[]; maxDevices: number }> {
  const email = getLicensedEmail();
  if (!email) throw new Error("no licensed email set — run 'market license <email>");
  const res = await marketFetch(`${marketBase()}/license-devices?plugin=${encodeURIComponent(plugin)}&email=${encodeURIComponent(email)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `license server returned ${res.status}`);
  return { devices: data.devices ?? [], maxDevices: data.maxDevices ?? 3 };
}

/** Frees a device's activation (its id, or the start of it). */
export async function deactivateDevice(plugin: string, device: string): Promise<{ removed: number; devices: LicenseDevice[] }> {
  const email = getLicensedEmail();
  if (!email) throw new Error("no licensed email set — run 'market license <email>");
  const res = await marketFetch(`${marketBase()}/license-devices`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plugin, email, device }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `license server returned ${res.status}`);
  localStorage.removeItem(CACHE_KEY_PREFIX + plugin); // this device may be the one that went
  return { removed: data.removed ?? 0, devices: data.devices ?? [] };
}

export function isThisDevice(id: string): boolean {
  return id === getDeviceId();
}
