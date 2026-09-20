/**
 * publish.ts — 'plugin publish <name>.
 *
 * What this genuinely does:
 *  - Validates the plugin is actually publishable (real checks, reusing
 *    pluginManager.validate() plus publish-specific manifest
 *    completeness checks — version/description/author/category/
 *    min_oxis_version all need to be real for a Market listing, even
 *    though they're merely optional for a plugin you only run yourself).
 *  - For a PAID plugin, kicks off a REAL Stripe Connect Express
 *    account — a genuine network call to the already-deployed
 *    `/connect-onboarding` endpoint (see cloudflare/functions/
 *    connect-onboarding.js) — and opens the real onboarding URL
 *    Stripe returns.
 *  - Submits the plugin's metadata AND its actual .lua source to the
 *    Market's `/submit-plugin` endpoint (see cloudflare/functions/
 *    submit-plugin.js), which opens a REAL GitLab merge request
 *    against gitlab.com/oxidelab/oxis adding the plugin's .lua file
 *    and its index.json entry. This automates the tedious mechanical
 *    part (branch/commit/push/open-MR) but is NOT auto-merged — a
 *    human still reviews and merges it on GitLab before the plugin
 *    is actually live and 'market install-able. This function's job
 *    ends at "the MR exists"; opening the returned URL in a browser
 *    is as far as automation goes.
 *
 * Also honest about a real limitation: the submission endpoint itself
 * could not be deployed or exercised end-to-end in the environment
 * this was written in (no GitLab/Cloudflare account access) — if
 * `'plugin publish` reports a network/server error, that's the first
 * thing to check, not necessarily a bug in this file.
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
 *  publish is publishing an UPDATE (the MR replaces its existing
 *  index.json entry) rather than a first-time listing — detected
 *  automatically rather than needing a separate command. */
export async function findExistingListing(name: string): Promise<MarketEntry | undefined> {
  try { return await findEntry(name); } catch { return undefined; }
}

export interface SubmissionResult {
  ok: boolean;
  message: string;
  mergeRequestUrl?: string;
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
      return { ok: false, message: `couldn't open a merge request: ${(body as { error?: string }).error || res.statusText}` };
    }
    const { mergeRequestUrl } = body as { mergeRequestUrl?: string };
    return {
      ok: true,
      mergeRequestUrl,
      message: mergeRequestUrl
        ? `merge request opened: ${mergeRequestUrl}\nNot live yet — it needs a human review and merge on GitLab first.`
        : `submitted, but the Market backend didn't return a merge request link — check gitlab.com/oxidelab/oxis's merge requests directly.`,
    };
  } catch (e) {
    return { ok: false, message: `couldn't reach the Market backend: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Free plugin — opens a real GitLab merge request via the Market's
 *  `/submit-plugin` endpoint (see cloudflare/functions/submit-plugin.js)
 *  adding the plugin's .lua file and its index.json entry. Not live
 *  until a human reviews and merges it on GitLab — this only
 *  automates getting the MR opened, not the review itself. `existing`
 *  (if the plugin's already listed) only changes the wording — the
 *  submission works the same either way; submit-plugin.js replaces
 *  the existing index.json entry in place either way. */
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
      ? `update merge request opened for ${metadata.name} (v${existing!.version || "?"} → v${metadata.version}):\n${result.message}`
      : result.message,
  };
}

export interface ConnectOnboardingResult {
  ok: boolean;
  message: string;
  onboardingUrl?: string;
  accountId?: string;
}

/** Kicks off a REAL Stripe Connect Express account via the already-
 *  deployed /connect-onboarding endpoint — a genuine network call and
 *  a genuine onboarding link Stripe itself generates, not a
 *  placeholder. The actual Market listing (see submitPaidPlugin
 *  below) still goes through GitLab MR review like any other
 *  submission — the account being created here doesn't make anything
 *  live by itself. */
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

/** Submits a paid listing — same GitLab-MR endpoint as the free path,
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
      ? `update merge request opened for ${metadata.name} (v${existing!.version || "?"} → v${metadata.version}):\n${result.message}`
      : result.message)
      + `\nReminder: paid OXIS Market plugins are recurring Stripe subscriptions, not one-time purchases — the 75/25 developer/OXIS split happens automatically once merged (see cloudflare/functions/checkout.js).`,
  };
}

/** 'plugin unpublish <name> — opens a GitLab merge request removing
 *  the plugin's Market listing (see cloudflare/functions/
 *  delete-plugin.js). Same human-review-gated model as publishing:
 *  nothing is actually removed until a human merges the MR. `author`
 *  is checked against the CURRENT listing's own author server-side —
 *  this is a typo/mistake guard, not real authentication, same
 *  caveat as the rest of this pipeline. */
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
      return { ok: false, message: `couldn't open a deletion merge request: ${(body as { error?: string }).error || res.statusText}` };
    }
    const { mergeRequestUrl } = body as { mergeRequestUrl?: string };
    return {
      ok: true,
      mergeRequestUrl,
      message: mergeRequestUrl
        ? `deletion merge request opened: ${mergeRequestUrl}\nThe plugin stays listed until a human reviews and merges it.`
        : `submitted, but the Market backend didn't return a merge request link — check gitlab.com/oxidelab/oxis's merge requests directly.`,
    };
  } catch (e) {
    return { ok: false, message: `couldn't reach the Market backend: ${e instanceof Error ? e.message : String(e)}` };
  }
}