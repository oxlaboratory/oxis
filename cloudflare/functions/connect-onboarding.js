/**
 * POST /connect-onboarding
 * Body (JSON): { email: string }
 *
 * First step of third-party developer payouts (README § Third-Party
 * Developer Marketplace): creates a Stripe Connect **Express**
 * account for the developer and returns an onboarding link. Express
 * (not Standard or Custom) because it's the right fit here — Stripe
 * hosts the KYC/bank-details flow, OXIS never touches or stores the
 * developer's banking info directly, and it's the fastest path to a
 * working payout account.
 *
 * The returned `accountId` (acct_...) is what checkout.js's
 * `stripeConnectAccountId` field is, once you add the developer's
 * plugin to index.json. Account creation succeeds immediately; the
 * account can't actually RECEIVE payouts until the developer finishes
 * the onboarding link's KYC steps — Stripe tracks that as
 * `charges_enabled`/`payouts_enabled` on the account, which is why
 * production payouts stay gated on "account verification complete"
 * (README § v1.2.2 preparation) rather than being available the
 * moment this endpoint returns.
 */

import { stripeRequest } from "./lib/stripe.js";

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "expected JSON body: { email }" }, 400);
  }
  const { email } = body || {};
  if (!email) return json({ error: "missing 'email'" }, 400);

  const siteUrl = new URL(request.url).origin;

  try {
    const account = await stripeRequest(env, "POST", "/accounts", {
      type: "express",
      email,
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
    }, `connect-acct-${email}-${Date.now()}`);

    const link = await stripeRequest(env, "POST", "/account_links", {
      account: account.id,
      refresh_url: `${siteUrl}/developers?onboarding=refresh`,
      return_url: `${siteUrl}/developers?onboarding=complete&account=${account.id}`,
      type: "account_onboarding",
    });

    return json({ accountId: account.id, onboardingUrl: link.url });
  } catch (e) {
    return json({ error: e.message || "Stripe Connect account creation failed" }, 502);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
