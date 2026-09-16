/**
 * POST /checkout
 * Body (JSON): { plugin: string, customerEmail?: string }
 *
 * Looks up the plugin in index.json, creates a Stripe Checkout
 * Session in subscription mode for its configured Price, and returns
 * the session URL for the browser to redirect to.
 *
 * Third-party plugins (index.json entry has `stripeConnectAccountId`)
 * get the 75/25 split automatically via Stripe Connect destination
 * charges: `subscription_data.transfer_data.destination` sends the
 * subscription's underlying charges to the developer's connected
 * account, and `application_fee_percent: 25` keeps OXIS's cut on the
 * platform account. OXIS-owned plugins (AI DevOps) omit both fields —
 * the whole subscription is OXIS revenue, nothing to split.
 *
 * Test mode vs. live mode is controlled entirely by which
 * STRIPE_SECRET_KEY is configured (sk_test_... vs sk_live_...) — see
 * README § Stripe. There is no separate code path; using a live key
 * here is a deploy-time decision, not something this file decides.
 */

import { stripeRequest } from "./lib/stripe.js";

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "expected JSON body: { plugin, customerEmail? }" }, 400);
  }

  const { plugin, customerEmail } = body || {};
  if (!plugin) return json({ error: "missing 'plugin'" }, 400);

  const listing = await fetchPluginListing(request, plugin);
  if (!listing) return json({ error: `unknown plugin: ${plugin}` }, 404);
  if (!listing.premium) return json({ error: `${plugin} is free — no checkout needed, use 'market install ${plugin}` }, 400);
  if (!listing.stripePriceId) return json({ error: `${plugin} has no Stripe Price configured yet — see README § Stripe` }, 409);

  const siteUrl = new URL(request.url).origin;

  const params = {
    mode: "subscription",
    line_items: [{ price: listing.stripePriceId, quantity: 1 }],
    success_url: `${siteUrl}/?checkout=success&plugin=${encodeURIComponent(plugin)}`,
    cancel_url: `${siteUrl}/?checkout=cancelled&plugin=${encodeURIComponent(plugin)}`,
    client_reference_id: plugin,
    customer_email: customerEmail || undefined,
    metadata: { plugin, oxisOwned: listing.stripeConnectAccountId ? "false" : "true" },
  };

  // Third-party developer plugin — split via Stripe Connect. OXIS-owned
  // plugins (no connected account) skip this entirely; see README
  // § Third-Party Developer Marketplace for the 75/25 model.
  if (listing.stripeConnectAccountId) {
    params.subscription_data = {
      application_fee_percent: 25,
      transfer_data: { destination: listing.stripeConnectAccountId },
      metadata: { plugin },
    };
  } else {
    params.subscription_data = { metadata: { plugin } };
  }

  try {
    const session = await stripeRequest(env, "POST", "/checkout/sessions", params, `checkout-${plugin}-${Date.now()}`);
    return json({ url: session.url, id: session.id });
  } catch (e) {
    return json({ error: e.message || "Stripe checkout session creation failed" }, 502);
  }
}

async function fetchPluginListing(request, name) {
  const siteUrl = new URL(request.url).origin;
  const res = await fetch(`${siteUrl}/index.json`);
  if (!res.ok) return null;
  const list = await res.json();
  return list.find((p) => p.name === name) || null;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
