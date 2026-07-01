// Headless tests for the NPC system: the spec/schema additions, the engine hooks
// that let a host own extra avatars (addLocalAvatar / steerAvatar), the steering
// controller's three behaviors, and the world-host actually spawning + advancing +
// broadcasting NPCs. No DOM, no LLM — the body layer is pure and deterministic.

import { describe, it, expect } from "@jest/globals";
import {
  addLocalAvatar,
  certifyWorldSpec,
  collectOutbound,
  createWorldState,
  smoothRemoteAvatars,
  steerAvatar,
  validateWorldSpec,
  type AvatarState,
  type WorldNetMessage,
  type WorldSpec,
} from "@shared/world-engine/index.js";
import { socialFieldNpcsSpec, socialFieldSpec } from "@shared/world-engine/specs/index.js";
import { createNpcController } from "@shared/world-engine/npc-controller.js";
import type { NpcProximity } from "@shared/world-engine/npc-controller.js";
import { runWorldHost } from "@shared/world-engine/world-host.js";
import type { WorldView } from "@shared/world-engine/world-view.js";

const DT = 1 / 60;

/** Tiny deterministic LCG so wander/jitter is repeatable across runs. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function makeAvatar(id: string, x: number, y: number): AvatarState {
  return { id, x, y, fx: 1, fy: 0, vx: 0, vy: 0 };
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe("NPC schema", () => {
  it("certifies a spec carrying NPCs (the demo field)", () => {
    const res = certifyWorldSpec(socialFieldNpcsSpec);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.spec.npcs?.length).toBe(2);
  });

  it("keeps NPCs optional (back-compat: the plain field still certifies)", () => {
    const res = certifyWorldSpec(socialFieldSpec);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.spec.npcs).toBeUndefined();
  });

  it("rejects duplicate NPC ids", () => {
    const spec = {
      ...socialFieldNpcsSpec,
      npcs: [
        { id: "dup", x: 10, y: 10, behavior: { movement: "wander" } },
        { id: "dup", x: 20, y: 20, behavior: { movement: "wander" } },
      ],
    };
    const res = validateWorldSpec(spec);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(" ")).toMatch(/duplicate npc id/);
  });

  it("rejects an NPC id that collides with a toy id", () => {
    const spec = {
      ...socialFieldNpcsSpec,
      npcs: [{ id: "ball", x: 10, y: 10, behavior: { movement: "wander" } }],
    };
    const res = validateWorldSpec(spec);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(" ")).toMatch(/collides with a toy id/);
  });

  it("rejects an out-of-bounds NPC", () => {
    const spec = {
      ...socialFieldNpcsSpec,
      npcs: [{ id: "stray", x: 999, y: 10, behavior: { movement: "wander" } }],
    };
    const res = validateWorldSpec(spec);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(" ")).toMatch(/outside the manifold/);
  });

  it("rejects an unknown movement behavior", () => {
    const spec = {
      ...socialFieldNpcsSpec,
      npcs: [{ id: "weird", x: 10, y: 10, behavior: { movement: "teleport" } }],
    };
    expect(validateWorldSpec(spec).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Engine hooks
// ---------------------------------------------------------------------------

describe("engine NPC hooks", () => {
  it("addLocalAvatar adds an owned (un-smoothed) avatar", () => {
    const state = createWorldState(socialFieldSpec, "you");
    const npc = addLocalAvatar(state, "npc_a", 12, 34, Math.PI);
    expect(state.avatars["npc_a"]).toBe(npc);
    // No smoothing target → smoothRemoteAvatars must leave it alone.
    expect(npc.tx).toBeUndefined();
    const before = { x: npc.x, y: npc.y };
    smoothRemoteAvatars(state, DT);
    expect(npc.x).toBe(before.x);
    expect(npc.y).toBe(before.y);
  });

  it("steerAvatar walks an owned avatar toward its aim", () => {
    const state = createWorldState(socialFieldSpec, "you");
    addLocalAvatar(state, "npc_a", 10, 10);
    const start = dist(state.avatars["npc_a"], { x: 30, y: 10 });
    for (let i = 0; i < 60; i++) steerAvatar(state, "npc_a", { x: 30, y: 10 }, DT);
    expect(dist(state.avatars["npc_a"], { x: 30, y: 10 })).toBeLessThan(start);
  });

  it("steerAvatar no-ops for an unknown id", () => {
    const state = createWorldState(socialFieldSpec, "you");
    expect(() => steerAvatar(state, "ghost", { x: 0, y: 0 }, DT)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Controller behaviors
// ---------------------------------------------------------------------------

describe("NpcController", () => {
  const ctx = (self: AvatarState, humans: AvatarState[], now = 0) => ({
    self,
    humans,
    now,
    width: 80,
    height: 60,
    rng: makeRng(7),
  });

  it("stationary turns to face the nearest person without travelling there", () => {
    const ctrl = createNpcController({ id: "s", x: 40, y: 30, behavior: { movement: "stationary" } });
    const self = makeAvatar("s", 40, 30);
    const aim = ctrl.computeAim(ctx(self, [makeAvatar("you", 60, 30)]))!;
    expect(aim).not.toBeNull();
    // The face-aim sits just off the NPC (well inside any travel distance) and on
    // the line toward the person (+x here).
    expect(dist(aim, self)).toBeLessThan(1);
    expect(aim.x).toBeGreaterThan(self.x);
  });

  it("stationary rests (null aim) when nobody is around", () => {
    const ctrl = createNpcController({ id: "s", x: 40, y: 30, behavior: { movement: "stationary" } });
    expect(ctrl.computeAim(ctx(makeAvatar("s", 40, 30), []))).toBeNull();
  });

  it("wander only ever targets in-bounds waypoints", () => {
    const ctrl = createNpcController({ id: "w", x: 40, y: 30, behavior: { movement: "wander" } });
    const self = makeAvatar("w", 40, 30);
    for (let t = 0; t < 50; t++) {
      const aim = ctrl.computeAim(ctx(self, [], t));
      if (aim) {
        expect(aim.x).toBeGreaterThanOrEqual(0);
        expect(aim.x).toBeLessThanOrEqual(80);
        expect(aim.y).toBeGreaterThanOrEqual(0);
        expect(aim.y).toBeLessThanOrEqual(60);
      }
    }
  });

  it("approach_nearest converges to a conversational distance and holds", () => {
    const spec = { id: "a", x: 56, y: 42, behavior: { movement: "approach_nearest" as const, conversationRadius: 8 } };
    const ctrl = createNpcController(spec);
    const state = createWorldState(socialFieldSpec, "you"); // "you" parks at a spawn
    const you = state.avatars["you"];
    const npc = addLocalAvatar(state, "a", 56, 42);
    const rng = makeRng(3);

    const startD = dist(npc, you);
    for (let i = 0; i < 400; i++) {
      state.time += DT;
      const aim = ctrl.computeAim({ self: npc, humans: [you], now: state.time, width: 80, height: 60, rng });
      steerAvatar(state, "a", aim, DT);
    }
    const endD = dist(npc, you);
    expect(endD).toBeLessThan(startD); // closed the gap
    expect(endD).toBeLessThanOrEqual(8); // within the conversation radius
    expect(endD).toBeGreaterThan(1); // didn't pile onto the player

    // Hold: another second of steering keeps it parked near the player.
    for (let i = 0; i < 60; i++) {
      state.time += DT;
      const aim = ctrl.computeAim({ self: npc, humans: [you], now: state.time, width: 80, height: 60, rng });
      steerAvatar(state, "a", aim, DT);
    }
    expect(dist(npc, you)).toBeLessThanOrEqual(8);
  });

  it("engagement pull tightens the hold distance", () => {
    const mk = () => createNpcController({ id: "a", x: 0, y: 0, behavior: { movement: "approach_nearest", conversationRadius: 10 } });
    const self = makeAvatar("a", 0, 0);
    const human = makeAvatar("you", 5, 0); // in range
    const drawnIn = mk();
    drawnIn.setEngagement({ partnerId: "you", pull: 1 });
    const withdrawn = mk();
    withdrawn.setEngagement({ partnerId: "you", pull: -1 });
    // Drawn-in wants to stand closer to the human than withdrawn does: its target
    // point sits nearer the person (smaller hold ring).
    const aimIn = drawnIn.computeAim({ self, humans: [human], now: 0, width: 80, height: 60, rng: makeRng(1) })!;
    const aimOut = withdrawn.computeAim({ self, humans: [human], now: 0, width: 80, height: 60, rng: makeRng(1) })!;
    expect(dist(aimIn, human)).toBeLessThan(dist(aimOut, human));
  });
});

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

describe("collectOutbound with owned NPCs", () => {
  it("broadcasts each owned NPC avatar alongside the local one", () => {
    const state = createWorldState(socialFieldSpec, "you");
    addLocalAvatar(state, "npc_a", 10, 10);
    addLocalAvatar(state, "npc_b", 20, 20);
    const msgs = collectOutbound(state, [], ["you", "npc_a", "npc_b"]);
    const avatarIds = msgs.filter((m): m is Extract<WorldNetMessage, { t: "avatar" }> => m.t === "avatar").map((m) => m.id);
    expect(avatarIds).toEqual(expect.arrayContaining(["you", "npc_a", "npc_b"]));
  });

  it("defaults to just the local avatar (no NPCs leak without ownership)", () => {
    const state = createWorldState(socialFieldSpec, "you");
    addLocalAvatar(state, "npc_a", 10, 10);
    const ids = collectOutbound(state, []).filter((m) => m.t === "avatar").map((m) => (m as { id: string }).id);
    expect(ids).toEqual(["you"]);
  });
});

// ---------------------------------------------------------------------------
// World host
// ---------------------------------------------------------------------------

/** A no-op view: the host's loop never needs real drawing or a real camera here. */
function fakeView(): WorldView {
  return {
    screenToWorld: () => null,
    render: () => undefined,
    resize: () => undefined,
    dispose: () => undefined,
  };
}

describe("runWorldHost NPC hosting", () => {
  /** Drive the host's manual clock + scheduled callback for `steps` frames. */
  function build(hostNpcs: boolean) {
    let pending: ((nowMs: number) => void) | null = null;
    let clock = 0;
    const sent: WorldNetMessage[][] = [];
    const host = runWorldHost({
      view: fakeView(),
      spec: socialFieldNpcsSpec,
      localId: "you",
      spawnIndex: 0,
      hostNpcs,
      npcRng: makeRng(11),
      net: { send: (m) => sent.push(m) },
      scheduleFrame: (cb) => {
        pending = cb;
        return () => { pending = null; };
      },
      now: () => clock,
    });
    host.start();
    const step = (frames: number) => {
      for (let i = 0; i < frames; i++) {
        clock += 16;
        pending?.(clock);
      }
    };
    return { host, sent, step };
  }

  it("spawns, advances, and broadcasts hosted NPCs", () => {
    const { host, sent, step } = build(true);
    // Spawned into state at their spec positions.
    expect(host.state.avatars["npc_maya"]).toBeDefined();
    expect(host.state.avatars["npc_theo"]).toBeDefined();
    const theoStart = { ...host.state.avatars["npc_theo"] };

    step(240); // ~3.8s

    // Theo (approach_nearest) walked toward the parked local player.
    const you = host.state.avatars["you"];
    const theoEnd = host.state.avatars["npc_theo"];
    expect(dist(theoEnd, you)).toBeLessThan(dist(theoStart, you));
    // Maya (wander) left her spawn.
    expect(dist(host.state.avatars["npc_maya"], { x: 24, y: 18 })).toBeGreaterThan(1);

    // The NPCs rode the outbound avatar stream.
    const broadcastIds = new Set(sent.flat().filter((m) => m.t === "avatar").map((m) => (m as { id: string }).id));
    expect(broadcastIds.has("npc_theo")).toBe(true);
    expect(broadcastIds.has("npc_maya")).toBe(true);
    host.stop();
  });

  it("hosts no NPCs when hostNpcs is false", () => {
    const { host, sent, step } = build(false);
    expect(host.state.avatars["npc_maya"]).toBeUndefined();
    step(60);
    const broadcastIds = new Set(sent.flat().filter((m) => m.t === "avatar").map((m) => (m as { id: string }).id));
    expect(broadcastIds.has("npc_maya")).toBe(false);
    expect(broadcastIds.has("you")).toBe(true);
    host.stop();
  });
});

// ---------------------------------------------------------------------------
// World host — Phase 2 brain hooks (proximity + engagement)
// ---------------------------------------------------------------------------

describe("runWorldHost NPC brain hooks", () => {
  function build(engagement?: { npcId: string; pull: number }) {
    let pending: ((nowMs: number) => void) | null = null;
    let clock = 0;
    const prox: NpcProximity[][] = [];
    const host = runWorldHost({
      view: fakeView(),
      spec: socialFieldNpcsSpec,
      localId: "you",
      spawnIndex: 0,
      hostNpcs: true,
      npcRng: makeRng(5),
      onNpcProximity: (nearby) => prox.push(nearby),
      net: { send: () => undefined },
      scheduleFrame: (cb) => { pending = cb; return () => { pending = null; }; },
      now: () => clock,
    });
    if (engagement) host.setNpcEngagement(engagement.npcId, { partnerId: null, pull: engagement.pull });
    host.start();
    const step = (frames: number) => {
      for (let i = 0; i < frames; i++) { clock += 16; pending?.(clock); }
    };
    return { host, prox, step };
  }

  it("emits proximity when the player enters and leaves an NPC's circle", () => {
    const { host, prox, step } = build();
    // Park the player right on Maya (well inside her 8-unit circle).
    host.state.avatars["you"].x = 24;
    host.state.avatars["you"].y = 18;
    step(2);
    expect(prox.length).toBeGreaterThan(0);
    expect(prox[prox.length - 1].some((n) => n.npcId === "npc_maya")).toBe(true);

    // Move the player far from Maya — a couple of frames isn't enough for the
    // approaching Theo to reach the player, so the set goes empty.
    host.state.avatars["you"].x = 40;
    host.state.avatars["you"].y = 4;
    step(2);
    expect(prox[prox.length - 1]).toEqual([]);
    host.stop();
  });

  it("setNpcEngagement biases an NPC's hold distance (withdrawn stands farther)", () => {
    const settle = (pull: number): number => {
      const { host, step } = build({ npcId: "npc_theo", pull });
      step(360); // ~5.8s — Theo walks to his (engagement-biased) hold ring
      const d = dist(host.state.avatars["npc_theo"], host.state.avatars["you"]);
      host.stop();
      return d;
    };
    const withdrawn = settle(-1); // wider hold (~5.6)
    const drawnIn = settle(1); // tighter hold (~2.4)
    expect(withdrawn).toBeGreaterThan(drawnIn + 1);
  });

  it("setNpcEngagement is a no-op for an unknown id", () => {
    const { host, step } = build();
    expect(() => host.setNpcEngagement("nobody", { partnerId: null, pull: 1 })).not.toThrow();
    step(5);
    host.stop();
  });

  it("emits proximity on a NON-owner from received NPC positions (no local hosting)", () => {
    // A peer that does NOT host the NPCs still gets their positions over the net and
    // must be able to tell its player is standing next to one (for the dock).
    let pending: ((nowMs: number) => void) | null = null;
    let clock = 0;
    const prox: NpcProximity[][] = [];
    const host = runWorldHost({
      view: fakeView(),
      spec: socialFieldNpcsSpec,
      localId: "you",
      spawnIndex: 0,
      hostNpcs: false,
      onNpcProximity: (nearby) => prox.push(nearby),
      net: { send: () => undefined },
      scheduleFrame: (cb) => { pending = cb; return () => { pending = null; }; },
      now: () => clock,
    });
    host.start();
    expect(host.state.avatars["npc_theo"]).toBeUndefined(); // not hosted here
    host.state.avatars["you"].x = 40;
    host.state.avatars["you"].y = 30;
    host.applyNetInbound([{ t: "avatar", id: "npc_theo", x: 41, y: 30, fx: 1, fy: 0, vx: 0, vy: 0 }]);
    for (let i = 0; i < 3; i++) { clock += 16; pending?.(clock); }
    expect(prox[prox.length - 1]?.some((n) => n.npcId === "npc_theo")).toBe(true);
    host.stop();
  });
});
