import { describe, expect, it } from "vitest";
import { imageLength, inlineImageLine, sniffImageType } from "./terminal";

// A 1×1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("inline images (OSC 1337)", () => {
  it("knows an image by its first bytes", () => {
    const bytes = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
    expect(sniffImageType(bytes(PNG))).toBe("image/png");
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageType(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBe("image/svg+xml");
    expect(sniffImageType(new TextEncoder().encode("#!/bin/sh\necho hi"))).toBeNull();
  });
  it("reads iTerm2's sizes as CSS", () => {
    expect(imageLength("40", "width")).toBe("40ch");
    expect(imageLength("10", "height")).toBe("calc(10 * var(--lh))");
    expect(imageLength("300px", "width")).toBe("300px");
    expect(imageLength("50%", "width")).toBe("50%");
    expect(imageLength("auto", "width")).toBeUndefined();
    expect(imageLength("1e9;", "width")).toBeUndefined();
  });
  it("makes an image line with its name as the text", () => {
    const line = inlineImageLine(`1337;name=${btoa("C:/pics/chart.png")};inline=1;width=20:${PNG}`);
    expect(line?.text).toBe("[image chart.png]");
    expect(line?.image?.width).toBe("20ch");
    expect(line?.image?.src.startsWith("blob:")).toBe(true);
  });
  it("shows nothing for data that isn't an image", () => {
    expect(inlineImageLine(`1337;inline=1:${btoa("not an image at all")}`)).toBeNull();
    expect(inlineImageLine("1337;inline=1:!!!not base64")).toBeNull();
  });
});
