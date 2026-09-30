import { describe, expect, it } from "vitest";
import { AnsiParser, stripSgr } from "./ansi";

describe("stripSgr", () => {
  it("removes colour codes only", () => {
    expect(stripSgr("\x1b[1;32mok\x1b[0m")).toBe("ok");
    expect(stripSgr("plain")).toBe("plain");
  });
});

describe("AnsiParser", () => {
  it("returns plain lines without spans", () => {
    expect(new AnsiParser().parse("hello")).toEqual({ text: "hello" });
  });

  it("styles the base colours from the theme", () => {
    const { text, spans } = new AnsiParser().parse("\x1b[31mred\x1b[0m plain");
    expect(text).toBe("red plain");
    expect(spans).toEqual([{ t: "red", s: "color:var(--ansi-1)" }, { t: " plain", s: undefined }]);
  });

  it("maps bright, background and text styles", () => {
    const { spans } = new AnsiParser().parse("\x1b[1;3;4;92;44mX");
    expect(spans?.[0].s).toBe("color:var(--ansi-10);background-color:var(--ansi-4);font-weight:700;font-style:italic;text-decoration:underline");
  });

  it("reads 256-colour and 24-bit colours, in both separator forms", () => {
    const p = new AnsiParser();
    expect(p.parse("\x1b[38;5;196mX").spans?.[0].s).toBe("color:rgb(255,0,0)");
    expect(p.parse("\x1b[38;5;244mX").spans?.[0].s).toBe("color:rgb(128,128,128)");
    expect(p.parse("\x1b[38;2;1;2;3mX").spans?.[0].s).toBe("color:rgb(1,2,3)");
    expect(p.parse("\x1b[38:2::10:20:30mX").spans?.[0].s).toBe("color:rgb(10,20,30)");
    expect(p.parse("\x1b[0;48:5:208mX").spans?.[0].s).toBe("background-color:rgb(255,135,0)");
  });

  it("swaps colours for inverse", () => {
    expect(new AnsiParser().parse("\x1b[7mX").spans?.[0].s).toBe("color:var(--bg);background-color:var(--text)");
  });

  it("carries a style to the next line until a reset", () => {
    const p = new AnsiParser();
    p.parse("\x1b[32mgreen");
    expect(p.parse("still green").spans).toEqual([{ t: "still green", s: "color:var(--ansi-2)" }]);
    expect(p.parse("\x1b[0mplain")).toEqual({ text: "plain" });
  });

  it("previews a line without keeping its style", () => {
    const p = new AnsiParser();
    p.preview("\x1b[31mprompt");
    expect(p.parse("after")).toEqual({ text: "after" });
  });

  it("merges neighbouring spans with the same style", () => {
    const { spans } = new AnsiParser().parse("\x1b[31ma\x1b[31mb\x1b[1m\x1b[22mc");
    expect(spans).toEqual([{ t: "abc", s: "color:var(--ansi-1)" }]);
  });
});
