import { describe, expect, it } from "vitest";
import { newIssueUrl, removalIssue, submissionIssue } from "./submissionIssue";

const details = {
  name: "dice", version: "1.2.0", desc: "roll | dice", category: "games", author: "ana",
  permissions: ["net"], os: ["windows", "unix"], minOxisVersion: "1.2.1",
};

describe("submission issues", () => {
  it("puts the details in a table and the source in a fence", () => {
    const issue = submissionIssue(details, 'oxis.echo("hi")\n');
    expect(issue.title).toBe("Plugin submission: dice 1.2.0");
    expect(issue.labels).toEqual(["plugin-submission"]);
    expect(issue.body).toContain("| Description | roll \\| dice |");
    expect(issue.body).toContain("| Permissions | net |");
    expect(issue.body).toContain('```lua\noxis.echo("hi")\n```');
  });

  it("makes the fence longer than any backticks in the source", () => {
    const issue = submissionIssue(details, "local s = [[```]]");
    expect(issue.body).toContain("````lua\nlocal s = [[```]]\n````");
  });

  it("says when it's an update", () => {
    const issue = submissionIssue({ ...details, updateOf: "1.1.0" }, "x");
    expect(issue.title).toBe("Plugin update: dice 1.2.0");
    expect(issue.body).toContain("| Version | 1.2.0 (listed: 1.1.0) |");
  });

  it("can leave the source out with a note", () => {
    const issue = submissionIssue(details, "x".repeat(10), "_(pasted below)_");
    expect(issue.body).toContain("_(pasted below)_");
    expect(issue.body).not.toContain("xxxxxxxxxx");
  });

  it("builds GitHub's new-issue URL", () => {
    const url = new URL(newIssueUrl(removalIssue("dice", "ana")));
    expect(url.origin + url.pathname).toBe("https://github.com/oxlaboratory/oxis/issues/new");
    expect(url.searchParams.get("title")).toBe("Plugin removal: dice");
    expect(url.searchParams.get("labels")).toBe("plugin-submission");
  });
});
