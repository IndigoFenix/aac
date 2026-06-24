// shared/social-world/world-presence.ts
//
// The world MEMBERSHIP/POSITION relay payload + the client-side channel that
// feeds the circle solver.
//
// Phase 1 of "variable conversation circles" DECOUPLES where-everyone-is from the
// media mesh: avatar positions travel world-wide over a cheap SERVER RELAY (the
// call WS, command/event `call:world`) instead of riding peer connections. So a
// client knows the position of people it has NO media link to — the exact input
// the solver needs to decide who should be audible. High-frequency in-circle
// state (toys, possession) stays on the mesh "world" channel; only avatar
// presence moves here.
//
// See planning-docs/large-world-conversation-circles.md.

import type { WorldParticipant } from "./circle-solver.js";

/**
 * One participant's avatar state, broadcast over the relay (~6–8 Hz). It carries
 * exactly what a renderer needs to draw the avatar AND what the solver needs to
 * place it (it extends WorldParticipant). Lossy + latest-wins, like the mesh
 * avatar stream it replaces.
 */
export interface WorldPresence extends WorldParticipant {
  personId: string;
  x: number;
  y: number;
  /** Facing unit vector. */
  fx: number;
  fy: number;
  /** Velocity (world units/sec) for smoothing/extrapolation. */
  vx: number;
  vy: number;
}

interface Entry {
  presence: WorldPresence;
  at: number;
}

/**
 * How long a participant's last position is honored before it's pruned (ms). A
 * client that stops publishing (closed tab, lost focus, crashed) drops out of the
 * world rather than freezing in place forever.
 */
export const PRESENCE_STALE_MS = 5_000;

/**
 * Latest-wins store of every known participant position, fed by inbound relay
 * events. Pure data; the clock is a parameter so it stays deterministic in tests.
 */
export class WorldPresenceStore {
  private entries = new Map<string, Entry>();

  /** Record (or replace) a participant's position. */
  apply(presence: WorldPresence, now: number = Date.now()): void {
    this.entries.set(presence.personId, { presence, at: now });
  }

  /** Drop a participant immediately (explicit leave). */
  remove(personId: string): void {
    this.entries.delete(personId);
  }

  /** Forget everyone (game/call teardown). */
  clear(): void {
    this.entries.clear();
  }

  /** Evict entries older than `staleMs`. Returns the pruned ids. */
  prune(now: number = Date.now(), staleMs: number = PRESENCE_STALE_MS): string[] {
    const dropped: string[] = [];
    for (const [id, e] of this.entries) {
      if (now - e.at > staleMs) {
        this.entries.delete(id);
        dropped.push(id);
      }
    }
    return dropped;
  }

  get(personId: string): WorldPresence | undefined {
    return this.entries.get(personId)?.presence;
  }

  /** Snapshot of all current positions (the solver's participant list). */
  all(): WorldPresence[] {
    return Array.from(this.entries.values(), (e) => e.presence);
  }
}

/**
 * Event-driven wrapper around a WorldPresenceStore, mirroring CallWorldHub: the
 * call context feeds inbound relay events in via `receive`/`leave`/`prune`, and
 * the mounted canvas subscribes to apply them to its engine state (one applied
 * presence per remote message, matching the mesh's per-message contract). The
 * store underneath stays queryable for the solver.
 */
export class WorldPresenceChannel {
  private store = new WorldPresenceStore();
  private onPresence = new Set<(p: WorldPresence) => void>();
  private onLeave = new Set<(personId: string) => void>();

  /** Inbound remote presence from the relay. */
  receive(presence: WorldPresence, now: number = Date.now()): void {
    this.store.apply(presence, now);
    for (const h of this.onPresence) h(presence);
  }

  /** A participant explicitly left (call peer-left). */
  leave(personId: string): void {
    this.store.remove(personId);
    for (const h of this.onLeave) h(personId);
  }

  /** Evict participants who stopped publishing; emits a leave for each. Call on
   *  a low-frequency interval. */
  prune(now: number = Date.now()): void {
    for (const id of this.store.prune(now)) {
      for (const h of this.onLeave) h(id);
    }
  }

  /** Forget everyone, emitting a leave for each (game/call teardown). */
  clear(): void {
    const ids = this.store.all().map((p) => p.personId);
    this.store.clear();
    for (const id of ids) {
      for (const h of this.onLeave) h(id);
    }
  }

  subscribePresence(handler: (p: WorldPresence) => void): () => void {
    this.onPresence.add(handler);
    return () => this.onPresence.delete(handler);
  }

  subscribeLeave(handler: (personId: string) => void): () => void {
    this.onLeave.add(handler);
    return () => this.onLeave.delete(handler);
  }

  /** Everyone we currently know about — the solver's participant list (includes
   *  self once the local client records its own published presence). */
  participants(): WorldPresence[] {
    return this.store.all();
  }

  get(personId: string): WorldPresence | undefined {
    return this.store.get(personId);
  }
}
