import { describe, expect, it } from "vitest";
import { scriptRunTracker } from "./scriptRunTracker";

const M = "⁣";

describe("step markers", () => {
  it("a marker whose call is gone isn't shown", () => {
    expect(scriptRunTracker.consume(`Already on 'main'\r\n${M}OXISSTEPrgs8vi7ok7:0${M}\r\nshop $ `)).toBe("Already on 'main'\r\nshop $ ");
  });
  it("other output with the invisible separator is left alone", () => {
    expect(scriptRunTracker.consume(`a${M}b`)).toBe(`a${M}b`);
  });
});
