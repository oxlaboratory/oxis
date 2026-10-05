/**
 * publish.ts — 'plugin publish / 'plugin unpublish.
 *
 * Checks the plugin is ready (validate() plus a complete manifest), then
 * opens a GitHub issue on github.com/oxlaboratory/oxis with its details
 * and source (submissionIssue.ts) for a maintainer to review and add to
 * the Market. The Market's /submit-plugin endpoint files it when it can;
 * otherwise GitHub's new-issue page opens with it filled in, to submit
 * from your own account. Paid plugins first go through Stripe Connect
 * onboarding (/connect-onboarding).
 */

import { pluginManager } from "./pluginManager";
import { getLicensedEmail } from "./pluginLicense";
import { marketBase, marketFetch, findEntry, type MarketEntry } from "./market";
import { submissionIssue, removalIssue, newIssueUrl, MAX_ISSUE_URL, type IssueDraft, type SubmissionDetails } from "./submissionIssue";
import { copyText } from "../terminal/clipboard";
import { demoUrlProblem } from "./manifest";

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
  /** A video of it running, for the Market card (optional). */
  demo?: string;
}

export interface PublishCheckResult {
  ok: boolean;
  issues: string[]; // missing/invalid required fields — non-empty means "can't publish yet"
  metadata?: PublishMetadata; // present even when ok is false, for whatever's already fillable, so the developer can see what's missing at a glance
}

const REQUIRED_OS = ["windows", "unix"];

/** Publish checks: validate() plus the manifest fields a Market
 *  listing needs (optional for plugins you only run yourself). */
export async function checkPublishable(name: string, demoOverride?: string): Promise<PublishCheckResult> {
  const p = pluginManager.get(name);
  if (!p) return { ok: false, issues: [`not installed: ${name}`] };
  if (p.builtin) return { ok: false, issues: [`${name} is built-in — nothing to publish`] };
  if (p.origin !== "user") {
    return { ok: false, issues: [`${name} isn't one of yours (origin: ${p.origin ?? "unknown"}) — only plugins you created can be published`] };
  }

  const issues: string[] = [];
  const { issues: validateIssues } = await pluginManager.validate(name);
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
  // A demo video is optional; one that's given must be a usable link.
  const demo = (demoOverride ?? m?.demo ?? "").trim();
  const demoProblem = demo ? demoUrlProblem(demo) : "";
  if (demoProblem) issues.push(demoProblem);

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
    ...(demo ? { demo } : {}),
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
  /** The issue the Market backend opened. */
  issueUrl?: string;
  /** GitHub's new-issue page, filled in, to submit yourself (when the
   *  backend couldn't open the issue). */
  draftUrl?: string;
}

/** Files the issue through the Market backend, or hands back GitHub's
 *  new-issue page with it filled in. A source too long for that page's
 *  address goes on the clipboard, to paste into the issue. */
async function fileIssue(endpoint: string, payload: Record<string, unknown>, draft: (note?: string) => IssueDraft, source?: string): Promise<SubmissionResult> {
  let reason = "";
  try {
    const res = await marketFetch(`${marketBase()}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => ({})) as { issueUrl?: string; error?: string };
    if (res.ok && body.issueUrl) {
      return { ok: true, issueUrl: body.issueUrl, message: `issue opened: ${body.issueUrl}` };
    }
    reason = body.error || res.statusText;
    // A refusal about the plugin itself is final (bad fields, not
    // listed, someone else's); anything else (the backend not set up,
    // GitHub down) falls back to the browser.
    if ([400, 404, 409].includes(res.status)) return { ok: false, message: `the Market refused it: ${reason}` };
  } catch (e) {
    reason = e instanceof Error ? e.message : String(e);
  }
  let issue = draft();
  let url = newIssueUrl(issue);
  let copied = false;
  if (url.length > MAX_ISSUE_URL && source) {
    issue = draft("_The source is on your clipboard: paste it here._");
    url = newIssueUrl(issue);
    copied = await copyText("```lua\n" + source.replace(/\s+$/, "") + "\n```").catch(() => false);
  }
  return {
    ok: true,
    draftUrl: url,
    message: `GitHub's new-issue page has it filled in — check it and press "Submit new issue"${copied ? " (paste the source from your clipboard into it first)" : ""}.`
      + (reason ? ` (The Market couldn't open the issue itself: ${reason}.)` : ""),
  };
}

function detailsOf(metadata: PublishMetadata, existing?: MarketEntry, priceDisplay?: string): SubmissionDetails {
  return {
    name: metadata.name, version: metadata.version, desc: metadata.desc, category: metadata.category,
    author: metadata.author, permissions: metadata.permissions, os: metadata.os,
    minOxisVersion: metadata.minOxisVersion, priceDisplay, demo: metadata.demo,
    updateOf: existing ? existing.version || "?" : undefined,
  };
}

/** Free plugin: an issue with its details and source. */
export async function prepareFreePublish(metadata: PublishMetadata, existing?: MarketEntry): Promise<SubmissionResult> {
  const source = pluginManager.get(metadata.name)?.lua ?? "";
  const details = detailsOf(metadata, existing);
  const result = await fileIssue("submit-plugin", {
    name: metadata.name, desc: metadata.desc, category: metadata.category,
    version: metadata.version, author: metadata.author, source,
    permissions: metadata.permissions, os: metadata.os, minOxisVersion: metadata.minOxisVersion,
    ...(metadata.demo ? { demo: metadata.demo } : {}),
    ...(existing ? { updateOf: metadata.name, listedVersion: existing.version } : {}),
  }, note => submissionIssue(details, source, note), source);
  if (!result.ok) return result;
  return {
    ...result,
    message: `${existing ? `update for ${metadata.name} (v${existing.version || "?"} → v${metadata.version}): ` : ""}${result.message}`
      + "\nNot live yet: once a maintainer adds it, it appears in 'market and on the website by itself.",
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
    const res = await marketFetch(`${marketBase()}/connect-onboarding`, {
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

/** Paid listing: the same issue, with the price and the Connect
 *  account attached. */
export async function submitPaidPlugin(metadata: PublishMetadata, price: string, interval: string, accountId: string, existing?: MarketEntry): Promise<SubmissionResult> {
  const source = pluginManager.get(metadata.name)?.lua ?? "";
  const priceDisplay = `$${price}/${interval === "year" ? "yr" : "mo"}`;
  const details = detailsOf(metadata, existing, priceDisplay);
  const result = await fileIssue("submit-plugin", {
    name: metadata.name, desc: metadata.desc, category: metadata.category,
    version: metadata.version, author: metadata.author, source,
    premium: true, priceDisplay, stripeConnectAccountId: accountId,
    ...(metadata.demo ? { demo: metadata.demo } : {}),
    ...(existing ? { updateOf: metadata.name, listedVersion: existing.version } : {}),
  }, note => submissionIssue(details, source, note), source);
  if (!result.ok) return result;
  return {
    ...result,
    message: result.message
      + "\nPaid plugins are recurring Stripe subscriptions; the 75/25 split happens automatically once it's listed.",
  };
}

/** 'plugin unpublish <name>: an issue asking for the listing to be
 *  removed. The author is checked against the listing as a guard
 *  against mistakes, not as authentication. */
export async function requestPluginDeletion(name: string, author: string): Promise<SubmissionResult> {
  const result = await fileIssue("delete-plugin", { name, author }, () => removalIssue(name, author));
  if (!result.ok) return result;
  return { ...result, message: result.message + "\nThe plugin stays listed until a maintainer removes it." };
}
