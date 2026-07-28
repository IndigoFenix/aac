// WALL-GLIDE (engine.ts `config.wallGlide`): a body whose aim points INTO a
// surface it is pressed against must walk PARALLEL to the face at walking pace,
// not grind down it on the slide residue. The old behaviour — steering
// re-accelerates at the aim every frame, the constrained slide zeroes the
// blocked component every frame — is preserved byte-for-byte when the flag is
// off (the player/spark-driven walker, and every world that doesn't opt in).
// Pure engine logic, no GL — safe in `npm test`.

import { describe, it, expect } from "@jest/globals";
import {
  addLocalAvatar,
  createWorldState,
  steerAvatar,
  tickWorld,
  WORLD_ENGINE_DEFAULTS,
  type MoveConstraint,
  type WorldEngineConfig,
  type WorldState,
} from "@shared/world-engine/engine.js";
import type { WorldSpec } from "@shared/world-engine/types.js";

/** A flat empty world — the constraint under test is passed in explicitly. */
function world(): WorldState {
  const spec: WorldSpec = {
    engine: "world",
    engineVersion: 1,
    meta: { title: "t", locale: "en", theme: "t" },
    manifold: { kind: "flat", width: 80, height: 80 },
    terrain: { kind: "flat" },
    spawns: [{ id: "s", x: 2, y: 2 }],
    objects: [],
    multiplayer: { maxPlayers: 2, authority: "distributed" },
    content: { kind: "sandbox" },
  };
  return createWorldState(spec, "me");
}

/** Solid half-plane x ≥ wallX — one long axis-aligned face, like a table edge
 *  or a room wall seen up close. */
const wallAt = (wallX: number): MoveConstraint => ({
  walkable: (p, r) => p.x + r < wallX,
});

const DT = 1 / 60;

/** Drive `id` at `aim` for `seconds`, counting frames where the proposed step
 *  was rejected by the constraint (the body fed the collider). */
function drive(
  s: WorldState,
  id: string,
  aim: { x: number; y: number },
  seconds: number,
  config: WorldEngineConfig,
  constraint: MoveConstraint,
): { collidedFrames: number } {
  const body = s.avatars[id]!;
  let collidedFrames = 0;
  const counting: MoveConstraint = {
    walkable: (p, r) => {
      const ok = constraint.walkable(p, r);
      // Count only probes AWAY from the current spot (the proposed step).
      if (!ok && (p.x !== body.x || p.y !== body.y)) collidedFrames++;
      return ok;
    },
  };
  for (let f = 0; f < Math.round(seconds / DT); f++) {
    steerAvatar(s, id, aim, DT, config, counting);
    tickWorld(s, { aim: null }, DT); // advances state.time — the contact-expiry clock
  }
  return { collidedFrames };
}

describe("wall-glide — steer parallel to a pressed face instead of into it", () => {
  // The scraping scenario: body against the wall at x=10, aim far BEYOND the
  // wall and only a little ahead along it — an ~80°-into-the-face approach,
  // which is exactly the tail of a stand-point leg grazing a table. The aim's
  // FOOT on the face (its tangential projection) is 4 m ahead at y=8.
  const AIM = { x: 30, y: 8 };
  const START = { x: 9.5, y: 4 };

  it("walks the face to the aim's foot — the grind never gets there", () => {
    // OFF: only the desired velocity's small tangential component moves the
    // body, and it shrinks as the geometry squares up — an asymptotic crawl.
    // ON: the whole desired speed runs along the face, easing onto the foot
    // (the closest reachable point) by the normal approach law.
    const runTo = (config: WorldEngineConfig): number => {
      const s = world();
      const body = addLocalAvatar(s, "npc", START.x, START.y);
      drive(s, "npc", AIM, 2, config, wallAt(10));
      return body.y;
    };
    const ground = runTo(WORLD_ENGINE_DEFAULTS);
    const glide = runTo({ ...WORLD_ENGINE_DEFAULTS, wallGlide: true });
    expect(glide).toBeGreaterThan(7); // at the foot (y=8), give or take the ease
    expect(ground).toBeLessThan(6.5); // the crawl is still far short at 2 s
    expect(glide - START.y).toBeGreaterThan((ground - START.y) * 2);
  });

  it("stops feeding the collider while gliding (the probe-storm goes quiet)", () => {
    const collisions = (config: WorldEngineConfig): number => {
      const s = world();
      addLocalAvatar(s, "npc", START.x, START.y);
      return drive(s, "npc", AIM, 2, config, wallAt(10)).collidedFrames;
    };
    const ground = collisions(WORLD_ENGINE_DEFAULTS);
    const glide = collisions({ ...WORLD_ENGINE_DEFAULTS, wallGlide: true });
    // OFF grinds: essentially every frame re-collides. ON touches only on
    // contact (re-)acquisition — the CONTACT_HOLD_S retry cadence.
    expect(ground).toBeGreaterThan(60);
    expect(glide).toBeLessThan(ground / 3);
  });

  it("a dead head-on aim settles at its foot — no orbiting, no dither", () => {
    // Aim square behind the face: the foot is underfoot, so the tangential
    // approach law brakes to rest there — the body stands at the closest
    // reachable point instead of pacing around it (or grinding into it).
    const s = world();
    const body = addLocalAvatar(s, "npc", 9.5, 20);
    let excursion = 0;
    const cfg = { ...WORLD_ENGINE_DEFAULTS, wallGlide: true };
    for (let f = 0; f < Math.round(2 / DT); f++) {
      steerAvatar(s, "npc", { x: 14, y: 20 }, DT, cfg, wallAt(10));
      tickWorld(s, { aim: null }, DT);
      excursion = Math.max(excursion, Math.abs(body.y - 20));
    }
    expect(excursion).toBeLessThan(1); // never wandered off along the face
    expect(Math.hypot(body.vx, body.vy)).toBeLessThan(0.2); // at rest, not vibrating
  });

  it("a glide past the face's END releases toward the aim (the retry clears)", () => {
    const s = world();
    const body = addLocalAvatar(s, "npc", 9.5, 4);
    // Finite wall: solid only for y ≤ 8 — past its end the straight is clear.
    const finiteWall: MoveConstraint = { walkable: (p, r) => p.x + r < 10 || p.y > 8 };
    for (let f = 0; f < Math.round(6 / DT); f++) {
      steerAvatar(s, "npc", { x: 14, y: 20 }, DT, { ...WORLD_ENGINE_DEFAULTS, wallGlide: true }, finiteWall);
      tickWorld(s, { aim: null }, DT);
    }
    // Around the corner and on to the aim (arrive dead zone 0.8).
    expect(Math.hypot(body.x - 14, body.y - 20)).toBeLessThan(1.2);
  });

  it("flag off: no contact is ever recorded (the default path stays untouched)", () => {
    const s = world();
    const body = addLocalAvatar(s, "npc", START.x, START.y);
    drive(s, "npc", AIM, 1, WORLD_ENGINE_DEFAULTS, wallAt(10));
    expect(body.contact).toBeUndefined();
  });

  it("FAILSAFE preserved: a body already inside geometry still walks out", () => {
    const s = world();
    const body = addLocalAvatar(s, "npc", 12, 4); // spawned INSIDE the solid
    drive(s, "npc", { x: 2, y: 4 }, 2, { ...WORLD_ENGINE_DEFAULTS, wallGlide: true }, wallAt(10));
    expect(body.x).toBeLessThan(10 - WORLD_ENGINE_DEFAULTS.avatarRadius);
  });
});
