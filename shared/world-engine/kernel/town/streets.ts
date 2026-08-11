/**
 * streets.ts — the ORGANIC street skeleton of a town. A town is grown as a
 * STREET TREE from its SEEDS by a deterministic event stream: each round
 * every live street extends one step (with gentle heading drift) and
 * recorded branch ports may sprout side lanes. Every extension step emits
 * the house lots that front it, so the global slot sequence is the order
 * construction happened — the lot list IS the town's development history,
 * and prefix stability falls out (city-development.md §2b: the map reads
 * as accretion because it is one). Same scalars + seeds ⇒ byte-identical
 * streets; a bigger town runs the SAME event stream further, so streets
 * only extend and lots only append.
 *
 * KILL THE HUB (growth-unification.md §3, phase B). There is no plaza
 * ring and no special point. Street 0 is the BASELINE — an OPEN path the
 * town formed around, in preference order:
 *
 *   1. a SPAN seed — the intercity route's polyline clipped to the town
 *      extent, port to port. The trade road is literally the structure
 *      the town grew around; further spans attach at their crossing.
 *   2. a SPINE seed — the access lanes joining the founding homesteads.
 *   3. a STUB seed — a lone founder in trackless wilderness: a short
 *      baseline along the best bearing. The degenerate case, never the
 *      template.
 *
 * Arterials root ON the baseline at spaced ATTACHMENT STATIONS; every
 * other lane branches off them. The town's CENTER is an output (whichever
 * junction the traffic makes busiest — plan.ts), never an input.
 *
 * LOOPS (growth phase C §2). The tree is the substrate and stays one —
 * but a tree is what MAKES a chord-to-walked ratio, and phase B measured
 * the price: a 30–45 m gap between two lanes that the tree sends people
 * 400–750 m around. `TownStreets.links` is the overlay that closes those:
 * short connectors emitted DURING growth, at the moment a lane dies
 * against a street it has walked half the town to reach. They own no lots
 * and no arm and never touch a street's `pts`, so the development history
 * above is untouched — the map still reads as accretion, with the
 * shortcuts the accretion earned.
 *
 * Routing: a position is (street, arc). With no links, door-to-door paths
 * climb parent chains to the deepest common street (ultimately the
 * baseline, which every arterial roots on) and walk the difference —
 * O(depth), and still the answer for every town that never closed a loop.
 * With links it is a shortest path over the graph of junctions, link ends
 * and the trip's own two projections. Either way `roadRoute` materializes
 * the same path as waypoints that lie ON streets, preserving the old
 * contract: NPCs walk like people, never through a parlor.
 */

/* ------------------------------ types ------------------------------- */

export interface Vec2 {
  x: number;
  y: number;
}

/** An axis-aligned town-local footprint streets must bend around. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * WHAT THE TOWN GREW AROUND (phase B §1.1). Town-local metres. The seed
 * set is recorded at founding and replayed verbatim, so regrowth stays
 * prefix-consistent exactly as the `bearings` echo used to guarantee.
 */
export type GrowSeed =
  /** A through-route's span across the extent. `portA`/`portB` mark which
   *  ends are real PORTS (where the region's road continues) rather than
   *  loose ends the town may grow past. */
  | { kind: "span"; pts: Vec2[]; portA?: true; portB?: true }
  /** Founding homesteads' access lanes (phase C feeds the full set). */
  | { kind: "spine"; lanes: Vec2[][] }
  /** A bare direction — "there is a road out that way". */
  | { kind: "stub"; bearing: number };

export interface Street {
  id: number;
  /** 0 = the baseline AND the arterials rooted on it; +1 per branch. */
  gen: number;
  /** Parent street id (-1 only for the baseline itself). */
  parent: number;
  /** Arc length along the parent where this street's origin attaches. */
  parentArc: number;
  /** Which arterial subtree this street descends from (0 = the baseline's
   *  own quarter — the high street). */
  arm: number;
  /** THE BASELINE (street 0): the open path the town formed around, laid
   *  whole from the seeds before any growth. Replaces the closed plaza
   *  ring — arc never wraps, so all the ring math is gone. */
  baseline?: true;
  /** Centerline polyline, origin (junction) first. */
  pts: Vec2[];
  /** Cumulative arc length at each point. */
  cum: number[];
  capped: boolean;
}

/** One house lot fronting a street — emitted in construction order. */
export interface LotSlot {
  street: number;
  side: -1 | 1;
  /** Arc of the frontage anchor along the street. */
  arc: number;
  /** Lot center (town-local meters). */
  x: number;
  y: number;
  /** Frontage anchor ON the street centerline (doors face this). */
  ax: number;
  ay: number;
  arm: number;
}

/** A GATE: the end of a street where an incident road meets the town.
 *  `end` 0 = the street's origin, 1 = its far tip (which MOVES as the
 *  street extends — resolve with `townPorts`). */
export interface TownPort {
  street: number;
  end: 0 | 1;
}

/**
 * A LOOP (growth phase C §2.1) — the short connector that closes a cycle
 * the growth TREE could not. Written ONLY by `growStreets`, at the moment
 * a street tip would otherwise have died against a foreign street it had
 * walked hundreds of metres around (§2.2).
 *
 * A link is an OVERLAY, never a `Street`: it has no id, no arm, no
 * frontage and no children, so `Street.parent/arm/pts` and every prefix
 * pin that reads them survive untouched, and the districts' arm buckets
 * never re-arm. Its ends name EXISTING positions — `pointAt(street, arc)`
 * reproduces each one exactly — so no street's `pts` is ever mutated to
 * make room for it (the `attachSeedPath` precedent: join at what is
 * already there).
 *
 * A given net object's link set is FIXED FOREVER once grown, which is
 * what keeps every routing memo sound by net identity (goods' srcCache
 * and routeCache, the lazy streetTraffic map, the director's roadMemo,
 * projCaches, construction's streetMemo).
 */
export interface StreetLink {
  /** One end: a position on the street whose tip closed the loop. */
  a: { street: number; arc: number };
  /** The other: the position on the FOREIGN street that blocked it. */
  b: { street: number; arc: number };
  /** The connector's centerline, `a`'s point first. */
  pts: Vec2[];
}

export interface TownStreets {
  streets: Street[];
  /** THE LOOPS (§2.1) — the tree's cycles, as an overlay. Empty on any town
   *  whose lanes never met a stranger worth joining, and routing then
   *  answers exactly as the pure tree climb did — bit for bit, because it
   *  IS the pure tree climb. Every routing entry point also tolerates the
   *  field being ABSENT, which is what a net serialized before loops
   *  existed (or hand-built by a fixture) honestly means: no loops. */
  links: StreetLink[];
  /** Frontage slots in EVENT ORDER — the prefix-stable lot sequence. */
  slots: LotSlot[];
  /** The seed set this tree was grown from (the GrowOpts INPUT, echoed in
   *  canonical order) — a later PREFIX-CONSISTENT regrow (founding
   *  enumeration: more slots for a founded building) must pass the same
   *  seeds. A town with no declared seed at all echoes `[]`, not the stub
   *  growth invented for it: the invention is drawn from the event stream,
   *  so replaying `[]` re-invents it and replaying the invention would not. */
  seeds: GrowSeed[];
  /** The town's PORTS, in canonical seed order. */
  ports: TownPort[];
  /** LEGACY ECHO — the bare directions among `seeds` (their STUB members),
   *  for callers still on the `bearings` input. Never a lossless echo of a
   *  span/spine seed, so a route town's list is short or empty however many
   *  roads it has. Prefer `seeds`; this dies with the fixture sweep. */
  bearings: number[];
}

/** Live world position of each port (the tip moves as streets extend). */
export function townPorts(net: TownStreets): Array<{ street: number; x: number; y: number }> {
  const out: Array<{ street: number; x: number; y: number }> = [];
  for (const p of net.ports) {
    const s = net.streets[p.street];
    if (!s || s.pts.length === 0) continue;
    const pt = p.end === 0 ? s.pts[0] : s.pts[s.pts.length - 1];
    out.push({ street: p.street, x: pt.x, y: pt.y });
  }
  return out;
}

/* ---------------------------- constants ------------------------------ */
// The physical numbers are single-sourced in dimensions.ts (the
// realistic-scale knob set); this module keeps only its own growth
// tuning (branch probabilities, jitter, generation caps).

import { TOWN_DIMS } from "./dimensions";

/** Plaza radius — the clearing a widened junction gets, and the scale a
 *  stub baseline is measured in (plan.ts owns WHERE the plaza lands). */
export const PLAZA_R = TOWN_DIMS.plazaR;
/** One growth step of street, meters. */
const STEP = TOWN_DIMS.streetStep;
/** DEFAULT declared extent of the built area (dimensions.townRMax). */
const EXTENT = TOWN_DIMS.townRMax;
/** Built town a street tip carries past its own centerline — growth is
 *  gated `extent - BUILT_MARGIN` so the plan's radius stays inside. */
const BUILT_MARGIN = TOWN_DIMS.builtMargin;
/** A street tip keeps this clear of any other street's centerline. */
const MIN_GAP = TOWN_DIMS.streetMinGap;
/** Lot centers sit this far off their street's centerline. */
const LOT_SETBACK = TOWN_DIMS.lotSetback;
/** A lot keeps this clear of any FOREIGN street's centerline. */
const LOT_CLEAR = TOWN_DIMS.lotClear;
/** Lot centers keep this far apart (the pitch along the street). */
const SLOT_GAP = TOWN_DIMS.lotPitch;
/** No lots within this arc of a street's own origin (junction mouth). */
const JUNCTION_KEEP = TOWN_DIMS.junctionKeep;
/** No lots within this arc of a branch port on the same side. */
const PORT_KEEP = TOWN_DIMS.portKeep;
/** Ports keep this much street between them (sibling lanes don't
 *  crowd each other into MIN_GAP failures). */
const PORT_SPACING = TOWN_DIMS.portSpacing;
/** Attachment stations (where arterials root) keep this much street
 *  between them. */
const STATION_SPACING = TOWN_DIMS.arterialSpacing;
/** THE JUNCTION MOUTH, in arc: how much of a neighbouring street either
 *  side of a shared junction is "legitimately close" and does not block.
 *  A lane leaving its parent (or a parent growing past its own new lane)
 *  is inside the gap by construction for the first stride or two; past
 *  this it has diverged and MIN_GAP rules again. Must exceed MIN_GAP —
 *  at exactly MIN_GAP a short baseline's own END blocks the arterial
 *  rooted at its middle. */
const MOUTH_ARC = MIN_GAP + STEP;
/** A failed port retries this many times before it is spent (later
 *  attempts jitter differently — a lane finds its way eventually). */
const PORT_TRIES = 3;
/** Streets deeper than this never branch (arterial → lane → alley…). */
const MAX_GEN = 6;
/** Length caps by gen (arterials run to the extent instead). */
const MAX_LEN = [Infinity, 450, 320, 220, 160, 120, 90];
/** Per extension step per side: chance the slot becomes a branch PORT. */
const PORT_P = [0.34, 0.3, 0.24, 0.18, 0.12, 0.1, 0];
/** Per round per unused port: chance it fires (tries to sprout). */
const FIRE_P = [0.45, 0.32, 0.24, 0.18, 0.14, 0.12, 0];
/** Heading jitter per step / persistent curvature range (radians). */
const JIT = 0.28;
const CURV = 0.05;
/** How far a station may swing its arterial off the baseline's own
 *  normal toward the seed bearing. A road that arrives nearly parallel
 *  to the baseline still has to LEAVE it, or it dies at step one. */
const STATION_SWING = 1.0;
/** Un-served ground (metres of open run out from a free station) that
 *  licenses a re-seeded arterial. */
const COVERAGE_MIN_RUN = 4 * STEP;
/**
 * THE CLOSURE BAR (growth phase C §2.2): how many times its own chord a
 * dying tip's TREE detour to the street blocking it must be before the
 * two are joined. Below the bar the tree already goes that way and a link
 * would only be a shortcut through somebody's garden; above it, the tree
 * is sending people the long way round a wall they are standing at.
 *
 * THERE IS NO NATURAL GAP TO SIT IN. Measured at the rejection itself
 * rather than on the finished map, the ratios run continuously from 1 to
 * 24 — half of them below 2, where the tree already goes that way. So the
 * bar was SWEPT against the acceptance metric instead (9 values × 3 towns,
 * a full re-lay each): 4 is the last rung where every town's ≥3× tail still
 * improves, and below it the metric turns NON-MONOTONE, because closing a
 * loop changes the growth stream and more links is not shorter walks. Full
 * distribution and sweep table: the ledger's stage-2 landing notes.
 */
const LOOP_MIN_RATIO = 4;
/** A LINK holds its ground against later growth — nothing may be built over
 *  a lane — but it holds an ALLEY's worth, not an arterial's. A shortcut is
 *  a narrow thing cut through the gap between two streets, and MIN_GAP is
 *  the distance that keeps two THOROUGHFARES from crowding. At the full gap
 *  a link walls off the ground it was cut across and the town stops closing
 *  loops there (MEASURED: 189 links instead of 248, and seed 23's worst leg
 *  came out WORSE than doing nothing). At half, nothing is ever built over
 *  and the loops survive. */
const LINK_GAP = MIN_GAP / 2;

/* ------------------------ deterministic rng -------------------------- */

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

/* -------------------------- spatial hash ----------------------------- */

const CELL = 24;

class PointGrid<T extends Vec2> {
  private cells = new Map<string, T[]>();
  add(p: T): void {
    const k = `${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)}`;
    const c = this.cells.get(k);
    if (c) c.push(p);
    else this.cells.set(k, [p]);
  }
  /** All stored points within `r` of `p` (conservative cell sweep). */
  near(p: Vec2, r: number): T[] {
    const out: T[] = [];
    const x0 = Math.floor((p.x - r) / CELL);
    const x1 = Math.floor((p.x + r) / CELL);
    const y0 = Math.floor((p.y - r) / CELL);
    const y1 = Math.floor((p.y + r) / CELL);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const c = this.cells.get(`${cx},${cy}`);
        if (!c) continue;
        for (const q of c) {
          if (Math.hypot(q.x - p.x, q.y - p.y) <= r) out.push(q);
        }
      }
    }
    return out;
  }
}

interface StreetPt extends Vec2 {
  street: number;
  arc: number;
}

/* ----------------------------- growth -------------------------------- */

interface Port {
  street: number;
  arc: number;
  side: -1 | 1;
  /** Sprout attempts left; 0 = spent. */
  tries: number;
}

/** Where an arterial may root on an existing street: an arc position and
 *  the side it leaves by (side 0 = straight on past the street's end —
 *  the baseline's own continuation). */
interface Station {
  street: number;
  arc: number;
  side: -1 | 0 | 1;
  /** Outward direction the station faces (radians). */
  bearing: number;
}

interface GrowState {
  streets: Street[];
  /** The loops closed so far (§2.2) — appended in event order. */
  links: StreetLink[];
  slots: LotSlot[];
  ports: Port[];
  ptGrid: PointGrid<StreetPt>;
  slotGrid: PointGrid<LotSlot>;
  /** Live heading/curvature per street id (not part of the output). */
  heading: number[];
  curv: number[];
  /** Standing footprints lanes must bend around (GrowOpts.obstacles). */
  obstacles: readonly Rect[];
  /** Hard bound on a street point's distance from the frame origin —
   *  the declared extent less the built margin it carries (§1.5). */
  gate: number;
  rng: () => number;
}

export interface GrowOpts {
  /** WHAT THE TOWN GREW AROUND (§1.1) — supersedes `bearings`. */
  seeds?: readonly GrowSeed[];
  /** LEGACY arterial bearings (radians), most important first — compiled
   *  to STUB seeds by the one adapter below, so every caller written
   *  against the old input keeps working unchanged until the seam lands.
   *  Ignored when `seeds` is given. */
  bearings?: readonly number[];
  /** Standing footprints (annexed homesteads, founded buildings) lanes
   *  must bend around. Part of the deterministic input. */
  obstacles?: readonly Rect[];
  /** The DECLARED extent of the built area (default dimensions.townRMax).
   *  Growth stops short of it by the built margin, so everything the plan
   *  places sits inside — `plan.radius` is an output, never a promise. */
  extentM?: number;
}

/** Smallest absolute angular separation between two bearings. */
function angSep(a: number, b: number): number {
  let d = Math.abs(a - b) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d;
}

/** Signed smallest turn from `a` to `b`. */
function angDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** How many stub seeds a bearing list may compile to — the approach cap
 *  (`approachBearings`' own default): beyond it a hub is pathological. */
export const STUB_SEED_CAP = 6;

/**
 * THE ONE ADAPTER, half one: bearings → stub seeds. PORTS ARE PLURAL —
 * every incident road gets its own stub — with the compass dedup that
 * collapses roads sharing a bucket, and the cap that bounds a pathological
 * hub. Exported so a caller that assembles a MIXED seed set (phase B §2.1:
 * road spans plus the substrate's fertile/ore leanings) compiles its
 * bearings through the same law the legacy input does, instead of a second
 * copy of it.
 */
export function stubSeedsOf(bearings: readonly number[], max = STUB_SEED_CAP): GrowSeed[] {
  const kept: number[] = [];
  const out: GrowSeed[] = [];
  for (const b of bearings) {
    if (kept.length >= max) break;
    if (kept.some(g => angSep(g, b) < 0.5)) continue;
    kept.push(b);
    out.push({ kind: "stub", bearing: b });
  }
  return out;
}

/**
 * THE ONE ADAPTER: legacy `bearings` → stub seeds, then everything into
 * CANONICAL ORDER (spans longest-first, spines by founding ord, stubs
 * last in importance order). Pure — the order is a function of the input
 * alone, which is what makes the round robin below deterministic.
 *
 * The `bearings` it returns is the LEGACY ECHO, and it reads the compiled
 * STUBS whichever input arm produced them — so a caller that hands seeds
 * still gets an honest answer to "which bare directions did this town grow
 * out along", rather than a silent empty list.
 */
function compileSeeds(opts: GrowOpts | undefined): { seeds: GrowSeed[]; bearings: number[] } {
  const given = opts?.seeds ?? null;
  const raw: GrowSeed[] = given && given.length
    ? [...given]
    : stubSeedsOf(opts?.bearings ?? []);
  const lenOf = (pts: Vec2[]): number => {
    let l = 0;
    for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    return l;
  };
  const spans = raw.filter((s): s is Extract<GrowSeed, { kind: "span" }> => s.kind === "span");
  spans.sort((a, b) => {
    const d = lenOf(b.pts) - lenOf(a.pts);
    if (Math.abs(d) > 1e-9) return d;
    return Math.atan2(a.pts[0]?.y ?? 0, a.pts[0]?.x ?? 0) - Math.atan2(b.pts[0]?.y ?? 0, b.pts[0]?.x ?? 0);
  });
  const spines = raw.filter(s => s.kind === "spine");
  const stubs = raw.filter((s): s is Extract<GrowSeed, { kind: "stub" }> => s.kind === "stub");
  return { seeds: [...spans, ...spines, ...stubs], bearings: stubs.map(s => s.bearing) };
}

/** Densify a seed polyline so arc math and the clearance grid sample it
 *  at the growth step (original vertices are kept). */
function densify(pts: readonly Vec2[], step: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (i > 0) {
      const a = pts[i - 1];
      const len = Math.hypot(p.x - a.x, p.y - a.y);
      const n = Math.ceil(len / step);
      for (let k = 1; k < n; k++) {
        out.push({ x: a.x + ((p.x - a.x) * k) / n, y: a.y + ((p.y - a.y) * k) / n });
      }
    }
    out.push({ x: p.x, y: p.y });
  }
  return out;
}

/**
 * Grow the street tree until at least `minSlots` lots exist (or the town
 * is full). The event stream is fixed by (seed, key, opts): a run to a
 * higher `minSlots` replays the same events and continues — streets only
 * extend, slots only append, so lot k is stable as the town grows.
 */
export function growStreets(seed: number, key: string, minSlots: number, opts?: GrowOpts): TownStreets {
  const rng = mulberry32(hashSeed(seed, `${key}:streets`));
  const { seeds, bearings } = compileSeeds(opts);
  // THE ECHO IS THE INPUT, not the input plus whatever growth invented: a
  // caller that regrows from `net.seeds` must re-enter this function with
  // the SAME arguments, and the invented stub below is drawn from the event
  // stream. Echo it and the regrow skips that draw — the stream forks and
  // the "prefix-consistent regrow" contract silently breaks.
  const declared = [...seeds];

  // A town with no seed at all still grew around SOMETHING: a bearing off
  // the stream stands in for the founder's own track.
  const stubs = seeds.filter((s): s is Extract<GrowSeed, { kind: "stub" }> => s.kind === "stub");
  if (!seeds.length) {
    const b = rng() * Math.PI * 2;
    seeds.push({ kind: "stub", bearing: b });
    stubs.push({ kind: "stub", bearing: b });
  }
  // 3–4 arterials was the shipped shape (two was fragile: one blocked
  // early left the town lopsided behind it); a road-rich crossroads gets
  // one per road.
  const nArterial = Math.max(stubs.length, 3 + (rng() < 0.5 ? 1 : 0));

  const st: GrowState = {
    streets: [],
    links: [],
    slots: [],
    ports: [],
    ptGrid: new PointGrid<StreetPt>(),
    slotGrid: new PointGrid<LotSlot>(),
    heading: [],
    curv: [],
    obstacles: opts?.obstacles ?? [],
    gate: Math.max(STEP * 2, (opts?.extentM ?? EXTENT) - BUILT_MARGIN),
    rng,
  };

  /* ---- STREET 0: the baseline, laid whole from the primary seed ---- */
  const primary = seeds[0];
  const ports: TownPort[] = [];
  let basePts: Vec2[];
  let openEnds: Array<0 | 1>;
  if (primary.kind === "span") {
    basePts = densify(primary.pts, STEP);
    openEnds = [];
    if (primary.portA) ports.push({ street: 0, end: 0 });
    else openEnds.push(0);
    if (primary.portB) ports.push({ street: 0, end: 1 });
    else openEnds.push(1);
  } else if (primary.kind === "spine") {
    basePts = densify(primary.lanes[0] ?? [{ x: 0, y: 0 }, { x: STEP, y: 0 }], STEP);
    openEnds = [0, 1];
  } else {
    // A stub baseline is the degenerate through-road: centred on the frame
    // origin, along the seed bearing, and long enough to hold its town's
    // declared roads as SEPARATE junctions (never a hub).
    const sideArcs = Math.max(1, Math.ceil(Math.max(0, nArterial - 2) / 2));
    const len = Math.max(
      2 * PLAZA_R,
      2 * JUNCTION_KEEP + (sideArcs - 1) * STATION_SPACING,
    );
    const c = Math.cos(primary.bearing);
    const s = Math.sin(primary.bearing);
    basePts = densify(
      [{ x: (-c * len) / 2, y: (-s * len) / 2 }, { x: (c * len) / 2, y: (s * len) / 2 }],
      STEP,
    );
    openEnds = [0, 1];
  }
  const baseline: Street = {
    id: 0, gen: 0, parent: -1, parentArc: 0, arm: 0, baseline: true,
    pts: basePts, cum: cumOf(basePts), capped: true,
  };
  st.streets.push(baseline);
  st.heading.push(tangentAt(baseline, 0));
  st.curv.push(0);
  for (let i = 0; i < basePts.length; i++) {
    st.ptGrid.add({ ...basePts[i], street: 0, arc: baseline.cum[i] });
    // Midpoints too: the clearance checks sample the centerline every
    // ~8 m, so a lane can never slip between two baseline vertices.
    if (i > 0) {
      st.ptGrid.add({
        x: (basePts[i - 1].x + basePts[i].x) / 2,
        y: (basePts[i - 1].y + basePts[i].y) / 2,
        street: 0,
        arc: (baseline.cum[i - 1] + baseline.cum[i]) / 2,
      });
    }
  }

  /* ---- Attachment stations: where arterials root on the baseline ---- */
  // CLAIMING is pure (bearings in, stations out) and runs BEFORE the
  // frontage pass, so only the mouths a road will actually use are held
  // open — the rest of the high street gets its houses.
  const stations = stationsOn(baseline, openEnds);
  const taken = new Set<number>();
  /** The free station best facing `b`, swung toward it within the clamp. */
  const claimFor = (b: number): { station: Station; bearing: number } | null => {
    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < stations.length; i++) {
      if (taken.has(i)) continue;
      const score = Math.cos(angDelta(stations[i].bearing, b));
      if (score > bestScore) { bestScore = score; best = i; }
    }
    if (best < 0) return null;
    const station = stations[best];
    taken.add(best);
    const swing = Math.max(-STATION_SWING, Math.min(STATION_SWING, angDelta(station.bearing, b)));
    return { station, bearing: station.bearing + swing };
  };
  const claims: Array<{ station: Station; bearing: number; jit: number }> = [];
  for (const stub of stubs) {
    const c = claimFor(stub.bearing);
    if (!c) break;
    claims.push({ ...c, jit: 0.2 });
  }
  for (let i = stubs.length; i < nArterial; i++) {
    let free = -1;
    for (let k = 0; k < stations.length; k++) {
      if (!taken.has(k)) { free = k; break; }
    }
    if (free < 0) break;
    taken.add(free);
    claims.push({ station: stations[free], bearing: stations[free].bearing, jit: 0.5 });
  }
  // Claimed side mouths behave as spent branch PORTS during the frontage
  // pass: no lot may block an arterial's mouth (the PORT_KEEP corridor).
  for (const c of claims) {
    if (c.station.side !== 0) {
      st.ports.push({ street: c.station.street, arc: c.station.arc, side: c.station.side, tries: 0 });
    }
  }

  /* ---- The baseline's own frontage: the high street is a street ---- */
  const baseTotal = baseline.cum[baseline.cum.length - 1];
  for (let arc = STEP; arc <= baseTotal + 1e-9; arc += STEP) {
    const slotArc = arc - STEP / 2;
    if (slotArc > baseTotal - JUNCTION_KEEP) break; // the far end is a mouth too
    emitFrontage(st, baseline, slotArc, pointAt(baseline, slotArc), tangentAt(baseline, slotArc));
  }

  /* ---- Arterials: the seeds' roads, rooted at their claimed station ---- */
  let arms = 1; // arm 0 is the baseline's own quarter (the high street)
  /** Returns the new street's id, or -1 when the mouth is built over. */
  const seedArterial = (bearing: number, station: Station): number => {
    const origin = pointAt(st.streets[station.street], station.arc);
    const probe = { x: origin.x + Math.cos(bearing) * STEP, y: origin.y + Math.sin(bearing) * STEP };
    const fake = { id: -1, parent: station.street, parentArc: station.arc } as Street;
    if (tipBlocked(st, fake, probe)) return -1; // the mouth is built over
    const mid = { x: (origin.x + probe.x) / 2, y: (origin.y + probe.y) / 2 };
    for (const pt of [mid, probe]) {
      if (st.slotGrid.near(pt, 6).length > 0) return -1;
    }
    const s: Street = {
      id: st.streets.length, gen: 0, parent: station.street, parentArc: station.arc, arm: arms++,
      pts: [origin], cum: [0], capped: false,
    };
    st.streets.push(s);
    st.heading[s.id] = bearing;
    st.curv[s.id] = (rng() - 0.5) * 2 * CURV;
    return s.id;
  };
  for (const c of claims) {
    const id = seedArterial(c.bearing + (rng() - 0.5) * c.jit, c.station);
    // An END station's arterial CONTINUES the baseline out of town — its
    // outer tip is the gate the region's road meets (a span seed declares
    // its ports outright; a stub grows them).
    if (id >= 0 && c.station.side === 0) ports.push({ street: id, end: 1 });
  }

  /* ---- Secondary seeds: connected by construction (§1.4) ---- */
  // A span that is not the baseline, or a spine lane past the first, is
  // real geometry somewhere on the ground: it joins the network by an
  // ACCESS LANE to the nearest network point, so the tree stays a tree.
  for (let i = 1; i < seeds.length; i++) {
    const sd = seeds[i];
    if (sd.kind === "span") {
      const at = attachSeedPath(st, densify(sd.pts, STEP), arms++);
      // Its FAR end (the one the access lane did not join at) is a gate
      // when the seed declared a port there; the near end is inside the
      // town by construction, so it is not one.
      if (at && (at.nearEnd === 0 ? sd.portB : sd.portA)) ports.push({ street: at.street, end: 1 });
    } else if (sd.kind === "spine") {
      for (const lane of sd.lanes) attachSeedPath(st, densify(lane, STEP), arms++);
    }
  }

  // Rounds: extend every live street a step, then let ports fire.
  let barren = 0;
  for (let round = 0; round < 900 && st.slots.length < minSlots; round++) {
    // A maturing town opens NEW roads where the ground is UN-SERVED: the
    // free station with the longest open run out from the network wins
    // (the stranded-mass rule `marketServiceDeficit` runs on bread,
    // applied to ground). Replaces the old "widest angular gap about the
    // hub", which could not see a hole that wasn't radial.
    if (round >= 18 && round % 12 === 6) {
      const pick = bestCoverageStation(st);
      if (pick) seedArterial(pick.station.bearing + (rng() - 0.5) * 0.3, pick.station);
    }

    let progress = false;
    const ids = st.streets.map(s => s.id); // snapshot: newcomers wait a round
    for (const id of ids) {
      const s = st.streets[id];
      if (!s.capped && extend(st, s)) progress = true;
    }
    const nPorts = st.ports.length; // snapshot
    for (let i = 0; i < nPorts; i++) {
      const port = st.ports[i];
      if (port.tries <= 0) continue;
      const gen = st.streets[port.street].gen;
      // Firing pressure rises when growth stalls: the town keeps building
      // wherever it still can before we declare it full.
      if (rng() >= Math.min(1, FIRE_P[Math.max(0, gen)] + barren * 0.12)) continue;
      if (sprout(st, port)) {
        port.tries = 0;
        progress = true;
      } else {
        port.tries--;
      }
    }
    barren = progress ? 0 : barren + 1;
    if (barren > 15) break; // the town is full
  }

  return { streets: st.streets, links: st.links, slots: st.slots, seeds: declared, ports, bearings };
}

function cumOf(pts: Vec2[]): number[] {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  return cum;
}

/** Arc separation on a street (open paths — the ring's wrap is gone). */
function arcSep(_s: Street, a: number, b: number): number {
  return Math.abs(a - b);
}

/**
 * ATTACHMENT STATIONS along a street: spaced side mouths, plus the open
 * ENDS (a baseline end that is not a port is where the road carries on
 * out of town). Deterministic in the street's own geometry.
 */
function stationsOn(s: Street, openEnds: ReadonlyArray<0 | 1>): Station[] {
  const total = s.cum[s.cum.length - 1];
  const out: Station[] = [];
  for (const end of openEnds) {
    const arc = end === 0 ? 0 : total;
    // Facing OUT: the origin end looks back down the path.
    const t = tangentAt(s, arc);
    out.push({ street: s.id, arc, side: 0, bearing: end === 0 ? t + Math.PI : t });
  }
  // Side mouths from the middle outward, so a town with few roads hangs
  // them off the centre of its high street rather than its ends.
  const arcs: number[] = [];
  const usable = total - 2 * JUNCTION_KEEP;
  if (usable >= 0) {
    const n = Math.floor(usable / STATION_SPACING) + 1;
    const span = (n - 1) * STATION_SPACING;
    const a0 = (total - span) / 2;
    for (let i = 0; i < n; i++) arcs.push(a0 + i * STATION_SPACING);
    arcs.sort((a, b) => Math.abs(a - total / 2) - Math.abs(b - total / 2) || a - b);
  }
  for (const arc of arcs) {
    const t = tangentAt(s, arc);
    for (const side of [-1, 1] as const) {
      out.push({ street: s.id, arc, side, bearing: t + (side * Math.PI) / 2 });
    }
  }
  return out;
}

/** Is `p` inside a standing footprint (padded by a lot's clear zone)? */
function inObstacle(st: GrowState, p: Vec2): boolean {
  for (const r of st.obstacles) {
    if (
      p.x > r.x - LOT_CLEAR && p.x < r.x + r.w + LOT_CLEAR &&
      p.y > r.y - LOT_CLEAR && p.y < r.y + r.h + LOT_CLEAR
    ) return true;
  }
  return false;
}

/**
 * May the tip at `p` grow here? The extent gate (§1.5 — the built margin
 * is held back so plan.radius stays inside the declared extent), standing
 * footprints (§1.4), and foreign-street proximity.
 *
 * THE BASELINE-CLEARANCE RULE (replacing the ring's "don't curve back
 * in"): the baseline is street 0, an ordinary member of this test, so a
 * lane that leaves it may never re-cross it within MIN_GAP — the parent
 * exemption below only forgives the 30 m of parent either side of the
 * lane's OWN junction. Same PointGrid, no new geometry.
 */
function tipBlocked(st: GrowState, s: Street, p: Vec2, atArc?: number): boolean {
  return blockerAt(st, s, p, atArc) !== null;
}

/**
 * THE ONE BLOCKING LAW, and the payload it used to throw away. Returns
 * WHAT blocks the tip at `p`: the FOREIGN street point in the way (the
 * loop candidate — both endpoints' (street, arc) are then known, so a
 * tree detour is O(depth) and projection-free), or the sentinel
 * `HARD_BLOCK` for the extent gate and standing footprints, which no
 * loop can ever answer. `null` = the tip may grow.
 *
 * `tipBlocked` above is the boolean face of this, and `sprout`'s
 * `clearAt` — which carried an INLINE COPY of the same three clauses —
 * now asks here too (growth phase C §2.2: one law, one site). The copy
 * differed only in what it could not know: a sprouting lane has no id
 * yet, so it passes the id its street is ABOUT to get, which no grid
 * point and no parent field can match, and both exemptions fall through
 * exactly as the copy's absence of them did.
 */
const HARD_BLOCK: unique symbol = Symbol("hard-block");
type Blocker = StreetPt | typeof HARD_BLOCK;

function blockerAt(st: GrowState, s: Street, p: Vec2, atArc?: number): Blocker | null {
  if (Math.hypot(p.x, p.y) > st.gate) return HARD_BLOCK;
  if (inObstacle(st, p)) return HARD_BLOCK;
  const mine = atArc ?? (s.cum ? s.cum[s.cum.length - 1] : 0);
  for (const q of st.ptGrid.near(p, MIN_GAP)) {
    // A LINK (synthetic id, below zero) is an alley: it blocks, but only
    // within its own narrower gap, and no mouth exemption reaches it.
    if (q.street < 0) {
      if (Math.hypot(q.x - p.x, q.y - p.y) <= LINK_GAP) return q;
      continue;
    }
    if (q.street === s.id) continue;
    // The PARENT is legitimately close near our own junction…
    if (q.street === s.parent && arcSep(st.streets[s.parent], q.arc, s.parentArc) < MOUTH_ARC) continue;
    // …and so, symmetrically, is a CHILD we have only just passed: a
    // street must not be strangled by the lane it just sprouted.
    const qs = st.streets[q.street];
    if (qs && qs.parent === s.id && arcSep(s, qs.parentArc, mine) < MOUTH_ARC) continue;
    return q;
  }
  return null;
}

/** Frontage fronting one step of street: one slot per side, or a branch
 *  PORT. Shared by the baseline's opening lay and every extension step —
 *  ONE definition of what a step of street produces. */
function emitFrontage(st: GrowState, s: Street, slotArc: number, mid: Vec2, h: number): void {
  const { rng } = st;
  const nx = -Math.sin(h);
  const ny = Math.cos(h);
  for (const side of [-1, 1] as const) {
    const roll = rng();
    if (slotArc < JUNCTION_KEEP) continue; // junction mouth stays open
    if (roll < PORT_P[Math.min(s.gen, PORT_P.length - 1)] && s.gen < MAX_GEN) {
      let crowded = false;
      for (const port of st.ports) {
        if (port.street === s.id && Math.abs(port.arc - slotArc) < PORT_SPACING) {
          crowded = true;
          break;
        }
      }
      if (!crowded) {
        st.ports.push({ street: s.id, arc: slotArc, side, tries: PORT_TRIES });
        continue;
      }
    }
    const c = { x: mid.x + nx * side * LOT_SETBACK, y: mid.y + ny * side * LOT_SETBACK };
    if (inObstacle(st, c)) continue;
    // Clear of foreign streets (grid points sample every 7 m, so a point
    // within LOT_CLEAR + 3.6 means the centerline may breach LOT_CLEAR).
    let bad = false;
    for (const q of st.ptGrid.near(c, LOT_CLEAR + 3.6)) {
      if (q.street !== s.id) { bad = true; break; }
    }
    // …of other lots…
    if (!bad && st.slotGrid.near(c, SLOT_GAP).length > 0) bad = true;
    // …and of same-street ports (the branch corridor stays open).
    if (!bad) {
      for (const port of st.ports) {
        if (port.street === s.id && port.side === side && Math.abs(port.arc - slotArc) < PORT_KEEP) {
          bad = true;
          break;
        }
      }
    }
    if (bad) continue;
    const slot: LotSlot = { street: s.id, side, arc: slotArc, x: c.x, y: c.y, ax: mid.x, ay: mid.y, arm: s.arm };
    st.slots.push(slot);
    st.slotGrid.add(slot);
  }
}

/** Extend street `s` one step; emit the slots (or ports) fronting it. */
function extend(st: GrowState, s: Street): boolean {
  const { rng } = st;
  const maxLen = MAX_LEN[Math.min(s.gen, MAX_LEN.length - 1)];
  if (s.cum[s.cum.length - 1] + STEP > maxLen) {
    s.capped = true;
    return false;
  }
  const tip = s.pts[s.pts.length - 1];
  // Streets BEND around obstacles before giving up (real lanes turn at
  // whatever is in the way) — try straight-ish first, then harder turns
  // to a randomized side.
  const h0 = st.heading[s.id] + st.curv[s.id] + (rng() - 0.5) * JIT;
  const sgn = rng() < 0.5 ? 1 : -1;
  let next: Vec2 | null = null;
  let h = h0;
  /** THE LOOP PAYLOAD (§2.2): the first FOREIGN street point that turned
   *  this tip back. The rejection has always known it and always threw it
   *  away; the closure rule below is what it was for. Extent and obstacle
   *  blocks are `HARD_BLOCK` and never become candidates — no link can
   *  answer the edge of the world or the wall of a house. */
  let block: StreetPt | null = null;
  for (const turn of [0, 0.55 * sgn, -0.55 * sgn, 1.0 * sgn]) {
    const hc = h0 + turn;
    const cand = { x: tip.x + Math.cos(hc) * STEP, y: tip.y + Math.sin(hc) * STEP };
    const mid = { x: (tip.x + cand.x) / 2, y: (tip.y + cand.y) / 2 };
    const arcAt = s.cum[s.cum.length - 1] + STEP;
    // Short-circuit EXACTLY as the two `tipBlocked` calls did — the mid is
    // probed only when the candidate itself is clear.
    const bc = blockerAt(st, s, cand, arcAt);
    const bm = bc === null ? blockerAt(st, s, mid, arcAt - STEP / 2) : null;
    if (bc === null && bm === null) {
      next = cand;
      h = hc;
      break;
    }
    if (!block) {
      const b = bc !== null && bc !== HARD_BLOCK ? bc : bm !== null && bm !== HARD_BLOCK ? bm : null;
      if (b) block = b;
    }
  }
  if (!next) {
    // THE TIP DIES — but not before it is asked whether the thing in its
    // way is a neighbour it has been walking half the town to reach.
    closeLoop(st, s.id, s.cum[s.cum.length - 1], tip, block);
    s.capped = true;
    return false;
  }
  st.heading[s.id] = h;
  const mid = { x: (tip.x + next.x) / 2, y: (tip.y + next.y) / 2 };

  s.pts.push(next);
  const arc = s.cum[s.cum.length - 1] + STEP;
  s.cum.push(arc);
  st.ptGrid.add({ ...next, street: s.id, arc });
  // Midpoint too: 7 m sampling caps the sag between grid points, so the
  // clearance checks stay honest at village-dense street spacing.
  st.ptGrid.add({ ...mid, street: s.id, arc: arc - STEP / 2 });

  emitFrontage(st, s, arc - STEP / 2, mid, h);
  return true;
}

/**
 * THE CLOSURE RULE (growth phase C §2.2). A lane has just been refused
 * against the foreign street point `q` — either a TIP that has nowhere
 * left to grow or a PORT that cannot open at all. Both endpoints'
 * (street, arc) are in hand, so the TREE detour between them is the
 * parent climb — O(depth), no projection, no search. Join them iff
 *
 *   1. the tree really does send people the long way: detour ≥
 *      LOOP_MIN_RATIO × chord (the bar's evidence is in the ledger), and
 *   2. the chord is GROUND a lane may take: inside the extent gate, clear
 *      of standing footprints, MIN_GAP clear of every street but the two
 *      it joins, and clear of the frontage already built along both.
 *
 * The link is emitted; the tip still caps and the port is still spent.
 * Nothing else moves: no street gains points, no lot is re-numbered, no
 * arm is re-assigned. The town is the same tree with a shortcut written
 * beside it. Returns whether one was cut, which is how a walled-in port
 * reports that it did something after all.
 */
function closeLoop(
  st: GrowState, from: number, fromArc: number, at: Vec2, q: StreetPt | null,
): boolean {
  // A LINK in the way is a wall, not a candidate: its grid id is synthetic
  // (< 0), it holds no arc anyone can climb from, and a loop onto a loop is
  // not a loop onto the town. The lane dies here as it would at a house.
  if (!q || q.street < 0) return false;
  const chord = Math.hypot(q.x - at.x, q.y - at.y);
  if (chord < 1e-6) return false;
  if (!(treeDetour(st.streets, from, fromArc, q.street, q.arc) >= LOOP_MIN_RATIO * chord)) return false;
  if (!linkClear(st, at, q, from, fromArc, q.street, q.arc)) return false;
  const pts = densify([{ x: at.x, y: at.y }, { x: q.x, y: q.y }], STEP);
  st.links.push({
    a: { street: from, arc: fromArc },
    b: { street: q.street, arc: q.arc },
    pts,
  });
  // A LINK IS GROUND NOW, so nothing may be built over it. Its INTERIOR
  // points enter the clearance grid under a synthetic id no `Street` can
  // hold (−2 downward): every exemption in `blockerAt` and `mouthForgives`
  // is keyed on a real street id or a real parent field, so a link is
  // forgiven by nobody and blocks like the lane it is. The two ENDS are
  // deliberately left out — they sit ON the streets they join, and adding
  // them would strangle those streets' own growth at the junction they
  // just gained. (Without this, 1 link in 248 was later crossed at 1.8 m.)
  const id = -2 - st.links.length;
  for (let k = 1; k < pts.length - 1; k++) {
    st.ptGrid.add({ ...pts[k], street: id, arc: 0 });
  }
  return true;
}

/** May a connector run from `a` to `b`? The tip law, minus the two streets
 *  the link exists to touch (it is within MIN_GAP of both by construction
 *  — that is what made it a candidate) and plus the frontage test, because
 *  a shortcut may not be driven through a standing house. */
function linkClear(
  st: GrowState, a: Vec2, b: Vec2, mine: number, mineArc: number, theirs: number, theirsArc: number,
): boolean {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(2, Math.ceil(len / (STEP / 2)));
  for (let k = 0; k <= n; k++) {
    const f = k / n;
    const p = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    if (Math.hypot(p.x, p.y) > st.gate) return false;
    if (inObstacle(st, p)) return false;
    for (const g of st.ptGrid.near(p, MIN_GAP)) {
      if (g.street < 0) {
        // Another shortcut: the same alley gap, both ways.
        if (Math.hypot(g.x - p.x, g.y - p.y) <= LINK_GAP) return false;
        continue;
      }
      if (mouthForgives(st, g, mine, mineArc) || mouthForgives(st, g, theirs, theirsArc)) continue;
      return false;
    }
    // The lots are already built along both streets; the lane threads
    // BETWEEN them or not at all (`sprout`'s own mouth test, applied the
    // whole length because every metre of a link is a mouth).
    if (st.slotGrid.near(p, 6).length > 0) return false;
  }
  return true;
}

/** THE MOUTH LAW, read from a LINK's end instead of a tip's (`blockerAt`'s
 *  two exemptions, said once for each end the link stands on): the street
 *  we leave from never blocks us, and neither does a neighbour that meets
 *  it inside the junction mouth we are leaving by — a lane sprouted at
 *  this very spot is not "something in the way", it is the same corner. */
function mouthForgives(st: GrowState, g: StreetPt, host: number, hostArc: number): boolean {
  if (g.street === host) return true;
  const hs = st.streets[host];
  const gs = st.streets[g.street];
  // A CHILD that meets `host` within the mouth we stand in.
  if (gs && gs.parent === host && hs && arcSep(hs, gs.parentArc, hostArc) < MOUTH_ARC) return true;
  // The PARENT, when we stand in `host`'s own mouth onto it.
  if (hs && hs.parent === g.street && arcSep(hs, hostArc, 0) < MOUTH_ARC
    && arcSep(st.streets[hs.parent], g.arc, hs.parentArc) < MOUTH_ARC) return true;
  return false;
}


/** Try to sprout a child street at a fired port. */
function sprout(st: GrowState, port: Port): boolean {
  const { rng } = st;
  const parent = st.streets[port.street];
  const origin = pointAt(parent, port.arc);
  const tangent = tangentAt(parent, port.arc);
  const base = tangent + (port.side * Math.PI) / 2;

  // THE LANE THIS PORT IS ABOUT TO BE: it has no id until it is pushed, so
  // it borrows the one it will get — a value no grid point carries and no
  // street names as its parent, which is exactly why `blockerAt`'s two
  // mouth exemptions fall through here and only the PARENT mouth forgives.
  const fake = { id: st.streets.length, parent: port.street, parentArc: port.arc } as Street;
  /** THE LOOP PAYLOAD at this site too (§2.2): a port that cannot open a
   *  lane because a FOREIGN street stands 30 m off is the same discovery
   *  a dying tip makes — two streets that nearly touch. */
  let block: StreetPt | null = null;
  const clearAt = (h: number): Vec2 | null => {
    const tip = { x: origin.x + Math.cos(h) * STEP, y: origin.y + Math.sin(h) * STEP };
    const b = blockerAt(st, fake, tip);
    if (b !== null) {
      if (!block && b !== HARD_BLOCK) block = b;
      return null;
    }
    const mid = { x: (origin.x + tip.x) / 2, y: (origin.y + tip.y) / 2 };
    for (const probe of [mid, tip]) {
      if (st.slotGrid.near(probe, 6).length > 0) return null;
    }
    return tip;
  };
  let h = base + (rng() - 0.5) * 0.35;
  let tip = clearAt(h);
  if (!tip) {
    h = base + (rng() - 0.5) * 1.1; // a skewed lane beats no lane
    tip = clearAt(h);
  }
  if (!tip) {
    // THE PORT IS WALLED IN — ask whether the wall is worth a door.
    return closeLoop(st, port.street, port.arc, origin, block);
  }

  const s: Street = {
    id: st.streets.length,
    gen: parent.gen + 1,
    parent: parent.id,
    parentArc: port.arc,
    arm: parent.arm,
    pts: [origin, tip],
    cum: [0, STEP],
    capped: false,
  };
  st.streets.push(s);
  st.heading[s.id] = h;
  st.curv[s.id] = (rng() - 0.5) * 2 * CURV;
  st.ptGrid.add({ ...origin, street: s.id, arc: 0 });
  st.ptGrid.add({ x: (origin.x + tip.x) / 2, y: (origin.y + tip.y) / 2, street: s.id, arc: STEP / 2 });
  st.ptGrid.add({ ...tip, street: s.id, arc: STEP });
  return true;
}

/**
 * CONNECTED BY CONSTRUCTION (§1.4): a seed path that is not the baseline
 * joins the network by an ACCESS LANE from the nearest network point to
 * its nearest end, then stands as a capped street of its own. The tree
 * stays a tree; nothing is ever orphaned.
 */
function attachSeedPath(
  st: GrowState, pts: Vec2[], arm: number,
): { street: number; nearEnd: 0 | 1 } | null {
  if (pts.length < 2) return null;
  // Nearest network point to either end of the seed path.
  let best: { onArc: number; onStreet: number; at: Vec2; end: 0 | 1; d: number } | null = null;
  for (const end of [0, 1] as const) {
    const p = end === 0 ? pts[0] : pts[pts.length - 1];
    for (const s of st.streets) {
      for (let i = 0; i < s.pts.length; i++) {
        const d = Math.hypot(s.pts[i].x - p.x, s.pts[i].y - p.y);
        if (!best || d < best.d) best = { onArc: s.cum[i], onStreet: s.id, at: s.pts[i], end, d };
      }
    }
  }
  if (!best) return null;
  const head = best.end === 0 ? pts : [...pts].reverse();
  // The lane runs from the network to the seed path's head; when they
  // already touch, the seed attaches directly.
  const lane = best.d > STEP / 2 ? densify([best.at, head[0]], STEP) : [best.at, head[0]];
  const path = [...lane.slice(0, -1), ...head];
  const s: Street = {
    id: st.streets.length, gen: 0, parent: best.onStreet, parentArc: best.onArc, arm,
    pts: path, cum: cumOf(path), capped: true,
  };
  st.streets.push(s);
  st.heading[s.id] = tangentAt(s, 0);
  st.curv[s.id] = 0;
  for (let i = 0; i < path.length; i++) {
    st.ptGrid.add({ ...path[i], street: s.id, arc: s.cum[i] });
  }
  const total = s.cum[s.cum.length - 1];
  for (let arc = STEP; arc <= total + 1e-9; arc += STEP) {
    const slotArc = arc - STEP / 2;
    if (slotArc > total - JUNCTION_KEEP) break;
    emitFrontage(st, s, slotArc, pointAt(s, slotArc), tangentAt(s, slotArc));
  }
  return { street: s.id, nearEnd: best.end };
}

/**
 * COVERAGE RE-SEEDING (§1.4): the free station with the LARGEST UN-SERVED
 * RUN — how far a new road could march out from it before something is in
 * the way. The stranded-mass measure `marketServiceDeficit` runs on
 * households, read on ground instead: the biggest hole the network does
 * not reach wins, whatever direction it lies in.
 */
function bestCoverageStation(st: GrowState): { station: Station; run: number } | null {
  let best: { station: Station; run: number } | null = null;
  for (const s of st.streets) {
    if (s.gen !== 0) continue;
    const total = s.cum[s.cum.length - 1];
    if (total < JUNCTION_KEEP) continue;
    for (let arc = JUNCTION_KEEP; arc <= total - JUNCTION_KEEP + 1e-9; arc += STATION_SPACING) {
      const origin = pointAt(s, arc);
      const t = tangentAt(s, arc);
      for (const side of [-1, 1] as const) {
        const bearing = t + (side * Math.PI) / 2;
        // No second road out of the SAME mouth. Anything else already in
        // the way shortens the run below, which is the whole measure.
        let spoken = false;
        for (const c of st.streets) {
          if (c.parent === s.id && Math.abs(c.parentArc - arc) < 1e-6) { spoken = true; break; }
        }
        if (spoken) continue;
        const fake = { id: -1, parent: s.id, parentArc: arc } as Street;
        let run = 0;
        // A dozen steps is "plenty of room" — the measure only has to
        // RANK the holes, and an unbounded march is the whole tree's cost.
        for (let k = 1; k <= 12; k++) {
          const p = { x: origin.x + Math.cos(bearing) * STEP * k, y: origin.y + Math.sin(bearing) * STEP * k };
          if (tipBlocked(st, fake, p)) break;
          // Only the MOUTH is tested against lots: past it, any ground
          // MIN_GAP clear of every street is clear of their frontage too
          // (a lot sits `lotSetback` off its own centerline).
          if (k === 1 && st.slotGrid.near(p, 6).length > 0) break;
          run = STEP * k;
        }
        if (run < COVERAGE_MIN_RUN) continue;
        if (!best || run > best.run) best = { station: { street: s.id, arc, side, bearing }, run };
      }
    }
  }
  return best;
}

/* ---------------------------- geometry ------------------------------- */

/** Point on a street's centerline at arc length `a` (clamped). */
export function pointAt(s: Street, a: number): Vec2 {
  const total = s.cum[s.cum.length - 1];
  const arc = Math.max(0, Math.min(total, a));
  let i = 0;
  while (i < s.cum.length - 2 && s.cum[i + 1] < arc) i++;
  const seg = s.cum[i + 1] - s.cum[i];
  const f = seg > 1e-9 ? (arc - s.cum[i]) / seg : 0;
  const p = s.pts[i];
  const q = s.pts[i + 1];
  return { x: p.x + (q.x - p.x) * f, y: p.y + (q.y - p.y) * f };
}

function tangentAt(s: Street, a: number): number {
  const total = s.cum[s.cum.length - 1];
  const arc = Math.max(0, Math.min(total, a));
  let i = 0;
  while (i < s.cum.length - 2 && s.cum[i + 1] < arc) i++;
  const p = s.pts[i];
  const q = s.pts[i + 1];
  return Math.atan2(q.y - p.y, q.x - p.x);
}

/* ----------------------------- routing ------------------------------- */

interface Proj {
  street: number;
  arc: number;
  d: number;
  pt: Vec2;
}

const projCaches = new WeakMap<TownStreets, Map<string, Proj>>();

/** Nearest point of the street network to `p` (town-local meters). */
export function project(net: TownStreets, p: Vec2): Proj {
  let cache = projCaches.get(net);
  if (!cache) {
    cache = new Map();
    projCaches.set(net, cache);
  }
  const key = `${p.x},${p.y}`;
  const hit = cache.get(key);
  if (hit) return hit;

  let best: Proj | null = null;
  for (const s of net.streets) {
    for (let i = 0; i < s.pts.length - 1; i++) {
      const a = s.pts[i];
      const b = s.pts[i + 1];
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const len2 = abx * abx + aby * aby;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2)) : 0;
      const px = a.x + abx * t;
      const py = a.y + aby * t;
      const d = Math.hypot(px - p.x, py - p.y);
      if (!best || d < best.d) {
        best = { street: s.id, arc: s.cum[i] + Math.sqrt(len2) * t, d, pt: { x: px, y: py } };
      }
    }
  }
  if (cache.size > 4096) cache.clear();
  cache.set(key, best!);
  return best!;
}

interface ChainLink {
  street: number;
  /** Where the path sits on this street (arc). */
  arcOn: number;
  /** On-network meters walked to get here from the projection. */
  cost: number;
}

/** The path from a position up the tree to the baseline. Takes the street
 *  ARRAY, not the net, so the growth pass can climb a half-built tree
 *  (`closeLoop`) through the very same code the routing pass uses. */
function chainOf(streets: readonly Street[], street: number, arc: number): ChainLink[] {
  const out: ChainLink[] = [];
  let cur = street;
  let arcOn = arc;
  let cost = 0;
  for (;;) {
    out.push({ street: cur, arcOn, cost });
    const s = streets[cur];
    if (s.parent < 0) break;
    cost += arcOn; // walk back to our origin (the junction on the parent)
    arcOn = s.parentArc;
    cur = s.parent;
  }
  return out;
}

/** THE TREE detour between two (street, arc) positions — the metres the
 *  parent climb costs, ignoring any link. O(depth) and projection-free,
 *  which is what lets the closure rule ask it at every dying tip. */
function treeDetour(
  streets: readonly Street[], aS: number, aA: number, bS: number, bA: number,
): number {
  const ca = chainOf(streets, aS, aA);
  const cb = chainOf(streets, bS, bA);
  const inA = new Map<number, ChainLink>();
  for (const l of ca) inA.set(l.street, l);
  for (const l of cb) {
    const m = inA.get(l.street);
    if (m) return m.cost + l.cost + Math.abs(m.arcOn - l.arcOn);
  }
  return Infinity;
}

/** Arc distance between two positions on one street. */
function onStreetDist(_s: Street, a: number, b: number): number {
  return Math.abs(a - b);
}

/* ------------------------ THE ROAD GRAPH (§2.3) ----------------------- */

/**
 * Once a net has LINKS it is no longer a tree, and "climb to the deepest
 * common ancestor" stops being the answer — it is merely one of several
 * ways round. Routing becomes a shortest path over the graph whose nodes
 * are (junctions ∪ link ends ∪ every street's two ends), with the trip's
 * own two projections spliced in per query.
 *
 * THE TREE FAST PATH IS KEPT, and it is not an optimization: on a net with
 * no links there is exactly ONE path, so the search can only rediscover
 * the climb — but it would re-associate the additions doing it, and the
 * last ulp of `roadDistance` is pinned by fixtures all over this repo. A
 * link-free net therefore takes the original code verbatim and answers
 * BYTE-IDENTICALLY forever (measured: every legacy fixture, every hand-
 * built net, and every town whose tips never met a stranger).
 */
interface GraphEdge {
  to: number;
  w: number;
  /** Index into `net.links`, or -1 for street arc and junction edges. */
  link: number;
}

interface RoadGraph {
  /** node → the position it stands at. */
  street: number[];
  arc: number[];
  /** street id → its node ids, arc ASCENDING (the query's bracket search). */
  onStreet: number[][];
  adj: GraphEdge[][];
  /** Directed edge count — the heap's high-water mark. */
  edgeCount: number;
}

const graphCaches = new WeakMap<TownStreets, RoadGraph>();

/** The node standing exactly at (street, arc), or -1. Arcs are inserted
 *  from the very fields looked up here, so equality is exact. */
function nodeAt(g: { arc: number[]; onStreet: number[][] }, street: number, arc: number): number {
  const ids = g.onStreet[street];
  if (!ids) return -1;
  let lo = 0;
  let hi = ids.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    const a = g.arc[ids[m]];
    if (a === arc) return ids[m];
    if (a < arc) lo = m + 1;
    else hi = m - 1;
  }
  return -1;
}

/** Built ONCE per net object and memoized by identity — sound because a
 *  net's links are fixed the moment `growStreets` returns (§2.1). */
function roadGraph(net: TownStreets): RoadGraph {
  const hit = graphCaches.get(net);
  if (hit) return hit;
  const n = net.streets.length;
  // A street contributes a node for its ORIGIN (where it meets its parent),
  // for every child's mouth, and for every link end. Its far TIP is NOT a
  // node unless something attaches there — a query past the last node
  // brackets against that node from both sides and pays the same arc, so
  // the tip would only be a node nobody ever leaves.
  const arcs: number[][] = net.streets.map(() => [0]);
  for (const s of net.streets) {
    if (s.parent >= 0 && arcs[s.parent]) arcs[s.parent].push(s.parentArc);
  }
  for (const l of net.links ?? []) {
    if (arcs[l.a.street]) arcs[l.a.street].push(l.a.arc);
    if (arcs[l.b.street]) arcs[l.b.street].push(l.b.arc);
  }
  // CANONICAL NODE ORDER — street-major, arc ascending. Dijkstra's
  // tie-break is the node index, so this ordering IS the determinism.
  const street: number[] = [];
  const arc: number[] = [];
  const onStreet: number[][] = [];
  for (let sid = 0; sid < n; sid++) {
    const uniq = [...new Set(arcs[sid])].sort((a, b) => a - b);
    const ids: number[] = [];
    for (const a of uniq) {
      ids.push(street.length);
      street.push(sid);
      arc.push(a);
    }
    onStreet.push(ids);
  }
  const adj: GraphEdge[][] = street.map(() => []);
  const g: RoadGraph = { street, arc, onStreet, adj, edgeCount: 0 };
  const join = (u: number, v: number, w: number, link: number): void => {
    if (u < 0 || v < 0 || u === v) return;
    adj[u].push({ to: v, w, link });
    adj[v].push({ to: u, w, link });
    g.edgeCount += 2;
  };
  // Along each street: consecutive cut points, cost = the arc between.
  for (let sid = 0; sid < n; sid++) {
    const ids = onStreet[sid];
    for (let k = 1; k < ids.length; k++) join(ids[k - 1], ids[k], arc[ids[k]] - arc[ids[k - 1]], -1);
  }
  // Every junction: a street's ORIGIN and its parentArc on the parent are
  // one and the same point, so the hop between them is free.
  for (const s of net.streets) {
    if (s.parent < 0) continue;
    join(nodeAt(g, s.id, 0), nodeAt(g, s.parent, s.parentArc), 0, -1);
  }
  // Every loop.
  (net.links ?? []).forEach((l, i) => {
    join(nodeAt(g, l.a.street, l.a.arc), nodeAt(g, l.b.street, l.b.arc), routeLength(l.pts), i);
  });
  graphCaches.set(net, g);
  return g;
}

/** A query position spliced onto the graph: the two static nodes that
 *  bracket it on its own street, and the arc to each. */
interface QuerySplice {
  street: number;
  arc: number;
  lo: number;
  hi: number;
  dLo: number;
  dHi: number;
}

function splice(g: RoadGraph, street: number, arcv: number): QuerySplice | null {
  const ids = g.onStreet[street];
  if (!ids || ids.length === 0) return null;
  let k = 0;
  for (let i = 1; i < ids.length; i++) {
    if (g.arc[ids[i]] <= arcv) k = i;
    else break;
  }
  const lo = ids[k];
  const hi = ids[Math.min(ids.length - 1, k + 1)];
  return { street, arc: arcv, lo, hi, dLo: Math.abs(arcv - g.arc[lo]), dHi: Math.abs(g.arc[hi] - arcv) };
}

// Scratch buffers, grown on demand and validated by a STAMP rather than
// refilled — routing is synchronous and non-reentrant, and `plazaOf`
// alone runs this ~1500 times per plan.
let sDist = new Float64Array(0);
let sPrev = new Int32Array(0);
let sPrevE = new Int32Array(0);
let sSettled = new Uint8Array(0);
let sStamp = new Int32Array(0);
let stampNo = 0;

/**
 * Shortest path from `a` to `b` over the graph. THE DETERMINISM DOCTRINE
 * IS travel.ts:161-165's, copied deliberately rather than shared (that
 * one is hard-bound to a CellGrid): the heap orders (cost asc, node index
 * asc) and predecessors update only on STRICT improvement, so every
 * equal-cost choice — and a town full of 16 m steps has many — resolves
 * the same way on every run, on every machine.
 *
 * Node `N` is `a`, node `N+1` is `b`; both sit after every static node, so
 * splicing a query can never renumber the graph underneath a tie-break.
 */
function graphSearch(g: RoadGraph, a: QuerySplice, b: QuerySplice | null): number {
  const base = g.street.length;
  const N = base + 2;
  const SRC = base;
  const DST = base + 1;
  if (sDist.length < N) {
    sDist = new Float64Array(N);
    sPrev = new Int32Array(N);
    sPrevE = new Int32Array(N);
    sSettled = new Uint8Array(N);
    sStamp = new Int32Array(N);
  }
  // One heap slot per RELAXATION, and a node is relaxed at most once per
  // incident edge — so the edge count bounds the heap.
  if (hCost.length < g.edgeCount + 4) {
    hCost = new Float64Array(g.edgeCount * 2 + 16);
    hNode = new Int32Array(g.edgeCount * 2 + 16);
  }
  // The stamp says "this slot belongs to the CURRENT search"; it must never
  // wrap back onto a stale one, so the counter resets by clearing the marks.
  if (stampNo >= 0x7fffffff) {
    sStamp.fill(0);
    stampNo = 0;
  }
  const mark = ++stampNo;
  let hn = 0; // live heap size (the arrays below are reused, never re-cut)
  const less = (x: number, y: number): boolean =>
    hCost[x] < hCost[y] || (hCost[x] === hCost[y] && hNode[x] < hNode[y]);
  const push = (cost: number, node: number): void => {
    hCost[hn] = cost; hNode[hn] = node;
    let k = hn++;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (!less(k, p)) break;
      const c = hCost[k]; hCost[k] = hCost[p]; hCost[p] = c;
      const i = hNode[k]; hNode[k] = hNode[p]; hNode[p] = i;
      k = p;
    }
  };
  const pop = (): number => {
    const top = hNode[0];
    hn--;
    hCost[0] = hCost[hn]; hNode[0] = hNode[hn];
    let k = 0;
    for (;;) {
      const l = 2 * k + 1;
      const r = l + 1;
      let m = k;
      if (l < hn && less(l, m)) m = l;
      if (r < hn && less(r, m)) m = r;
      if (m === k) break;
      const c = hCost[k]; hCost[k] = hCost[m]; hCost[m] = c;
      const i = hNode[k]; hNode[k] = hNode[m]; hNode[m] = i;
      k = m;
    }
    return top;
  };
  const relax = (from: number, to: number, w: number, link: number): void => {
    const nd = sDist[from] + w;
    // STRICT improvement only — an equal-cost rival never displaces the
    // incumbent, so the predecessor tree is a function of the input alone.
    if (nd < (sStamp[to] === mark ? sDist[to] : Infinity)) {
      sStamp[to] = mark;
      sDist[to] = nd;
      sPrev[to] = from;
      sPrevE[to] = link;
      sSettled[to] = 0;
      push(nd, to);
    }
  };

  sStamp[SRC] = mark; sDist[SRC] = 0; sPrev[SRC] = -1; sPrevE[SRC] = -1; sSettled[SRC] = 0;
  push(0, SRC);
  while (hn > 0) {
    const v = pop();
    if (sStamp[v] !== mark || sSettled[v]) continue;
    sSettled[v] = 1;
    if (v === DST) break;
    if (v === SRC) {
      relax(SRC, a.lo, a.dLo, -1);
      if (a.hi !== a.lo) relax(SRC, a.hi, a.dHi, -1);
      // Same street, same bracket ⇒ the trip never touches a node at all.
      if (b && a.street === b.street && a.lo === b.lo && a.hi === b.hi) {
        relax(SRC, DST, Math.abs(a.arc - b.arc), -1);
      }
      continue;
    }
    for (const e of g.adj[v]) relax(v, e.to, e.w, e.link);
    // The destination hangs off its own two bracket nodes. `b === null` is
    // the SINGLE-SOURCE run: no destination, so nothing stops it early.
    if (!b) continue;
    if (v === b.lo) relax(v, DST, b.dLo, -1);
    else if (v === b.hi) relax(v, DST, b.dHi, -1);
  }
  return b && sStamp[DST] === mark ? sDist[DST] : NaN;
}

// The heap's own storage, reused across queries: routing is synchronous
// and non-reentrant, so one town's search never interleaves with another's.
let hCost = new Float64Array(1024);
let hNode = new Int32Array(1024);

/**
 * THE SINGLE-SOURCE SHAPE (stage 1's handoff called this one exactly):
 * `plazaOf` asks 48 anchors × every junction, and `foundServicePoints`'
 * argmin is O(bucket²) — both hammer ONE source against many destinations.
 * A search run to completion settles every node, and a settled node's
 * distance is final, so the answer for any destination is
 * `min(dist[lo] + dLo, dist[hi] + dHi)` — THE SAME TWO FLOATS the targeted
 * search minimises when it relaxes the destination off its bracket. Same
 * value, bit for bit; one search instead of hundreds.
 *
 * Memoized per graph by source position, capped like `projCaches`.
 */
const srcCaches = new WeakMap<RoadGraph, Map<string, Float64Array>>();

function graphDist(g: RoadGraph, a: QuerySplice, b: QuerySplice): number {
  let cache = srcCaches.get(g);
  if (!cache) {
    cache = new Map();
    srcCaches.set(g, cache);
  }
  const key = `${a.street},${a.arc}`;
  let dist = cache.get(key);
  if (!dist) {
    graphSearch(g, a, null);
    const base = g.street.length;
    dist = new Float64Array(base);
    const mark = stampNo;
    for (let v = 0; v < base; v++) dist[v] = sStamp[v] === mark ? sDist[v] : Infinity;
    if (cache.size > 512) cache.clear();
    cache.set(key, dist);
  }
  let best = Infinity;
  const viaLo = dist[b.lo] + b.dLo;
  if (viaLo < best) best = viaLo;
  const viaHi = dist[b.hi] + b.dHi;
  if (viaHi < best) best = viaHi;
  // Same street, same bracket ⇒ the trip never touches a node at all.
  if (a.street === b.street && a.lo === b.lo && a.hi === b.hi) {
    const direct = Math.abs(a.arc - b.arc);
    if (direct < best) best = direct;
  }
  return best === Infinity ? NaN : best;
}

/** The node/edge sequence of the last `graphSearch`, walked back from the
 *  destination. Only `roadRoute`/`roadStreetPath` pay for this. */
function lastPath(g: RoadGraph): { nodes: number[]; edges: number[] } {
  const base = g.street.length;
  const nodes: number[] = [];
  const edges: number[] = [];
  for (let v = base + 1; v >= 0; v = sPrev[v]) {
    nodes.push(v);
    edges.push(sPrevE[v]);
    if (v === base) break;
  }
  nodes.reverse();
  edges.reverse();
  return { nodes, edges };
}

/** The two spliced query ends, or null when either falls off the graph. */
function spliceEnds(g: RoadGraph, pa: Proj, pb: Proj): [QuerySplice, QuerySplice] | null {
  const a = splice(g, pa.street, pa.arc);
  const b = splice(g, pb.street, pb.arc);
  return a && b ? [a, b] : null;
}

/** Street length of the door-to-door trip, WITHOUT materializing the
 *  waypoints — cheap, so catchment binding and market founding can compare
 *  many (house, source) pairs. O(tree depth) on a link-free net; a heap
 *  search over ~170 nodes once the town has loops. */
export function roadDistance(net: TownStreets, from: Vec2, to: Vec2): number {
  const pa = project(net, from);
  const pb = project(net, to);
  if (net.links && net.links.length > 0) {
    const g = roadGraph(net);
    const ends = spliceEnds(g, pa, pb);
    const d = ends ? graphDist(g, ends[0], ends[1]) : NaN;
    if (d === d) return pa.d + d + pb.d;
  }
  const chainA = chainOf(net.streets, pa.street, pa.arc);
  const chainB = chainOf(net.streets, pb.street, pb.arc);
  const inA = new Map<number, ChainLink>();
  for (const l of chainA) inA.set(l.street, l);
  for (const l of chainB) {
    const m = inA.get(l.street);
    if (m) {
      return pa.d + m.cost + l.cost + onStreetDist(net.streets[l.street], m.arcOn, l.arcOn) + pb.d;
    }
  }
  // Unreachable: both chains end at the baseline.
  return pa.d + Math.hypot(to.x - from.x, to.y - from.y) + pb.d;
}

/** The street ids a door-to-door trip rides, junction to junction —
 *  traffic accounting (street WEAR follows use, city-development §3b).
 *  A LINK carries no id of its own (it is not a `Street`), so a trip that
 *  takes the shortcut wears the two streets it joins and nothing between. */
export function roadStreetPath(net: TownStreets, from: Vec2, to: Vec2): number[] {
  const pa = project(net, from);
  const pb = project(net, to);
  if (net.links && net.links.length > 0) {
    const g = roadGraph(net);
    const ends = spliceEnds(g, pa, pb);
    const d = ends ? graphSearch(g, ends[0], ends[1]) : NaN;
    if (d === d) {
      const base = g.street.length;
      const ids: number[] = [];
      for (const v of lastPath(g).nodes) {
        const sid = v === base ? pa.street : v === base + 1 ? pb.street : g.street[v];
        if (ids[ids.length - 1] !== sid) ids.push(sid);
      }
      return ids;
    }
  }
  const chainA = chainOf(net.streets, pa.street, pa.arc);
  const chainB = chainOf(net.streets, pb.street, pb.arc);
  const inA = new Map<number, number>();
  chainA.forEach((l, i) => inA.set(l.street, i));
  for (let j = 0; j < chainB.length; j++) {
    const i = inA.get(chainB[j].street);
    if (i === undefined) continue;
    const ids = chainA.slice(0, i + 1).map(l => l.street);
    for (let k = j - 1; k >= 0; k--) ids.push(chainB[k].street);
    return ids;
  }
  return [pa.street, pb.street];
}

/**
 * THE JUNCTIONS of the network: every attachment point, with the streets
 * that meet there. The town's ACCESSIBILITY nodes — `plan.ts` ranks them
 * by the trips they carry and founds the civic buildings on the busiest,
 * which is how "civic buildings near the middle" becomes an OUTPUT rather
 * than a hard-coded plaza berth (growth-unification §3).
 */
export interface Junction {
  /** The street the child lanes attach to. */
  street: number;
  arc: number;
  x: number;
  y: number;
  /** Every street meeting here (the parent first, then its children). */
  incident: number[];
}

export function networkJunctions(net: TownStreets): Junction[] {
  const byKey = new Map<string, Junction>();
  for (const s of net.streets) {
    if (s.parent < 0) continue;
    const parent = net.streets[s.parent];
    if (!parent) continue;
    const key = `${s.parent}:${s.parentArc.toFixed(3)}`;
    let j = byKey.get(key);
    if (!j) {
      const p = pointAt(parent, s.parentArc);
      j = { street: s.parent, arc: s.parentArc, x: p.x, y: p.y, incident: [s.parent] };
      byKey.set(key, j);
    }
    j.incident.push(s.id);
  }
  return [...byKey.values()].sort((a, b) => a.street - b.street || a.arc - b.arc);
}

/**
 * Junctions ranked by the TRAFFIC they carry — Σ over `traffic` of the
 * incident streets, ties by the network's own order. `traffic` is the
 * same map `streetTraffic()` builds (trips per street id); a caller with
 * no economy yet passes the tree's own trip load (plan.ts counts the
 * households whose chain to the baseline rides each junction).
 */
export function rankJunctions(
  net: TownStreets, traffic: ReadonlyMap<number, number>,
): Array<Junction & { traffic: number }> {
  const out = networkJunctions(net).map(j => ({
    ...j,
    traffic: j.incident.reduce((a, id) => a + (traffic.get(id) ?? 0), 0),
  }));
  return out.sort((a, b) => b.traffic - a.traffic || a.street - b.street || a.arc - b.arc);
}

/** Points along street `s` from arc `a0` to arc `a1` (exclusive of the
 *  interpolated ends' duplicates). */
function slicePts(s: Street, a0: number, a1: number): Vec2[] {
  const out: Vec2[] = [];
  if (a1 > a0) {
    for (let i = 0; i < s.pts.length; i++) {
      if (s.cum[i] > a0 && s.cum[i] < a1) out.push(s.pts[i]);
    }
    out.push(pointAt(s, a1));
  } else {
    for (let i = s.pts.length - 1; i >= 0; i--) {
      if (s.cum[i] < a0 && s.cum[i] > a1) out.push(s.pts[i]);
    }
    out.push(pointAt(s, a1));
  }
  return out;
}

/** Door-to-door path riding the street tree (town-local meters). The
 *  first and last points are `from`/`to` themselves (the doorstep hop is
 *  the only off-street step). Deterministic; waypoints lie ON streets. */
export function roadRoute(net: TownStreets, from: Vec2, to: Vec2): Vec2[] {
  const pa = project(net, from);
  const pb = project(net, to);
  if (net.links && net.links.length > 0) {
    const g = roadGraph(net);
    const ends = spliceEnds(g, pa, pb);
    const d = ends ? graphSearch(g, ends[0], ends[1]) : NaN;
    if (d === d) {
      const path = lastPath(g);
      const base = g.street.length;
      const streetOf = (v: number): number => (v === base ? pa.street : v === base + 1 ? pb.street : g.street[v]);
      const arcOf = (v: number): number => (v === base ? pa.arc : v === base + 1 ? pb.arc : g.arc[v]);
      const pts: Vec2[] = [from, pa.pt];
      for (let k = 1; k < path.nodes.length; k++) {
        const u = path.nodes[k - 1];
        const v = path.nodes[k];
        const li = path.edges[k];
        if (li >= 0) {
          // THE SHORTCUT ITSELF — walked from whichever end we arrived at.
          const l = net.links![li];
          const fwd = streetOf(u) === l.a.street && arcOf(u) === l.a.arc;
          const lp = fwd ? l.pts : [...l.pts].reverse();
          for (const p of lp) pts.push(p);
          continue;
        }
        // A junction hop joins two names for ONE point: nothing is walked.
        if (streetOf(u) !== streetOf(v)) continue;
        pts.push(...slicePts(net.streets[streetOf(u)], arcOf(u), arcOf(v)));
      }
      pts.push(pb.pt, to);
      return prune(pts);
    }
  }
  const chainA = chainOf(net.streets, pa.street, pa.arc);
  const chainB = chainOf(net.streets, pb.street, pb.arc);
  const inA = new Map<number, number>();
  chainA.forEach((l, i) => inA.set(l.street, i));
  let meetA = 0;
  let meetB = 0;
  for (let j = 0; j < chainB.length; j++) {
    const i = inA.get(chainB[j].street);
    if (i !== undefined) {
      meetA = i;
      meetB = j;
      break;
    }
  }

  const pts: Vec2[] = [from, pa.pt];
  // Down chain A: from the projection toward each junction.
  for (let i = 0; i < meetA; i++) {
    const s = net.streets[chainA[i].street];
    pts.push(...slicePts(s, chainA[i].arcOn, 0));
  }
  // Across the common street.
  const c = net.streets[chainA[meetA].street];
  pts.push(...slicePts(c, chainA[meetA].arcOn, chainB[meetB].arcOn));
  // Up chain B: from each junction out toward the projection.
  for (let j = meetB - 1; j >= 0; j--) {
    const s = net.streets[chainB[j].street];
    pts.push(...slicePts(s, 0, chainB[j].arcOn));
  }
  pts.push(pb.pt, to);
  return prune(pts);
}

function prune(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 0.5) out.push(p);
  }
  // The endpoints are the actual doorsteps — keep them EXACT even when
  // they landed within pruning distance of a street point.
  const fin = pts[pts.length - 1];
  const last = out[out.length - 1];
  if (last !== fin) {
    if (Math.hypot(fin.x - last.x, fin.y - last.y) > 0.5 || out.length < 2) out.push(fin);
    else out[out.length - 1] = fin;
  }
  return out.length >= 2 ? out : [pts[0], fin];
}

export function routeLength(pts: Array<{ x: number; y: number }>): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return len;
}
