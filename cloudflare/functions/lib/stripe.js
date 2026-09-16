/**
 * lib/stripe.js — minimal Stripe REST client for Cloudflare Pages
 * Functions.
 *
 * This project has no build step (static Pages + Functions, no
 * package.json/bundler) — the `stripe` npm SDK isn't usable without
 * one. Stripe's API is plain HTTPS + form-encoded bodies, so a small
 * fetch()-based client is the correct, dependency-free way to call it
 * from a Worker. Nothing here talks to any secret from the client —
 * every call reads `env.STRIPE_SECRET_KEY`, which only exists
 * server-side (Cloudflare Pages "Environment variables", or
 * `.dev.vars` locally — see .dev.vars.example). It is never sent to
 * the browser, never bundled into index.html, and never touches the
 * OXIS desktop app or its Lua plugins.
 */

const STRIPE_API = "https://api.stripe.com/v1";

/** Stripe wants classic form-encoding, including bracket notation for
 *  nested objects (`subscription_data[application_fee_percent]=25`). */
function encodeStripeParams(obj, prefix = "") {
  const parts = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const paramKey = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((v, i) => parts.push(...encodeStripeParams({ [i]: v }, paramKey)));
    } else if (typeof value === "object") {
      parts.push(...encodeStripeParams(value, paramKey));
    } else {
      parts.push(`${encodeURIComponent(paramKey)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts;
}

/**
 * POST/GET to the Stripe API. `params` is a plain object — nested
 * objects/arrays are encoded Stripe-style automatically.
 * `idempotencyKey` is optional but strongly recommended for anything
 * that creates a charge/subscription, so a retried request (flaky
 * network, Cloudflare cold start) can't double-charge a customer.
 */
export async function stripeRequest(env, method, path, params = {}, idempotencyKey) {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY is not configured — see .dev.vars.example / README § Stripe");
  }
  const headers = {
    Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  const body = method === "GET" ? undefined : encodeStripeParams(params).join("&");
  const qs = method === "GET" && Object.keys(params).length ? `?${encodeStripeParams(params).join("&")}` : "";

  const res = await fetch(`${STRIPE_API}${path}${qs}`, { method, headers, body });
  const json = await res.json();
  if (!res.ok) {
    const message = json?.error?.message || `Stripe API error (${res.status})`;
    const err = new Error(message);
    err.stripeError = json?.error;
    err.status = res.status;
    throw err;
  }
  return json;
}

/**
 * Verify a Stripe webhook signature by hand (Stripe's documented v1
 * scheme), since we're not using the SDK's built-in
 * `stripe.webhooks.constructEvent`. Timestamp tolerance guards
 * against replaying an old captured request.
 */
export async function verifyStripeSignature(rawBody, sigHeader, secret, toleranceSeconds = 300) {
  if (!sigHeader || !secret) return false;
  const parts = Object.fromEntries(sigHeader.split(",").map((p) => p.split("=")));
  const timestamp = parts.t;
  const v1 = parts.v1;
  if (!timestamp || !v1) return false;

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSeconds) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const expected = [...new Uint8Array(sigBuffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

  return timingSafeEqual(expected, v1);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}
