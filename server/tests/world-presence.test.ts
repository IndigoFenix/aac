// Unit tests for the world-presence relay store + channel
// (shared/social-world/world-presence.ts). A deterministic clock is passed in so
// staleness pruning is testable without timers.

import { describe, it, expect } from "@jest/globals";
import {
  WorldPresenceStore,
  WorldPresenceChannel,
  PRESENCE_STALE_MS,
  type WorldPresence,
} from "@shared/social-world/world-presence.js";

const p = (personId: string, x = 0, y = 0): WorldPresence => ({ personId, x, y, fx: 1, fy: 0, vx: 0, vy: 0 });

describe("WorldPresenceStore", () => {
  it("applies, replaces (latest-wins), gets and lists", () => {
    const s = new WorldPresenceStore();
    s.apply(p("a", 1, 1), 1000);
    s.apply(p("b", 2, 2), 1000);
    s.apply(p("a", 9, 9), 1100); // replace a
    expect(s.get("a")).toMatchObject({ x: 9, y: 9 });
    expect(s.all().map((e) => e.personId).sort()).toEqual(["a", "b"]);
  });

  it("removes and clears", () => {
    const s = new WorldPresenceStore();
    s.apply(p("a"), 0);
    s.apply(p("b"), 0);
    s.remove("a");
    expect(s.get("a")).toBeUndefined();
    s.clear();
    expect(s.all()).toHaveLength(0);
  });

  it("prunes only entries older than the stale window", () => {
    const s = new WorldPresenceStore();
    s.apply(p("fresh"), 10_000);
    s.apply(p("stale"), 1_000);
    const now = 1_000 + PRESENCE_STALE_MS + 1; // stale is just past the window, fresh isn't
    const dropped = s.prune(now);
    expect(dropped).toEqual(["stale"]);
    expect(s.get("fresh")).toBeDefined();
    expect(s.get("stale")).toBeUndefined();
  });
});

describe("WorldPresenceChannel", () => {
  it("receive() updates the store and notifies presence subscribers", () => {
    const ch = new WorldPresenceChannel();
    const seen: string[] = [];
    ch.subscribePresence((pres) => seen.push(pres.personId));
    ch.receive(p("a", 5, 5), 0);
    expect(seen).toEqual(["a"]);
    expect(ch.get("a")).toMatchObject({ x: 5, y: 5 });
    expect(ch.participants().map((e) => e.personId)).toEqual(["a"]);
  });

  it("leave() removes and notifies leave subscribers", () => {
    const ch = new WorldPresenceChannel();
    const left: string[] = [];
    ch.subscribeLeave((id) => left.push(id));
    ch.receive(p("a"), 0);
    ch.leave("a");
    expect(left).toEqual(["a"]);
    expect(ch.get("a")).toBeUndefined();
  });

  it("prune() evicts stale participants and emits a leave for each", () => {
    const ch = new WorldPresenceChannel();
    const left: string[] = [];
    ch.subscribeLeave((id) => left.push(id));
    ch.receive(p("a"), 1_000);
    ch.receive(p("b"), 10_000);
    ch.prune(1_000 + PRESENCE_STALE_MS + 1);
    expect(left).toEqual(["a"]);
    expect(ch.participants().map((e) => e.personId)).toEqual(["b"]);
  });

  it("clear() drops everyone and emits a leave per participant", () => {
    const ch = new WorldPresenceChannel();
    const left: string[] = [];
    ch.subscribeLeave((id) => left.push(id));
    ch.receive(p("a"), 0);
    ch.receive(p("b"), 0);
    ch.clear();
    expect(left.sort()).toEqual(["a", "b"]);
    expect(ch.participants()).toHaveLength(0);
  });

  it("unsubscribe stops further notifications", () => {
    const ch = new WorldPresenceChannel();
    const seen: string[] = [];
    const unsub = ch.subscribePresence((pres) => seen.push(pres.personId));
    ch.receive(p("a"), 0);
    unsub();
    ch.receive(p("b"), 0);
    expect(seen).toEqual(["a"]);
  });
});
