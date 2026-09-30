import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearSession, loadSession, registerTabSnapshot, saveSession, takeLines, type SavedTab } from "./session";
import { mkLine } from "./terminal";
import { memoryStorage } from "./storage.test-util";

const tab = (cwd: string, lines: string[] = []): SavedTab => ({
  title: cwd.split("/").pop() ?? cwd, cwd, lines: lines.map(text => ({ text })), files: [],
});

beforeEach(() => { vi.stubGlobal("localStorage", memoryStorage()); });

describe("session", () => {
  it("keeps the last 1,000 lines, with only the fields a line has", () => {
    const lines = Array.from({ length: 1_200 }, (_, i) => mkLine(String(i), i % 2 ? "dim" : undefined));
    const kept = takeLines(lines);
    expect(kept.length).toBe(1_000);
    expect(kept[0]).toEqual({ text: "200" });
    expect(kept[1]).toEqual({ text: "201", kind: "dim" });
  });

  it("saves tabs and their panes, and loads them back", () => {
    const off = [
      registerTabSnapshot("t1", () => tab("/work/web", ["$ npm test"])),
      registerTabSnapshot("t2", () => tab("/work/api")),
      registerTabSnapshot("t3", () => tab("/work/web/server")),
    ];
    saveSession([
      { panes: ["t1"], split: "row", focus: "t1" },
      { panes: ["t2", "t3"], split: "column", focus: "t3" },
    ], 1, { "/work/web/a.ts": "draft" });
    const s = loadSession();
    expect(s?.active).toBe(1);
    expect(s?.drafts).toEqual({ "/work/web/a.ts": "draft" });
    expect(s?.tabs.map(t => [t.cwd, t.split, t.focus, t.more?.map(m => m.cwd)])).toEqual([
      ["/work/web", "row", 0, undefined],
      ["/work/api", "column", 1, ["/work/web/server"]],
    ]);
    expect(s?.tabs[0].lines).toEqual([{ text: "$ npm test" }]);
    off.forEach(f => f());
  });

  it("drops a tab whose panes have all closed", () => {
    const off = registerTabSnapshot("t1", () => tab("/a"));
    saveSession([{ panes: ["t1"], split: "row", focus: "t1" }, { panes: ["gone"], split: "row", focus: "gone" }], 0, {});
    expect(loadSession()?.tabs.length).toBe(1);
    off();
  });

  it("drops colours first when the session is too big", () => {
    const big = Array.from({ length: 1_000 }, () => ({ text: "x".repeat(3_000), spans: [{ t: "x".repeat(3_000), s: "color:red" }] }));
    const off = registerTabSnapshot("t1", () => ({ ...tab("/a"), lines: big }));
    saveSession([{ panes: ["t1"], split: "row", focus: "t1" }], 0, {});
    const lines = loadSession()?.tabs[0].lines ?? [];
    expect(lines.length).toBe(1_000);
    expect(lines.every(l => l.spans === undefined)).toBe(true);
    off();
  });

  it("ignores a missing, unreadable or older session", () => {
    expect(loadSession()).toBeNull();
    localStorage.setItem("oxis-session-v1", "{not json");
    expect(loadSession()).toBeNull();
    localStorage.setItem("oxis-session-v1", JSON.stringify({ v: 0, tabs: [tab("/a")] }));
    expect(loadSession()).toBeNull();
  });

  it("clears", () => {
    const off = registerTabSnapshot("t1", () => tab("/a"));
    saveSession([{ panes: ["t1"], split: "row", focus: "t1" }], 0, {});
    clearSession();
    expect(loadSession()).toBeNull();
    off();
  });

  it("stops saving a tab once it unregisters, but not a newer registration", () => {
    const off = registerTabSnapshot("t1", () => tab("/old"));
    registerTabSnapshot("t1", () => tab("/new"));
    off(); // the old one leaving mustn't remove the new one
    saveSession([{ panes: ["t1"], split: "row", focus: "t1" }], 0, {});
    expect(loadSession()?.tabs[0].cwd).toBe("/new");
  });
});
