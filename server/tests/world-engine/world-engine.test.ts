// Tests for the data-driven world engine (shared/world-engine).
// Pure-logic, no DB / no LLM — safe in the default `npm test` run.
//
// Exercises the two things Phase 0 must get right: the closed WorldSpec
// certification gate, and the deterministic soccer-ball possession-dribble
// (grab → dribble → kick/stop → free-roll to rest), the way the renderer +
// call-mesh transport will drive it.

import { describe, it, expect } from "@jest/globals";
import {
  certifyWorldSpec,
  createWorldState,
  tickWorld,
  applyRemoteAvatar,
  smoothRemoteAvatars,
  applyRemoteToy,
  applyPossession,
  WORLD_ENGINE_DEFAULTS,
  type WorldEngineConfig,
  type WorldEvent,
  type WorldState,
  type Vec2,
} from "@shared/world-engine/index.js";
import { socialFieldSpec } from "@shared/world-engine/specs/social-field.js";

const DT = 1 / 60;

/** Tick for `seconds` toward a fixed aim; returns every event emitted. */
function run(
  state: WorldState,
  aim: Vec2 | null,
  seconds: number,
  config: WorldEngineConfig = WORLD_ENGINE_DEFAULTS,
): WorldEvent[] {
  const events: WorldEvent[] = [];
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    events.push(...tickWorld(state, { aim }, DT, config).events);
  }
  return events;
}

/** Tick toward `aim` until `pred(state)` holds or we hit the time cap. */
function runUntil(
  state: WorldState,
  aim: Vec2 | null,
  pred: (s: WorldState) => boolean,
  capSeconds = 10,
): WorldEvent[] {
  const events: WorldEvent[] = [];
  const n = Math.round(capSeconds / DT);
  for (let i = 0; i < n; i++) {
    events.push(...tickWorld(state, { aim }, DT).events);
    if (pred(state)) break;
  }
  return events;
}

describe("WorldSpec certification", () => {
  it("certifies the shipped social-field spec", () => {
    const res = certifyWorldSpec(socialFieldSpec);
    expect(res.ok).toBe(true);
  });

  it("rejects unknown keys (closed schema)", () => {
    const res = certifyWorldSpec({ ...socialFieldSpec, sneaky: true });
    expect(res.ok).toBe(false);
  });

  it("rejects a toy placed outside the manifold", () => {
    const bad = {
      ...socialFieldSpec,
      toys: [{ ...socialFieldSpec.toys[0], x: 999 }],
    };
    const res = certifyWorldSpec(bad);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.join(" ")).toMatch(/outside the manifold/);
    }
  });

  it("rejects duplicate spawn ids", () => {
    const dup = socialFieldSpec.spawns[0];
    const res = certifyWorldSpec({
      ...socialFieldSpec,
      spawns: [dup, dup],
    });
    expect(res.ok).toBe(false);
  });

  it("rejects friction at the forbidden endpoints", () => {
    for (const friction of [0, 1]) {
      const res = certifyWorldSpec({
        ...socialFieldSpec,
        toys: [{ ...socialFieldSpec.toys[0], friction }],
      });
      expect(res.ok).toBe(false);
    }
  });
});

describe("avatar locomotion", () => {
  it("steers the local avatar toward the aim point", () => {
    const s = createWorldState(socialFieldSpec, "local", 2); // west spawn (x=28)
    const start = s.avatars.local.x;
    run(s, { x: 52, y: 30 }, 1);
    expect(s.avatars.local.x).toBeGreaterThan(start + 2);
    expect(Math.abs(s.avatars.local.y - 30)).toBeLessThan(0.5);
  });
});

describe("soccer-ball possession", () => {
  it("grabs the ball on touch and dribbles it ahead", () => {
    const s = createWorldState(socialFieldSpec, "local", 2);
    const events = runUntil(s, { x: 52, y: 30 }, (st) => st.toys.ball.possessedBy === "local");

    expect(s.toys.ball.possessedBy).toBe("local");
    expect(events.some((e) => e.type === "possession-request")).toBe(true);

    // Dribble a touch further and check the ball rides ahead along facing (+x).
    run(s, { x: 52, y: 30 }, 0.2);
    const a = s.avatars.local;
    const b = s.toys.ball;
    expect(b.possessedBy).toBe("local");
    expect(b.x - a.x).toBeGreaterThan(0.5); // carried ahead
    expect(Math.abs(b.y - a.y)).toBeLessThan(0.4);
  });

  it("kicks: a hard brake while moving releases the ball with forward speed", () => {
    const s = createWorldState(socialFieldSpec, "local", 2);
    runUntil(s, { x: 52, y: 30 }, (st) => st.toys.ball.possessedBy === "local");
    run(s, { x: 52, y: 30 }, 0.3); // reach full speed while dribbling

    // One hard-brake tick (aim=null) → kick.
    const events = tickWorld(s, { aim: null }, DT).events;
    expect(events.some((e) => e.type === "possession-released")).toBe(true);

    const b = s.toys.ball;
    expect(b.possessedBy).toBeNull();
    expect(b.freeRollOwner).toBe("local");
    expect(Math.hypot(b.vx, b.vy)).toBeGreaterThan(2); // kept real speed
    expect(b.vx).toBeGreaterThan(2); // moving +x (the kick direction)
  });

  it("free-rolls a kicked ball to rest via friction", () => {
    const s = createWorldState(socialFieldSpec, "local", 2);
    runUntil(s, { x: 52, y: 30 }, (st) => st.toys.ball.possessedBy === "local");
    run(s, { x: 52, y: 30 }, 0.3);
    tickWorld(s, { aim: null }, DT); // kick
    const releaseX = s.toys.ball.x;

    const events = run(s, null, 5); // coast to a stop
    expect(events.some((e) => e.type === "toy-rest")).toBe(true);
    const b = s.toys.ball;
    expect(Math.hypot(b.vx, b.vy)).toBe(0);
    expect(b.freeRollOwner).toBeNull();
    expect(b.x).toBeGreaterThan(releaseX); // it rolled forward
  });

  it("blocks the kicker from instantly re-grabbing (cooldown)", () => {
    const s = createWorldState(socialFieldSpec, "local", 2);
    runUntil(s, { x: 52, y: 30 }, (st) => st.toys.ball.possessedBy === "local");

    // Simulate the moment just after a kick: the local peer released the ball
    // and is on cooldown for it, while still moving (so the grab speed-gate is
    // satisfied — only the cooldown should hold it off).
    applyPossession(s, "ball", null, s.time);
    expect(s.toys.ball.lastPossessor).toBe("local");

    // Keep the avatar moving with the ball pinned under it. Mid-cooldown it
    // must NOT re-grab; once the cooldown lapses it grabs again.
    const pinAndTick = (seconds: number) => {
      const n = Math.round(seconds / DT);
      for (let i = 0; i < n; i++) {
        s.toys.ball.x = s.avatars.local.x;
        s.toys.ball.y = s.avatars.local.y;
        tickWorld(s, { aim: { x: 52, y: 30 } }, DT);
      }
    };

    pinAndTick(WORLD_ENGINE_DEFAULTS.grabCooldown - 0.1);
    expect(s.toys.ball.possessedBy).toBeNull(); // still on cooldown

    pinAndTick(0.2); // crosses the cooldown boundary
    expect(s.toys.ball.possessedBy).toBe("local");
  });
});

describe("remote avatar smoothing", () => {
  const DT = 1 / 60;

  it("snaps to the first packet, then EASES toward a later target (no jump)", () => {
    const s = createWorldState(socialFieldSpec, "me", 2);
    applyRemoteAvatar(s, { id: "p", x: 40, y: 30, fx: 1, fy: 0, vx: 0, vy: 0 });
    expect(s.avatars.p.x).toBe(40); // first sight snaps

    applyRemoteAvatar(s, { id: "p", x: 50, y: 30, fx: 1, fy: 0, vx: 0, vy: 0 });
    smoothRemoteAvatars(s, DT);
    expect(s.avatars.p.x).toBeGreaterThan(40);
    expect(s.avatars.p.x).toBeLessThan(50); // eased partway, not snapped

    for (let i = 0; i < 240; i++) smoothRemoteAvatars(s, DT);
    expect(s.avatars.p.x).toBeCloseTo(50, 1); // converges to the target
  });

  it("dead-reckons a moving avatar forward within a packet gap (no freeze)", () => {
    const s = createWorldState(socialFieldSpec, "me", 2);
    applyRemoteAvatar(s, { id: "p", x: 40, y: 30, fx: 1, fy: 0, vx: 4, vy: 0 });
    // No further packets: within a normal gap the display keeps gliding forward.
    for (let i = 0; i < 12; i++) smoothRemoteAvatars(s, DT); // 0.2s < maxExtrapSec
    expect(s.avatars.p.x).toBeGreaterThan(40.5);
    expect(s.avatars.p.vx).toBeGreaterThan(2);
  });

  it("freezes a stale peer instead of gliding away when packets stop", () => {
    const s = createWorldState(socialFieldSpec, "me", 2);
    applyRemoteAvatar(s, { id: "p", x: 40, y: 30, fx: 1, fy: 0, vx: 4, vy: 0 });
    for (let i = 0; i < 120; i++) smoothRemoteAvatars(s, DT); // 2s of no packets
    // It glided briefly then stopped (capped) — not 8 units downfield.
    expect(s.avatars.p.x).toBeLessThan(42);
  });

  it("never moves the local avatar (no target fields)", () => {
    const s = createWorldState(socialFieldSpec, "me", 2);
    const x0 = s.avatars.me.x;
    smoothRemoteAvatars(s, DT);
    expect(s.avatars.me.x).toBe(x0);
  });
});

describe("multiplayer authority", () => {
  it("applies a remote avatar but never moves the local one", () => {
    const s = createWorldState(socialFieldSpec, "local", 2);
    applyRemoteAvatar(s, { id: "peer", x: 10, y: 10, fx: 1, fy: 0, vx: 0, vy: 0 });
    expect(s.avatars.peer.x).toBe(10);

    // A spoofed remote update for our own id is ignored.
    applyRemoteAvatar(s, { id: "local", x: 999, y: 999, fx: 1, fy: 0, vx: 0, vy: 0 });
    expect(s.avatars.local.x).not.toBe(999);
  });

  it("ignores remote toy updates while we own the toy", () => {
    const s = createWorldState(socialFieldSpec, "local", 2);
    runUntil(s, { x: 52, y: 30 }, (st) => st.toys.ball.possessedBy === "local");
    const ownedX = s.toys.ball.x;
    applyRemoteToy(s, "ball", { x: -5, y: -5 });
    expect(s.toys.ball.x).toBe(ownedX); // our sim stays authoritative
  });
});
