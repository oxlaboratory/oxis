/**
 * GET /verify-license?plugin=<name>&email=<email>
 *
 * Called by the OXIS desktop app's premium plugin licensing flow (see
 * README § Premium Plugin Licensing & Encryption) before decrypting a
 * premium plugin package into memory. Returns whether the given
 * email currently has an active subscription for the given plugin.
 *
 * This is intentionally a read-only, low-information endpoint: it
 * confirms active/inactive, nothing about billing details, card
 * info, or anything else Stripe holds. It does NOT accept or require
 * a password — the license is tied to the email used at Stripe
 * Checkout, same trust model as e.g. a Steam key tied to a purchase
 * email, not a full account system.
 */

import { getLicense, isActive } from "./lib/licenses.js";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const plugin = url.searchParams.get("plugin");
  const email = url.searchParams.get("email");

  if (!plugin || !email) {
    return json({ error: "usage: /verify-license?plugin=<name>&email=<email>" }, 400);
  }

  try {
    const record = await getLicense(env, plugin, email);
    return json({
      plugin,
      active: isActive(record),
      status: record?.status || "none",
    });
  } catch (e) {
    // A KV-not-bound config error should be loud and actionable, not
    // a silent "active: false" that looks like a real denial.
    return json({ error: e.message || "license lookup failed" }, 503);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
