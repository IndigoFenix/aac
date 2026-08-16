// SPARK WIRE (attached-avatar Phase 1 prep) — the loose-mesh `spark` message
// (net.ts): a peer's own spark position, chart-local, ~10 Hz, latest-wins,
// tracked in WorldState.peerSparks and TOLERANT of malformed payloads and
// unknown message kinds (peers run vendored engine snapshots of different
// ages) — same discipline as the `claim` message it sits beside.
//
// DB-free / GL-free — runs in `npm run test:engine`.

import { describe, it, expect } from "@jest/globals";
import { createWorldState } from "@shared/world-engine/engine.js";
import { applyInbound, sparkMessage, type WorldNetMessage } from "@shared/world-engine/net.js";
import type { WorldSpec } from "@shared/world-engine/types.js";

const spec: WorldSpec = {
  engine: "world",
  engineVersion: 1,
  meta: { title: "t", locale: "en", theme: "t" },
  manifold: { kind: "flat", width: 40, height: 40 },
  terrain: { kind: "flat" },
  spawns: [{ id: "s", x: 5, y: 5 }],
  objects: [],
  multiplayer: { maxPlayers: 4, authority: "distributed" },
  content: { kind: "sandbox" },
};

describe("spark messages — a peer's own spark position on the wire", () => {
  it("sparkMessage builds the exact wire shape", () => {
    expect(sparkMessage("peer-a", 3, -4.5)).toEqual({ t: "spark", id: "peer-a", x: 3, y: -4.5 });
  });

  it("peerSparks starts undefined and is lazily created on the first message", () => {
    const state = createWorldState(spec, "me");
    expect(state.peerSparks).toBeUndefined();

    applyInbound(state, sparkMessage("peer-a", 1, 2));
    expect(state.peerSparks).toEqual({ "peer-a": { x: 1, y: 2 } });
  });

  it("records the latest position per peer; a second message overwrites (latest-wins)", () => {
    const state = createWorldState(spec, "me");
    applyInbound(state, sparkMessage("peer-a", 1, 2));
    applyInbound(state, sparkMessage("peer-b", 5, 6));
    expect(state.peerSparks).toEqual({ "peer-a": { x: 1, y: 2 }, "peer-b": { x: 5, y: 6 } });

    // Latest wins for that peer only; the other peer's row is untouched.
    applyInbound(state, sparkMessage("peer-a", 10, 20));
    expect(state.peerSparks).toEqual({ "peer-a": { x: 10, y: 20 }, "peer-b": { x: 5, y: 6 } });
  });

  it("drops a malformed spark (missing/NaN coords) rather than mutating state, and never throws", () => {
    const state = createWorldState(spec, "me");
    for (const bad of [
      { t: "spark", id: "peer-a" }, // no coords at all
      { t: "spark", id: "peer-a", x: 1 }, // no y
      { t: "spark", id: "peer-a", y: 1 }, // no x
      { t: "spark", id: "peer-a", x: "1", y: 2 }, // x not a number
      { t: "spark", id: "peer-a", x: 1, y: "2" }, // y not a number
      { t: "spark", id: "peer-a", x: NaN, y: 2 },
      { t: "spark", id: "peer-a", x: 1, y: NaN },
      { t: "spark", id: "peer-a", x: Infinity, y: 2 },
      { t: "spark", id: "", x: 1, y: 2 }, // no sender
      { t: "spark", x: 1, y: 2 }, // nobody sent it
    ]) {
      expect(() => applyInbound(state, bad as unknown as WorldNetMessage)).not.toThrow();
    }
    expect(state.peerSparks).toBeUndefined(); // nothing added, nothing corrupted
  });

  // VERSION-SKEW TOLERANCE, pinned: a peer running a newer engine snapshot may
  // send a kind this build has never heard of. applyInbound's switch falls
  // through to `default: break` — no crash, no partial state.
  it("a fully foreign message kind is silently ignored, never a throw", () => {
    const state = createWorldState(spec, "me");
    const before = JSON.stringify(state.avatars);
    const alien = { t: "no-such-kind", id: "peer-x", x: 1, y: 2 } as unknown as WorldNetMessage;
    expect(() => applyInbound(state, alien)).not.toThrow();
    expect(JSON.stringify(state.avatars)).toBe(before);
    expect(state.peerSparks).toBeUndefined();
  });
});
