/**
 * POST /webhook
 *
 * Real Stripe webhook endpoint — this REPLACES the previous Paymento
 * payment-link webhook (functions/webhook.js used to verify
 * `x-paymento-signature` against PAYMENT_PROVIDER_SECRET; that
 * provider and both its env vars are gone from this project now).
 *
 * Set this exact URL as an endpoint in the Stripe Dashboard ->
 * Developers -> Webhooks (test mode while STRIPE_SECRET_KEY is a
 * sk_test_... key): https://your-site.pages.dev/webhook
 * Subscribe it to at least:
 *   checkout.session.completed
 *   customer.subscription.updated
 *   customer.subscription.deleted
 *
 * Requires two env vars (Cloudflare Pages -> Settings -> Environment
 * variables, or .dev.vars locally — see .dev.vars.example):
 *   STRIPE_SECRET_KEY      — server-side only, never sent to the browser
 *   STRIPE_WEBHOOK_SECRET  — the signing secret Stripe shows you for this endpoint
 * and the OXIS_LICENSES KV namespace binding (see lib/licenses.js).
 */

import { verifyStripeSignature, stripeRequest } from "./lib/stripe.js";
import { putLicense, LicenseStoreUnavailable } from "./lib/licenses.js";

export async function onRequestPost({ request, env }) {
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");

  const valid = await verifyStripeSignature(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) {
    return new Response("invalid signature", { status: 401 });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response("bad json", { status: 200 }); // ack so Stripe doesn't retry forever on a malformed body
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const plugin = session.client_reference_id || session.metadata?.plugin;
        const email = session.customer_details?.email || session.customer_email;
        if (plugin && email) {
          await putLicense(env, plugin, email, {
            status: "active",
            customerId: session.customer,
            subscriptionId: session.subscription,
          });
        } else {
          console.warn("[webhook] checkout.session.completed missing plugin or email", { plugin, email });
        }
        break;
      }
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const plugin = sub.metadata?.plugin;
        if (!plugin) { console.warn("[webhook] subscription event with no plugin metadata", sub.id); break; }
        // Need the email — subscriptions don't carry it directly, so
        // look the customer up. One extra Stripe API call per event,
        // which is fine at webhook volume.
        const customer = await stripeRequest(env, "GET", `/customers/${sub.customer}`);
        const email = customer.email;
        if (!email) { console.warn("[webhook] customer has no email", sub.customer); break; }
        const status = event.type === "customer.subscription.deleted"
          ? "canceled"
          : (sub.status === "active" || sub.status === "trialing" ? "active" : sub.status);
        await putLicense(env, plugin, email, { status, customerId: sub.customer, subscriptionId: sub.id });
        break;
      }
      default:
        // Unhandled event types are fine to ack and ignore.
        break;
    }
  } catch (e) {
    if (e instanceof LicenseStoreUnavailable) {
      // This is a real configuration problem, not a transient error —
      // ack the webhook anyway (500 here would make Stripe hammer
      // retries against a KV binding that isn't going to appear on
      // its own) but log loudly so it's visible in Cloudflare Pages
      // -> Logs.
      console.error("[webhook] " + e.message);
      return new Response("ok (license not persisted — see server logs)", { status: 200 });
    }
    console.error("[webhook] handler error", e);
    return new Response("internal error", { status: 500 });
  }

  return new Response("ok", { status: 200 });
}
