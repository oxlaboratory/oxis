import { beforeEach, describe, expect, it, vi } from "vitest";
import { paneHint, startHint, tabHint, tipHint } from "./hints";
import { memoryStorage } from "./storage.test-util";

beforeEach(() => { vi.stubGlobal("localStorage", memoryStorage()); });

describe("hints", () => {
  it("shows the start hint three times", () => {
    expect(startHint()).toContain("Ctrl+T");
    expect(startHint()).not.toBeNull();
    expect(startHint()).not.toBeNull();
    expect(startHint()).toBeNull();
  });

  it("stops the start hint once a tab or pane has been opened", () => {
    expect(startHint()).not.toBeNull();
    paneHint("row");
    expect(startHint()).toBeNull();
  });

  it("names the arrows for the way the tab is split", () => {
    expect(paneHint("row")).toContain("Alt+←→");
    expect(paneHint("column")).toContain("Alt+↑↓");
  });

  it("counts tab and pane hints separately", () => {
    for (let i = 0; i < 3; i++) expect(tabHint()).not.toBeNull();
    expect(tabHint()).toBeNull();
    expect(paneHint("row")).not.toBeNull();
  });

  it("still works without storage", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(startHint()).not.toBeNull();
  });

  it("shows each tip once, then none", () => {
    const tips = new Set<string>();
    for (let tip = tipHint(); tip; tip = tipHint()) tips.add(tip);
    expect(tips.size).toBeGreaterThanOrEqual(4);
    expect(tipHint()).toBeNull();
  });
});
