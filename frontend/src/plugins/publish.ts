/**
 * publish.ts — 'plugin publish / 'plugin unpublish.
 *
 * Checks the plugin is ready (validate() plus a complete manifest), then
 * sends it to the Market's /submit-plugin endpoint, which opens a pull
 * request against github.com/oxlaboratory/oxis. Nothing goes live until
 * a maintainer merges it. Paid plugins first go through Stripe Connect
 * onboarding (/connect-onboarding).
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

/** Publish checks: validate() plus the manifest fields a Market
 *  listing needs (optional for plugins you only run yourself). */
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
  if (!p.lua || !p.lua.trim()) issues.push("no source available to submit (plugin has no Lua source loaded)");

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

/** Is this plugin already listed on the Market? If so, 'plugin
 *  publish is publishing an UPDATE (the PR replaces its existing
 *  index.json entry) rather than a first-time listing — detected
 *  automatically rather than needing a separate command. */
export async function findExistingListing(name: string): Promise<MarketEntry | undefined> {
  try { return await findEntry(name); } catch { return undefined; }
}

export interface SubmissionResult {
  ok: boolean;
  message: string;
  pullRequestUrl?: string;
}

async function postSubmission(payload: Record<string, unknown>): Promise<SubmissionResult> {
  try {
    const res = await fetch(`${MARKET_BASE}/submit-plugin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, message: `couldn't open a pull request: ${(body as { error?: string }).error || res.statusText}` };
    }
    const { pullRequestUrl } = body as { pullRequestUrl?: string };
    return {
      ok: true,
      pullRequestUrl,
      message: pullRequestUrl
        ? `pull request opened: ${pullRequestUrl}\nNot live yet — it needs a human review and merge on GitHub first.`
        : `submitted, but the Market backend didn't return a pull request link — check github.com/oxlaboratory/oxis's pull requests directly.`,
    };
  } catch (e) {
    return { ok: false, message: `couldn't reach the Market backend: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Free plugin: opens a pull request adding the .lua file and its
 *  index.json entry (replacing the entry if it's already listed). */
export async function prepareFreePublish(metadata: PublishMetadata, existing?: MarketEntry): Promise<SubmissionResult> {
  const p = pluginManager.get(metadata.name);
  const source = p?.lua ?? "";
  const isUpdate = !!existing;
  const result = await postSubmission({
    name: metadata.name, desc: metadata.desc, category: metadata.category,
    version: metadata.version, author: metadata.author, source,
    ...(isUpdate ? { updateOf: metadata.name } : {}),
  });
  if (!result.ok) return result;
  return {
    ...result,
    message: isUpdate
      ? `update pull request opened for ${metadata.name} (v${existing!.version || "?"} → v${metadata.version}):\n${result.message}`
      : result.message,
  };
}

export interface ConnectOnboardingResult {
  ok: boolean;
  message: string;
  onboardingUrl?: string;
  accountId?: string;
}

/** Creates a Stripe Connect Express account and returns its
 *  onboarding link. The listing itself still goes through PR review. */
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
      message: `Stripe Connect Express account created: ${accountId}. Opening the onboarding link — Stripe hosts the KYC/bank-details flow directly; OXIS never sees or stores that information.`,
    };
  } catch (e) {
    return { ok: false, message: `couldn't reach the Market backend: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Submits a paid listing — same GitHub-PR endpoint as the free path,
 *  with the price/interval/Connect account attached, still gated on
 *  human review and merge like any other submission. */
export async function submitPaidPlugin(metadata: PublishMetadata, price: string, interval: string, accountId: string, existing?: MarketEntry): Promise<SubmissionResult> {
  const p = pluginManager.get(metadata.name);
  const source = p?.lua ?? "";
  const isUpdate = !!existing;
  const result = await postSubmission({
    name: metadata.name, desc: metadata.desc, category: metadata.category,
    version: metadata.version, author: metadata.author, source,
    premium: true,
    priceDisplay: `$${price}/${interval === "year" ? "yr" : "mo"}`,
    stripeConnectAccountId: accountId,
    ...(isUpdate ? { updateOf: metadata.name } : {}),
  });
  if (!result.ok) return result;
  return {
    ...result,
    message: (isUpdate
      ? `update pull request opened for ${metadata.name} (v${existing!.version || "?"} → v${metadata.version}):\n${result.message}`
      : result.message)
      + `\nReminder: paid OXIS Market plugins are recurring Stripe subscriptions, not one-time purchases — the 75/25 developer/OXIS split happens automatically once merged (see cloudflare/functions/checkout.js).`,
  };
}

/** 'plugin unpublish <name>: opens a PR removing the listing. The
 *  author is checked against the listing as a guard against mistakes,
 *  not as authentication. */
export async function requestPluginDeletion(name: string, author: string): Promise<SubmissionResult> {
  try {
    const res = await fetch(`${MARKET_BASE}/delete-plugin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, author }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, message: `couldn't open a deletion pull request: ${(body as { error?: string }).error || res.statusText}` };
    }
    const { pullRequestUrl } = body as { pullRequestUrl?: string };
    return {
      ok: true,
      pullRequestUrl,
      message: pullRequestUrl
        ? `deletion pull request opened: ${pullRequestUrl}\nThe plugin stays listed until a human reviews and merges it.`
        : `submitted, but the Market backend didn't return a pull request link — check github.com/oxlaboratory/oxis's pull requests directly.`,
    };
  } catch (e) {
    return { ok: false, message: `couldn't reach the Market backend: ${e instanceof Error ? e.message : String(e)}` };
  }
}