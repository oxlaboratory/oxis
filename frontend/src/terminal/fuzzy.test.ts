import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyMatch } from "./fuzzy";

describe("fuzzy matching", () => {
  it("needs the characters in order", () => {
    expect(fuzzyMatch("gco", "git checkout main")).not.toBeNull();
    expect(fuzzyMatch("ocg", "git checkout main")).toBeNull();
  });
  it("ignores case unless the query has a capital", () => {
    expect(fuzzyMatch("npm", "NPM run dev")).not.toBeNull();
    expect(fuzzyMatch("NPM", "npm run dev")).toBeNull();
  });
  it("ranks a substring, then word starts, above scattered letters", () => {
    const items = ["gist search", "go test ./...", "git status"];
    const order = fuzzyFilter("gst", items, s => s).map(r => r.item);
    expect(order.indexOf("git status")).toBeLessThan(order.indexOf("gist search"));
    expect(fuzzyFilter("stash", ["git stash", "git status"], s => s).map(r => r.item)).toEqual(["git stash"]);
  });
  it("breaks ties in favour of the newer item", () => {
    const items = [{ id: "old", cmd: "npm run dev" }, { id: "new", cmd: "npm run dev" }];
    expect(fuzzyFilter("dev", items, i => i.cmd)[0].item.id).toBe("new");
  });
  it("reports where it matched, for highlighting", () => {
    expect(fuzzyMatch("rd", "npm run dev")?.positions).toEqual([4, 8]);
    expect(fuzzyMatch("run", "npm run dev")?.positions).toEqual([4, 5, 6]);
  });
  it("lets spaces separate parts", () => {
    expect(fuzzyMatch("dock logs", "docker compose logs -f web")).not.toBeNull();
  });
});
