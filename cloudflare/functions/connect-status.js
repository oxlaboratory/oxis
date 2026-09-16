/**
 * GET /connect-status?account=<acct_...>
 *
 * Reports whether a developer's Stripe Connect account has finished
 * onboarding/verification. This is the gate referenced throughout the
 * README (v1.2.2 preparation: "production payments must remain
 * disabled until the required account verification is complete") —
 * a plugin should not be listed as purchasable with real money via
 * this account until BOTH charges_enabled and payouts_enabled are
 * true. In Stripe test mode, Express test accounts typically report
 * both as true almost immediately (Stripe fakes KYC in test mode),
 * which is exactly what makes it possible to test the full 75/25
 * payout flow end-to-end before going live.
 */

import { stripeRequest } from "./lib/stripe.js";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const accountId = url.searchParams.get("account");
  if (!accountId) return json({ error: "usage: /connect-status?account=<acct_...>" }, 400);

  try {
    const account = await stripeRequest(env, "GET", `/accounts/${accountId}`);
    return json({
      accountId,
      chargesEnabled: !!account.charges_enabled,
      payoutsEnabled: !!account.payouts_enabled,
      detailsSubmitted: !!account.details_submitted,
      readyForProduction: !!(account.charges_enabled && account.payouts_enabled),
    });
  } catch (e) {
    return json({ error: e.message || "couldn't fetch account status" }, 502);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
