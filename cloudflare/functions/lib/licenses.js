/**
 * lib/licenses.js — shared license storage.
 *
 * Requires a Cloudflare KV namespace bound as `OXIS_LICENSES` (Pages
 * project -> Settings -> Functions -> KV namespace bindings). There's
 * deliberately no fallback to some in-memory/log-only mode here the
 * way the old Paymento webhook had — a license system that silently
 * doesn't persist anything is worse than one that fails loudly, per
 * README § Automatic Initialization: "if something cannot initialize,
 * provide a clear actionable error instead of silently failing."
 *
 * Key scheme: `license:{plugin}:{email}` (email lowercased) — the
 * simplest thing that lets the OXIS desktop app check a subscription
 * using only the email the user checked out with, no separate OXIS
 * account system required for v1.2.2. Value is JSON:
 *   { status: "active"|"past_due"|"canceled", customerId, subscriptionId, updatedAt }
 */

export class LicenseStoreUnavailable extends Error {
  constructor() {
    super("OXIS_LICENSES KV namespace isn't bound — add it in Cloudflare Pages -> Settings -> Functions -> KV namespace bindings (see README § Stripe)");
    this.name = "LicenseStoreUnavailable";
  }
}

function key(plugin, email) {
  return `license:${plugin}:${String(email).trim().toLowerCase()}`;
}

export async function putLicense(env, plugin, email, record) {
  if (!env.OXIS_LICENSES) throw new LicenseStoreUnavailable();
  await env.OXIS_LICENSES.put(key(plugin, email), JSON.stringify({ ...record, updatedAt: Date.now() }));
}

export async function getLicense(env, plugin, email) {
  if (!env.OXIS_LICENSES) throw new LicenseStoreUnavailable();
  const raw = await env.OXIS_LICENSES.get(key(plugin, email));
  return raw ? JSON.parse(raw) : null;
}

/** True if a stored license record represents an active, usable subscription. */
export function isActive(record) {
  return !!record && record.status === "active";
}
