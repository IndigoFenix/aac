// OWNER-AUTHORITATIVE MULTIPLAYER — the world-host half (world-host.ts):
//
//   • the OWNER (hostNpcs) streams its avatar AND every NPC body it hosts;
//   • a FOLLOWER (replicaNpcs) spawns the same cast as controller-less
//     REPLICA bodies, streams ONLY its own spark, never advances an NPC
//     locally, and lets the owner's ordinary avatar packets drive them
//     (applyRemoteAvatar + smoothRemoteAvatars);
//   • single-player (no net) is byte-identical to before: same spawns, same
//     controllers, and the networking block never runs.
//
// Drives the REAL runWorldHost over a mock view — DB-free / GL-free, runs in
// `npm run test:engine` (same harness as claimed-body-girth.test.ts).

import { describe, it, expect } from "@jest/globals";
import { runWorldHost, type WorldHostDeps } from "@shared/world-engine/world-host.js";
import type { WorldView } from "@shared/world-engine/world-view.js";
import { claimMessage, type WorldNetMessage } from "@shared/world-engine/net.js";
import type { NpcSpec, WorldSpec } from "@shared/world-engine/types.js";

function mockView(): WorldView {
  return { screenToWorld: (px, py) => ({ x: px, y: py }), render: () => {}, resize: () => {}, dispose: () => {} };
}

const walker: NpcSpec = {
  id: "npc_walker",
  x: 20,
  y: 20,
  name: "Walker",
  behavior: { movement: "wander", wanderRadius: 4, home: { x: 20, y: 20 }, conversationRadius: 3 },
};

const spec: WorldSpec = {
  engine: "world",
  engineVersion: 1,
  meta: { title: "t", locale: "en", theme: "t" },
  manifold: { kind: "flat", width: 40, height: 40 },
  terrain: { kind: "flat" },
  spawns: [{ id: "s", x: 5, y: 5, facing: 0 }],
  objects: [],
  npcs: [walker],
  multiplayer: { maxPlayers: 4, authority: "distributed" },
  content: { kind: "sandbox" },
};

/** Boot a host on a manual clock; `run(frames)` advances 40 ms frames. */
function boot(over: Partial<WorldHostDeps> = {}) {
  const sent: WorldNetMessage[][] = [];
  let frameCb: ((now: number) => void) | null = null;
  let now = 0;
  const host = runWorldHost({
    view: mockView(),
    spec,
    localId: "me",
    spawnIndex: 0,
    scheduleFrame: (cb) => {
      frameCb = cb;
      return () => {};
    },
    now: () => now,
    ...over,
  });
  host.start();
  const run = (frames: number) => {
    for (let i = 0; i < frames; i++) {
      now += 40;
      frameCb?.(now);
    }
  };
  return { host, sent, run, net: { send: (msgs: WorldNetMessage[]) => sent.push(msgs) } };
}

describe("owner — hosts and streams the whole cast", () => {
  it("streams its own avatar AND every hosted NPC body", () => {
    const sent: WorldNetMessage[][] = [];
    const { host, run } = boot({ hostNpcs: true, net: { send: (m) => sent.push(m) } });
    run(6); // past the ~15 Hz send interval several times
    const avatarIds = new Set(
      sent.flat().filter((m) => m.t === "avatar").map((m) => (m as { id: string }).id),
    );
    expect(avatarIds.has("me")).toBe(true);
    expect(avatarIds.has("npc_walker")).toBe(true);
    expect(host.state.avatars["npc_walker"]).toBeDefined();
    host.stop();
  });
});

describe("follower — replica bodies, own spark only on the wire", () => {
  it("spawns the deterministic cast but streams ONLY its own spark", () => {
    const sent: WorldNetMessage[][] = [];
    const { host, run } = boot({ replicaNpcs: true, net: { send: (m) => sent.push(m) } });
    // The cast SPAWNED locally (correct bodies/models on this peer)…
    expect(host.state.avatars["npc_walker"]).toBeDefined();
    run(6);
    // …but never rides this peer's outbound stream.
    const avatarIds = new Set(
      sent.flat().filter((m) => m.t === "avatar").map((m) => (m as { id: string }).id),
    );
    expect(avatarIds.has("me")).toBe(true);
    expect(avatarIds.has("npc_walker")).toBe(false);
    host.stop();
  });

  it("never advances a replica locally; the owner's avatar packets drive it", () => {
    const { host, run } = boot({ replicaNpcs: true, net: { send: () => {} } });
    const before = { ...host.state.avatars["npc_walker"]! };
    run(25); // a second of frames with no inbound
    // No controller → the body stands exactly where it spawned.
    expect(host.state.avatars["npc_walker"]!.x).toBe(before.x);
    expect(host.state.avatars["npc_walker"]!.y).toBe(before.y);

    // An owner packet moves it (applyRemoteAvatar target + smoothing glide).
    host.applyNetInbound([
      { t: "avatar", id: "npc_walker", x: 24, y: 20, fx: 1, fy: 0, vx: 0, vy: 0 },
    ]);
    run(50); // let the ease converge
    expect(host.state.avatars["npc_walker"]!.x).toBeGreaterThan(22);
    host.stop();
  });

  it("runtime addNpc still spawns (the streamer's seam) — as a replica, not a broadcast", () => {
    const sent: WorldNetMessage[][] = [];
    const { host, run } = boot({ replicaNpcs: true, net: { send: (m) => sent.push(m) } });
    expect(
      host.addNpc({
        id: "resident_9_0",
        x: 10,
        y: 10,
        name: "R",
        behavior: { movement: "wander", wanderRadius: 2, home: { x: 10, y: 10 }, conversationRadius: 3 },
      }),
    ).toBe(true);
    expect(host.state.avatars["resident_9_0"]).toBeDefined();
    run(6);
    const avatarIds = new Set(
      sent.flat().filter((m) => m.t === "avatar").map((m) => (m as { id: string }).id),
    );
    expect(avatarIds.has("resident_9_0")).toBe(false); // not ours to stream
    // Errand/engagement calls are safe no-ops on a controller-less replica.
    expect(() => host.setNpcErrand("resident_9_0", { points: [{ x: 1, y: 1 }] })).not.toThrow();
    expect(host.npcErrandActive("resident_9_0")).toBe(false);
    host.stop();
  });

  it("claim messages arriving over the mesh land in state.peerClaims", () => {
    const { host } = boot({ replicaNpcs: true, net: { send: () => {} } });
    host.applyNetInbound([claimMessage("peer-a", "npc_walker")]);
    expect(host.state.peerClaims).toEqual({ "peer-a": "npc_walker" });
    host.applyNetInbound([claimMessage("peer-a", null)]);
    expect(host.state.peerClaims).toEqual({});
    host.stop();
  });
});

describe("single-player — byte-identical without a net", () => {
  it("hosts the cast with controllers and runs without any networking", () => {
    const { host, run } = boot({ hostNpcs: true }); // no net at all
    expect(host.state.avatars["npc_walker"]).toBeDefined();
    const t0 = host.state.time;
    run(10);
    expect(host.state.time).toBeGreaterThan(t0); // the sim advanced
    // The hosted body is claimable exactly as before (possession path intact).
    expect(host.claimBody("npc_walker")).toBe(true);
    expect(host.drivenBody()).toBe("npc_walker");
    host.stop();
  });

  it("a follower flag alone never sneaks controllers in", () => {
    const { host, run } = boot({ replicaNpcs: true }); // netless follower (degenerate but legal)
    const before = { ...host.state.avatars["npc_walker"]! };
    run(25);
    expect(host.state.avatars["npc_walker"]!.x).toBe(before.x);
    host.stop();
  });
});
