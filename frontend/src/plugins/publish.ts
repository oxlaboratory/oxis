/**
 * publish.ts — 'plugin publish <name>.
 *
 * What this genuinely does:
 *  - Validates the plugin is actually publishable (real checks, reusing
 *    pluginManager.validate() plus publish-specific manifest
 *    completeness checks — version/description/author/category/
 *    min_oxis_version all need to be real for a Market listing, even
 *    though they're merely optional for a plugin you only run yourself).
 *  - Prepares the exact metadata bundle README.md's documented
 *    MarketEntry shape (frontend/src/plugins/market.ts) expects.
 *  - For a PAID plugin, kicks off a REAL Stripe Connect Express
 *    account — a genuine network call to the already-deployed
 *    `/connect-onboarding` endpoint (see cloudflare/functions/
 *    connect-onboarding.js), not a stub — and opens the real
 *    onboarding URL Stripe returns.
 *
 * What this deliberately does NOT do, and says so out loud rather than
 * pretending otherwise: actually add the plugin to the Market's
 * index.json. There is no self-service "submit my plugin" endpoint in
 * the existing backend (checkout.js/webhook.js/connect-onboarding.js
 * handle payments and licensing, not listing submissions) — index.json
 * is maintained directly by the OXIS team. This hands the developer to
 * that real process (a copy-pasteable metadata block + where to send
 * it) instead of claiming "published!" when nothing was actually
 * submitted anywhere. Building actual self-service submission — and
 * the rest of the Connect payout wiring once an account is old enough
 * to complete Stripe's own KYC — is planned for v1.2.2, not this.
 */

import { pluginManager } from "./pluginManager";
import { getLicensedEmail } from "./pluginLicense";
import { MARKET_BASE, findEntry, type MarketEntry } from "./market";

export interface PublishMetadata {
  name: string;
  desc: string;
  category: string;
  version: string;
  author: string;
  file: string;
  minOxisVersion: string;
  os: string[];
  permissions: string[];
  dependencies: Record<string, string>;
  premium: boolean;
  priceDisplay?: string;
}

export interface PublishCheckResult {
  ok: boolean;
  issues: string[]; // missing/invalid required fields — non-empty means "can't publish yet"
  metadata?: PublishMetadata; // present even when ok is false, for whatever's already fillable, so the developer can see what's missing at a glance
}

const REQUIRED_OS = ["windows", "unix"];

/** Checks the plugin is actually ready to publish — real manifest
 *  completeness checks on top of pluginManager.validate()'s existing
 *  ones, since a field being merely OPTIONAL for a plugin you only run
 *  yourself (e.g. no declared version) isn't good enough for a public
 *  Market listing. */
export function checkPublishable(name: string): PublishCheckResult {
  const p = pluginManager.get(name);
  if (!p) return { ok: false, issues: [`not installed: ${name}`] };
  if (p.builtin) return { ok: false, issues: [`${name} is built-in — nothing to publish`] };
  if (p.origin !== "user") {
    return { ok: false, issues: [`${name} isn't one of yours (origin: ${p.origin ?? "unknown"}) — only plugins you created can be published`] };
  }

  const issues: string[] = [];
  const { issues: validateIssues } = pluginManager.validate(name);
  issues.push(...validateIssues);

  const m = p.manifest;
  if (!m) issues.push("no manifest at all — add a --[[@manifest ... ]] block with at least version/description/author/category/min_oxis_version");
  if (!m?.version) issues.push("manifest missing version");
  if (!m?.description && !p.desc) issues.push("manifest missing description");
  if (!m?.author) issues.push("manifest missing author");
  if (!p.category || p.category === "plugin") issues.push("category is just the generic default (\"plugin\") — set a real one in the manifest (category: dev, devops, system, etc.)");
  if (!m?.minOxisVersion) issues.push("manifest missing min_oxis_version");
  if (!m?.os || m.os.length === 0) issues.push(`manifest missing os — declare which platform(s) this actually works on (${REQUIRED_OS.join(", ")})`);

  const metadata: PublishMetadata = {
    name: p.name,
    desc: m?.description || p.desc,
    category: p.category,
    version: m?.version || "0.0.0",
    author: m?.author || "unknown",
    file: `${p.name}.lua`,
    minOxisVersion: m?.minOxisVersion || "",
    os: m?.os || [],
    permissions: m?.permissions || [],
    dependencies: m?.dependencies || {},
    premium: false,
  };

  return { ok: issues.length === 0, issues, metadata };
}

export interface PublishResult {
  ok: boolean;
  message: string;
}

/** Is this plugin already listed on the Market? If so, 'plugin
 *  publish is publishing an UPDATE (a new version of an existing
 *  listing) rather than a first-time listing — detected automatically
 *  rather than needing a separate command, since it's the same
 *  underlying action (hand a metadata block to whoever maintains
 *  index.json) either way, just worded differently. */
export async function findExistingListing(name: string): Promise<MarketEntry | undefined> {
  try { return await findEntry(name); } catch { return undefined; }
}

/** Free plugin — no Stripe involvement, just prepares the metadata
 *  block and hands the developer to the real (non-self-service)
 *  submission process. `existing` (if the plugin's already listed)
 *  switches the wording from "new listing" to "update this entry"
 *  and shows the version change. */
export function prepareFreePublish(metadata: PublishMetadata, existing?: MarketEntry): PublishResult {
  const block = JSON.stringify(
    { name: metadata.name, desc: metadata.desc, category: metadata.category, version: metadata.version, author: metadata.author, file: metadata.file },
    null, 2,
  );
  const isUpdate = !!existing;
  return {
    ok: true,
    message: [
      isUpdate
        ? `Metadata ready to UPDATE the existing Market listing (v${existing!.version || "?"} → v${metadata.version}):`
        : "Metadata ready for a NEW Market listing:",
      "",
      block,
      "",
      isUpdate
        ? `This isn't applied anywhere yet — there's no self-service "update my listing" endpoint (the Market backend handles payments/licensing, not listing edits; see cloudflare/functions/). Send this updated entry to whoever maintains oxis-market.pages.dev's index.json to replace the existing one.`
        : `This isn't submitted anywhere yet — there's no self-service "add my plugin" endpoint in the current Market backend (it handles payments/licensing, not listing submissions; see cloudflare/functions/). Open a merge request adding this entry (and ${metadata.file}) to the Market repo's index.json, or send it to whoever maintains oxis-market.pages.dev.`,
    ].join("\n"),
  };
}

export interface ConnectOnboardingResult {
  ok: boolean;
  message: string;
  onboardingUrl?: string;
  accountId?: string;
}

/** Paid plugin — kicks off a REAL Stripe Connect Express account via
 *  the already-deployed /connect-onboarding endpoint. This is a
 *  genuine network call and a genuine onboarding link Stripe itself
 *  generates, not a placeholder — but completing the onboarding (real
 *  KYC, requires being an adult with a bank account) and the actual
 *  Market listing step afterward are both still on the developer, not
 *  automated end-to-end here. */
export async function startConnectOnboarding(email: string): Promise<ConnectOnboardingResult> {
  try {
    const res = await fetch(`${MARKET_BASE}/connect-onboarding`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(10000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, message: `Stripe Connect account creation failed: ${(body as { error?: string }).error || res.statusText}` };
    }
    const { accountId, onboardingUrl } = body as { accountId?: string; onboardingUrl?: string };
    if (!accountId || !onboardingUrl) return { ok: false, message: "Market backend returned an unexpected response — no account/onboarding URL" };
    return {
      ok: true,
      accountId, onboardingUrl,
      message: `Stripe Connect Express account created: ${accountId}. Opening the onboarding link — Stripe hosts the KYC/bank-details flow directly; OXIS never sees or stores that information. Payouts can't actually happen until Stripe marks the account verified (charges_enabled/payouts_enabled) — that's on Stripe's side, not something this can check for you yet.`,
    };
  } catch (e) {
    return { ok: false, message: `couldn't reach the Market backend: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export function preparePaidPublishSummary(metadata: PublishMetadata, price: string, interval: string, accountId: string, existing?: MarketEntry): string {
  const isUpdate = !!existing;
  const block = JSON.stringify(
    {
      name: metadata.name, desc: metadata.desc, category: metadata.category, version: metadata.version,
      author: metadata.author, file: metadata.file, premium: true,
      priceDisplay: `$${price}/${interval === "year" ? "yr" : "mo"}`,
      stripeConnectAccountId: accountId,
    },
    null, 2,
  );
  return [
    isUpdate
      ? `Metadata ready to UPDATE the existing Market listing (v${existing!.version || "?"} → v${metadata.version}) once your Stripe Connect account finishes verification:`
      : "Metadata ready for a NEW Market listing, once your Stripe Connect account finishes verification:",
    "",
    block,
    "",
    "Reminder: paid OXIS Market plugins are recurring Stripe subscriptions, not one-time purchases — the 75/25 developer/OXIS split happens automatically inside the Checkout Session's transfer_data (see cloudflare/functions/checkout.js), same as OXIS's own paid plugins.",
    "",
    isUpdate
      ? "This still isn't applied anywhere — as with a first-time listing, updating index.json isn't self-service yet. Send this updated block, once your Connect account shows verified, to whoever maintains the Market listing."
      : "This still isn't submitted anywhere — as with free plugins, adding an entry to index.json (and creating the actual Stripe Price for it) isn't self-service yet. Send this block, once your Connect account shows verified, to whoever maintains the Market listing.",
  ].join("\n");
}