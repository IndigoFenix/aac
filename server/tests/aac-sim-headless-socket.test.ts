/**
 * The harness seam (design ⓪). DB-free and LLM-free on purpose: this asserts the
 * SOCKET contract, not a session. `bootSimSession` on top of it opens a real
 * billed session against a real student, so it is exercised by the harness
 * runner, never by jest.
 */

import { describe, it, expect, jest } from "@jest/globals";
import { HeadlessSocket } from "../services/aac-sim/headless-socket.js";
import type { ClientMessage } from "../services/dual-agent/live-relay.js";

const press = (buttons: string[]): ClientMessage =>
  ({ type: "button_press", buttons }) as ClientMessage;

describe("the surface the coordinator consumes", () => {
  it("delivers a client message to the 'message' listener as JSON text", () => {
    const s = new HeadlessSocket();
    const seen: string[] = [];
    s.on("message", (raw) => seen.push(String(raw)));

    s.deliver(press(["hello"]));

    expect(seen).toHaveLength(1);
    // The coordinator does `JSON.parse(String(raw))`, so this must survive it.
    expect(JSON.parse(seen[0])).toEqual({ type: "button_press", buttons: ["hello"] });
  });

  it("records what the server sends, parsed", () => {
    const s = new HeadlessSocket();
    s.send(JSON.stringify({ type: "speak", text: "hi there" }));
    expect(s.outbox).toEqual([{ type: "speak", text: "hi there" }]);
  });

  it("records unparseable output instead of throwing — garbage is a finding", () => {
    const s = new HeadlessSocket();
    s.send("<not json>");
    expect(s.outbox[0].type).toBe("__unparseable__");
    expect(s.outbox[0].raw).toBe("<not json>");
  });

  it("answers a ping immediately, or the coordinator terminates the run", () => {
    // startPingTimer() terminates the socket after ONE missed pong, so a fake
    // that stays silent gets killed mid-session.
    const s = new HeadlessSocket();
    const pongs = jest.fn();
    s.on("pong", pongs);
    s.ping();
    expect(pongs).toHaveBeenCalledTimes(1);
  });

  it("stops answering pings once closed", () => {
    const s = new HeadlessSocket();
    const pongs = jest.fn();
    s.on("pong", pongs);
    s.close();
    s.ping();
    expect(pongs).not.toHaveBeenCalled();
  });

  it("reports close and terminate through the 'close' listener", () => {
    for (const kill of ["close", "terminate"] as const) {
      const s = new HeadlessSocket();
      const closed = jest.fn();
      s.on("close", closed);
      s[kill]();
      expect(closed).toHaveBeenCalledTimes(1);
      expect(s.readyState).not.toBe(s.OPEN);
      expect(s.closed).toContain(kill === "close" ? "closed" : "terminated");
    }
  });

  it("is idempotent about closing — a terminate after a close emits once", () => {
    const s = new HeadlessSocket();
    const closed = jest.fn();
    s.on("close", closed);
    s.close();
    s.terminate();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("drops listeners on removeAllListeners, as the adoption path expects", () => {
    // The coordinator strips handlers per-event when handing a socket over.
    const s = new HeadlessSocket();
    const onMsg = jest.fn();
    const onClose = jest.fn();
    s.on("message", onMsg);
    s.on("close", onClose);

    s.removeAllListeners("message");
    s.deliver(press(["x"]));
    expect(onMsg).not.toHaveBeenCalled();

    s.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("survives a listener that throws — one bad handler cannot kill the run", () => {
    const s = new HeadlessSocket();
    const good = jest.fn();
    s.on("message", () => { throw new Error("boom"); });
    s.on("message", good);
    expect(() => s.deliver(press(["x"]))).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("refuses to deliver on a closed socket rather than pretending", () => {
    const s = new HeadlessSocket();
    s.close();
    expect(() => s.deliver(press(["x"]))).toThrow(/cannot deliver button_press/);
  });
});

describe("waiting for a reply", () => {
  it("resolves on a matching message that arrives later", async () => {
    const s = new HeadlessSocket();
    const waiting = s.waitForType("speak", { timeoutMs: 1000 });
    s.send(JSON.stringify({ type: "board", data: {} }));
    s.send(JSON.stringify({ type: "speak", text: "hi" }));
    await expect(waiting).resolves.toMatchObject({ type: "speak", text: "hi" });
  });

  it("resolves from history — a reply can land before anyone asks", async () => {
    const s = new HeadlessSocket();
    s.send(JSON.stringify({ type: "initialized", sessionId: "s1" }));
    await expect(s.waitForType("initialized")).resolves.toMatchObject({ sessionId: "s1" });
  });

  it("ignores history when told to", async () => {
    const s = new HeadlessSocket();
    s.send(JSON.stringify({ type: "speak", text: "old" }));
    const waiting = s.waitForType("speak", { timeoutMs: 1000, includeExisting: false });
    s.send(JSON.stringify({ type: "speak", text: "new" }));
    await expect(waiting).resolves.toMatchObject({ text: "new" });
  });

  it("REJECTS on timeout — a silent session must fail, not read as clean", async () => {
    // Harness law ⑦: silence is an event. A waiter that resolved null here would
    // let the runner report a clean turn for a session that never answered.
    const s = new HeadlessSocket();
    s.send(JSON.stringify({ type: "thinking", active: true }));
    await expect(s.waitForType("speak", { timeoutMs: 20 })).rejects.toThrow(/timed out.*thinking/s);
  });

  it("names what it did see, so a timeout is diagnosable", async () => {
    const s = new HeadlessSocket();
    await expect(s.waitForType("speak", { timeoutMs: 20 })).rejects.toThrow(/\(nothing\)/);
  });
});

describe("the press log and history", () => {
  it("keeps every delivered message in order — that IS the press log", () => {
    const s = new HeadlessSocket();
    s.deliver(press(["a"]));
    s.deliver(press(["b"]));
    expect(s.inbox.map((m) => (m as { buttons: string[] }).buttons[0])).toEqual(["a", "b"]);
  });

  it("collects all messages of a type", () => {
    const s = new HeadlessSocket();
    s.send(JSON.stringify({ type: "board", n: 1 }));
    s.send(JSON.stringify({ type: "speak" }));
    s.send(JSON.stringify({ type: "board", n: 2 }));
    expect(s.allOfType("board").map((m) => m.n)).toEqual([1, 2]);
  });

  it("clears the outbox without closing, so a turn can be measured alone", () => {
    const s = new HeadlessSocket();
    s.send(JSON.stringify({ type: "initialized" }));
    s.clearOutbox();
    expect(s.outbox).toEqual([]);
    expect(s.readyState).toBe(s.OPEN);
  });
});
