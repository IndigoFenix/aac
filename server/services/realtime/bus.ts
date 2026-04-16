// Cross-instance fanout bus for realtime events.
//
// Local delivery happens in room-registry.ts. When the app runs on more than
// one instance, the bus carries notifications so each instance can deliver to
// its own locally-connected sockets.
//
// Payloads are intentionally ID-only (no message bodies, no PHI). Each
// instance rehydrates from the database before delivering to sockets. This
// keeps the bus out of the PHI-handling boundary.
//
// Implementations:
//   - InMemoryBus      — single-instance dev (no fanout needed)
//   - PostgresBus      — LISTEN/NOTIFY; current production choice
//   - RedisBus         — Redis pub/sub; switch to this when we outgrow pg
//
// See bus-factory.ts for selection via REALTIME_BUS env var.

import { randomUUID } from "crypto";

export interface FanoutBus {
  /** Unique per-process id. Used to skip our own echoes. */
  readonly instanceId: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  publish(channel: string, payload: string): Promise<void>;
  /** Register a single handler; replaces any previous handler. */
  onMessage(handler: (channel: string, payload: string) => void): void;
}

export class InMemoryBus implements FanoutBus {
  readonly instanceId = randomUUID();
  private handler: ((channel: string, payload: string) => void) | null = null;

  async start(): Promise<void> {
    // no-op
  }

  async stop(): Promise<void> {
    this.handler = null;
  }

  async publish(_channel: string, _payload: string): Promise<void> {
    // In single-instance mode, local delivery is already done by the caller;
    // there is no other instance to notify.
  }

  onMessage(handler: (channel: string, payload: string) => void): void {
    this.handler = handler;
  }
}
