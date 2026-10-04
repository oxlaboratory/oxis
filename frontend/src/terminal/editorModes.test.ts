import { describe, expect, it } from "vitest";
import {
  moveLeft, moveRight, moveDown, moveUp, moveLineStart, moveLineEnd, moveDocEnd,
  moveWordForward, moveWordBackward, moveWordEnd, moveFirstNonBlank,
  deleteChar, deleteLine, deleteWord, openLineBelow, openLineAbove,
  selectionRange, deleteSelection, selectedText,
  yankLines, deleteLines, paste, deleteToLineEnd, changeLine, changeWord,
  replaceChar, joinLines, toggleCase, shiftLine, findNext,
} from "./editorModes";

const TEXT = "alpha beta\n  gamma(delta)\n\nlast line";
const at = (pos: number) => ({ content: TEXT, pos });

describe("motions", () => {
  it("move left and right within the line", () => {
    expect(moveLeft(at(3))).toBe(2);
    expect(moveLeft(at(0))).toBe(0);
    expect(moveRight(at(8))).toBe(9);
    expect(moveRight(at(10))).toBe(10); // stops at the end of the line
  });

  it("move up and down keeping the column, across an empty line", () => {
    // Lines start at 0, 11, 26 (the empty one) and 27.
    expect(moveDown(at(3))).toBe(14);       // alpha → "  g|amma"
    expect(moveDown(at(14))).toBe(26);      // onto the empty line
    expect(moveDown(at(26))).toBe(27);      // the empty line's column is 0
    expect(moveUp(at(27))).toBe(26);
    expect(moveUp(at(14))).toBe(3);
    expect(moveUp(at(3))).toBe(3);          // first line: stays
    expect(moveDown(at(3), 3)).toBe(30);    // 3j keeps column 3 past the empty line
    expect(moveDown(at(26), 1, 3)).toBe(30); // so does a j after it, given the column
  });

  it("go to the line's ends, first non-blank and the document's end", () => {
    expect(moveLineStart(at(15))).toBe(11);
    expect(moveLineEnd(at(15))).toBe(25);
    expect(moveFirstNonBlank(at(11))).toBe(13);
    expect(moveDocEnd(at(0))).toBe(TEXT.length);
  });

  it("move by words: w, b and e", () => {
    expect(moveWordForward(at(0))).toBe(6);
    expect(moveWordForward(at(13))).toBe(18);  // gamma → (
    expect(moveWordBackward(at(6))).toBe(0);
    expect(moveWordEnd(at(0))).toBe(4);
    expect(moveWordEnd(at(4))).toBe(9);        // from a word's end, the next word's
  });
});

describe("edits", () => {
  it("x, dd, dw, o and O", () => {
    expect(deleteChar(at(0)).content.startsWith("lpha")).toBe(true);
    expect(deleteLine(at(3)).content.startsWith("  gamma")).toBe(true);
    expect(deleteWord(at(0)).content.startsWith("beta")).toBe(true);
    const below = openLineBelow(at(3));
    expect(below.content.startsWith("alpha beta\n\n  gamma")).toBe(true);
    expect(below.pos).toBe(11);
    expect(openLineAbove(at(3)).content.startsWith("\nalpha")).toBe(true);
  });

  it("yy and p put a line below, P above", () => {
    const reg = yankLines(at(3));
    expect(reg).toEqual({ text: "alpha beta\n", linewise: true });
    const below = paste(at(14), reg, false);
    expect(below.content.split("\n").slice(0, 3)).toEqual(["alpha beta", "  gamma(delta)", "alpha beta"]);
    const above = paste(at(14), reg, true);
    expect(above.content.split("\n").slice(0, 3)).toEqual(["alpha beta", "alpha beta", "  gamma(delta)"]);
    // On the last line (no newline after it), the line still goes below.
    const end = paste(at(TEXT.length - 2), reg, false);
    expect(end.content.endsWith("last line\nalpha beta")).toBe(true);
  });

  it("2dd deletes two lines into the register; dd on the last line takes the newline before", () => {
    const { state, register } = deleteLines(at(3), 2);
    expect(register.text).toBe("alpha beta\n  gamma(delta)\n");
    expect(state.content).toBe("\nlast line");
    const last = deleteLines(at(TEXT.length - 1));
    expect(last.state.content).toBe("alpha beta\n  gamma(delta)\n");
  });

  it("p pastes characters after the cursor", () => {
    const s = paste({ content: "ac", pos: 0 }, { text: "b", linewise: false }, false);
    expect(s).toEqual({ content: "abc", pos: 1 });
  });

  it("D, cc and cw", () => {
    const d = deleteToLineEnd(at(6));
    expect(d.state.content.startsWith("alpha \n")).toBe(true);
    expect(d.register.text).toBe("beta");
    const cc = changeLine(at(15));
    expect(cc.content.split("\n")[1]).toBe("  ");
    expect(cc.pos).toBe(13);
    const cw = changeWord(at(13));
    expect(cw.content.split("\n")[1]).toBe("  (delta)");
  });

  it("r, J, ~, >> and <<", () => {
    expect(replaceChar(at(0), "A").content.startsWith("Alpha")).toBe(true);
    expect(joinLines(at(0)).content.startsWith("alpha beta gamma(delta)\n")).toBe(true);
    const t = toggleCase(at(0));
    expect(t.content.startsWith("Alpha")).toBe(true);
    expect(t.pos).toBe(1);
    expect(shiftLine(at(0), "  ", false).content.startsWith("  alpha")).toBe(true);
    expect(shiftLine(at(14), "  ", true).content.split("\n")[1]).toBe("gamma(delta)");
  });

  it("n and N find the next and previous match, wrapping", () => {
    expect(findNext(at(0), "a", false)).toBe(4);
    expect(findNext(at(TEXT.length - 1), "alpha", false)).toBe(0); // wraps
    expect(findNext(at(4), "a", true)).toBe(0);
    expect(findNext(at(0), "zzz", false)).toBeNull();
  });
});

describe("visual mode", () => {
  it("selects in either direction and deletes or yanks it", () => {
    expect(selectionRange({ content: TEXT, pos: 4, anchor: 0 })).toEqual([0, 5]);
    expect(selectionRange({ content: TEXT, pos: 0, anchor: 4 })).toEqual([0, 5]);
    expect(selectedText({ content: TEXT, pos: 4, anchor: 0 })).toBe("alpha");
    expect(deleteSelection({ content: TEXT, pos: 4, anchor: 0 }).content.startsWith(" beta")).toBe(true);
  });
});
