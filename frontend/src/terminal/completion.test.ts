import { describe, expect, it } from "vitest";
import { fuzzyMatch, suggest, wordAround, wordBefore, wordIndex } from "./completion";

describe("fuzzyMatch", () => {
  it("matches a subsequence, case-insensitively", () => {
    expect(fuzzyMatch("gs", "getState")?.at).toEqual([0, 3]);
    expect(fuzzyMatch("GS", "getState")?.at).toEqual([0, 3]);
    expect(fuzzyMatch("xz", "getState")).toBeNull();
  });

  it("prefers the start of a word", () => {
    expect(fuzzyMatch("fb", "foo/bar")?.at).toEqual([0, 4]);
    expect(fuzzyMatch("ct", "src/cart.ts")?.at).toEqual([4, 9]);
  });

  it("ranks a match at word starts above one scattered inside words", () => {
    const starts = fuzzyMatch("sc", "src/cart.ts")!.score;
    const inside = fuzzyMatch("sc", "basic.txt")!.score;
    expect(starts).toBeGreaterThan(inside);
  });
});

describe("wordIndex", () => {
  it("counts words of three or more characters, not numbers", () => {
    const words = wordIndex("const total = total + 12; let $el = a1b; x = 999");
    expect(words.get("total")).toBe(2);
    expect(words.get("const")).toBe(1);
    expect(words.get("$el")).toBe(1);
    expect(words.get("a1b")).toBe(1);
    expect(words.has("999")).toBe(false);
    expect(words.has("x")).toBe(false);
  });
});

describe("suggest", () => {
  const words = new Map([["total", 3], ["totalPrice", 1], ["tot", 1]]);

  it("offers longer words that start with the prefix first", () => {
    const got = suggest("tot", words, "ts").map(s => s.word);
    expect(got.slice(0, 2)).toEqual(["total", "totalPrice"]);
    expect(got).not.toContain("tot");
  });

  it("offers the language's keywords", () => {
    expect(suggest("ret", new Map(), "ts").map(s => s.word)).toContain("return");
    expect(suggest("ret", new Map(), "ts")[0].keyword).toBe(true);
  });

  it("offers no statement keywords after a dot", () => {
    expect(suggest("ret", new Map(), "ts", "", true).map(s => s.word)).not.toContain("return");
  });

  it("needs the first letter to match", () => {
    expect(suggest("st", new Map([["list", 1]]), "txt")).toEqual([]);
  });

  it("doesn't offer the half-typed word unless it's elsewhere too", () => {
    expect(suggest("to", new Map([["totally", 1]]), "txt", "totally")).toEqual([]);
    expect(suggest("to", new Map([["totally", 2]]), "txt", "totally").map(s => s.word)).toEqual(["totally"]);
  });
});

describe("words around the caret", () => {
  it("finds the whole word at an offset", () => {
    expect(wordAround("hello world", 2)).toBe("hello");
    expect(wordAround("a.b", 1)).toBe("a");
  });

  it("finds the word being typed", () => {
    expect(wordBefore("items.red", 9)).toEqual({ start: 6, prefix: "red" });
    expect(wordBefore("width: 12", 9)).toEqual({ start: 9, prefix: "" });
  });
});

describe("library members after a dot", () => {
  it("knows the dotted name before the dot", async () => {
    const { qualifierBefore } = await import("./completion");
    expect(qualifierBefore("local x = oxis.fs.", 18)).toBe("oxis.fs");
    expect(qualifierBefore("oxis.ec", 5)).toBe("oxis");
    expect(qualifierBefore("print(x)", 6)).toBeNull();
  });

  it("lists oxis members with signatures, then narrows as you type", async () => {
    const { membersOf, suggestMembers } = await import("./completion");
    const all = suggestMembers("", membersOf("lua", "oxis")!);
    expect(all[0]).toMatchObject({ word: "command", kind: "fn" });
    expect(all.find(s => s.word === "fs")).toMatchObject({ kind: "tbl" });
    const narrowed = suggestMembers("ev", membersOf("lua", "oxis")!);
    expect(narrowed[0]).toMatchObject({ word: "every", detail: "(seconds, fn [, { foreground, stop }])" });
    expect(suggestMembers("re", membersOf("lua", "oxis.fs")!)[0].word).toBe("read");
    expect(membersOf("ts", "oxis")).toBeNull();
    expect(membersOf("lua", "unknownlib")).toBeNull();
  });
});
