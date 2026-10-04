import { beforeEach, describe, expect, it } from "vitest";
import {
  ensurePermission, isGranted, requestPermissionAsync, setDeclaredPermissions, setPermissionAsker,
  denialReason, PluginPermissionError,
} from "./permissions";

// A localStorage for node, so grants persist the way they do in the app.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};

describe("asking for a permission in the prompt", () => {
  let asked: string[];
  let answer: (ok: boolean) => void;
  beforeEach(() => {
    store.clear();
    asked = [];
    setPermissionAsker((plugin, what) => {
      asked.push(`${plugin}: ${what}`);
      return new Promise((r) => { answer = r; });
    });
  });

  it("asks once, however many calls wait, and remembers a yes", async () => {
    const a = requestPermissionAsync("p1", "fs");
    const b = requestPermissionAsync("p1", "fs");
    expect(asked).toEqual(["p1: read/write files on your computer"]);
    answer(true);
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(isGranted("p1", "fs")).toBe(true);
    expect(await requestPermissionAsync("p1", "fs")).toBe(true);
    expect(asked).toHaveLength(1);
  });

  it("a no lasts the session and rejects ensurePermission", async () => {
    const p = ensurePermission("p2", "net");
    answer(false);
    await expect(p).rejects.toBeInstanceOf(PluginPermissionError);
    expect(denialReason("p2", "net")).toBe("declined");
    expect(await requestPermissionAsync("p2", "net")).toBe(false);
    expect(asked).toHaveLength(1);
  });

  it("never asks for a permission the manifest didn't declare", async () => {
    setDeclaredPermissions("p3", ["fs"]);
    expect(await requestPermissionAsync("p3", "process")).toBe(false);
    expect(denialReason("p3", "process")).toBe("undeclared");
    expect(asked).toHaveLength(0);
  });

  it("asks for the shell even when it's declared", async () => {
    setDeclaredPermissions("p4", ["shell"]);
    const p = requestPermissionAsync("p4", "shell");
    expect(asked).toEqual(["p4: run commands in your shell"]);
    answer(true);
    expect(await p).toBe(true);
  });
});
