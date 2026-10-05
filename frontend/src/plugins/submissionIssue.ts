/**
 * submissionIssue.ts — the GitHub issue 'plugin publish (and
 * 'plugin unpublish) opens on github.com/oxlaboratory/oxis: the
 * plugin's details in a table and its source, for a maintainer to
 * review and add to the Market. The Market backend (functions/
 * submit-plugin.js) writes the same issue when it can; otherwise OXIS
 * opens GitHub's new-issue page with it filled in.
 */

export const ISSUE_REPO = "oxlaboratory/oxis";
export const SUBMISSION_LABEL = "plugin-submission";

export interface SubmissionDetails {
  name: string;
  version: string;
  desc: string;
  category: string;
  author: string;
  permissions?: string[];
  os?: string[];
  minOxisVersion?: string;
  priceDisplay?: string;
  /** A video of it running (optional). */
  demo?: string;
  /** The listed version when this is an update. */
  updateOf?: string;
}

export interface IssueDraft { title: string; body: string; labels: string[] }

/** A code fence longer than any run of backticks in the source. */
function fence(source: string): string {
  const longest = Math.max(2, ...[...source.matchAll(/`+/g)].map(m => m[0].length));
  return "`".repeat(longest + 1);
}

const cell = (v: string) => v.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function submissionIssue(d: SubmissionDetails, source: string, sourceNote?: string): IssueDraft {
  const rows: Array<[string, string]> = [
    ["Name", `\`${d.name}\``],
    ["Version", d.updateOf ? `${d.version} (listed: ${d.updateOf})` : d.version],
    ["Author", d.author],
    ["Category", d.category],
    ["Description", d.desc],
    ["Permissions", d.permissions?.length ? d.permissions.join(", ") : "none"],
    ["Platforms", d.os?.length ? d.os.join(", ") : "—"],
    ["Needs OXIS", d.minOxisVersion || "—"],
    ["Size", `${new TextEncoder().encode(source).length.toLocaleString("en-US")} bytes`],
  ];
  if (d.priceDisplay) rows.push(["Price", d.priceDisplay]);
  rows.push(["Demo video", d.demo ? `<${d.demo}>` : "none (optional)"]);
  const f = fence(source);
  const body = [
    `${d.updateOf ? "An update for" : "A new plugin for"} the OXIS Market, sent with \`'plugin publish ${d.name}\`.`,
    "",
    "| | |",
    "|---|---|",
    ...rows.map(([k, v]) => `| ${k} | ${cell(v)} |`),
    "",
    `<details open><summary>${d.name}.lua</summary>`,
    "",
    sourceNote ?? `${f}lua\n${source.replace(/\s+$/, "")}\n${f}`,
    "",
    "</details>",
    "",
    "---",
    "**For the maintainer:** check what the code does and that it asks only for the permissions it needs, then add `cloudflare/plugins/" + d.name + ".lua` and its `cloudflare/index.json` entry"
      + (d.demo ? " (with `\"demo\"` set to the video, once it's been watched)" : "") + ".",
  ].join("\n");
  return { title: `Plugin ${d.updateOf ? "update" : "submission"}: ${d.name} ${d.version}`, body, labels: [SUBMISSION_LABEL] };
}

export function removalIssue(name: string, author: string): IssueDraft {
  return {
    title: `Plugin removal: ${name}`,
    body: [
      `Please take \`${name}\` off the OXIS Market (sent with \`'plugin unpublish ${name}\` by ${cell(author)}).`,
      "",
      "**For the maintainer:** check the request comes from the plugin's author, then remove `cloudflare/plugins/" + name + ".lua` and its `cloudflare/index.json` entry.",
    ].join("\n"),
    labels: [SUBMISSION_LABEL],
  };
}

/** GitHub's longest comfortable URL for a prefilled issue. */
export const MAX_ISSUE_URL = 7500;

/** GitHub's new-issue page with the issue filled in. */
export function newIssueUrl(issue: IssueDraft): string {
  const q = new URLSearchParams({ title: issue.title, body: issue.body, labels: issue.labels.join(",") });
  return `https://github.com/${ISSUE_REPO}/issues/new?${q.toString()}`;
}
