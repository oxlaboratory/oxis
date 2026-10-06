import { describe, expect, it } from "vitest";
import { parseTrigger, runTriggers, splitTriggerArgs, triggerRegex } from "./triggers";

describe("triggers", () => {
  it("plain text ignores case unless it has capitals", () => {
    expect(triggerRegex("error")?.test("Build ERROR here")).toBe(true);
    expect(triggerRegex("ERROR")?.test("an error")).toBe(false);
    expect(triggerRegex("a.b")?.test("axb")).toBe(false); // not a regex
  });
  it("/regex/ with flags", () => {
    expect(triggerRegex(String.raw`/took \d+ms/`)?.test("GET / took 312ms")).toBe(true);
    expect(triggerRegex("/(unclosed/")).toBeNull();
  });
  it("splits quoted phrases and regexes", () => {
    expect(splitTriggerArgs('"listening on" ok notify')).toEqual(["listening on", "ok", "notify"]);
    expect(splitTriggerArgs(String.raw`/fail(ed)? \w+/i err`)).toEqual([String.raw`/fail(ed)? \w+/i`, "err"]);
  });
  it("parses options, defaulting to a highlight", () => {
    expect(parseTrigger(["ERROR", "err", "sound=error", "notify"])).toEqual({ pattern: "ERROR", color: "err", sound: "error", notify: true });
    expect(parseTrigger(["WARN"])).toEqual({ pattern: "WARN", color: "warn" });
    expect(typeof parseTrigger(["x", "loud"])).toBe("string");
  });
  it("finds the lines, sounds and notices", () => {
    const hits = runTriggers(["ok", "ERROR db down", "", "listening on :3000"], [
      { pattern: "ERROR", color: "err", sound: "error" },
      { pattern: "listening on", color: "ok", notify: true },
    ]);
    expect([...hits.colors]).toEqual([[1, "err"], [3, "ok"]]);
    expect([...hits.sounds]).toEqual(["error"]);
    expect(hits.notices).toEqual(["listening on :3000"]);
  });
});
