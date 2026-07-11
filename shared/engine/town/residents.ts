/**
 * residents.ts — WHO EXISTS WHERE, DOING WHAT: the town's population
 * model, renderer-agnostic. Grand-dream's overhead canvas established
 * these mechanics (its TownManager, zoom.ts); this module is that rule
 * set extracted to the engine so EVERY view — top-down map or full 3D —
 * streams the same people to the same places on the same clock. The
 * mechanics are tied to the world model; the camera only decides what
 * gets drawn.
 *
 * The rules (each one was tuned in the 2D lab — change them THERE, i.e.
 * here, never per-renderer):
 *
 *   HOUSEHOLDS — every house holds HOUSEHOLD members. Member role =
 *   good slot: role 0 walks the food run, role 1 the wares run, and so
 *   on; members beyond the goods are HOMEBODIES at deterministic spots
 *   about the room. An N-need household is N different people out on
 *   different clocks.
 *
 *   POSITION TRUTH — a runner is where its errand's closed form says
 *   (mid-trip on the streets); anyone home is INSIDE the house (indoor
 *   tether, INDOOR_WANDER_R about their home anchor), never parked on
 *   the doorstep.
 *
 *   EMBODIMENT — bodies exist for the best-ranked candidates within
 *   PEOPLE_R (beyond street-level camera reach, so appearance happens
 *   off-screen). INTERIORS STAY ABSTRACTED until you enter: a home-phase
 *   resident (idle homebody, or a runner still at home) embodies ONLY
 *   when the player is inside that house — an empty home you're standing
 *   in would be the visible absence, but a closed house you pass has no
 *   hidden crowd to build and nobody to swing its door from within.
 *   Street-phase runners (out on the lanes) embody by proximity as ever.
 *
 *   THE LOCK — a body within PEOPLE_EVICT_MIN of the player never
 *   blinks out; eviction turns the crowd over off to the sides. An
 *   idle body inside its own house holds no lock (the view hides it)
 *   unless the player is in there with it.
 *
 *   POP-IN — people enter the world through buildings, never onto open
 *   ground: at home ⇒ inside the house; mid-errand where the camera
 *   can see (visibleR) ⇒ at the trip's SOURCE building, exiting its
 *   door, playing the rest of the trip from there; off-camera ⇒
 *   on-route, exactly where the clock says.
 *
 *   TRIPS — once per cycle, bracketed by door transits at BOTH ends
 *   and ending AT the good's box (BOX_FILL_DWELL at the crate).
 */

import type { TownPlan, TownHouse } from "./plan";
import {
  HOUSEHOLD, doorTransit, goodBoxAt, houseDoorstep, pantryBoxAt, type TownGoods,
} from "./goods";

/* ------------------------- the tuned constants ------------------------- */
// Single-sourced here since the parity carve; grand-dream re-exports them.

/** Concurrent BODY budget for a streamed world — pure steering bodies,
 *  so the engine's small voiced-NPC cap doesn't apply. Pass to
 *  `runWorldHost({ maxNpcs })`. */
export const STREET_NPCS = 40;
/** Residents may embody within this range of the player (meters). */
export const PEOPLE_R = 240;
/** A body this close to the player never despawns. */
export const PEOPLE_EVICT_MIN = 60;
/** Indoor wander tether radius (a shuffle inside their own four walls). */
export const INDOOR_WANDER_R = 2.5;
/** Legacy "up-close" idle radius. Home-phase residents now embody ONLY when
 *  the player is inside their house (interiors abstracted otherwise), so this
 *  no longer gates embodiment; kept as the reference distance for callers. */
export const IDLE_EMBODY_R = 110;
/** ...and rank this many meters behind visible street life. */
export const IDLE_RANK_PENALTY = 200;
/** Seconds the shopper stands at the box stowing the goods. */
export const BOX_FILL_DWELL = 2;

type Pt = { x: number; y: number };
type TripPoint = { x: number; y: number; dwell?: number };

function hashSeed(seed: number, key: string): number {
  let h = 0x811c9dc5 ^ seed;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------- the API ------------------------------- */

/** A body entering the world, with the behavior that keeps 2D/3D honest:
 *  wander tethered to the home anchor, walking at the errand pace. */
export interface ResidentSpawn {
  id: string;
  x: number;
  y: number;
  /** The wander tether anchor (house center for house members). */
  home: Pt;
  wanderRadius: number;
  /** Trip already underway from the spawn point, when mid-errand. */
  walkTo?: TripPoint[];
  /** Spawned inside a building (views may cull until they step out). */
  indoor: boolean;
  house: number;
  member: number;
}

export interface ResidentUpdate {
  spawn: ResidentSpawn[];
  despawn: string[];
  /** Fresh shopping trips for already-embodied runners (once per cycle). */
  trips: Array<{ id: string; points: TripPoint[] }>;
}

export interface ResidentModelOpts {
  center: Pt;
  plan: TownPlan;
  /** The town's street goods in slot order (streetGoods). Role = slot. */
  goods: TownGoods[];
  seed: number;
  /** Resident ids never embodied (recruited away, cast doubles...). */
  excluded?: ReadonlySet<string>;
}

export interface ResidentModel {
  /**
   * One streaming step: diff who SHOULD be embodied against who IS.
   * `bodyPos` reports a live body's current position (null = unknown —
   * the doorstep stands in); `visibleR` is the camera's world reach,
   * feeding only the POP-IN rule (where a body materializes), never
   * whether it exists. `isVisible(houseIndex)` reports whether a house's
   * INTERIOR is ON SHOW — its roof transparent because the player occupies
   * it (an open door you're standing OUTSIDE of does not count; the roof is
   * still opaque). Embodiment/abstraction keys on THAT, not raw distance.
   * Omit it and the model falls back to the bare "player inside this house"
   * footprint test (the 2D lab, which has no roof/visibility model).
   */
  update(
    p: Pt,
    now: number,
    budget: number,
    bodyPos: (id: string) => Pt | null,
    visibleR?: number,
    isVisible?: (houseIndex: number) => boolean,
  ): ResidentUpdate;
  /** The member id filling errand ROLE `role` of a house (see roleMemberId). */
  runnerId(houseIndex: number, role: number): string | null;
  /** Forget all embodiment state (a fresh host). */
  reset(): void;
}

/** A resident's world NPC id. */
export function residentId(houseIndex: number, member: number): string {
  return `resident_${houseIndex}_${member}`;
}

export function createResidentModel(opts: ResidentModelOpts): ResidentModel {
  const { center, plan, goods, seed } = opts;
  const excluded = opts.excluded ?? new Set<string>();

  interface GoodRun {
    goods: TownGoods;
    role: number;
    box: (h: TownHouse) => Pt;
  }
  const runs: GoodRun[] = goods.map((g, i) => {
    const slot = g.good.slot ?? i;
    return { goods: g, role: slot, box: (h: TownHouse) => goodBoxAt(center, h, slot) };
  });

  const houseCenter = (h: TownHouse): Pt =>
    ({ x: center.x + h.dx + h.w / 2, y: center.y + h.dy + h.h / 2 });
  const inHouseRect = (pt: Pt, h: TownHouse): boolean =>
    pt.x > center.x + h.dx && pt.x < center.x + h.dx + h.w &&
    pt.y > center.y + h.dy && pt.y < center.y + h.dy + h.h;
  /** Deterministic indoor spot for member m — five people in a house are
   *  five bodies around the room, not a stack at its center. */
  const memberSpot = (h: TownHouse, m: number): Pt => {
    const rng = mulberry32(hashSeed(seed, `member:${h.index}:${m}`));
    return {
      x: center.x + h.dx + 1.4 + rng() * Math.max(0.5, h.w - 2.8),
      y: center.y + h.dy + 1.4 + rng() * Math.max(0.5, h.h - 2.8),
    };
  };
  /** Door-transit bracketing: out through the door first (when leaving
   *  home), and always back in to end AT the good's box. */
  const throughDoor = (
    h: TownHouse, walkTo: TripPoint[], exitFirst: boolean, box?: Pt,
  ): TripPoint[] => {
    const d = doorTransit(center, h);
    const pts: TripPoint[] = exitFirst ? [d.inside, d.outside, ...walkTo] : [...walkTo];
    pts.push(d.inside, { ...(box ?? pantryBoxAt(center, h)), dwell: BOX_FILL_DWELL });
    return pts;
  };
  /** The member filling errand ROLE `role`: the (role+1)-th member not
   *  excluded — role handover survives exclusions, and a house down to
   *  one soul covers food and drops the later runs. */
  const runnerId = (houseIdx: number, role: number): string | null => {
    let seen = 0;
    for (let m = 0; m < HOUSEHOLD; m++) {
      const id = residentId(houseIdx, m);
      if (excluded.has(id)) continue;
      if (seen === role) return id;
      seen++;
    }
    return null;
  };
  const segDist = (a: Pt, b: Pt, p: Pt): number => {
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len2 = vx * vx + vy * vy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2));
    return Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t));
  };

  /** Embodied bodies + their house/member, and per-body trip bookkeeping. */
  const bodies = new Map<string, { house: TownHouse; member: number }>();
  const tripSent = new Map<string, number>();

  const update = (
    p: Pt,
    now: number,
    budget: number,
    bodyPos: (id: string) => Pt | null,
    visibleR?: number,
    isVisible?: (houseIndex: number) => boolean,
  ): ResidentUpdate => {
    // A house's interior is ON SHOW when its roof is transparent — the player
    // OCCUPIES it (an open door you're outside of doesn't reveal it; the roof
    // stays opaque). Every embodiment/abstraction gate below reads this. No
    // signal supplied ⇒ fall back to the raw footprint test.
    const isHouseVisible = (h: TownHouse): boolean =>
      isVisible ? isVisible(h.index) : inHouseRect(p, h);
    interface Candidate extends ResidentSpawn {
      d: number;
      rank: number;
      run?: GoodRun;
      cycle?: number;
    }
    const candidates: Candidate[] = [];

    for (const house of plan.houses) {
      const door = houseDoorstep(center, house);
      const houseVisible = isHouseVisible(house);
      // Interiors stay ABSTRACTED until you're inside: a home-phase resident
      // (an idle homebody, or an errand-runner still at home) embodies ONLY when
      // the player is in the house. So nobody shuffles up to a closed door and
      // swings it open from within, and walking past a house costs only its
      // exterior walls — not a roomful of hidden bodies. Street-phase runners
      // (mid-errand, out on the lanes) are unaffected: they embody by proximity.
      const homeNear = houseVisible;

      const runnerOf = new Map<string, GoodRun>();
      for (const run of runs) {
        const id = runnerId(house.index, run.role);
        if (id) runnerOf.set(id, run);
      }

      for (let m = 0; m < HOUSEHOLD; m++) {
        const id = residentId(house.index, m);
        if (excluded.has(id)) continue;
        const run = runnerOf.get(id);

        if (bodies.has(id)) {
          // Already embodied: candidacy from its LIVE position.
          const at = bodyPos(id) ?? door;
          const d = Math.hypot(at.x - p.x, at.y - p.y);
          if (d > PEOPLE_R) continue;
          // `idle` = the errand clock has no pending task: a homebody always,
          // or a runner whose trip window is closed (phase "home"). A shopper
          // still walking back is phase "to_home" — NOT idle — so it's never
          // culled mid-return; it keeps its slot until it's actually done.
          const idle = !run || run.goods.errand(house, now).phase === "home";
          // ABSTRACT ON ARRIVAL: once a body has finished its tasks (idle) AND
          // is back inside its own house, with the player NOT in there to see
          // it, cull it now instead of letting it linger indoors. Returning
          // shoppers were piling up embodied at home → steadily growing the
          // live cast until it lagged. It re-pops through its door when its
          // next trip's window opens. The interior is hidden, so the despawn is
          // unseen; the pantry it was heading for reads its closed form while
          // unwatched (the witnessed fill only matters when you're inside).
          if (idle && !houseVisible && inHouseRect(at, house)) continue;
          const rank = idle && !houseVisible ? d + IDLE_RANK_PENALTY : d;
          candidates.push({
            id, d, rank, x: at.x, y: at.y, home: houseCenter(house),
            wanderRadius: INDOOR_WANDER_R, indoor: false, house: house.index, member: m, run,
          });
          continue;
        }

        if (!run) {
          // A HOMEBODY: indoors at their own spot in the room.
          if (!homeNear) continue;
          const spot = memberSpot(house, m);
          const d = Math.hypot(spot.x - p.x, spot.y - p.y);
          if (d > PEOPLE_R) continue;
          const rank = houseVisible ? d : d + IDLE_RANK_PENALTY;
          candidates.push({
            id, d, rank, x: spot.x, y: spot.y, home: spot,
            wanderRadius: INDOOR_WANDER_R, indoor: true, house: house.index, member: m,
          });
          continue;
        }

        // An ERRAND RUNNER: where their good's cycle says they are.
        const src = run.goods.sourceOf(house);
        if (segDist(door, src, p) > PEOPLE_R + 120) continue;
        const est = run.goods.errand(house, now);
        const d = Math.hypot(est.pos.x - p.x, est.pos.y - p.y);
        if (d > PEOPLE_R) continue;
        // A home-phase runner is indoors — the same inside-only rule as a homebody.
        if (est.phase === "home" && !houseVisible) continue;
        const rank = est.phase === "home" && !houseVisible ? d + IDLE_RANK_PENALTY : d;

        // POP-IN: people enter the world through buildings.
        let at = est.pos;
        let walkTo = est.walkTo ?? undefined;
        let indoor = false;
        if (est.phase === "home") {
          at = houseCenter(house);
          indoor = true;
          walkTo = undefined;
        } else if (visibleR !== undefined && d < visibleR) {
          at = { x: est.source.x, y: est.source.y };
          if (est.phase === "to_source" && walkTo) {
            // Skip the outbound leg they no longer walk: resume from the
            // stall (its dwell point) onward.
            const dwellAt = walkTo.findIndex(pt => pt.dwell !== undefined);
            if (dwellAt > 0) walkTo = walkTo.slice(dwellAt);
          }
          const wk = est.source.work !== undefined ? plan.works[est.source.work] : undefined;
          if (wk) {
            // Inside the source building, exiting through its door.
            at = { x: center.x + wk.dx + wk.w / 2, y: center.y + wk.dy + wk.h / 2 };
            const t = doorTransit(center, wk);
            walkTo = [t.inside, t.outside, ...(walkTo ?? [])];
          }
        }
        // A mid-trip body ends its errand back through its own door.
        if (walkTo && !indoor) walkTo = throughDoor(house, walkTo, false, run.box(house));
        candidates.push({
          id, d, rank, x: at.x, y: at.y, home: houseCenter(house),
          wanderRadius: INDOOR_WANDER_R, ...(walkTo ? { walkTo } : {}),
          indoor, house: house.index, member: m, run, cycle: est.cycle,
        });
      }
    }

    candidates.sort((a, b) => a.rank - b.rank);

    // THE LOCK: spawned bodies beside the player hold their slots first
    // (an idle body inside its own house holds no lock unless that house's
    // interior is visible); the rest fills best-rank-first.
    const desired = new Map<string, Candidate>();
    const houseOf = new Map(plan.houses.map(h => [h.index, h] as const));
    for (const c of candidates) {
      if (desired.size >= budget) break;
      if (!bodies.has(c.id) || c.d >= PEOPLE_EVICT_MIN) continue;
      const h = houseOf.get(c.house);
      if (h && inHouseRect(c, h) && !isHouseVisible(h)) continue;
      desired.set(c.id, c);
    }
    for (const c of candidates) {
      if (desired.size >= budget) break;
      if (!desired.has(c.id)) desired.set(c.id, c);
    }

    const spawn: ResidentSpawn[] = [];
    const despawn: string[] = [];
    for (const id of bodies.keys()) {
      if (!desired.has(id)) {
        despawn.push(id);
        bodies.delete(id);
        tripSent.delete(id);
      }
    }
    for (const [id, c] of desired) {
      if (bodies.has(id)) continue;
      const h = houseOf.get(c.house);
      if (!h) continue;
      bodies.set(id, { house: h, member: c.member });
      spawn.push({
        id, x: c.x, y: c.y, home: c.home, wanderRadius: c.wanderRadius,
        ...(c.walkTo ? { walkTo: c.walkTo } : {}),
        indoor: c.indoor, house: c.house, member: c.member,
      });
      // Their current trip is already underway — don't re-issue it.
      if (c.walkTo && c.cycle !== undefined) tripSent.set(id, c.cycle);
    }

    // LIVE TRIPS: an embodied runner whose cycle entered its trip window
    // goes out — once per cycle, door-bracketed both ends.
    const trips: ResidentUpdate["trips"] = [];
    for (const [id, b] of bodies) {
      const run = runs.find(r => runnerId(b.house.index, r.role) === id);
      if (!run) continue;
      const est = run.goods.errand(b.house, now);
      if (est.phase === "home" || !est.walkTo) continue;
      if (tripSent.get(id) === est.cycle) continue;
      tripSent.set(id, est.cycle);
      trips.push({ id, points: throughDoor(b.house, est.walkTo, true, run.box(b.house)) });
    }

    return { spawn, despawn, trips };
  };

  return {
    update,
    runnerId,
    reset: () => {
      bodies.clear();
      tripSent.clear();
    },
  };
}
