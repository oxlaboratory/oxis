import { describe, expect, it } from "vitest";
import { findTargets, makeLabels } from "./quickSelect";

const texts = (line: string) => findTargets(line).map(t => t.text);

describe("quick select targets", () => {
  it("finds URLs whole, without trailing punctuation", () => {
    expect(texts("see https://oxis.space/docs?x=1#keys.")).toEqual(["https://oxis.space/docs?x=1#keys"]);
    expect(texts("(http://localhost:5173/)")).toEqual(["http://localhost:5173/"]);
  });
  it("finds paths, file names and file:line", () => {
    expect(texts(String.raw`PS C:\Users\dev\api> npm test`)).toEqual([String.raw`C:\Users\dev\api`]);
    expect(texts("error in src/app.ts:12:5 and ./lib/x.js")).toEqual(["src/app.ts:12:5", "./lib/x.js"]);
    expect(texts("modified:   package.json")).toEqual(["package.json"]);
    expect(texts("on branch origin/main")).toEqual(["origin/main"]);
  });
  it("finds git hashes, IPs, UUIDs and long numbers", () => {
    expect(texts("a820581 Open in OXIS")).toEqual(["a820581"]);
    expect(texts("listening on 127.0.0.1:8080, pid 41234")).toEqual(["127.0.0.1:8080", "41234"]);
    expect(texts("id 3f2b8c1e-9d4a-4e1f-8b2c-7a6d5e4f3c2b")).toEqual(["3f2b8c1e-9d4a-4e1f-8b2c-7a6d5e4f3c2b"]);
  });
  it("leaves ordinary words, short numbers, fractions and dates alone", () => {
    expect(texts("the deadline is 1/2 of 12 days")).toEqual([]);
    expect(texts("decade facade")).toEqual([]);
  });
});

describe("quick select labels", () => {
  it("uses single keys while they last", () => {
    expect(makeLabels(3)).toEqual(["a", "s", "d"]);
  });
  it("goes to two letters without a label being another's prefix", () => {
    for (const n of [27, 60, 300, 676]) {
      const l = makeLabels(n);
      expect(l.length).toBe(n);
      expect(new Set(l).size).toBe(n);
      const singles = new Set(l.filter(x => x.length === 1));
      expect(l.some(x => x.length === 2 && singles.has(x[0]))).toBe(false);
    }
  });
});
