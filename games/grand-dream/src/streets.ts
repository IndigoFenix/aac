/**
 * streets.ts — the ORGANIC street skeleton of a town, replacing the polar
 * rings-and-spokes template (town-roads.ts, retired). A town is grown as a
 * STREET TREE from a plaza kernel by a deterministic event stream: each
 * round every live street extends one step (with gentle heading drift) and
 * recorded branch ports may sprout side lanes. Every extension step emits
 * the house lots that front it, so the global slot sequence is the order
 * construction happened — the lot list IS the town's development history,
 * and prefix stability falls out (city-development.md §2b: the map reads
 * as accretion because it is one). Same scalars + seed ⇒ byte-identical
 * streets; a bigger town runs the SAME event stream further, so streets
 * only extend and lots only append.
 *
 * Routing is tree routing: a position is (street, arc); door-to-door
 * paths climb parent chains to the deepest common street (ultimately the
 * plaza ring, a closed pseudo-street every arterial roots on) and walk
 * the difference. `roadDistance` is O(depth) — cheap enough for the food
 * economy to compare every (house, source) pair — and `roadRoute`
 * materializes the same path as waypoints that lie ON streets, preserving
 * the old contract: NPCs walk like people, never through a parlor.
 */

/* ------------------------------ types ------------------------------- */

export interface Vec2 {
  x: number;
  y: number;
}

export interface Street {
  id: number;
  /** -1 = the plaza ring; 0 = arterial off the plaza; +1 per branch. */
  gen: number;
  /** Parent street id (-1 only for the plaza ring itself). */
  parent: number;
  /** Arc length along the parent where this street's origin attaches. */
  parentArc: number;
  /** Which arterial subtree this street descends from (-1 = the ring). */
  arm: number;
  /** The plaza ring is closed: arc wraps at `cum[pts.length-1]`. */
  ring?: boolean;
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

export interface TownStreets {
  plazaR: number;
  streets: Street[];
  /** Frontage slots in EVENT ORDER — the prefix-stable lot sequence. */
  slots: LotSlot[];
}

/* ---------------------------- constants ------------------------------ */

/** Plaza radius; the plaza ring road runs on this circle. */
export const PLAZA_R = 20;
/** One growth step of street, meters — also the lot pitch per side. */
const STEP = 14;
/** Town edge: streets stop here (the km² tile is 500 m half-width). */
const R_MAX = 430;
/** A street tip keeps this clear of any other street's centerline —
 *  village-dense: one lot row fits between two lanes (the polar template
 *  packed rings 15 m apart; an organic mesh needs about the same to hold
 *  a real town inside its tile). */
const MIN_GAP = 18;
/** Lot centers sit this far off their street's centerline. */
const LOT_SETBACK = 7.2;
/** A lot keeps this clear of any FOREIGN street's centerline (houses may
 *  BACK snugly onto the next lane — medieval, like the ring template). */
const LOT_CLEAR = 4.2;
/** Lot centers keep this far apart (own street's pitch is 14). */
const SLOT_GAP = 8.5;
/** No lots within this arc of a street's own origin (junction mouth). */
const JUNCTION_KEEP = 9;
/** No lots within this arc of a branch port on the same side. */
const PORT_KEEP = 10;
/** Ports keep this much street between them (sibling lanes don't
 *  crowd each other into MIN_GAP failures). */
const PORT_SPACING = 26;
/** A failed port retries this many times before it is spent (later
 *  attempts jitter differently — a lane finds its way eventually). */
const PORT_TRIES = 3;
/** Streets deeper than this never branch (arterial → lane → alley…). */
const MAX_GEN = 6;
/** Length caps by gen (arterials are radius-capped instead). */
const MAX_LEN = [Infinity, 300, 210, 150, 110, 80, 60];
/** Per extension step per side: chance the slot becomes a branch PORT. */
const PORT_P = [0.34, 0.3, 0.24, 0.18, 0.12, 0.1, 0];
/** Per round per unused port: chance it fires (tries to sprout). */
const FIRE_P = [0.45, 0.32, 0.24, 0.18, 0.14, 0.12, 0];
/** Heading jitter per step / persistent curvature range (radians). */
const JIT = 0.28;
const CURV = 0.05;

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

interface GrowState {
  streets: Street[];
  slots: LotSlot[];
  ports: Port[];
  ptGrid: PointGrid<StreetPt>;
  slotGrid: PointGrid<LotSlot>;
  /** Live heading/curvature per street id (not part of the output). */
  heading: number[];
  curv: number[];
  rng: () => number;
}

export interface GrowOpts {
  /** Preferred arterial bearings (radians), most important first — the
   *  typed seeds of city-development.md §2b: roads out toward trade
   *  partners, the farm road toward the fertile side, the mine road
   *  toward the ore. Up to three are honored; the rest of the arterials
   *  fan out randomly as before. Part of the deterministic input: same
   *  bearings ⇒ same town, changed bearings ⇒ a re-laid town. */
  bearings?: number[];
}

/** Smallest absolute angular separation between two bearings. */
function angSep(a: number, b: number): number {
  let d = Math.abs(a - b) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d;
}

/**
 * Grow the street tree until at least `minSlots` lots exist (or the town
 * is full). The event stream is fixed by (seed, key, opts): a run to a
 * higher `minSlots` replays the same events and continues — streets only
 * extend, slots only append, so lot k is stable as the town grows.
 */
export function growStreets(seed: number, key: string, minSlots: number, opts?: GrowOpts): TownStreets {
  const rng = mulberry32(hashSeed(seed, `${key}:streets`));

  // The plaza ring: a closed pseudo-street every arterial roots on.
  const RING_N = 40;
  const ringPts: Vec2[] = [];
  for (let i = 0; i <= RING_N; i++) {
    const a = (i / RING_N) * Math.PI * 2;
    ringPts.push({ x: Math.cos(a) * PLAZA_R, y: Math.sin(a) * PLAZA_R });
  }
  const ring: Street = {
    id: 0, gen: -1, parent: -1, parentArc: 0, arm: -1, ring: true,
    pts: ringPts, cum: cumOf(ringPts), capped: true,
  };

  const st: GrowState = {
    streets: [ring],
    slots: [],
    ports: [],
    ptGrid: new PointGrid<StreetPt>(),
    slotGrid: new PointGrid<LotSlot>(),
    heading: [0],
    curv: [0],
    rng,
  };
  for (let i = 0; i < ringPts.length - 1; i++) {
    st.ptGrid.add({ ...ringPts[i], street: 0, arc: ring.cum[i] });
  }

  // Arterials: 3–4 streets out of the plaza at spread bearings — the
  // crossroads the town grew on; everything else branches off them. (Two
  // was fragile: one arterial blocked early left the plaza at the town's
  // EDGE, with the whole town lopsided behind it.)
  const seedArterial = (bearing: number, arm: number): void => {
    const gateArc = ringArcAt(ring, bearing);
    const gate = { x: Math.cos(bearing) * PLAZA_R, y: Math.sin(bearing) * PLAZA_R };
    if (tipBlocked(st, { id: -1, parent: 0, parentArc: gateArc } as Street,
      { x: Math.cos(bearing) * (PLAZA_R + STEP), y: Math.sin(bearing) * (PLAZA_R + STEP) })) {
      return; // the mouth is built over — this bearing is lost
    }
    const s: Street = {
      id: st.streets.length, gen: 0, parent: 0, parentArc: gateArc, arm,
      pts: [gate], cum: [0], capped: false,
    };
    st.streets.push(s);
    st.heading[s.id] = bearing;
    st.curv[s.id] = (rng() - 0.5) * 2 * CURV;
  };
  // Typed bearings first (trade roads, the farm/mine side), deduped;
  // the remaining arterials fan out from a random rotation. A blocked
  // or clustered gate self-heals through the reseeding below.
  const given: number[] = [];
  for (const b of opts?.bearings ?? []) {
    if (given.length >= 3) break;
    if (given.some(g => angSep(g, b) < 0.5)) continue;
    given.push(b);
  }
  const nArterial = Math.max(given.length, 3 + (rng() < 0.5 ? 1 : 0));
  const theta0 = rng() * Math.PI * 2;
  let arms = 0;
  for (const b of given) seedArterial(b + (rng() - 0.5) * 0.2, arms++);
  const rest = nArterial - given.length;
  for (let i = 0; i < rest; i++) {
    seedArterial(theta0 + (i / Math.max(1, rest)) * Math.PI * 2 + (rng() - 0.5) * 0.5, arms++);
  }

  // Rounds: extend every live street a step, then let ports fire.
  let barren = 0;
  for (let round = 0; round < 600 && st.slots.length < minSlots; round++) {
    // A maturing town opens NEW radial roads: periodically seed another
    // arterial into the widest angular gap between existing gates (a
    // dead arm — one arterial blocked early — gets rebuilt instead of
    // leaving half the town forever empty).
    if (round >= 18 && round % 12 === 6) {
      // Only arterials that BECAME roads count as coverage — a stub that
      // capped at a few steps leaves its sector effectively empty, and
      // the gap measure must see that hole to rebuild it.
      const bearings = st.streets
        .filter(s => s.gen === 0 && (!s.capped || s.cum[s.cum.length - 1] >= 80))
        .map(s => (s.parentArc / ring.cum[ring.cum.length - 1]) * Math.PI * 2)
        .sort((a, b) => a - b);
      let gapAt = 0;
      let gap = 0;
      for (let i = 0; i < bearings.length; i++) {
        const next = i + 1 < bearings.length ? bearings[i + 1] : bearings[0] + Math.PI * 2;
        if (next - bearings[i] > gap) {
          gap = next - bearings[i];
          gapAt = bearings[i] + (next - bearings[i]) / 2;
        }
      }
      if (gap > 1.6) seedArterial(gapAt + (rng() - 0.5) * 0.3, arms++);
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

  return { plazaR: PLAZA_R, streets: st.streets, slots: st.slots };
}

function cumOf(pts: Vec2[]): number[] {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  return cum;
}

/** Arc position on the (uniform) ring for a bearing angle. */
function ringArcAt(ring: Street, bearing: number): number {
  const total = ring.cum[ring.cum.length - 1];
  const t = ((bearing % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  return (t / (Math.PI * 2)) * total;
}

/** Arc separation on a street, wrap-aware (the plaza ring is closed). */
function arcSep(s: Street, a: number, b: number): number {
  const d = Math.abs(a - b);
  if (!s.ring) return d;
  const total = s.cum[s.cum.length - 1];
  return Math.min(d, total - d);
}

/** May the tip at `p` grow here? Checks foreign street proximity. */
function tipBlocked(st: GrowState, s: Street, p: Vec2): boolean {
  if (Math.hypot(p.x, p.y) > R_MAX) return true;
  if (Math.hypot(p.x, p.y) < PLAZA_R + 2) return true; // don't curve back in
  for (const q of st.ptGrid.near(p, MIN_GAP)) {
    if (q.street === s.id) continue;
    // The parent is legitimately close near our own junction.
    if (q.street === s.parent && arcSep(st.streets[s.parent], q.arc, s.parentArc) < 30) continue;
    return true;
  }
  return false;
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
  for (const turn of [0, 0.55 * sgn, -0.55 * sgn, 1.0 * sgn]) {
    const hc = h0 + turn;
    const cand = { x: tip.x + Math.cos(hc) * STEP, y: tip.y + Math.sin(hc) * STEP };
    const mid = { x: (tip.x + cand.x) / 2, y: (tip.y + cand.y) / 2 };
    if (!tipBlocked(st, s, cand) && !tipBlocked(st, s, mid)) {
      next = cand;
      h = hc;
      break;
    }
  }
  if (!next) {
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

  // Frontage: one slot per side of the new step (or a branch port).
  const slotArc = arc - STEP / 2;
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
    if (Math.hypot(c.x, c.y) < PLAZA_R + 6) continue;
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
  return true;
}

/** Try to sprout a child street at a fired port. */
function sprout(st: GrowState, port: Port): boolean {
  const { rng } = st;
  const parent = st.streets[port.street];
  const origin = pointAt(parent, port.arc);
  const tangent = tangentAt(parent, port.arc);
  const base = tangent + (port.side * Math.PI) / 2;

  const clearAt = (h: number): Vec2 | null => {
    const tip = { x: origin.x + Math.cos(h) * STEP, y: origin.y + Math.sin(h) * STEP };
    if (Math.hypot(tip.x, tip.y) > R_MAX || Math.hypot(tip.x, tip.y) < PLAZA_R + 2) return null;
    for (const q of st.ptGrid.near(tip, MIN_GAP)) {
      if (q.street === port.street && arcSep(parent, q.arc, port.arc) < 30) continue;
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
  if (!tip) return false;

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

/* ---------------------------- geometry ------------------------------- */

/** Point on a street's centerline at arc length `a` (clamped). */
export function pointAt(s: Street, a: number): Vec2 {
  const total = s.cum[s.cum.length - 1];
  let arc = Math.max(0, Math.min(total, a));
  if (s.ring) arc = ((a % total) + total) % total;
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
  const arc = s.ring ? ((a % total) + total) % total : Math.max(0, Math.min(total, a));
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

/** The path from a position up the tree to the plaza ring. */
function chainOf(net: TownStreets, street: number, arc: number): ChainLink[] {
  const out: ChainLink[] = [];
  let cur = street;
  let arcOn = arc;
  let cost = 0;
  for (;;) {
    out.push({ street: cur, arcOn, cost });
    const s = net.streets[cur];
    if (s.parent < 0) break;
    cost += arcOn; // walk back to our origin (the junction on the parent)
    arcOn = s.parentArc;
    cur = s.parent;
  }
  return out;
}

/** Arc distance between two positions on one street (ring wraps). */
function onStreetDist(s: Street, a: number, b: number): number {
  const d = Math.abs(a - b);
  if (!s.ring) return d;
  const total = s.cum[s.cum.length - 1];
  return Math.min(d, total - d);
}

/** Street length of the door-to-door trip, WITHOUT materializing the
 *  waypoints — cheap (O(tree depth)), so catchment binding and market
 *  founding can compare many (house, source) pairs. */
export function roadDistance(net: TownStreets, from: Vec2, to: Vec2): number {
  const pa = project(net, from);
  const pb = project(net, to);
  const chainA = chainOf(net, pa.street, pa.arc);
  const chainB = chainOf(net, pb.street, pb.arc);
  const inA = new Map<number, ChainLink>();
  for (const l of chainA) inA.set(l.street, l);
  for (const l of chainB) {
    const m = inA.get(l.street);
    if (m) {
      return pa.d + m.cost + l.cost + onStreetDist(net.streets[l.street], m.arcOn, l.arcOn) + pb.d;
    }
  }
  // Unreachable: both chains end at the ring.
  return pa.d + Math.hypot(to.x - from.x, to.y - from.y) + pb.d;
}

/** The street ids a door-to-door trip rides, junction to junction —
 *  traffic accounting (street WEAR follows use, city-development §3b). */
export function roadStreetPath(net: TownStreets, from: Vec2, to: Vec2): number[] {
  const pa = project(net, from);
  const pb = project(net, to);
  const chainA = chainOf(net, pa.street, pa.arc);
  const chainB = chainOf(net, pb.street, pb.arc);
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

/** Points along street `s` from arc `a0` to arc `a1` (exclusive of the
 *  interpolated ends' duplicates; ring takes the shorter way round). */
function slicePts(s: Street, a0: number, a1: number): Vec2[] {
  const out: Vec2[] = [];
  if (s.ring) {
    const total = s.cum[s.cum.length - 1];
    let d = (a1 - a0) % total;
    if (d > total / 2) d -= total;
    if (d < -total / 2) d += total;
    const steps = Math.max(1, Math.ceil(Math.abs(d) / 5));
    for (let i = 1; i <= steps; i++) {
      out.push(pointAt(s, a0 + (d * i) / steps));
    }
    return out;
  }
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
  const chainA = chainOf(net, pa.street, pa.arc);
  const chainB = chainOf(net, pb.street, pb.arc);
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
