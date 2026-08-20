/**
 * headless-socket.ts — THE HARNESS SEAM (harness design ⓪).
 *
 * An in-memory stand-in for the client WebSocket, so an `AgentCoordinator` can
 * be driven with no browser, no HTTP upgrade and no network. This is the whole
 * boot seam for the simulated-child harness: the coordinator is constructed
 * exactly as production constructs it —
 *
 *     new AgentCoordinator(socket.asWebSocket(), user)
 *
 * — and every message in and out is a real `ClientMessage` / `ServerMessage`.
 * Nothing about the four agents, the board manager, the session or the DB is
 * stubbed. (Harness law ④: BYPASS THE PIXELS, NEVER THE SERVER.)
 *
 * THE SURFACE IS SMALL AND FIXED. The coordinator touches a socket in exactly
 * nine places, verified against `agent-coordinator.ts`:
 *   on / removeAllListeners  ("message" | "close" | "error" | "pong")
 *   send · readyState · OPEN · close · terminate · ping
 * That is why this file is 200 lines instead of a `ws` reimplementation. If the
 * coordinator ever reaches for something else, the cast in `asWebSocket` is
 * where it will surface — deliberately one place.
 *
 * AUTO-PONG. The coordinator health-checks the socket on a timer and
 * `terminate()`s it after one missed pong (`startPingTimer`). A dumb fake would
 * therefore be killed mid-run, so `ping()` answers immediately. That is the one
 * behaviour here that models the BROWSER rather than the protocol.
 */

import type { ClientMessage } from "../dual-agent/live-relay.js";

/** Anything the server sends down. Parsed from the wire, never re-typed here —
 *  the union lives with the relay and the harness reads it structurally. */
export interface OutboundMessage {
  type: string;
  [k: string]: unknown;
}

type SocketEvent = "message" | "close" | "error" | "pong";
type Listener = (...args: unknown[]) => void;

/** ws readyState constants — the only two this fake ever occupies. */
const OPEN = 1;
const CLOSED = 3;

export interface WaitOptions {
  /** Give up after this long. Default 10s — long enough for a real agent turn,
   *  short enough that a hung test fails instead of hanging a suite. */
  timeoutMs?: number;
  /** Search messages already received before waiting. Default true: a reply
   *  can easily land before the caller gets round to asking for it. */
  includeExisting?: boolean;
}

export class HeadlessSocket {
  /** Every message the server has sent, in order, parsed. */
  readonly outbox: OutboundMessage[] = [];
  /** Every message the driver has sent up, in order — the press log. */
  readonly inbox: ClientMessage[] = [];

  readonly OPEN = OPEN;
  readyState: number = OPEN;

  private readonly listeners = new Map<SocketEvent, Set<Listener>>();
  /** Resolvers parked by `waitFor`, checked against each new outbound message. */
  private readonly waiters = new Set<(m: OutboundMessage) => void>();
  /** Set when the coordinator closes or terminates us — a run should stop. */
  private closedReason: string | null = null;

  // ── The surface the coordinator consumes ────────────────────────────────

  on(event: SocketEvent, fn: Listener): this {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(fn);
    return this;
  }

  removeAllListeners(event?: SocketEvent): this {
    if (event) this.listeners.delete(event);
    else this.listeners.clear();
    return this;
  }

  /** The server speaking. Malformed JSON is recorded rather than thrown — a
   *  server that sends garbage is a finding, not a crash. */
  send(data: unknown): void {
    let parsed: OutboundMessage;
    try {
      parsed = JSON.parse(String(data)) as OutboundMessage;
    } catch {
      parsed = { type: "__unparseable__", raw: String(data) };
    }
    this.outbox.push(parsed);
    for (const w of [...this.waiters]) w(parsed);
  }

  close(): void {
    this.shutdown("closed by server");
  }

  terminate(): void {
    this.shutdown("terminated by server");
  }

  /** Answer immediately — see AUTO-PONG in the header. */
  ping(): void {
    if (this.readyState !== OPEN) return;
    this.emit("pong");
  }

  /**
   * The coordinator's parameter is `ws.WebSocket`, and this implements only the
   * nine members it actually uses. The cast is quarantined here so the gap is
   * one auditable line rather than sprinkled through the harness.
   */
  asWebSocket(): any {
    return this as unknown as any;
  }

  // ── The driver side ─────────────────────────────────────────────────────

  /** Send a message UP, exactly as the real client would. */
  deliver(msg: ClientMessage): void {
    if (this.readyState !== OPEN) {
      throw new Error(`[HeadlessSocket] cannot deliver ${msg.type}: socket ${this.closedReason}`);
    }
    this.inbox.push(msg);
    this.emit("message", JSON.stringify(msg));
  }

  /** Why the socket is no longer open, or null while it is. */
  get closed(): string | null {
    return this.closedReason;
  }

  /**
   * Resolve on the first outbound message matching `match`.
   *
   * Rejects on timeout rather than resolving null: a harness that silently
   * proceeds past a reply that never came reports a clean run for a broken
   * session, which is the failure mode the whole rig exists to catch.
   */
  waitFor(
    match: (m: OutboundMessage) => boolean,
    opts: WaitOptions = {},
  ): Promise<OutboundMessage> {
    const { timeoutMs = 10_000, includeExisting = true } = opts;

    if (includeExisting) {
      const already = this.outbox.find(match);
      if (already) return Promise.resolve(already);
    }

    return new Promise<OutboundMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        const seen = this.outbox.map((m) => m.type).join(", ") || "(nothing)";
        reject(new Error(`[HeadlessSocket] timed out after ${timeoutMs}ms. Saw: ${seen}`));
      }, timeoutMs);

      const waiter = (m: OutboundMessage) => {
        if (!match(m)) return;
        clearTimeout(timer);
        this.waiters.delete(waiter);
        resolve(m);
      };
      this.waiters.add(waiter);
    });
  }

  /** Convenience for the common case. */
  waitForType(type: string, opts?: WaitOptions): Promise<OutboundMessage> {
    return this.waitFor((m) => m.type === type, opts);
  }

  /** Every outbound message of a type, oldest first. */
  allOfType(type: string): OutboundMessage[] {
    return this.outbox.filter((m) => m.type === type);
  }

  /** Drop the recorded history, keeping the socket open. Lets a scenario
   *  measure one turn without the startup traffic in the way. */
  clearOutbox(): void {
    this.outbox.length = 0;
  }

  // ── internals ───────────────────────────────────────────────────────────

  private shutdown(reason: string): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.closedReason = reason;
    this.emit("close", 1000, Buffer.from(reason));
    // Anything still waiting will now never be answered; let it time out with
    // its own message rather than inventing a resolution here.
  }

  private emit(event: SocketEvent, ...args: unknown[]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(...args);
      } catch (err) {
        console.error(`[HeadlessSocket] listener for "${event}" threw:`, err);
      }
    }
  }
}
