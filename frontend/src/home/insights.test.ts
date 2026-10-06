import { describe, expect, it } from "vitest";
import { suggest } from "./Insights";
import type { WorkspaceInsights } from "./insightsStore";

const base: WorkspaceInsights = { day: "2026-10-06", tasks: 0, saves: 0, workflows: 0, commands: 0, files: [] };
const repo = { repo: true, branch: "main", changed: 0, branches: 1, remote: true };

describe("OXIS suggests", () => {
  it("says nothing when all is well", () => {
    expect(suggest({ git: repo, hasProject: true, tasks: ["test"], insights: base })).toEqual([]);
  });
  it("puts a recent failure first, then uncommitted changes", () => {
    const now = 1_000_000_000;
    const s = suggest({ git: { ...repo, changed: 3 }, hasProject: true, tasks: ["test"], insights: { ...base, lastFailed: { command: "npm test", code: 1, at: now - 4 * 60_000 } }, now });
    expect(s.map(x => x.label)).toEqual(["run it again", "'task commit"]);
    expect(s[0].text).toContain("4m ago");
  });
  it("forgets a failure after an hour", () => {
    const now = 1_000_000_000;
    expect(suggest({ git: repo, hasProject: true, tasks: ["t"], insights: { ...base, lastFailed: { command: "x", code: 2, at: now - 2 * 3600_000 } }, now })).toEqual([]);
  });
  it("knows about remotes, pushing and repositories", () => {
    expect(suggest({ git: { ...repo, remote: false }, hasProject: true, tasks: ["t"], insights: base })[0].label).toBe("connect GitHub");
    expect(suggest({ git: { ...repo, ahead: 2, behind: 1 }, hasProject: true, tasks: ["t"], insights: base }).map(s => s.run)).toEqual(["git push", "git pull"]);
    expect(suggest({ git: { repo: false, changed: 0, branches: 0, remote: false }, hasProject: true, tasks: ["t"], insights: base })[0].run).toBe("git init");
  });
  it("shows three at most", () => {
    const now = 5_000_000;
    const s = suggest({ git: { ...repo, changed: 1, ahead: 1, behind: 1, remote: false }, hasProject: true, tasks: [], insights: { ...base, lastFailed: { command: "a", code: 1, at: now } }, now });
    expect(s.length).toBe(3);
  });
});
