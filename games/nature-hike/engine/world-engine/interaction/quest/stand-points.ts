// shared/world-engine/interaction/quest/stand-points.ts
//
// STAND-POINT PLANNING — where a body stands to USE a thing. Pure functions
// over WorldState, extracted from quest-host (which needs WebGL and can't be
// imported by tests) so the rules that put waypoints on the map are pinnable:
// the observed "deposit spot behind the house" bug lived exactly here, and a
// wrong answer from these functions sends a body out the front door and
// grinding against the back wall forever (DEBUG-CREATURE-BEHAVIOR §5).

import {
  buildingAt,
  fixturesWalkable,
  objectIsSolid,
  structuresWalkable,
  type WorldState,
} from "../../engine.js";
import { PASSTHROUGH_FIXTURES } from "../../types.js";
import { DEFAULT_BODY_RADIUS_M } from "../../creatures/species.js";
import { useContractFor, useSideDirs } from "../../furniture-use.js";

/** THE TANGENCY RULE: the furnishing fit rule (kernel placement.ts) packs
 *  stations so their standing spots sit at EXACT wall/fixture clearance — a
 *  toilet 1.0 m from the partition puts its stand cardinal at float-0.599…
 *  from the wall. A planner probing at the full body radius reads every such
 *  generator-legal spot as blocked, exhausts its candidates, and falls back
 *  to an unreachable point — the body then grinds at a wall while the detour
 *  force-flips shoulders every frame (the observed "detour flipping" in the
 *  dollhouse). So PLANNING probes at slightly UNDER the body radius:
 *  locomotion still enforces the true 0.4, and the errand arrival tolerances
 *  (0.9–1.3) absorb the boundary. */
const PLAN_SLACK = 0.06;

/** Can a body STAND at `p` — clear of walls AND solid fixtures? Delegates the
 *  fixture half to the engine's OWN `fixturesWalkable` (the composed movement
 *  constraint) rather than restating its box test — the two can never drift.
 *  `radius` is the planning girth (default = the engine's avatarRadius 0.4,
 *  probed with PLAN_SLACK — see THE TANGENCY RULE above); a caller planning
 *  for a bigger body passes its own. */
export function standClear(state: WorldState, p: { x: number; y: number }, radius = DEFAULT_BODY_RADIUS_M): boolean {
  const r = Math.max(0.1, radius - PLAN_SLACK);
  return structuresWalkable(state, p, r) && fixturesWalkable(state, p, r);
}

/** THE CROWDING RULE (emergent, not per-activity): two bodies should never
 *  stand within their COMBINED radii — their footprints would overlap and they
 *  read as fused. `bodiesClear` answers "is `p` far enough from every OTHER
 *  live body that a body of radius `bodyR` could stand there without piling
 *  onto a neighbour". The mover excludes ITSELF (`selfId`); every other avatar
 *  (residents, pets, the player, claimed bodies) is an obstacle. Separation
 *  SCALES with body size — `bodyR + otherR`, never a magic constant
 *  (pathfinding-clearance-contract): a big body keeps a wider berth. `radiusOf`
 *  supplies per-body girth (world-host `npcRadiusOf`); bodies it doesn't know
 *  fall back to the design species radius. This is a SOFT preference at the
 *  spot-choosers below — a spot that fails it is undesirable, not forbidden, so
 *  a genuinely crowded room still terminates (termination over fidelity). */
export function bodiesClear(
  state: WorldState,
  p: { x: number; y: number },
  selfId?: string,
  bodyR = DEFAULT_BODY_RADIUS_M,
  radiusOf?: (id: string) => number,
): boolean {
  for (const a of Object.values(state.avatars)) {
    if (a.id === selfId) continue;
    const otherR = radiusOf?.(a.id) ?? DEFAULT_BODY_RADIUS_M;
    if (Math.hypot(a.x - p.x, a.y - p.y) < bodyR + otherR) return false;
  }
  return true;
}

/** Which OTHER bodies a spot-chooser should keep clear of, and how big each is.
 *  Passed to `standPointFor` / `nearestClearSpot` so a work/idle/rest stand
 *  position prefers ground no neighbour already occupies. Absent ⇒ the classic
 *  structure-only planning (no crowding avoidance). */
export interface BodyAvoidance {
  /** The MOVER's own avatar id — it never counts as an obstacle to itself. */
  selfId?: string;
  /** Per-body radius (world-host `npcRadiusOf`); unknown bodies use the default. */
  radiusOf?: (id: string) => number;
}

/** A body the separation pass can move: an id + live position + storey. */
export interface SeparableBody {
  id: string;
  x: number;
  y: number;
  floor?: number;
  /** Live velocity, when the caller has one (avatar states do) — feeds the
   *  walker-vs-stander share asymmetry. Absent ⇒ treated as standing. */
  vx?: number;
  vy?: number;
}

/** Faster than this and a body counts as WALKING for the separation share
 *  (idle drift and brake tails stay below it; real walks are ≥ 0.8 m/s). */
const MOVING_EPS = 0.1;

/** Options for {@link separateBodies}. */
export interface SeparateOptions {
  /** Per-body girth (world-host `npcRadiusOf`); unknown bodies use the design radius. */
  radiusOf: (id: string) => number;
  /** May this body be MOVED this frame? A spark-driven / player body returns
   *  false — its neighbours part around it but it is never itself shoved.
   *  Absent ⇒ every body is movable. */
  movable?: (id: string) => boolean;
  /** May a body of `radius` STAND at `p` (walls + solid fixtures + terrain)? A
   *  push whose landing spot fails this is dropped, so separation never shoves a
   *  body through a wall — a genuinely packed room simply holds (termination
   *  over fidelity). Absent ⇒ no structural gate (open field). */
  canStand?: (p: { x: number; y: number; floor?: number }, radius: number) => boolean;
  /** Metres per second the gap OPENS. Small + damped — the correction only ever
   *  pushes apart (never a spring back), so nothing oscillates. Default 1.5. */
  rate?: number;
}

/** THE STANDING SEPARATION RULE (emergent, sim-side). Locomotion collides bodies
 *  with walls but NEVER with each other, and the crowding rule ({@link bodiesClear})
 *  only biases where a body AIMS. Neither unmerges bodies that ALREADY overlap:
 *  two whose stand points / homecoming spots land on one patch arrive fused and
 *  stand there forever, and two on parallel errands walk in lockstep reading as
 *  one body. This pass — run each frame after steering — pushes every overlapping
 *  pair GENTLY apart along the line between them, split between the two movable
 *  bodies, scaled to their COMBINED radii (never a magic constant — a big body
 *  keeps a wider berth), capped at `rate` and WALKABILITY-GATED. Mutates the
 *  bodies' `x`/`y` in place. Only compares bodies on the SAME storey. */
export function separateBodies(bodies: SeparableBody[], dt: number, opts: SeparateOptions): void {
  if (dt <= 0) return;
  const rate = opts.rate ?? 1.5;
  const movable = (id: string): boolean => opts.movable?.(id) ?? true;
  const stands = (p: { x: number; y: number; floor?: number }, r: number): boolean =>
    opts.canStand ? opts.canStand(p, r) : true;
  for (let i = 0; i < bodies.length; i++) {
    const a = bodies[i]!;
    const aMove = movable(a.id);
    const rA = opts.radiusOf(a.id);
    for (let j = i + 1; j < bodies.length; j++) {
      const b = bodies[j]!;
      if (a.floor !== b.floor) continue;
      const bMove = movable(b.id);
      if (!aMove && !bMove) continue; // neither can move — nothing to do
      const rB = opts.radiusOf(b.id);
      const min = rA + rB;
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= min * min) continue; // not overlapping
      const d = Math.sqrt(d2);
      let ux: number;
      let uy: number;
      if (d < 1e-4) {
        // Exactly stacked — no direction to part along. Derive a stable axis from
        // the pair's ids so both bodies fly apart the SAME way every frame (no
        // per-frame reshuffle that would dither them in place). The overlap stays
        // the FULL `min` (d ≈ 0) — only the direction comes from the hash.
        let h = 0;
        const key = a.id + "|" + b.id;
        for (let k = 0; k < key.length; k++) h = (h * 31 + key.charCodeAt(k)) | 0;
        const ang = ((h & 0xffff) / 0xffff) * Math.PI * 2;
        ux = Math.cos(ang);
        uy = Math.sin(ang);
      } else {
        ux = dx / d;
        uy = dy / d;
      }
      const correction = Math.min(min - d, rate * dt);
      // Split between the movable bodies (full to the one that can move when its
      // partner is pinned). ASYMMETRIC when exactly one of the pair is actively
      // WALKING (clock-path-dodging.md pinned decision 5): the stander absorbs
      // the whole correction — it steps aside for the walker instead of the
      // walker being knocked off its route. Both walking (lockstep) or both
      // standing (a fused pile) still split 50/50, the original unmerge.
      let shareA = aMove ? (bMove ? 0.5 : 1) : 0;
      let shareB = bMove ? (aMove ? 0.5 : 1) : 0;
      if (aMove && bMove) {
        const aWalks = Math.hypot(a.vx ?? 0, a.vy ?? 0) > MOVING_EPS;
        const bWalks = Math.hypot(b.vx ?? 0, b.vy ?? 0) > MOVING_EPS;
        if (aWalks !== bWalks) {
          shareA = aWalks ? 0 : 1;
          shareB = bWalks ? 0 : 1;
        }
      }
      if (shareA > 0) {
        const na = { x: a.x + ux * correction * shareA, y: a.y + uy * correction * shareA, floor: a.floor };
        if (stands(na, rA)) {
          a.x = na.x;
          a.y = na.y;
        }
      }
      if (shareB > 0) {
        const nb = { x: b.x - ux * correction * shareB, y: b.y - uy * correction * shareB, floor: b.floor };
        if (stands(nb, rB)) {
          b.x = nb.x;
          b.y = nb.y;
        }
      }
    }
  }
}

/** Options for {@link clockDodgeAim}. */
export interface ClockDodgeOptions {
  selfId: string;
  /** Per-body girth (world-host `npcRadiusOf`). */
  radiusOf: (id: string) => number;
  /** Dodge strength 0..1 — the bubble's SHRINK rule: 1 near the anchor, 0 at
   *  the bubble edge (pass through rather than lose the schedule). */
  scale: number;
  /** Walkability gate — a dodge whose landing probe is blocked is DROPPED
   *  (pass through rather than clip a wall; pinned decision 5). */
  canStand?: (p: { x: number; y: number; floor?: number }, radius: number) => boolean;
  /** How far ahead (m, along the walk direction) a body counts as in the way. */
  look?: number;
}

/** How much lateral clearance beyond combined radii a dodge aims for. */
const DODGE_MARGIN = 0.15;

/**
 * CLOCKED-WALKER AVOIDANCE (clock-path-dodging.md) — an AIM bend, never a
 * position push: a clocked body walks around the nearest body blocking its
 * line by offsetting its aim sideways, scaled by the bubble's shrink rule.
 * Two walkers meeting head-on split to DETERMINISTIC opposite sides by id
 * order (pinned decision 2); off-center meetings dodge away from the
 * neighbour's actual side. Pure — the caller composes it after detourAim and
 * only off TIGHT legs (indoors the shrink rule alone applies).
 */
export function clockDodgeAim(
  self: SeparableBody,
  aim: { x: number; y: number },
  bodies: readonly SeparableBody[],
  opts: ClockDodgeOptions,
): { x: number; y: number } {
  if (opts.scale <= 0) return aim; // at the bubble edge — pass through
  const look = opts.look ?? 2.2;
  const ux0 = aim.x - self.x;
  const uy0 = aim.y - self.y;
  const d0 = Math.hypot(ux0, uy0);
  if (d0 < 1e-4) return aim;
  const ux = ux0 / d0;
  const uy = uy0 / d0;
  const rSelf = opts.radiusOf(self.id);
  // The nearest body ahead that intrudes on the walk line.
  let best: { fwd: number; lat: number; need: number; id: string } | null = null;
  for (const b of bodies) {
    if (b.id === self.id || b.floor !== self.floor) continue;
    const dx = b.x - self.x;
    const dy = b.y - self.y;
    const fwd = dx * ux + dy * uy;
    if (fwd <= 0.05 || fwd > look) continue;
    const lat = dx * -uy + dy * ux; // + = neighbour on the LEFT of the line
    const need = rSelf + opts.radiusOf(b.id) + DODGE_MARGIN;
    if (Math.abs(lat) >= need) continue; // already clear
    if (!best || fwd < best.fwd) best = { fwd, lat, need, id: b.id };
  }
  if (!best) return aim;
  // Dodge AWAY from the neighbour's side; dead-ahead ties split by id order
  // so the two parties of a head-on pass always pick opposite sides.
  const side =
    Math.abs(best.lat) > 1e-3 ? -Math.sign(best.lat) : opts.selfId < best.id ? 1 : -1;
  const offset = (best.need - Math.abs(best.lat)) * opts.scale * side;
  const dodged = { x: aim.x + -uy * offset, y: aim.y + ux * offset };
  if (opts.canStand) {
    // Probe where the dodge actually sends the body next, not the far aim.
    const probeF = Math.min(best.fwd, 1);
    const probe = {
      x: self.x + ux * probeF + -uy * offset,
      y: self.y + uy * probeF + ux * offset,
      floor: self.floor,
    };
    if (!opts.canStand(probe, rSelf)) return aim; // blocked — pass through
  }
  return dodged;
}

/** The SOLID object whose no-stand box covers `p` (an item resting on a table
 *  reports the tabletop's centre; a place ref can resolve to a fixture centre) —
 *  or null if `p` is in the open. Solid objects block a Chebyshev box of
 *  half-extent `radius + avatarRadius`, the same girth the engine's
 *  `fixturesWalkable` enforces; pass-through kinds (chairs, bowls) never block.
 *
 *  ⚖️ SOLID, NOT "IS FURNITURE" (user ruling 2026-09-02, the arrival law's
 *  safety half). This asked `spec.fixture && !PASSTHROUGH` — an inline copy of
 *  `objectIsSolid`'s FALLBACK arm with the explicit-`solid` clause missing — so
 *  everything the world declares solid WITHOUT calling it furniture was
 *  invisible here: a modeled oak, a boulder. Locomotion collided with them
 *  (`fixtureGridOf` reads `objectIsSolid`), the repair did not, and once the
 *  founding clear stopped flattening the town's ground that gap became "a
 *  resident outside a tree-blocked door grinds forever with no diagnosis".
 *  Reading the ENGINE'S OWN predicate also drops a loose chest lying on the
 *  floor (`solid: false`, item-prop.ts), which never blocked anybody. */
export function fixtureCovering(
  state: WorldState,
  p: { x: number; y: number },
  bodyR = DEFAULT_BODY_RADIUS_M,
): { id: string; x: number; y: number; radius: number } | null {
  for (const spec of state.spec.objects) {
    if (!objectIsSolid(spec)) continue;
    const o = state.objects[spec.id];
    if (!o) continue;
    if (Math.abs(p.x - o.x) <= spec.radius + bodyR && Math.abs(p.y - o.y) <= spec.radius + bodyR) {
      return { id: spec.id, x: o.x, y: o.y, radius: spec.radius };
    }
  }
  return null;
}

/** The candidate directions for a stand spot: toward `from` first (usually
 *  the open room), then the cardinals. */
export function standDirs(
  raw: { x: number; y: number },
  from: { x: number; y: number },
): { x: number; y: number }[] {
  const toBody = Math.hypot(from.x - raw.x, from.y - raw.y);
  const dirs: { x: number; y: number }[] = [];
  if (toBody > 1e-3) dirs.push({ x: (from.x - raw.x) / toBody, y: (from.y - raw.y) / toBody });
  dirs.push({ x: 0, y: 1 }, { x: 0, y: -1 }, { x: 1, y: 0 }, { x: -1, y: 0 });
  return dirs;
}

/** Is `p` on the SAME side of the walls as `anchor` — the same room, or both
 *  outdoors? `standClear` is a purely LOCAL test: a probe pushed past a
 *  fixture that hugs a wall can land on open ground on the WRONG side (behind
 *  the house — observed: deposit stand points behind the rear wall, walked
 *  out the front door and ground against the back wall forever). Every stand
 *  candidate must ALSO share the fixture's room. */
export function sameRoomAs(
  state: WorldState,
  anchor: { x: number; y: number },
  p: { x: number; y: number },
): boolean {
  return (buildingAt(state, anchor.x, anchor.y)?.id ?? null) === (buildingAt(state, p.x, p.y)?.id ?? null);
}

/** Where a body STANDS to use `objId`. Solid fixtures (beds, tables, chests
 *  — engine makeFixtureConstraint) block within radius + avatarRadius of
 *  their center, so the CENTER is unreachable: a bed (r 0.9) can never be
 *  approached closer than 1.3 — the "walks to the bed and stands forever"
 *  deadlock (the needs arrival check is ≤ 1.3). Target the first WALKABLE
 *  spot just off the fixture's edge instead: toward the approaching body
 *  first (usually the open room), then the other cardinals (a bed's
 *  headboard wall rules one side out). Non-fixtures pass through unchanged. */
export function standPointFor(
  state: WorldState,
  objId: string,
  raw: { x: number; y: number },
  from: { x: number; y: number },
  /** The MOVER's body radius — a bigger creature stands further off the
   *  fixture's edge and needs a wider clear spot. */
  bodyR = DEFAULT_BODY_RADIUS_M,
  /** Other bodies to keep clear of (the crowding rule) — a SOFT preference:
   *  the spot beside the fixture that also avoids piling onto a neighbour is
   *  chosen first, falling back to the plain structural spot when the room is
   *  too crowded to separate. Absent ⇒ structure-only (unchanged). */
  avoid?: BodyAvoidance,
): { x: number; y: number } {
  let spec = state.spec.objects.find((s) => s.id === objId);
  let center = raw;
  // A PASS-THROUGH FIXTURE (a chair, a bowl — PASSTHROUGH_FIXTURES) is the piece
  // being USED and carries no collider, so its own centre IS the stand spot and a
  // body may stand right on it. But a dining chair is TUCKED UNDER its table: the
  // seat centre sits inside the table's Chebyshev keep-out (0.8 + 0.22 + 0.1 =
  // 1.12 < radius + bodyR = 1.2), so that centre is not standable and the caller
  // must nudge off the TABLE.
  //
  // WHICH SIDE of the table it nudges to is the whole bug: this used to fall
  // straight to `return raw`, so `nearestClearSpot` resolved the point as "inside
  // the table" with no idea a SEAT was the aim, and `standDirs` biased the
  // stand-off toward the WALKER. A body approaching from the west therefore
  // committed to a spot on the table's WEST face — a whole table-width (~2.4 m)
  // from the chair it was sent to sit on. Two failures followed, both observed
  // live: the walk cut the table's corner heading for that spot and wedged flush
  // against the collider ("turns too soon, hits the table, gets stuck"), and the
  // arrival landed outside every use gate (2.64 m from a chair whose pose gate is
  // radius + 2.2 = 2.42), so no claim ever formed and the furniture anchor had
  // nothing to slide onto.
  //
  // THE SEAT CHOOSES THE SIDE. Stand just outside the covering piece on the
  // seat's OWN side — the dominant axis from the covering centre through the
  // seat, so the spot lands square on a face and never on a corner. Emergent from
  // the two footprints; no per-kind composite.
  if (spec?.fixture && PASSTHROUGH_FIXTURES.has(spec.fixture)) {
    const bodyClearAt = (p: { x: number; y: number }) =>
      !avoid || bodiesClear(state, p, avoid.selfId, bodyR, avoid.radiusOf);
    if (standClear(state, raw, bodyR) && bodyClearAt(raw)) return raw; // an open seat — stand on it
    const cov = fixtureCovering(state, raw, bodyR);
    if (cov) {
      const stand = cov.radius + bodyR + 0.22;
      const dx = raw.x - cov.x;
      const dy = raw.y - cov.y;
      const d =
        Math.abs(dx) >= Math.abs(dy)
          ? { x: Math.sign(dx) || 1, y: 0 }
          : { x: 0, y: Math.sign(dy) || 1 };
      const p = { x: cov.x + d.x * stand, y: cov.y + d.y * stand };
      if (standClear(state, p, bodyR) && sameRoomAs(state, raw, p) && bodyClearAt(p)) return p;
      // CROWDED but structurally clear — still the seat's side. For a SEAT the
      // mount side is not negotiable: a housemate on the spot MOVES (separation,
      // its own errands), a wall doesn't, and committing another table face here
      // sent the sitter to stand ACROSS the table from its claimed chair
      // (observed live: stand spot on the north face, chair on the south — the
      // engage trigger rightly refused it and the body dined standing). Crowd
      // avoidance stays a SOFT preference (module doc), never a side change.
      if (standClear(state, p, bodyR) && sameRoomAs(state, raw, p)) return p;
      // The face is STRUCTURALLY blocked (a wall behind the chair) — fall
      // through to the covering piece's general resolution, still biased toward
      // the SEAT rather than the walker.
      return standPointFor(state, cov.id, { x: cov.x, y: cov.y }, raw, bodyR, avoid);
    }
    return raw;
  }
  // AN ITEM SITTING ON/IN A SOLID FIXTURE (a banana ON a table, a bowl of soup
  // on a counter) reports the FIXTURE'S CENTRE as its position — the table
  // blocks a body there exactly as if it were the table itself, so walking to
  // the item's own coordinate grinds into the tabletop ("stuck reaching the
  // consume point, into the table's centre"). The item is a pass-through prop,
  // so its own spec never nudges; resolve the stand-off from the CONTAINING
  // fixture instead. A loose item / a pass-through station keeps `raw`.
  //
  // ⚖️ "SOLID" IS THE TEST, not "is furniture" (2026-09-02) — the same
  // correction `fixtureCovering` above carries. A standing oak is solid and is
  // no kind of furniture, so this branch used to hand the tree's own CENTRE
  // back as the stand point and send the hauler into the trunk.
  if (!spec || !objectIsSolid(spec)) {
    const containerId = state.objects[objId]?.containedIn?.objectId;
    const cspec = containerId ? state.spec.objects.find((s) => s.id === containerId) : undefined;
    if (cspec && objectIsSolid(cspec)) {
      const cObj = state.objects[containerId!];
      spec = cspec;
      if (cObj) center = { x: cObj.x, y: cObj.y }; // nudge off the FIXTURE's edge, not the item
    } else {
      return raw;
    }
  }
  const stand = spec.radius + bodyR + 0.22; // the body + a comfortable gap
  // USE-DIRECTION BIAS (the furniture-use contract): try the fixture's DECLARED
  // use side(s) FIRST — a fridge/chest/cupboard is opened from its FRONT, never
  // the side or back; a bed is approached from a long side, not the headboard.
  // A PREFERENCE, not a hard filter: a blocked front still falls through to the
  // general candidates below, so a crowded room still terminates (termination
  // over fidelity). A non-fixture / an item resolved onto its container uses the
  // resolved fixture's own facing. Absent facing ⇒ front = +x, harmless.
  const useDirs = spec.fixture ? useSideDirs(useContractFor(spec.fixture), spec.facing) : [];
  const dirs = [...useDirs, ...standDirs(center, from)];
  const structural = (p: { x: number; y: number }) => standClear(state, p, bodyR) && sameRoomAs(state, center, p);
  const bodyClear = (p: { x: number; y: number }) =>
    !avoid || bodiesClear(state, p, avoid.selfId, bodyR, avoid.radiusOf);
  // Candidates in preference order: the cardinals at the base ring (toward the
  // approaching body first), THEN the DIAGONALS + a wider ring — the old
  // unchecked `dirs[0]` fallback could hand back a point INSIDE another
  // fixture's Chebyshev box (the §5 landmine: a "safe" radial stand-off is
  // inside the box on the diagonals). Every candidate is same-room-gated: a
  // wider probe past a wall-hugging fixture lands OUTSIDE the room — clear
  // ground, wrong side of the wall.
  const D = Math.SQRT1_2;
  const diags = [
    { x: D, y: D },
    { x: D, y: -D },
    { x: -D, y: D },
    { x: -D, y: -D },
  ];
  const candidates: { x: number; y: number }[] = dirs.map((d) => ({ x: center.x + d.x * stand, y: center.y + d.y * stand }));
  for (const ring of [stand, stand + 0.6]) {
    for (const d of [...diags, ...dirs]) candidates.push({ x: center.x + d.x * ring, y: center.y + d.y * ring });
  }
  // TWO PASS: first a spot that ALSO avoids other bodies (the crowding rule),
  // then any structural spot when the room is too crowded to separate — so two
  // creatures using the same fixture stand shoulder-off instead of fused, but
  // a packed room still yields a usable spot (termination over fidelity). With
  // no `avoid`, the first pass equals the second and the result is unchanged.
  for (const p of candidates) if (structural(p) && bodyClear(p)) return p;
  for (const p of candidates) if (structural(p)) return p;
  return { x: center.x + dirs[0]!.x * stand, y: center.y + dirs[0]!.y * stand }; // best effort — the leg's stall watch copes
}

/**
 * THE PLAY RING — where a body stands to use a thing SET OUT ON THE FLOOR (a
 * toy pulled out of the box into an open space). A fixture is approached at its
 * declared use side(s) and a body stands at its EDGE; a floor station has no
 * front and no footprint worth standing off, and it is used from ALL AROUND —
 * so players gather on a ring, each on their own side, and ONE toy serves
 * several bodies at once.
 *
 * Sides are tried nearest the approaching body FIRST and then fan outward
 * alternately (you join from where you came, not by walking the whole ring).
 * What actually spreads the players out is the ordinary crowding rule
 * (`bodiesClear`): a side a neighbour already holds fails it and the fan moves
 * on, so the second player lands beside or opposite rather than fused with the
 * first. No side is ever ASSIGNED — the separation is emergent, and identical
 * to the one every other stand chooser uses.
 *
 * SOFT, like the rest of them: a crowded ring falls back to any standable side,
 * and finally to the approach side, so play always terminates.
 */
export function playRingSpot(
  state: WorldState,
  at: { x: number; y: number },
  from: { x: number; y: number },
  bodyR = DEFAULT_BODY_RADIUS_M,
  avoid?: BodyAvoidance,
  /** How far off the station the ring sits. Default = the body's own girth plus
   *  a reach, so a player stands clear of the toy and still over it. */
  ring = bodyR + 0.45,
): { x: number; y: number } {
  const base = Math.atan2(from.y - at.y, from.x - at.x);
  const SIDES = 8;
  const candidates: { x: number; y: number }[] = [];
  for (let i = 0; i < SIDES; i++) {
    // 0, +1, −1, +2, −2 … — the approach side, then out both ways.
    const off = Math.ceil(i / 2) * (i % 2 === 1 ? 1 : -1);
    const a = base + (off * 2 * Math.PI) / SIDES;
    candidates.push({ x: at.x + Math.cos(a) * ring, y: at.y + Math.sin(a) * ring });
  }
  const structural = (p: { x: number; y: number }) => standClear(state, p, bodyR) && sameRoomAs(state, at, p);
  const bodyClear = (p: { x: number; y: number }) =>
    !avoid || bodiesClear(state, p, avoid.selfId, bodyR, avoid.radiusOf);
  for (const p of candidates) if (structural(p) && bodyClear(p)) return p;
  for (const p of candidates) if (structural(p)) return p;
  return candidates[0]!;
}

/** A clear spot at-or-near `raw`: itself when standable, else nudged outward
 *  along the from-direction + cardinals (for planned points that may land
 *  inside furniture — a homecoming spot, a room anchor). Nudged candidates
 *  are same-room-gated like stand points: a nudge past a wall lands on clear
 *  ground on the WRONG side. */
export function nearestClearSpot(
  state: WorldState,
  raw: { x: number; y: number },
  from: { x: number; y: number },
  bodyR = DEFAULT_BODY_RADIUS_M,
  /** Other bodies to keep clear of (the crowding rule) — a SOFT preference,
   *  like `standPointFor`: an offset that also avoids piling onto a neighbour
   *  is chosen first, falling back to the plain structural spot. Absent ⇒
   *  structure-only (unchanged). */
  avoid?: BodyAvoidance,
): { x: number; y: number } {
  const bodyClear = (p: { x: number; y: number }) =>
    !avoid || bodiesClear(state, p, avoid.selfId, bodyR, avoid.radiusOf);
  // The raw spot works when it's both clear of walls AND clear of other bodies.
  if (standClear(state, raw, bodyR) && bodyClear(raw)) return raw;
  // INSIDE A SOLID FIXTURE (an item on a table, a place ref at a fixture's
  // centre): nudge off THAT fixture's edge via standPointFor — radius-aware,
  // diagonals + a wider ring. The fixed-step sweep below is girth-blind (max
  // 1.6, no diagonals): for a big or crowded fixture it can't reach clear
  // ground and falls back to the blocked centre (the "grinds into the table's
  // centre reaching the consume point" bug). standPointFor handles the fixture
  // (and the same crowding avoidance, via `avoid`).
  const fx = fixtureCovering(state, raw, bodyR);
  if (fx) {
    const sp = standPointFor(state, fx.id, { x: fx.x, y: fx.y }, from, bodyR, avoid);
    if (standClear(state, sp, bodyR) && bodyClear(sp)) return sp;
  }
  // An oversized body sweeps proportionally further (identical at the default).
  const grow = 2 * Math.max(0, bodyR - DEFAULT_BODY_RADIUS_M);
  // TWO PASS: prefer an offset that ALSO avoids other bodies, then any
  // structural offset when the area is too crowded to separate. Structure-only
  // callers (no `avoid`) get the original single sweep.
  const sweep = (requireBodyClear: boolean): { x: number; y: number } | null => {
    for (const step of [0.9 + grow, 1.6 + grow]) {
      for (const d of standDirs(raw, from)) {
        const p = { x: raw.x + d.x * step, y: raw.y + d.y * step };
        if (standClear(state, p, bodyR) && sameRoomAs(state, raw, p) && (!requireBodyClear || bodyClear(p))) return p;
      }
    }
    return null;
  };
  if (avoid) {
    const clear = sweep(true);
    if (clear) return clear;
  }
  const any = sweep(false);
  if (any) return any;
  return raw; // best effort — the errand leg deadline copes
}
