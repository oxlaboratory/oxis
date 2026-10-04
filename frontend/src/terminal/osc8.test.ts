import { describe, expect, it } from "vitest";
import { AnsiParser, stripSgr } from "./ansi";
import { stripAnsiKeepSgr } from "./terminal";

const ESC = "\x1b", BEL = "\x07";
// As the PTY writes them: ended with ST (ESC \\), which survives the
// cleanup that drops BEL characters; programs may use either.
const ST = `${ESC}\\`;
const link = (uri: string, text: string, end = ST) => `${ESC}]8;;${uri}${end}${text}${ESC}]8;;${end}`;

describe("OSC 8 hyperlinks", () => {
  it("survive the PTY output cleanup, and leave plain text without them", () => {
    const line = `see ${link("https://oxis.space", "the site")} now`;
    expect(stripAnsiKeepSgr(line)).toBe(line);
    expect(stripSgr(line)).toBe("see the site now");
  });

  it("become spans with the link, colours kept", () => {
    const p = new AnsiParser();
    const r = p.parse(`a ${ESC}]8;id=7;file:///C:/dev/x.ts${ESC}\\${ESC}[36mx.ts${ESC}[0m${ESC}]8;;${ESC}\\ b`);
    expect(r.text).toBe("a x.ts b");
    expect(r.spans?.find(s => s.t === "x.ts")).toMatchObject({ l: "file:///C:/dev/x.ts" });
    expect(r.spans?.find(s => s.t === " b")?.l).toBeUndefined();
  });

  it("a plain linked word still counts as styled", () => {
    const r = new AnsiParser().parse(link("https://x.dev", "x", BEL));
    expect(r.spans).toEqual([{ t: "x", l: "https://x.dev" }]);
  });
});
