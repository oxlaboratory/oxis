import { describe, expect, it } from "vitest";
import {
  stripAnsi, stripAnsiKeepSgr, commandBlockAt, foldOutput, visibleText, processOutput, mergeOutput, mkLine,
  wordLeft, wordRight, deleteWordLeft, deleteWordRight, deleteToLineStart, deleteToLineEnd, transposeChars,
} from "./terminal";

describe("stripAnsi", () => {
  it("removes CSI, OSC, DCS and single-character escapes", () => {
    expect(stripAnsi("\x1b[1;31mred\x1b[0m")).toBe("red");
    expect(stripAnsi("\x1b]0;title\x07after")).toBe("after");
    expect(stripAnsi("\x1b]8;;https://x.dev\x1b\\link\x1b]8;;\x1b\\")).toBe("link");
    expect(stripAnsi("\x1bPq#0;2;0;0;0\x1b\\text")).toBe("text");
    expect(stripAnsi("\x1b=keypad\x1b>")).toBe("keypad");
    expect(stripAnsi("\x1b[?25lhidden cursor\x1b[?25h")).toBe("hidden cursor");
  });

  it("drops NUL, BEL and backspace", () => {
    expect(stripAnsi("a\x00b\x07c\x08d")).toBe("abcd");
  });

  it("keeps colours when asked, and nothing else", () => {
    expect(stripAnsiKeepSgr("\x1b[2K\x1b[32mok\x1b[0m\x1b[1G")).toBe("\x1b[32mok\x1b[0m");
  });
});

describe("visibleText", () => {
  it("shows the last state of a line rewritten with carriage returns", () => {
    expect(visibleText("4%\r8%\r12%")).toBe("12%");
  });

  it("keeps a line that ends in a carriage return", () => {
    expect(visibleText("done\r")).toBe("done");
  });

  it("carries colour codes from overwritten text", () => {
    expect(visibleText("\x1b[32mold\rnew")).toBe("\x1b[32mnew");
  });

  it("leaves plain lines alone", () => {
    expect(visibleText("plain")).toBe("plain");
  });
});

describe("processOutput", () => {
  it("splits complete lines from the unfinished one", () => {
    expect(processOutput("one\ntwo\nthr", "")).toEqual({ completedLines: ["one", "two"], newPending: "thr" });
  });

  it("reads a CRLF split across two chunks as one line break", () => {
    const a = processOutput("a\r", "");
    expect(a.completedLines).toEqual([]);
    const b = processOutput("\nb\n", a.newPending);
    expect(b).toEqual({ completedLines: ["a", "b"], newPending: "" });
  });

  it("strips escapes but keeps colours in lines", () => {
    expect(processOutput("\x1b[?2004h\x1b[31merr\x1b[0m\n", "").completedLines).toEqual(["\x1b[31merr\x1b[0m"]);
  });
});

describe("mergeOutput", () => {
  it("appends shell lines", () => {
    const out = mergeOutput([mkLine("a")], [{ text: "b" }]);
    expect(out.map(l => [l.text, l.kind])).toEqual([["a", undefined], ["b", "shell"]]);
  });

  it("keeps memory bounded", () => {
    const prev = Array.from({ length: 9_999 }, (_, i) => mkLine(String(i)));
    const out = mergeOutput(prev, [{ text: "x" }, { text: "y" }]);
    expect(out.length).toBe(8_000);
    expect(out[out.length - 1].text).toBe("y");
  });
});

describe("readline editing", () => {
  it("moves by words", () => {
    expect(wordLeft("git commit -m", 13)).toBe(11);
    expect(wordLeft("git commit  ", 12)).toBe(4);
    expect(wordRight("git commit", 0)).toBe(3);
    expect(wordRight("git   commit", 3)).toBe(12);
  });

  it("deletes words and to either end", () => {
    expect(deleteWordLeft("git commit", 10)).toEqual({ text: "git ", pos: 4 });
    expect(deleteWordRight("git commit -m", 3)).toEqual({ text: "git -m", pos: 3 });
    expect(deleteToLineStart("abc def", 4)).toEqual({ text: "def", pos: 0 });
    expect(deleteToLineEnd("abc def", 3)).toEqual({ text: "abc", pos: 3 });
  });

  it("transposes characters like readline", () => {
    expect(transposeChars("abc", 1)).toEqual({ text: "bac", pos: 2 });
    expect(transposeChars("abc", 3)).toEqual({ text: "acb", pos: 3 });
    expect(transposeChars("a", 1)).toEqual({ text: "a", pos: 1 });
  });
});

describe("commandBlockAt", () => {
  const ok = { code: 0, ms: 5 };
  const ls = [
    mkLine("type 'help"),
    { ...mkLine("acme $ npm test"), status: { code: 1, ms: 900 } },
    mkLine("FAIL cart.test.ts"),
    mkLine("  expected 3, got 4"),
    mkLine(""),
    mkLine("acme $"),
    { ...mkLine("acme $ echo hi"), status: ok },
    mkLine("hi"),
    mkLine("acme $ "),
  ];
  it("the command above and its output, without the empty prompt after", () => {
    const b = commandBlockAt(ls, ls[3].id)!;
    expect(b.command.text).toBe("acme $ npm test");
    expect(b.output.map(l => l.text)).toEqual(["FAIL cart.test.ts", "  expected 3, got 4"]);
    expect(commandBlockAt(ls, ls[1].id)!.output).toHaveLength(2);
    expect(commandBlockAt(ls, ls[8].id)!.output.map(l => l.text)).toEqual(["hi"]);
  });
  it("nothing above the first command", () => {
    expect(commandBlockAt(ls, ls[0].id)).toBeNull();
  });
});

describe("foldOutput", () => {
  const ok = { code: 0, ms: 1 };
  const ls = [
    { ...mkLine("$ npm test"), status: ok },
    mkLine("a"), mkLine("b"), mkLine("c"),
    { ...mkLine("$ ls"), status: ok },
    mkLine("x"),
  ];
  it("hides a folded command's lines up to the next command", () => {
    const f = foldOutput(ls, new Set([ls[0].id]));
    expect(f.lines.map(l => l.text)).toEqual(["$ npm test", "$ ls", "x"]);
    expect(f.hidden.get(ls[0].id)).toBe(3);
  });
  it("nothing folded: the same array", () => {
    expect(foldOutput(ls, new Set()).lines).toBe(ls);
  });
});
