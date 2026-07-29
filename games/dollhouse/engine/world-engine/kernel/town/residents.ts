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
import { probesOn } from "../../perf-probes.js";
import {
  FOOD_DAY_SEC, HOUSEHOLD, doorTransit, goodBoxAt, houseDoorstep, pantryBoxAt, workDoorstep,
  type TownGoods,
} from "./goods";
import { creatureActivityAt, mealOffset } from "./activity";
import { assignTownJobs, inShiftWindow, jobDutyOf, rosterOf, shopDutyOf } from "./roster";
import { houseRoomPlan, livingRect, memberRoomOf, type HouseRoomPlan } from "./rooms";

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
/** Embodied bodies rank this many meters AHEAD of would-be spawns — slot
 *  HYSTERESIS. Without it, two candidates trading places across the budget
 *  boundary despawn/respawn each other every frame (the thrash that showed
 *  as bodies strobing at their doorsteps). */
export const EMBODIED_STICKINESS = 25;
/** Seconds the shopper stands at the box stowing the goods. */
export const BOX_FILL_DWELL = 2;

/**
 * DESPAWN PRIORITY — when more bodies want to exist than the budget carries,
 * this ONE function orders who keeps one (LOWER keeps its body; higher is
 * culled / never spawned first). Every candidacy rank flows through here so
 * the policy can grow without touching the streaming plumbing.
 *
 * Current axes: distance from the camera focus (the obvious one); a heavy
 * penalty for idle bodies in unwatched interiors (they matter least); and
 * embodied stickiness (see EMBODIED_STICKINESS).
 *
 * FUTURE axes belong HERE, not inline: body SIZE (tiny creatures cull
 * first), IMPORTANCE (historical figures; creatures the player recently
 * interacted with rank late), PARTY membership (never cull). Those signals
 * live above this module today — thread them in through ResidentModelOpts
 * when they're wanted.
 */
export function despawnPriority(c: { d: number; idleHidden?: boolean; embodied?: boolean }): number {
  return c.d + (c.idleHidden ? IDLE_RANK_PENALTY : 0) - (c.embodied ? EMBODIED_STICKINESS : 0);
}

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
   * `isRoomVisible(buildingId)` refines the view guard to ROOM granularity
   * (rooms-as-buildings, round 4): a VISIBLE house's unrevealed back rooms
   * are legitimate spawn cover — standing in the living room, the camera
   * cannot see into a closed bedroom. Omit it and concealment stays
   * house-granular (a visible house hides nothing).
   * `isHousePooled(houseIndex)` (④ cohorts): a POOLED house's household is
   * statistical — no candidates generate, no trips issue; any lingering
   * body despawns through the normal cull (the view guard still holds a
   * visible one until it leaves the frame). Omit = every house tracked.
   */
  update(
    p: Pt,
    now: number,
    budget: number,
    bodyPos: (id: string) => Pt | null,
    visibleR?: number,
    isVisible?: (houseIndex: number) => boolean,
    isRoomVisible?: (buildingId: string) => boolean,
    isHousePooled?: (houseIndex: number) => boolean,
    /** RECRUITED CIVIC WORKERS (pipeline ⑥): a BUSY body — claimed by a
     *  pooled task, executing a haul — is PINNED: never despawned (however
     *  far it walks), never handed a fresh shopping trip (the host owns it
     *  until the work ends). The normal cull resumes the frame it frees. */
    isBusy?: (id: string) => boolean,
  ): ResidentUpdate;
  /** The member id filling errand ROLE `role` of a house (see roleMemberId). */
  runnerId(houseIndex: number, role: number): string | null;
  /**
   * DIAGNOSTIC: why is (house, member) embodied or not, right now? Re-runs
   * the candidacy decision for that one member and names the gate that ate
   * it — including the desync the model can't see on its own: `bodies` says
   * embodied while the world holds no avatar (a "ghost": never re-spawned,
   * never despawned). Read-only.
   */
  explain(
    p: Pt,
    now: number,
    houseIndex: number,
    member: number,
    bodyPos: (id: string) => Pt | null,
    isVisible?: (houseIndex: number) => boolean,
  ): string;
  /** Drop the model's embodiment record for `id` (ghost self-heal): the next
   *  update re-decides it from scratch and spawns it properly. */
  dropBody(id: string): void;
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

  /** The house's INTERIOR anchor — the LIVING room's center (the table's
   *  room), never the raw footprint center: once a house partitions
   *  (rooms.ts) the footprint center can sit ON the partition wall. */
  const houseCenter = (h: TownHouse): Pt => {
    const r = livingRect(center, h);
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  };
  const inHouseRect = (pt: Pt, h: TownHouse): boolean =>
    pt.x > center.x + h.dx && pt.x < center.x + h.dx + h.w &&
    pt.y > center.y + h.dy && pt.y < center.y + h.dy + h.h;
  const roomPlans = new Map<number, HouseRoomPlan>();
  const roomPlanOf = (h: TownHouse): HouseRoomPlan => {
    let p = roomPlans.get(h.index);
    if (!p) {
      p = houseRoomPlan(center, h);
      roomPlans.set(h.index, p);
    }
    return p;
  };
  /** Deterministic indoor spot for member m — inside their OWN room
   *  (rooms.ts memberRoomOf): five people in a house are five bodies in
   *  their rooms, not a stack at the footprint's center (which may now
   *  be a wall). */
  const memberSpot = (h: TownHouse, m: number): Pt => {
    const rng = mulberry32(hashSeed(seed, `member:${h.index}:${m}`));
    const r = memberRoomOf(roomPlanOf(h), m).rect;
    return {
      x: r.x + 1.2 + rng() * Math.max(0.5, r.w - 2.4),
      y: r.y + 1.2 + rng() * Math.max(0.5, r.h - 2.4),
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
  /** The house's DUTY ROSTER (kernel/town/roster.ts) — the ONE allocator of
   *  member↔duty. Exclusions (quest-cast bodies) are folded in per house, so
   *  role handover survives them and a one-soul house still covers food.
   *  JOBS staff every work building from the nearest households' duty-free
   *  members (projection-only: bodies at workplaces render the aggregate's
   *  production; household-duties-and-sims-mode.md §2). */
  const goodDefs = goods.map((g, i) => ({ key: g.good.key, slot: g.good.slot ?? i }));
  const jobsByHouse = assignTownJobs(
    plan.houses.map((h) => ({ index: h.index, door: houseDoorstep(center, h) })),
    // Per-spec staff where a row declares it (①b founded buildings; an
    // under-construction row carries jobs 0 and hires nobody).
    plan.works.map((wk) => ({ door: workDoorstep(center, wk), ...(wk.jobs !== undefined ? { staff: wk.jobs } : {}) })),
    goods.length,
    seed,
  );
  /** Where a worker STANDS at its workplace — the doorstep, spread by a small
   *  per-member deterministic jitter so a crew doesn't stack on one point. */
  const workStand = (work: number, houseIdx: number, m: number): Pt => {
    const d = workDoorstep(center, plan.works[work]!);
    const a = (hashSeed(seed, `stand:${work}:${houseIdx}:${m}`) / 4294967296) * Math.PI * 2;
    return { x: d.x + Math.cos(a) * 0.9, y: d.y + Math.sin(a) * 0.9 };
  };
  const rosterCache = new Map<number, ReturnType<typeof rosterOf>>();
  const houseRoster = (houseIdx: number): ReturnType<typeof rosterOf> => {
    const hit = rosterCache.get(houseIdx);
    if (hit) return hit;
    const ex = new Set<number>();
    for (let m = 0; m < HOUSEHOLD; m++) {
      if (excluded.has(residentId(houseIdx, m))) ex.add(m);
    }
    const r = rosterOf(goodDefs, ex, jobsByHouse.get(houseIdx));
    rosterCache.set(houseIdx, r);
    return r;
  };
  /** The member filling errand ROLE `role` — the roster's shop assignment. */
  const runnerId = (houseIdx: number, role: number): string | null => {
    const roster = houseRoster(houseIdx);
    for (let m = 0; m < HOUSEHOLD; m++) {
      if (shopDutyOf(roster[m])?.role === role) return residentId(houseIdx, m);
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
  let _tripLogAt = -Infinity; // TEMP trip-emit probe pacing
  // ── EMBODIMENT DWELL (view-distance-lod-tiers.md rework) ──────────────────
  // The desired set is a pure function of CONTINUOUS inputs (distances to a
  // moving viewer, rank among moving bodies, budget) — marginal bodies sit on
  // a decision boundary and, stateless, flip across it EVERY FRAME: a
  // spawn+despawn pair per body per frame, each spawn re-shipping its mid-trip
  // walkTo as a fresh errand (the measured `spawn=25 trips=0` storm).
  // Embodiment is therefore an EVENT WITH A DWELL, not a per-frame re-vote:
  // once embodied a body holds ≥EMBODY_HOLD_S (unless its whole basis is gone),
  // once abstracted it stays ≥ABSTRACT_HOLD_S, and at most SPAWN_STREAM bodies
  // materialize per frame (the town's FIRST frame is exempt — it must start
  // populated, mid-errand, per the pop-in rule below).
  const EMBODY_HOLD_S = 4;
  const ABSTRACT_HOLD_S = 2;
  const SPAWN_STREAM = 6;
  const embodiedAt = new Map<string, number>();
  const abstractedAt = new Map<string, number>();
  let lastNow = 0; // last update() clock — dwell anchor for out-of-frame drops
  /** Last observed in-shift state per body — commute trips fire on the edge. */
  const jobPhase = new Map<string, boolean>();
  /** Houses whose interior was on show LAST update — a homecoming into a
   *  CONTINUOUSLY WATCHED interior walks in through the door (units never
   *  "suddenly reappear" in front of the player); a freshly-revealed house
   *  spawns its members at their spots (they were home all along). */
  const lastVisible = new Set<number>();
  /** False until the first update: the town's FIRST frame populates freely —
   *  mid-errand clocks put people on the streets from minute zero (nothing is
   *  on show yet to contradict), and only then do the view guards arm. */
  let primed = false;

  const update = (
    p: Pt,
    now: number,
    budget: number,
    bodyPos: (id: string) => Pt | null,
    visibleR?: number,
    isVisible?: (houseIndex: number) => boolean,
    isRoomVisible?: (buildingId: string) => boolean,
    isHousePooled?: (houseIndex: number) => boolean,
    isBusy?: (id: string) => boolean,
  ): ResidentUpdate => {
    // A house's interior is ON SHOW when its roof is transparent — the player
    // OCCUPIES it (an open door you're outside of doesn't reveal it; the roof
    // stays opaque). Every embodiment/abstraction gate below reads this. No
    // signal supplied ⇒ fall back to the raw footprint test.
    const isHouseVisible = (h: TownHouse): boolean =>
      isVisible ? isVisible(h.index) : inHouseRect(p, h);
    // CANDIDACY MUST COVER THE SPAWN RING (spirit-view churn, 2026-07-23): the
    // view guard relocates open-ground spawns to `visibleR + 8`, and a spirit
    // camera's whole-town visibleR exceeds street-level PEOPLE_R — a body
    // flung to that ring held no candidacy, was culled at dwell expiry,
    // re-desired, re-flung: a ~6 s spawn/despawn loop per body, each cycle
    // re-routing its long walk and rebuilding its model (the measured 7 fps
    // dollhouse collapse). Same rule the haulers already use (town-stage
    // embodyR): the band people may EXIST in must contain the band they
    // ENTER through.
    const peopleR = Math.max(PEOPLE_R, (visibleR ?? 0) + 16);
    const firstFrame = !primed;
    primed = true;
    lastNow = now; // dwell anchor for dropBody (called outside update's frame)
    // THE VIEW GUARD's "can the camera see this point": within the renderer's
    // world reach (`visibleR` — a circle approximating the frustum) and NOT
    // hidden inside a concealed interior (an unwatched house, any work
    // building). Bodies may appear/disappear ONLY where this is false — a
    // spawn or cull the player can watch is a teleport, and teleports are the
    // one thing the fiction can never survive. No visibleR (a headless/2D
    // caller) leaves the guards inert.
    const hiddenIndoors = (pt: Pt): boolean => {
      for (const h of plan.houses) {
        if (!inHouseRect(pt, h)) continue;
        if (!isHouseVisible(h)) return true;
        // ROOM GRANULARITY (round 4 — a house is one building PER ROOM):
        // "house visible" means SOME room is on show, not the whole
        // interior. Standing in the living room, the camera cannot see
        // into a closed bedroom — an unrevealed room of a visible house
        // is legitimate concealment (the round-3c spawn cover), and
        // blocking it was why re-entered houses spawned their members a
        // whole view-radius up the road instead of at home. Callers
        // without a per-room signal (2D) keep the house-granular read.
        if (isRoomVisible) {
          const room = roomPlanOf(h).rooms.find(
            (r) =>
              pt.x >= r.rect.x && pt.x <= r.rect.x + r.rect.w &&
              pt.y >= r.rect.y && pt.y <= r.rect.y + r.rect.h,
          );
          if (room && !isRoomVisible(room.id)) return true;
        }
        return false;
      }
      return plan.works.some(
        (wk) =>
          pt.x > center.x + wk.dx && pt.x < center.x + wk.dx + wk.w &&
          pt.y > center.y + wk.dy && pt.y < center.y + wk.dy + wk.h,
      );
    };
    const inView = (pt: Pt): boolean =>
      visibleR !== undefined && Math.hypot(pt.x - p.x, pt.y - p.y) < visibleR && !hiddenIndoors(pt);
    interface Candidate extends ResidentSpawn {
      d: number;
      rank: number;
      run?: GoodRun;
      cycle?: number;
    }
    const candidates: Candidate[] = [];
    const visibleNow = new Set<number>();

    for (const house of plan.houses) {
      // COHORT TIER (④): a pooled house streams nobody — its souls are a
      // district statistic until promotion returns them.
      if (isHousePooled?.(house.index)) continue;
      const door = houseDoorstep(center, house);
      const houseVisible = isHouseVisible(house);
      if (houseVisible) visibleNow.add(house.index);
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
        // JOB duty (roster): inside its shift window the member belongs at
        // its workplace — spawn there, don't cull there, commute at edges.
        const jd = jobDutyOf(houseRoster(house.index)[m]);
        const working = jd ? inShiftWindow(jd.window, now, FOOD_DAY_SEC) : false;
        const job = jd ? { window: jd.window, workPos: workStand(jd.work, house.index, m) } : null;

        if (bodies.has(id)) {
          // Already embodied: candidacy from its LIVE position. A member of a
          // WATCHED house is never distance-culled — the observed family stays
          // loaded through its whole commute/errand (despawning mid-walk is
          // what made returns read as teleports).
          const at = bodyPos(id) ?? door;
          const d = Math.hypot(at.x - p.x, at.y - p.y);
          if (d > peopleR && !houseVisible) continue;
          // `idle` = no schedule holds the body: a homebody off-shift, or a
          // runner whose trip window is closed (phase "home"). A shopper
          // still walking back is phase "to_home" — NOT idle — so it's never
          // culled mid-return; a worker mid-shift is likewise held.
          const idle = (!run || run.goods.errand(house, now).phase === "home") && !working;
          // ABSTRACT ON ARRIVAL: once a body has finished its tasks (idle) AND
          // is back inside its own house, with the player NOT in there to see
          // it, cull it now instead of letting it linger indoors. Returning
          // shoppers were piling up embodied at home → steadily growing the
          // live cast until it lagged. It re-pops through its door when its
          // next trip's window opens. The interior is hidden, so the despawn is
          // unseen; the pantry it was heading for reads its closed form while
          // unwatched (the witnessed fill only matters when you're inside).
          if (idle && !houseVisible && inHouseRect(at, house)) continue;
          const rank = despawnPriority({ d, idleHidden: idle && !houseVisible, embodied: true });
          candidates.push({
            // The wander anchor is the member's OWN deterministic spot — the
            // shared houseCenter piled every runner onto one point (and onto
            // the table that stands there).
            id, d, rank, x: at.x, y: at.y, home: memberSpot(house, m),
            wanderRadius: INDOOR_WANDER_R, indoor: false, house: house.index, member: m, run,
          });
          continue;
        }

        // WHERE IS THIS MEMBER RIGHT NOW — the ONE shared mid-task function (activity.ts):
        // composes the SHOP schedule (runner only) with the EAT schedule, so a member
        // loaded mid-trip spawns walking and one loaded mid-MEAL spawns at the table, from
        // the SAME call. A homebody never shops (shop = null) — it only ever eats or idles.
        // AN ON-SHOW HOUSE IS THE LIVE LOOP'S (§13): while the player watches the
        // interior, the chests are the truth and the LIVE needs loop does the real
        // shopping — the abstract schedule must not ALSO project trips (a stale
        // empty-chest schedule loops endless trips: the member never reads "home",
        // never wins embodiment at trip distance, and is simply never there).
        const shop = run && !houseVisible ? run.goods.errand(house, now) : null;
        const activity = creatureActivityAt({
          shop,
          job,
          mealOff: mealOffset(seed, house.index, m),
          tablePos: houseCenter(house), // the eating place (≈ the house table)
          // Every member idles at its OWN spot — runners too (houseCenter
          // stacked them all on one point, on top of the table).
          homeSpot: memberSpot(house, m),
          t: now,
        });

        if (activity.task === "work") {
          // MID-SHIFT — at the workplace. Public space: embodies by street
          // proximity like a mid-trip shopper (no roof gate), shuffling on
          // the indoor tether around its stand. A watched house's member
          // embodies at work at ANY distance (the family stays loaded).
          const d = Math.hypot(activity.pos.x - p.x, activity.pos.y - p.y);
          if (d > peopleR && !houseVisible) continue;
          // The stand is on the workplace DOORSTEP — open ground. In view,
          // enter THROUGH the building instead: the generic relocation would
          // fling the body to the visibleR ring (the spirit-camera churn).
          let at = activity.pos;
          let walkTo: TripPoint[] | undefined;
          const wk2 = jd ? plan.works[jd.work] : undefined;
          if (!firstFrame && visibleR !== undefined && d < visibleR && wk2) {
            at = { x: center.x + wk2.dx + wk2.w / 2, y: center.y + wk2.dy + wk2.h / 2 };
            const t2 = doorTransit(center, wk2);
            walkTo = [t2.inside, t2.outside, { x: activity.pos.x, y: activity.pos.y }];
          }
          candidates.push({
            id, d, rank: despawnPriority({ d }), x: at.x, y: at.y, home: activity.pos,
            wanderRadius: INDOOR_WANDER_R, ...(walkTo ? { walkTo } : {}),
            indoor: false, house: house.index, member: m, run,
          });
          continue;
        }

        if (activity.task !== "shop") {
          // AT HOME — idle at its own spot, or mid-MEAL at the table. Indoors: the same
          // inside-only rule as before (embody only while the interior is on show).
          if (!homeNear) continue;
          const spot = activity.pos;
          const d = Math.hypot(spot.x - p.x, spot.y - p.y);
          if (d > peopleR) continue;
          const rank = despawnPriority({ d, idleHidden: !houseVisible });
          if (houseVisible && lastVisible.has(house.index)) {
            // The player WATCHED this interior while the member was away
            // (a trip that finished abstracted, a live errand evicted far
            // off) — the homecoming WALKS IN through the door, never
            // materializes at its spot in front of them.
            const dt = doorTransit(center, house);
            candidates.push({
              id, d, rank, x: dt.outside.x, y: dt.outside.y,
              home: memberSpot(house, m),
              wanderRadius: INDOOR_WANDER_R,
              walkTo: [dt.inside, { x: spot.x, y: spot.y }],
              indoor: false, house: house.index, member: m, run,
            });
            continue;
          }
          candidates.push({
            id, d, rank, x: spot.x, y: spot.y,
            home: activity.task === "eat" ? houseCenter(house) : spot,
            wanderRadius: INDOOR_WANDER_R, indoor: true, house: house.index, member: m, run,
          });
          continue;
        }

        // OUT ON A SHOPPING TRIP (mid-trip) — the shared function handed back the errand.
        const est = activity.errand!;
        const src = run!.goods.sourceOf(house);
        if (segDist(door, src, p) > peopleR + 120) continue;
        const d = Math.hypot(est.pos.x - p.x, est.pos.y - p.y);
        if (d > peopleR) continue;
        const rank = despawnPriority({ d });

        // POP-IN: people enter the world through buildings — except on the
        // town's FIRST frame, when mid-errand clocks spawn people right on
        // the lanes (the streets must start populated, not fill up as the
        // player waits).
        let at = est.pos;
        let walkTo = est.walkTo ?? undefined;
        const indoor = false;
        let exitFirst = false;
        if (!firstFrame && visibleR !== undefined && d < visibleR) {
          if (est.phase === "to_source" && !houseVisible) {
            // A trip STARTING in view: enter the world inside the (concealed)
            // home and walk the WHOLE trip — the neighbor is SEEN leaving
            // through its own door, never materializing mid-street.
            at = houseCenter(house);
            exitFirst = true; // the door bracket below exits home first
          } else {
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
            } else if (!houseVisible) {
              // OPEN-AIR source (a stall, a well): no building to enter the
              // world through, and the stall stands on visible ground — the
              // generic relocation below would fling the body to the visibleR
              // ring, which under a spirit camera lies past candidacy and off
              // the walkable town (girth-rejected or churned; the dollhouse
              // 7 fps collapse). The concealed HOME is the honest entry: step
              // out of the house and walk the trip. A return leg has no such
              // cover — it finishes abstract (the box gets its goods; the
              // next appearance is from home).
              if (est.phase === "to_home") continue;
              at = houseCenter(house);
              exitFirst = true;
            }
          }
        }
        // A mid-trip body ends its errand back through its own door (and a
        // home-interior entry leaves through it first).
        if (walkTo && !indoor) walkTo = throughDoor(house, walkTo, exitFirst, run!.box(house));
        candidates.push({
          id, d, rank, x: at.x, y: at.y, home: memberSpot(house, m),
          wanderRadius: INDOOR_WANDER_R, ...(walkTo ? { walkTo } : {}),
          indoor, house: house.index, member: m, run, cycle: est.cycle,
        });
      }
    }

    candidates.sort((a, b) => a.rank - b.rank);

    // THE FAMILY LOCK — UNBUDGETED: every member of a WATCHED interior keeps
    // (or claims) its body, at any distance. They used to compete by distance
    // rank like everyone else, which broke two ways: a watched member walking
    // away (the well, a commute) would lose its body to closer street
    // residents, finish the errand ABSTRACTLY, and re-enter the world by
    // MATERIALIZING at its own doorstep in front of the player (the reported
    // teleport); and when several revealed households together crowded the
    // budget, members at the rank boundary THRASHED in and out of embodiment
    // every frame (spawn → despawn → doorstep respawn, in a visible loop).
    // Budget is a background-crowd guard; the watched families ARE the scene —
    // they ride on top of it, and the street fill below keeps its full
    // allowance so open roofs don't empty the lanes.
    const desired = new Map<string, Candidate>();
    const houseOf = new Map(plan.houses.map(h => [h.index, h] as const));
    for (const c of candidates) {
      if (!desired.has(c.id) && visibleNow.has(c.house)) desired.set(c.id, c);
    }
    const lockedN = desired.size;
    // THE LOCK: spawned bodies beside the player hold their slots next
    // (an idle body inside its own house holds no lock unless that house's
    // interior is visible); the rest fills best-rank-first.
    for (const c of candidates) {
      if (desired.size >= budget + lockedN) break;
      if (desired.has(c.id) || !bodies.has(c.id) || c.d >= PEOPLE_EVICT_MIN) continue;
      const h = houseOf.get(c.house);
      if (h && inHouseRect(c, h) && !isHouseVisible(h)) continue;
      desired.set(c.id, c);
    }
    for (const c of candidates) {
      if (desired.size >= budget + lockedN) break;
      if (!desired.has(c.id)) desired.set(c.id, c);
    }

    const spawn: ResidentSpawn[] = [];
    const despawn: string[] = [];
    for (const id of bodies.keys()) {
      if (!desired.has(id)) {
        // THE BUSY PIN (⑥ — recruited civic workers): a body the host has
        // claimed for real work is NEVER culled, at any distance — a hauler
        // vanishing mid-carry would strand its agreement. It keeps its body
        // and its slot; the normal cull resumes the frame the work ends.
        if (isBusy?.(id)) continue;
        // THE VIEW GUARD, cull half: never remove a body the camera can SEE —
        // a visible pop-out is a teleport. It keeps its body this frame and
        // re-competes next frame; culling lands once it walks out of view or
        // into a concealed interior. (Which bodies get here at all is the
        // despawnPriority function's job — edit ordering THERE.)
        const at = bodyPos(id);
        if (!firstFrame && at && inView(at)) continue;
        // EMBODIMENT DWELL: a freshly-embodied body is not un-decided by the
        // next frame's rank jitter — it holds its slot for the dwell. CONCEALED
        // interiors are exempt (abstract instantly, the historical rule): the
        // despawn is invisible there, and re-embodiment is paced by the
        // ABSTRACT dwell anyway — so a flapping reveal damps, never loops.
        if (
          !firstFrame && at !== null && !hiddenIndoors(at) &&
          now - (embodiedAt.get(id) ?? -Infinity) < EMBODY_HOLD_S
        ) continue;
        despawn.push(id);
        bodies.delete(id);
        jobPhase.delete(id);
        embodiedAt.delete(id);
        abstractedAt.set(id, now);
        // tripSent is KEPT: the trip gate is idempotent per (id, CYCLE) — a
        // body despawned and respawned inside the same shopping cycle resumes
        // its trip silently instead of re-emitting it (entries retire when
        // the cycle advances; the map is bounded by the resident count).
      }
    }
    let streamed = 0;
    for (const [id, c] of desired) {
      if (bodies.has(id)) continue;
      const h = houseOf.get(c.house);
      if (!h) continue;
      if (!firstFrame) {
        // ABSTRACT DWELL: a just-abstracted body doesn't re-materialize on the
        // next frame's rank jitter — and a spawn the host refused (dropBody)
        // retries on this same pacing rather than every frame.
        if (now - (abstractedAt.get(id) ?? -Infinity) < ABSTRACT_HOLD_S) continue;
        // STREAM-IN BUDGET: embodiment is paced like every other pipeline
        // stage — a burst of newly-desired bodies materializes over a few
        // frames, never as one spike. (First frame exempt: populated start.)
        if (streamed >= SPAWN_STREAM) continue;
      }
      streamed++;
      // THE VIEW GUARD, spawn half: never MATERIALIZE where the camera can
      // see. Concealed-interior entries pass untouched (people enter the
      // world through buildings); a spawn point on visible ground relocates
      // just past the view edge along its approach ray and WALKS in — the
      // doorstep homecoming becomes a figure coming up the road. The first
      // frame is exempt: the town starts POPULATED (mid-errand clocks put
      // people on the streets at minute zero), it doesn't fill in while the
      // player watches.
      let sx = c.x;
      let sy = c.y;
      let walkTo = c.walkTo;
      if (!firstFrame && inView(c)) {
        // CONCEALED-ROOM COVER first: a spawn point inside the member's own
        // VISIBLE house that is still in view (the living room, the table
        // mid-meal, a studio) materializes in an UNREVEALED room of the same
        // house and walks out — someone who was home all along steps out of
        // the bedroom, never treks a whole view-radius up the road.
        const cover =
          isRoomVisible && inHouseRect(c, h)
            ? roomPlanOf(h)
                .rooms.filter((r) => !isRoomVisible(r.id))
                .map((r) => ({ x: r.rect.x + r.rect.w / 2, y: r.rect.y + r.rect.h / 2 }))
                .sort((a, b) => Math.hypot(a.x - c.x, a.y - c.y) - Math.hypot(b.x - c.x, b.y - c.y))[0]
            : undefined;
        if (cover) {
          sx = cover.x;
          sy = cover.y;
          walkTo = [{ x: c.x, y: c.y }, ...(walkTo ?? [])];
        } else {
          const dx = c.x - p.x;
          const dy = c.y - p.y;
          const len = Math.hypot(dx, dy) || 1;
          const R = (visibleR ?? 0) + 8;
          sx = p.x + (dx / len) * R;
          sy = p.y + (dy / len) * R;
          walkTo = [{ x: c.x, y: c.y }, ...(walkTo ?? [])];
        }
      }
      bodies.set(id, { house: h, member: c.member });
      embodiedAt.set(id, now); // dwell anchor — holds the slot against rank jitter
      spawn.push({
        id, x: sx, y: sy, home: c.home, wanderRadius: c.wanderRadius,
        ...(walkTo ? { walkTo } : {}),
        indoor: c.indoor, house: c.house, member: c.member,
      });
      // Their current trip is already underway — don't re-issue it.
      if (c.walkTo && c.cycle !== undefined) tripSent.set(id, c.cycle);
    }

    // LIVE TRIPS: an embodied runner whose cycle entered its trip window
    // goes out — once per cycle, door-bracketed both ends. NEVER for an
    // on-show house: there the LIVE needs loop shops for real (same §13 rule
    // as candidacy above) — the stale schedule was marching watched families
    // in and out of their own door on endless ghost errands.
    const trips: ResidentUpdate["trips"] = [];
    for (const [id, b] of bodies) {
      if (isBusy?.(id)) continue; // ⑥ pin: the host owns this body's feet
      if (isHousePooled?.(b.house.index)) continue; // pooled: no fresh trips
      if (isHouseVisible(b.house)) continue;
      const run = runs.find(r => runnerId(b.house.index, r.role) === id);
      if (!run) continue;
      const est = run.goods.errand(b.house, now);
      if (est.phase === "home" || !est.walkTo) continue;
      // A non-finite cycle can never satisfy the once-per-cycle gate below
      // (NaN ≠ NaN) — it would re-emit this trip EVERY FRAME forever. A house
      // whose cycle is degenerate (poisoned offset, zero-period good) sends
      // nobody rather than an infinite stream. (goods.ts reanchor guards the
      // known poison source; this is the belt to its braces.)
      if (!Number.isFinite(est.cycle)) continue;
      if (tripSent.get(id) === est.cycle) continue;
      // TEMP trip-emit probe (view-distance-lod-tiers.md): a steady per-frame
      // stream means the gate below never holds — log WHY: is `cycle` jumping
      // (offset re-anchored under the runner) or `prev` missing (tripSent
      // cleared by a despawn)? ≤1 line/sim-second. Remove with the probes.
      if (probesOn() && typeof console !== "undefined" && now - _tripLogAt > 1) {
        _tripLogAt = now;
        console.log(`[trip-emit] ${id} cyc=${est.cycle} prev=${tripSent.get(id) ?? "none"} phase=${est.phase} sent=${tripSent.size}`);
      }
      tripSent.set(id, est.cycle);
      trips.push({ id, points: throughDoor(b.house, est.walkTo, true, run.box(b.house)) });
    }

    // COMMUTES: an embodied worker crossing its shift boundary walks to work /
    // back home (edge-detected, like trips-once-per-cycle). The door transits
    // bracket the HOUSE end; the application layer door-routes from the live
    // position anyway, so a body caught elsewhere still walks sensibly. First
    // observation of a body seeds silently — its spawn already placed it right.
    for (const [id, b] of bodies) {
      if (isBusy?.(id)) continue; // ⑥ pin: no commute pulls a working hauler
      if (isHousePooled?.(b.house.index)) continue; // pooled: no commutes
      const m = bodies.get(id)!.member;
      const jd = jobDutyOf(houseRoster(b.house.index)[m]);
      if (!jd) continue;
      const working = inShiftWindow(jd.window, now, FOOD_DAY_SEC);
      const prev = jobPhase.get(id);
      jobPhase.set(id, working);
      if (prev === undefined || working === prev) continue;
      const d = doorTransit(center, b.house);
      const stand = workStand(jd.work, b.house.index, m);
      trips.push({
        id,
        points: working
          ? [d.inside, d.outside, stand]
          : [d.outside, d.inside, memberSpot(b.house, m)],
      });
    }

    lastVisible.clear();
    for (const h of visibleNow) lastVisible.add(h);
    return { spawn, despawn, trips };
  };

  const explain = (
    p: Pt,
    now: number,
    houseIndex: number,
    member: number,
    bodyPos: (id: string) => Pt | null,
    isVisible?: (houseIndex: number) => boolean,
  ): string => {
    const house = plan.houses.find((h) => h.index === houseIndex);
    if (!house) return `house ${houseIndex} not in plan`;
    const id = residentId(houseIndex, member);
    if (excluded.has(id)) return "EXCLUDED (cast double / family overflow — never embodied)";
    const at = bodyPos(id);
    if (bodies.has(id)) {
      return at
        ? `embodied @${at.x.toFixed(1)},${at.y.toFixed(1)} (d=${Math.hypot(at.x - p.x, at.y - p.y).toFixed(0)})`
        : "GHOST: model says embodied but the world has NO avatar — never re-spawns (dropBody heals)";
    }
    if (at) return "INVERSE GHOST: world has an avatar the model doesn't own";
    const houseVisible = isVisible ? isVisible(house.index) : inHouseRect(p, house);
    const run = runs.find((r) => runnerId(house.index, r.role) === id);
    const jd = jobDutyOf(houseRoster(house.index)[member]);
    const job = jd
      ? { window: jd.window, workPos: workStand(jd.work, house.index, member) }
      : null;
    const shop = run ? run.goods.errand(house, now) : null;
    const activity = creatureActivityAt({
      shop,
      job,
      mealOff: mealOffset(seed, house.index, member),
      tablePos: houseCenter(house),
      homeSpot: memberSpot(house, member),
      t: now,
    });
    const d = Math.hypot(activity.pos.x - p.x, activity.pos.y - p.y);
    const base = `task=${activity.task} pos=${activity.pos.x.toFixed(1)},${activity.pos.y.toFixed(1)} d=${d.toFixed(0)}`;
    if (activity.task === "work") {
      return d > PEOPLE_R ? `${base} — NOT a candidate: workplace beyond PEOPLE_R ${PEOPLE_R}` : `${base} — candidate at work (budget/rank decides)`;
    }
    if (activity.task !== "shop") {
      if (!houseVisible) return `${base} — NOT a candidate: home-phase, interior not on show`;
      if (d > PEOPLE_R) return `${base} — NOT a candidate: beyond PEOPLE_R`;
      return `${base} — candidate at home (budget/rank decides)`;
    }
    const src = run!.goods.sourceOf(house);
    const door = houseDoorstep(center, house);
    if (segDist(door, src, p) > PEOPLE_R + 120) return `${base} — NOT a candidate: whole trip route beyond PEOPLE_R+120`;
    if (d > PEOPLE_R) return `${base} — NOT a candidate: trip position beyond PEOPLE_R`;
    return `${base} — candidate mid-trip (budget/rank decides)`;
  };

  return {
    update,
    runnerId,
    explain,
    dropBody: (id: string) => {
      bodies.delete(id);
      tripSent.delete(id);
      jobPhase.delete(id);
      embodiedAt.delete(id);
      // A dropped body (host refused the spawn / GHOST heal) retries on the
      // abstract dwell's pacing — never on the next frame.
      abstractedAt.set(id, lastNow);
    },
    reset: () => {
      primed = false; // a fresh host repopulates freely again
      bodies.clear();
      tripSent.clear();
      jobPhase.clear();
      lastVisible.clear();
      embodiedAt.clear();
      abstractedAt.clear();
    },
  };
}
