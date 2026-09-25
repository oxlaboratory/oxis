/**
 * ptyClient.ts — WebSocket ↔ PTY bridge. No UI.
 *
 * In the native window the socket lives on a different origin than the
 * page (Wails' asset server can't upgrade WebSockets), so the port comes
 * from Go (getPtyPort). In a browser tab at http://127.0.0.1:<port> the
 * socket is same-origin.
 *
 * Protocol (JSON over WS):
 *   Client → Server: { type: "init", cols, rows }
 *                    { type: "input", data }
 *                    { type: "resize", cols, rows }
 *                    { type: "kill" }
 *   Server → Client: { type: "output", data }
 *                    { type: "ready" }
 *                    { type: "exit", code }
 *                    { type: "error", message }
 */

import { getPtyPort, isNativeApp } from "../native";

export type OutputCallback = (data: string) => void;
export type ReadyCallback  = () => void;
export type ExitCallback   = (code: number) => void;
export type ErrorCallback  = (msg: string) => void;

export interface PtySession {
  write  : (data: string) => void;
  resize : (cols: number, rows: number) => void;
  kill   : () => void;
}

export interface PtyOptions {
  cols:     number;
  rows:     number;
  onOutput: OutputCallback;
  onReady:  ReadyCallback;
  onExit:   ExitCallback;
  onError:  ErrorCallback;
  /** Auto-reconnect on unexpected close. Default: false */
  reconnect?: boolean;
}

// The port never changes while OXIS runs; only a successful lookup is
// cached so a failed one can be retried.
let ptyPortPromise: Promise<number> | null = null;

async function wsURL(): Promise<string> {
  if (!isNativeApp()) {
    // Browser mode: server.Listen serves /ws on this same origin, so
    // a same-origin relative URL just works.
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}/ws`;
  }
  if (!ptyPortPromise) {
    ptyPortPromise = getPtyPort().catch((err) => {
      ptyPortPromise = null;
      throw err;
    });
  }
  const port = await ptyPortPromise;
  return `ws://127.0.0.1:${port}/ws`;
}

export function openPty(opts: PtyOptions): PtySession {
  const { onOutput, onReady, onExit, onError, reconnect } = opts;
  // Latest requested size; resizes before the socket opens are kept and
  // sent with init.
  let size = { cols: opts.cols, rows: opts.rows };
  let ws: WebSocket | null = null;
  let dead = false;

  async function connect(): Promise<void> {
    let url: string;
    try {
      url = await wsURL();
    } catch {
      onError("Couldn't reach the OXIS PTY server — is oxis.exe running?");
      return;
    }
    if (dead) return;

    const socket = new WebSocket(url);
    ws = socket;

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "init", ...size }));
    });

    socket.addEventListener("message", (ev) => {
      let msg: { type: string; data?: string; code?: number; message?: string };
      try { msg = JSON.parse(ev.data as string); } catch { return; }
      switch (msg.type) {
        case "output": if (msg.data) onOutput(msg.data); break;
        case "ready":                onReady();           break;
        case "exit":   if (msg.code !== undefined) onExit(msg.code); break;
        case "error":  if (msg.message) onError(msg.message); break;
      }
    });

    socket.addEventListener("error", () => {
      onError("WebSocket connection failed — is the OXIS server running?");
    });

    socket.addEventListener("close", (ev) => {
      if (dead) return;
      if (ev.code !== 1000 && ev.code !== 1001) {
        if (reconnect) { connect(); return; }
        onExit(-1);
      }
    });
  }

  connect();

  const send = (msg: object) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  return {
    write : (data) => send({ type: "input", data }),
    resize: (c, r) => { size = { cols: c, rows: r }; send({ type: "resize", cols: c, rows: r }); },
    kill  : () => {
      dead = true;
      send({ type: "kill" });
      ws?.close(1000, "killed");
    },
  };
}