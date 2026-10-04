import { describe, expect, it, vi, beforeEach } from "vitest";
import type { OxisBindings, LuaLoadResult } from "./luaRuntime";

vi.mock("../native", () => ({ isNativeApp: () => false, getPtyPort: async () => 1420 }));

/** A stand-in for the /lua socket: records what the page sends and lets
 *  the test answer as OXIS would. */
class FakeSocket {
  static last: FakeSocket;
  static OPEN = 1;
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  onmessage?: (ev: { data: string }) => void;
  onclose?: () => void;
  constructor(public url: string) { FakeSocket.last = this; }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() {}
  emit(m: unknown) { this.onmessage?.({ data: JSON.stringify(m) }); }
}

function bindings(over: Partial<OxisBindings> = {}): OxisBindings {
  return {
    platform: "windows",
    command: vi.fn(), task: vi.fn(), echo: vi.fn(), cwd: () => "C:/work",
    line: vi.fn(() => ({ set: vi.fn(), text: () => "now" })),
    reportError: vi.fn(), dispose: vi.fn(),
    ...over,
  } as unknown as OxisBindings;
}

const tick = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  vi.resetModules();
  (globalThis as Record<string, unknown>).WebSocket = FakeSocket;
  (globalThis as Record<string, unknown>).window = { location: { protocol: "http:", host: "127.0.0.1:1420" } };
  (globalThis as Record<string, unknown>).localStorage = { getItem: () => null, setItem: () => {} };
});

describe("nativeLua", () => {
  it("runs a plugin's calls on its bindings and calls Lua back", async () => {
    const { loadNative } = await import("./nativeLua");
    const b = bindings();
    const fallback = vi.fn((): LuaLoadResult => ({ ok: false, error: "x", ready: Promise.resolve({ ok: false, error: "x" }) }));
    const r = loadNative("oxis.echo('hi')", b, "demo", fallback);
    await tick();
    const ws = FakeSocket.last;
    expect(ws.url).toBe("ws://127.0.0.1:1420/lua");
    ws.emit({ t: "hello", available: true, engine: "Lua 5.4.9" });
    await tick();
    const open = ws.sent.find(m => m.t === "open")!;
    expect(open).toMatchObject({ source: "oxis.echo('hi')", chunk: "demo", platform: "windows" });
    const sid = open.sid;

    // Posts: an echo and a command whose handler is a Lua function.
    ws.emit({ t: "post", sid, posts: [["echo", ["hi"]], ["command", ["greet", { $fn: 3 }, "says hi"]]] });
    expect(b.echo).toHaveBeenCalledWith("hi", undefined);
    const [name, invoke, desc] = (b.command as ReturnType<typeof vi.fn>).mock.calls[0];
    expect([name, desc]).toEqual(["greet", "says hi"]);
    invoke(["a"], "a", "a");
    expect(ws.sent.at(-1)).toEqual({ t: "invoke", sid, ref: 3, args: [["a"], "a", "a"] });

    // A call that waits: the answer goes back with its id.
    ws.emit({ t: "call", sid, id: 1, fn: "cwd", args: [] });
    expect(ws.sent.at(-1)).toMatchObject({ t: "ret", sid, id: 1, ok: true, value: "C:/work" });

    // A handle: Lua gets its id and methods, then calls one.
    ws.emit({ t: "call", sid, id: 2, fn: "line", args: ["frame 1"] });
    const ret = ws.sent.at(-1)!;
    expect(ret.value).toEqual({ $h: 1, m: ["set", "text"], post: ["set"] });
    ws.emit({ t: "call", sid, id: 3, fn: "$h", args: [1, "text"] });
    expect(ws.sent.at(-1)).toMatchObject({ id: 3, ok: true, value: "now" });

    // An error in a binding is Lua's error at the call.
    ws.emit({ t: "call", sid, id: 4, fn: "nope", args: [] });
    expect(ws.sent.at(-1)).toMatchObject({ id: 4, ok: false, error: "OXIS has no nope" });

    ws.emit({ t: "opened", sid, ok: true });
    await expect(r.ready).resolves.toEqual({ ok: true });
    expect(r.ok && r.plugin.engine).toBe("native");
    expect(fallback).not.toHaveBeenCalled();

    // Unloading tells OXIS to close the state.
    if (r.ok) r.plugin.dispose();
    expect(ws.sent.at(-1)).toEqual({ t: "close", sid });
    expect(b.dispose).toHaveBeenCalled();
  });

  it("falls back to fengari when this build has no native Lua", async () => {
    const { loadNative } = await import("./nativeLua");
    const dispose = vi.fn();
    const fallback = vi.fn((): LuaLoadResult => ({ ok: true, plugin: { dispose, engine: "fengari" }, ready: Promise.resolve({ ok: true }) }));
    const r = loadNative("x", bindings(), "demo", fallback);
    await tick();
    FakeSocket.last.emit({ t: "hello", available: false, error: "built without a C compiler" });
    await expect(r.ready).resolves.toEqual({ ok: true });
    expect(fallback).toHaveBeenCalled();
    expect(r.ok && r.plugin.engine).toBe("fengari");
    if (r.ok) r.plugin.dispose();
    expect(dispose).toHaveBeenCalled();
  });

  it("reports a plugin that fails to load", async () => {
    const { loadNative } = await import("./nativeLua");
    const b = bindings();
    const r = loadNative("error('boom')", b, "bad", vi.fn());
    await tick();
    const ws = FakeSocket.last;
    ws.emit({ t: "hello", available: true });
    await tick();
    const sid = ws.sent.find(m => m.t === "open")!.sid;
    ws.emit({ t: "opened", sid, ok: false, error: "bad:1: boom" });
    await expect(r.ready).resolves.toEqual({ ok: false, error: "bad:1: boom" });
    expect(b.dispose).toHaveBeenCalled();
  });
});
