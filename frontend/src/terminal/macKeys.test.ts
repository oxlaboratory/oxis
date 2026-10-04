import { describe, expect, it } from "vitest";
import { macShortcut } from "./macKeys";

const cmd = (key: string, extra: Partial<{ shiftKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) =>
  ({ key, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, ...extra });

describe("⌘ shortcuts on macOS", () => {
  it("app shortcuts anywhere", () => {
    expect(macShortcut(cmd("t"), false)).toEqual({ key: "t", shiftKey: false });
    expect(macShortcut(cmd("="), true)).toEqual({ key: "=", shiftKey: false });
    expect(macShortcut(cmd("P", { shiftKey: true }), false)).toEqual({ key: "P", shiftKey: true });
  });
  it("the system keeps copy, paste, cut and select all", () => {
    for (const k of ["c", "v", "x", "a"]) {
      expect(macShortcut(cmd(k), false), k).toBeNull();
      expect(macShortcut(cmd(k), true), k).toBeNull();
    }
  });
  it("editor keys only in the editor; the terminal's own ⌘K and ⌘F", () => {
    expect(macShortcut(cmd("s"), true)).toEqual({ key: "s", shiftKey: false });
    expect(macShortcut(cmd("s"), false)).toBeNull();
    expect(macShortcut(cmd("z"), false)).toBeNull(); // Ctrl+Z would suspend the program
    expect(macShortcut(cmd("z"), true)).toEqual({ key: "z", shiftKey: false });
    expect(macShortcut(cmd("Z", { shiftKey: true }), true)).toEqual({ key: "y", shiftKey: false });
    expect(macShortcut(cmd("k"), false)).toEqual({ key: "l", shiftKey: false });
    expect(macShortcut(cmd("f"), false)).toEqual({ key: "F", shiftKey: true });
    expect(macShortcut(cmd("f"), true)).toEqual({ key: "f", shiftKey: false });
  });
  it("leaves real Ctrl and Alt combinations alone", () => {
    expect(macShortcut({ key: "c", metaKey: false, ctrlKey: true, altKey: false, shiftKey: false }, false)).toBeNull();
    expect(macShortcut(cmd("t", { altKey: true }), false)).toBeNull();
  });
});
