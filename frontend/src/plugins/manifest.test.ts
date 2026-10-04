import { describe, expect, it } from "vitest";
import { parseManifest } from "./manifest";

describe("parseManifest", () => {
  it("reads every field", () => {
    const m = parseManifest(`--[[@manifest
version: 2.0.0
description: casino night
author: Oxide Labs
category: games
min_oxis_version: 1.2.1
os: windows, unix
permissions: fs, net, nonsense
dependencies: autotest>=1.0.0, notes
]]
oxis.echo("hi")`);
    expect(m).toEqual({
      version: "2.0.0", description: "casino night", author: "Oxide Labs", category: "games",
      minOxisVersion: "1.2.1", os: ["windows", "unix"], permissions: ["fs", "net"],
      dependencies: { autotest: ">=1.0.0", notes: "*" },
    });
  });

  it("takes an empty permissions line as needing none", () => {
    expect(parseManifest("--[[@manifest\nversion: 1.0.0\npermissions:\n]]")?.permissions).toEqual([]);
  });

  it("leaves permissions out when the line is missing", () => {
    expect(parseManifest("--[[@manifest\nversion: 1.0.0\n]]")?.permissions).toBeUndefined();
  });

  it("is null without a manifest", () => {
    expect(parseManifest("oxis.echo('no manifest')")).toBeNull();
  });
});
