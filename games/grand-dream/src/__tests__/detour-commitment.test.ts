/**
 * DETOUR COMMITMENT + WANDER CORRIDORS — the two steering fixes behind the
 * "spinning next to the table" and "gets stuck while aimlessly wandering" bugs.
 *
 * detourAim itself is a PURE function of (self, aim, walkable, radius, prefer),
 * so its side-commitment contract is fully testable here. What the host adds is
 * the MEMORY of `prefer` across frames; the host loop needs a live world, so the
 * memory policy is re-stated below as the same tiny state machine world-host
 * runs, and pinned against the geometry that used to flip.
 */
import { describe, it, expect } from "vitest";
import {
  detourAim, createNpcController, createDetourMemory, sideOfBend, DETOUR_HOLD_S,
} from "@shared/world-engine/npc-controller";
import type { AvatarState } from "@shared/world-engine/engine";

/** A solid box (the table): Chebyshev, exactly like engine.fixturesWalkable. */
const boxBlocker = (cx: number, cy: number, half: number) =>
  (p: { x: number; y: number }, radius: number) =>
    !(Math.abs(p.x - cx) < half + radius && Math.abs(p.y - cy) < half + radius);

const sideOf = sideOfBend;

describe("detourAim — the side contract world-host's memory relies on", () => {
  const walk = boxBlocker(0, 0, 1.2); // a table at the origin, body radius folded in by the caller

  it("leaves a clear aim untouched (=== so the caller can detect 'no bend')", () => {
    const self = { x: 0, y: -6 };
    const aim = { x: 0, y: -3 };
    expect(detourAim(self, aim, walk, 0.4, 1)).toBe(aim); // identity, not a copy
  });

  it("bends when the straight line crosses the table", () => {
    const self = { x: 0, y: -6 };
    const aim = { x: 0, y: 6 }; // straight through the box
    expect(detourAim(self, aim, walk, 0.4, 1)).not.toBe(aim);
  });

  it("HONOURS `prefer` — the same geometry bends to opposite shoulders", () => {
    // This is the property the memory depends on: if prefer were ignored, no
    // amount of remembering would stop the dither.
    const self = { x: 0, y: -6 };
    const aim = { x: 0, y: 6 };
    const plus = detourAim(self, aim, walk, 0.4, 1);
    const minus = detourAim(self, aim, walk, 0.4, -1);
    expect(sideOf(self, aim, plus)).toBe(1);
    expect(sideOf(self, aim, minus)).toBe(-1);
  });

  it("the recorded side round-trips: what the caller stores is what it fed in", () => {
    // world-host stores sign(cross(aim, bent)) and feeds it back as `prefer`.
    // If that round-trip were lossy the hold would commit to the WRONG shoulder.
    const self = { x: 0, y: -6 };
    const aim = { x: 0, y: 6 };
    for (const prefer of [1, -1] as const) {
      const bent = detourAim(self, aim, walk, 0.4, prefer);
      expect(sideOf(self, aim, bent)).toBe(prefer);
    }
  });

  it("REGRESSION: a committed shoulder BEATS a narrower gap on the fresh side", () => {
    // The surviving half of the table-spin bug: the old candidate loop probed
    // widths OUTERMOST, so whichever side cleared at the narrowest width won —
    // `prefer` only broke ties. Arcing around a table, the narrow side
    // alternates; each flip was then record()ed over the memory, and the body
    // dithered exactly as if there were no memory at all. The committed side
    // must be tried at EVERY width before the other side gets a look.
    //
    // Geometry: the table blocks the aim line; an extra crate crowds one
    // shoulder so it only clears WIDE (w=3.6) while the other clears NARROW
    // (w=2.4). Bent aims land on the sample row y=-1 (crate: |x+2|<1.6 there).
    const table = boxBlocker(0, 0, 1.2);
    const crate = boxBlocker(-2, 0, 1.2);
    const walkCrowded = (p: { x: number; y: number }, r: number) => table(p, r) && crate(p, r);
    const self = { x: 0, y: -6 };
    const aim = { x: 0, y: 6 };
    // detourAim's s=+1 offsets along perp(-1,0) → the crowded −x shoulder.
    const committed = detourAim(self, aim, walkCrowded, 0.4, 1);
    expect(committed).not.toBe(aim);
    expect(sideOf(self, aim, committed)).toBe(1); // stayed committed, went WIDE
    // The fresh side still resolves narrow when IT holds the commitment.
    const other = detourAim(self, aim, walkCrowded, 0.4, -1);
    expect(sideOf(self, aim, other)).toBe(-1);
  });
});

describe("createDetourMemory — expire, don't clear on a straight frame", () => {
  // THE fix, tested on the real shared implementation world-host now calls for
  // both its NPCs and the player (rather than a restatement of it).
  const A = "npc_a";

  it("a clear frame mid-maneuver does NOT reset the shoulder (the spin fix)", () => {
    const m = createDetourMemory();
    m.record(A, -1, 0); // committed to the LEFT shoulder at t=0
    // t=0.5: the straight line happens to read clear. The OLD code deleted the
    // memory right here, so the next blocked frame restarted at the +1 default
    // and could flip the body. The hold must survive those frames.
    expect(m.prefer(A, 0.5)).toBe(-1);
    expect(m.prefer(A, 1.9)).toBe(-1);
  });

  it("starts at +1 with nothing remembered", () => {
    expect(createDetourMemory().prefer(A, 0)).toBe(1);
  });

  it("lapses once the body has been genuinely free for the hold", () => {
    const m = createDetourMemory();
    m.record(A, -1, 0);
    expect(m.prefer(A, DETOUR_HOLD_S + 0.1)).toBe(1); // expired → fresh start
  });

  it("renewing on each bent frame carries one commitment through a long bypass", () => {
    const m = createDetourMemory();
    m.record(A, -1, 0);
    for (let t = 0.1; t <= 5; t += 0.1) {
      expect(m.prefer(A, t)).toBe(-1); // never flips…
      m.record(A, m.prefer(A, t), t); // …and each bent frame renews the hold
    }
  });

  it("keeps movers separate — one body's bypass can't steer another", () => {
    const m = createDetourMemory();
    m.record("npc_a", -1, 0);
    m.record("npc_b", 1, 0);
    expect(m.prefer("npc_a", 0.5)).toBe(-1);
    expect(m.prefer("npc_b", 0.5)).toBe(1);
  });

  it("forget() drops a mover that left the world", () => {
    const m = createDetourMemory();
    m.record(A, -1, 0);
    m.forget(A);
    expect(m.prefer(A, 0.5)).toBe(1);
  });

  it("REGRESSION: the old clear-on-straight policy flipped the shoulder", () => {
    // The bug shape, pinned so it can't quietly return. Old policy was
    //   bent → set(side);  straight → delete()  ⇒ prefer falls back to +1.
    // Re-stated here because the whole point is that createDetourMemory must
    // NOT behave this way: same sequence, opposite outcome.
    const oldPolicy = { side: null as 1 | -1 | null };
    oldPolicy.side = -1; // committed left
    oldPolicy.side = null; // ONE straight frame deleted it
    expect(oldPolicy.side ?? 1).toBe(1); // ← the flip that caused the spin

    const m = createDetourMemory();
    m.record(A, -1, 0);
    expect(m.prefer(A, 0.016)).toBe(-1); // the new policy holds instead
  });
});

describe("wander waypoints — reachable, not merely open", () => {
  // A wall across y = 0 with a door gap at x ∈ [4.5, 5.5]: open ground lies
  // beyond it, but only the gap is walkable.
  const wallWithDoor = (p: { x: number; y: number }, radius: number) => {
    const nearWall = Math.abs(p.y) < 0.3 + radius;
    if (!nearWall) return true;
    return p.x > 4.5 + radius && p.x < 5.5 - radius;
  };

  const ctx = (self: { x: number; y: number }, rng: () => number) => ({
    self: { id: "npc_a", x: self.x, y: self.y, vx: 0, vy: 0, floor: 0 } as unknown as AvatarState,
    humans: [],
    now: 1,
    width: 20,
    height: 20,
    rng,
    walkable: wallWithDoor,
    radius: 0.4,
  });

  // pickWaypoint's untethered draw is x = 2 + rng()·16, y = 2 + rng()·16 over a
  // 20×20 manifold — so a fixed rng sequence names an exact point.
  const drawFor = (x: number, y: number) => [(x - 2) / 16, (y - 2) / 16];

  /** One wanderAim call from `self`, with every draw landing on the same point. */
  const waypointFrom = (self: { x: number; y: number }, seq: number[]) => {
    let i = 0;
    const rng = () => seq[i++ % seq.length]!;
    const c = createNpcController({ id: "npc_a", x: self.x, y: self.y, behavior: { movement: "wander" } });
    return c.computeAim(ctx(self, rng));
  };

  it("REJECTS open ground on the far side of a wall (the old stuck-wander)", () => {
    // (10,-5) → (10,10) is open at BOTH ends but crosses the solid wall at x=10.
    // The old endpoint-only check accepted it and the body ground at the wall
    // until STUCK_SEC. Now all 8 draws fail the corridor → the home fallback.
    const self = { x: 10, y: -5 };
    const wp = waypointFrom(self, drawFor(10, 10));
    expect(wp).toEqual(self); // home === spawn === our side. Never the far side.
  });

  it("ACCEPTS a waypoint reachable straight through the door gap", () => {
    // (5,-5) → (5,10) crosses y=0 at x=5 — inside the 4.5..5.5 gap, so the
    // corridor is clear and the roam still crosses the wall where it truly can.
    const wp = waypointFrom({ x: 5, y: -5 }, drawFor(5, 10));
    expect(wp).toEqual({ x: 5, y: 10 });
  });

  it("ACCEPTS any draw when nothing blocks — an open roam still roams", () => {
    let i = 0;
    const seq = drawFor(10, 10);
    const c = createNpcController({ id: "npc_a", x: 3, y: 3, behavior: { movement: "wander" } });
    const wp = c.computeAim({ ...ctx({ x: 3, y: 3 }, () => seq[i++ % 2]!), walkable: () => true });
    expect(wp).toEqual({ x: 10, y: 10 });
  });

  it("the corridor is probed at the BODY's radius, not a padded one", () => {
    // A lane exactly one body wide must stay usable — padding here would reject
    // every indoor spot and starve the roam (the note already on pickWaypoint).
    const probed: number[] = [];
    const c = createNpcController({ id: "npc_a", x: 5, y: -5, behavior: { movement: "wander" } });
    const seq = drawFor(5, 10);
    let i = 0;
    c.computeAim({
      ...ctx({ x: 5, y: -5 }, () => seq[i++ % 2]!),
      radius: 0.4,
      walkable: (_p, r) => { probed.push(r); return true; },
    });
    expect(new Set(probed)).toEqual(new Set([0.4]));
  });
});
