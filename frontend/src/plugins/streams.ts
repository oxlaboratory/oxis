/**
 * streams.ts — the page's side of internal/wailsapp/streams.go.
 *
 * Spawned processes, file watchers and streamed HTTP requests all
 * deliver their events through one long poll: while any stream is open,
 * one PollStreams call is always waiting, and it returns as soon as
 * something arrives. Each stream has a handler; its "end" event is the
 * last one it gets.
 */

import { pollStreams, streamClose, streamsReset, type NativeStreamEvent } from "../native";

export type StreamEvent = NativeStreamEvent;
type Handler = (ev: StreamEvent) => void;

const handlers = new Map<string, Handler>();
// Streams whose start call hasn't finished, and those of them closed in
// the meantime (a process killed right after spawning): closed as soon
// as they exist.
const starting = new Set<string>();
const closedEarly = new Set<string>();
let session: Promise<number> | null = null;
let polling = false;
let counter = 0;

/** A unique stream id (the Go side rejects one that's already open). */
export function newStreamId(kind: string): string {
  return `${kind}-${Date.now().toString(36)}-${(++counter).toString(36)}`;
}

/** The poll session. The first call closes whatever an earlier load of
 *  the page left running (processes, watchers) before a reload. */
function currentSession(): Promise<number> {
  if (!session) {
    session = streamsReset().catch((e) => { session = null; throw e; });
  }
  return session;
}

/**
 * Opens a stream: registers its handler, then runs `start` (the Go call
 * that begins it). If start fails the handler is removed and the error
 * rethrown; otherwise events flow to the handler until "end".
 */
export async function openStream<T>(id: string, handler: Handler, start: () => Promise<T>): Promise<T> {
  starting.add(id);
  try {
    await currentSession();
    handlers.set(id, handler);
    void pollLoop();
    const result = await start();
    if (closedEarly.has(id)) void streamClose(id);
    return result;
  } catch (e) {
    handlers.delete(id);
    closedEarly.delete(id);
    throw e;
  } finally {
    starting.delete(id);
  }
}

/** Stops a stream (once it has started, if it's still starting). Its
 *  handler still gets the "end" event. */
export function closeStream(id: string): void {
  if (starting.has(id)) closedEarly.add(id);
  else if (handlers.has(id)) void streamClose(id);
}

/** Open streams (for tests and diagnostics). */
export function openStreamCount(): number {
  return handlers.size;
}

async function pollLoop(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const s = await currentSession();
    while (handlers.size > 0) {
      let events: StreamEvent[];
      try {
        events = await pollStreams(s, 25_000);
      } catch (e) {
        console.warn("[oxis:streams] poll failed:", e);
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      for (const ev of events) {
        const handler = handlers.get(ev.id);
        if (!handler) continue;
        if (ev.type === "end") { handlers.delete(ev.id); closedEarly.delete(ev.id); }
        try { handler(ev); } catch (e) { console.warn(`[oxis:streams] ${ev.id} handler:`, e); }
      }
    }
  } finally {
    polling = false;
  }
}

/** Splits text arriving in chunks into complete lines (without their
 *  line endings); flush() returns an unfinished last line. */
export class LineSplitter {
  private rest = "";
  push(chunk: string): string[] {
    // A \r at a chunk's end stays in `rest` until the \n after it arrives.
    const parts = (this.rest + chunk).split(/\r?\n/);
    this.rest = parts.pop() ?? "";
    return parts;
  }
  flush(): string | null {
    const r = this.rest.replace(/\r$/, "");
    this.rest = "";
    return r === "" ? null : r;
  }
}

export interface ServerSentEvent { event: string; data: string; id?: string }

/**
 * Parses server-sent events (text/event-stream), the format OpenAI,
 * Anthropic and most AI APIs stream answers in: "field: value" lines,
 * events separated by a blank line, "data" lines joined with "\n".
 */
export class SSEParser {
  private lines = new LineSplitter();
  private data: string[] = [];
  private event = "";
  private lastId: string | undefined;

  push(chunk: string): ServerSentEvent[] {
    const out: ServerSentEvent[] = [];
    for (const line of this.lines.push(chunk)) this.line(line, out);
    return out;
  }

  /** The end of the stream: an event without its closing blank line is
   *  still delivered. */
  end(): ServerSentEvent[] {
    const out: ServerSentEvent[] = [];
    const last = this.lines.flush();
    if (last !== null) this.line(last, out);
    this.line("", out);
    return out;
  }

  private line(line: string, out: ServerSentEvent[]): void {
    if (line === "") {
      if (this.data.length > 0) {
        out.push({ event: this.event || "message", data: this.data.join("\n"), ...(this.lastId !== undefined ? { id: this.lastId } : {}) });
      }
      this.data = [];
      this.event = "";
      return;
    }
    if (line.startsWith(":")) return; // comment / keep-alive
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
    else if (field === "event") this.event = value;
    else if (field === "id" && !value.includes("\0")) this.lastId = value;
  }
}
