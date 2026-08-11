/**
 * INTERCITY ROADS + CARAVANS + STATE BORDERS — the planet's polity made
 * visible.
 *
 * The DATA is shared and deterministic: capitals claim territory by travel
 * cost (planet/states.ts — a state is a label field, so a future merge is a
 * mutation-layer relabel), the road TOPOLOGY is the state adjacency graph
 * (every interstate joins two neighbouring capitals across their real
 * border), and the caravans are a CLOSED-FORM function of the world clock
 * (drawn from the flow, not simulated — the same cart at the same bend on
 * every client that shares the seed and the clock). This module only RENDERS
 * that data into the flight scene, with the same boundary-pair shape
 * everything else streams by:
 *
 *   • FAR: the whole net as wide terrain-draped ribbons per route (built a
 *     few per tick — no founding hitch), readable from cruise altitude,
 *     hidden near the ground where its lift would read as floating. State
 *     borders ride the same layer in a cooler ink.
 *   • NEAR: a streamed window of road around the ground focus, resampled
 *     fine and hugging the terrain — the road you can stand on. Rebuilt as
 *     the focus moves (flora-field's law: world-fixed, so remounts are
 *     invisible). Vertices are CENTER-RELATIVE (the float32 ripple lesson).
 *   • LOCAL: a refined region's village road net (tier 1) joins the live
 *     set as narrower ribbons — and leaves it when the region evicts.
 *   • CARAVANS: instanced cart trains at their closed-form arc positions,
 *     rendered only within sight of the ground focus.
 */
import * as THREE from "three";
import type { CelestialBody } from "@shared/world-engine/space/body";
import { planetCities } from "@shared/world-engine/planet/cities";
import {
  planetRoutes, routeFromDirs, caravanArc, caravanCount, type PlanetRoute,
} from "@shared/world-engine/planet/routes";
import {
  planetStates, statePairs, stateBorders,
} from "@shared/world-engine/planet/states";
import {
  createPolities, claimReader, type PlanetPolities, type PolityRow,
} from "@shared/world-engine/planet/polities";
import { simulateHistory, type PoliticalHistory } from "@shared/world-engine/planet/history";
import type { HighwayRefinement } from "@shared/world-engine/planet/refine";
import type { PaintPatch, RoutePaintEntry } from "@shared/world-engine/planet/route-paint";
import {
  spliceRouteAtTown, toTownLocal, type ArterialTip, type TownFrame,
} from "@shared/world-engine/kernel/town/approach";
import { roadMaterial, surfaceMaterial } from "@shared/world-engine/materials";

// FAR ribbons: a MAP GLYPH, not literal asphalt — the road's equivalent of
// the city beacon. Wide and faintly warm so the net reads from cruise
// altitude (a 44 m terrain-tan ribbon measured ~1 px and invisible), lifted
// over the coarse-LOD terrain between its sparse samples.
const FAR_SEG_M = 2500;
// (The wide FAR road glyph is gone — roads are terrain PAINT now, see the
// route-paint note at the queue. These remain for the border ink's layer.)
// Local (village-tier) roads: a lane, not a highway.
const LOCAL_NEAR_HALF_W_M = 2.5;
// Deep history span: how many years of political past a planet carries
// (nations P5). Content, not physics — the scrubber's domain.
const HISTORY_YEARS = 600;
// State borders: the same map-glyph layer in a cooler ink, lifted a little
// above the roads so a border crossing never z-fights the highway under it.
const BORDER_HALF_W_M = 35;
const BORDER_LIFT_M = 95;
// The far layer hides near the ground (its lift would float) — hysteresis
// so the swap never flaps on a bumpy approach.
const FAR_HIDE_ALT_M = 650;
const FAR_SHOW_ALT_M = 950;
// TERRITORY FILL (nations P6b): a faint wash of each crown's ink over the
// land it holds — the map answer to "which of these dots owns what".
// It is MAP INFORMATION, so it lives at map altitude only: a wash draped
// on 3×3 sub-quads of a tier-0 cell reads as painted ground from orbit,
// but from a hilltop it would cut through the terrain between its samples.
// Hysteresis, generous by design — the swap happens far above the height
// where the seam could be noticed.
const FILL_HIDE_ALT_M = 12_000;
const FILL_SHOW_ALT_M = 18_000;
const FILL_SUB = 3;
const FILL_LIFT_M = 300;
// FAINT, FLAT, and never emissive: a basic material at low opacity cannot
// cross the bloom threshold in space mode, and a territory wash must never
// read as a light source (the specular/flicker safety law — this layer
// repaints on political events, so it MUST NOT be able to flash).
const FILL_OPACITY = 0.26;
// Cells per fill mesh, per axis. Blocks keep vertices center-relative to
// their own patch (the float32 ripple lesson) and let the build drip.
const FILL_BLOCK = 6;
// Fill patches built per tick — each one samples the surface a few hundred
// times, so this stays well under the road ribbons' budget.
const FILL_BUILDS_PER_TICK = 2;
// NEAR window: fine road streamed around the ground focus.
const NEAR_MAX_ALT_M = 3200;
const NEAR_R_M = 9000;
const NEAR_SEG_M = 45;
const NEAR_HALF_W_M = 4.5;
const NEAR_LIFT_M = 1.0;
const NEAR_REBUILD_MOVE_M = 1500;
// Caravans render within sight of the focus; capacity bounds the instancing.
const CARAVAN_VIS_R_M = 8000;
const CARAVAN_CAP = 128;
const CARAVAN_LIFT_M = 0.3;
// Far meshes built per tick — spreads the one-time build over seconds
// instead of hitching the frame the geology bake lands on.
const FAR_BUILDS_PER_TICK = 8;

/** What a refined region hands the render layers. */
export interface RegionRoads {
  /** The village road net (tier-1 hubs — every endpoint a real town). */
  roads: PlanetRoute[];
  /** Interstate crossings re-solved on the child grid: render-only
   *  overrides of the tier-0 geometry within this region. */
  highways: HighwayRefinement[];
}

/** A city whose DETAILED town render is mounted — what the splice needs:
 *  the town's tangent frame + built radius + its street tree's arterial
 *  tips (kernel/town/approach.ts arterialTips). */
export interface TownSpliceSpec {
  frame: TownFrame;
  /** The town's PORT EXTENT — the SAME extent planet/routes.ts terminated
   *  its incident routes at (TOWN_DIMS.townRMax), NOT the built-up radius:
   *  the port is where the road ends, and the built-up radius moves as the
   *  town grows. */
  radiusM: number;
  /** THE TOWN'S GATES (kernel/town/approach.ts `arterialTips`) — resolved
   *  from the street tree's DECLARED ports where it has any. A span-seeded
   *  town's gates ARE its incident roads' ports, so its splices all come
   *  back null and the ribbon simply runs onto the baseline. */
  tips: ArterialTip[];
  /** House footprints in TOWN-LOCAL metres (plan.houses). STUB-TOWN PATH
   *  ONLY (growth phase B §2.2): read solely when a connector exists, i.e.
   *  when the town's streets stop short of the port and the road has to
   *  reach in. The connector's PAINT then stops at the building line — see
   *  paintableConnector: a ribbon may thread the lots to reach its gate, but
   *  ground paint that crossed a footprint would re-open the very
   *  roads-through-buildings bug the port law closed. */
  houses?: ReadonlyArray<{ dx: number; dy: number; w: number; h: number }>;
}

export interface TradeRoads {
  /** Drive the layers (call ~4 Hz): `tSec` = the shared world clock,
   *  `playerWorld` = the player in WORLD coordinates. */
  update(tSec: number, playerWorld: THREE.Vector3): void;
  /** A refined region's roads join the live set (idempotent per key).
   *  `key` is the region key its eviction will call back with. */
  addRegion(key: string, data: RegionRoads): void;
  /** The region evicted — its roads and overrides leave every layer. */
  removeRegion(key: string): void;
  /** A town's detailed render mounted (spec) or left (null): each incident
   *  route's PORT refines into a gate — its last stretch bends onto the
   *  street tree's nearest arterial tip. RENDER-ONLY (the refineHighways law):
   *  route data, lengths and caravan arcs never change — carts project
   *  onto the spliced geometry. Far ribbons keep the map glyph. */
  setTownSplice(cell: number, spec: TownSpliceSpec | null): void;
  /** Founding interstates incident to a city cell, with which endpoint
   *  the city is — the town loader reads true approach bearings off
   *  these polylines (kernel/town/approach.ts) before founding. */
  incidentRoutes(cell: number): Array<{ route: PlanetRoute; end: "a" | "b" }>;
  /** THE POLITY LEDGER (nations P1) — who holds each cost-Voronoi state.
   *  Relabels (merge/cede) repaint the border ink on the next update():
   *  internal borders between joined crowns vanish. */
  readonly polities: PlanetPolities;
  /** The polity claiming the tier-0 cell under a surface DIRECTION (unit,
   *  planet-local), or null on unclaimed ground — beacons read their flag
   *  here (villages and border towns resolve through their region's cell,
   *  the states.ts law). */
  polityAt(dir: readonly [number, number, number]): PolityRow | null;
  /** TERRITORY WASH controls (nations P6b) — the lab's tuning surface for
   *  a layer whose settings are taste, not correctness. `opacity` sets the
   *  wash strength; `force` overrides the altitude gate (true = always on,
   *  false = always off, null = back to altitude-driven). */
  fill(opts: { opacity?: number; force?: boolean | null }): void;
  /** THE NATION LAYER'S MASTER SWITCH — border ink and territory wash.
   *  OFF by default: a planet reads as geography until someone asks to see
   *  who holds it (the lab's 👑 Nations button). While off, no altitude or
   *  `fill({force})` setting can light either layer. */
  nations(on: boolean): void;
  /** Whether the nation layer is currently lit. */
  nationsOn(): boolean;
  /** DEEP HISTORY (nations P5) — centuries of political fusion and
   *  fission over this planet's tier-0 states, simulated lazily on first
   *  call, deterministic per body. Scrub the live map with
   *  `history().applyTo(polities, year)` — cede-only relabels, so border
   *  ink and beacon flags repaint on the version bump and the unions
   *  ledger stays reserved for real consented merges. */
  history(): PoliticalHistory;
  /** Debug probe (window.__roads): what the net built and shows right now. */
  stats(): {
    cities: number; routes: number; localRoutes: number; borders: number;
    highways: number; splices: number; farBuilt: number; farPending: number;
    altM: number; farVisible: boolean; nearActive: boolean; nearVerts: number;
    nearRoutes: number; carts: number;
    fillBuilt: number; fillPending: number; fillVisible: boolean;
  };
  dispose(): void;
}

/** Painted lane half-widths, named so a town connector — and a refined
 *  highway span — paints at the SAME width as the road it continues. */
const INTERSTATE_PAINT_HALF_W_M = 6;
const LOCAL_PAINT_HALF_W_M = 3;

/**
 * The stretch of a port→gate connector that may be PAINTED into the terrain:
 * from the clip (out in open country) inward, stopping at the town's
 * building line.
 *
 * WHY IT IS TRUNCATED. The connector's job is to reach a gate — the street
 * tree's arterial tip — and those tips sit deep inside the town (measured on
 * a 651-house village: gates at 94–219 m against a 450 m port). A ribbon may
 * thread the lots to get there; ground PAINT may not, because painted road
 * across a house footprint is exactly the roads-through-buildings bug the
 * port law was built to close. So the paint runs as far as open ground goes
 * and stops — which is precisely the gap the player sees between the road's
 * dead end and the town, and no further.
 *
 * Returns null when nothing worth painting survives (the buildings already
 * reach the port — a town whose built radius has outgrown the extent).
 */
export function paintableConnector(
  draw: PlanetRoute,
  spec: TownSpliceSpec,
  planetRadius: number,
  halfWidthM: number,
): PlanetRoute | null {
  const houses = spec.houses;
  if (!houses?.length) return draw; // no plan detail — paint the joint whole
  const clear = halfWidthM + 2;
  const kept: Array<readonly [number, number, number]> = [];
  for (const d of draw.dirs) {
    const p = toTownLocal(spec.frame, planetRadius, d);
    if (!p) break;
    let blocked = false;
    for (const h of houses) {
      if (p.x >= h.dx - clear && p.x <= h.dx + h.w + clear
        && p.y >= h.dy - clear && p.y <= h.dy + h.h + clear) { blocked = true; break; }
    }
    if (blocked) break;
    kept.push(d);
  }
  if (kept.length < 2) return null;
  const out = routeFromDirs(kept, planetRadius, draw.a, draw.b);
  return out && out.lengthM > 20 ? out : null;
}

/** Interval subtraction on route-arc spans: what remains of `spans` after
 *  removing every `cut` — the near window draws the tier-0 line only where
 *  no refined override covers it. Exported for the test suite. */
export function subtractSpans(
  spans: Array<[number, number]>,
  cuts: ReadonlyArray<{ s0: number; s1: number }>,
): Array<[number, number]> {
  let cur = spans;
  for (const c of cuts) {
    const next: Array<[number, number]> = [];
    for (const [a, b] of cur) {
      if (c.s1 <= a || c.s0 >= b) { next.push([a, b]); continue; }
      if (c.s0 > a) next.push([a, c.s0]);
      if (c.s1 < b) next.push([c.s1, b]);
    }
    cur = next;
  }
  return cur;
}

/** Arc position → planet-local surface point (JS doubles; callers subtract
 *  their own center before any Float32 storage). */
function samplePos(
  route: PlanetRoute,
  s: number,
  radius: number,
  heightAt: (dir: [number, number, number]) => number,
  liftM: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const cum = route.cum;
  const ss = Math.max(0, Math.min(route.lengthM, s));
  let lo = 0, hi = cum.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! <= ss) lo = mid; else hi = mid;
  }
  const a = route.dirs[lo]!;
  const b = route.dirs[Math.min(lo + 1, route.dirs.length - 1)]!;
  const seg = cum[Math.min(lo + 1, cum.length - 1)]! - cum[lo]!;
  const f = seg > 1e-9 ? (ss - cum[lo]!) / seg : 0;
  // nlerp — the smoothed polyline's segment angles are tiny.
  out.set(
    a[0] + (b[0] - a[0]) * f,
    a[1] + (b[1] - a[1]) * f,
    a[2] + (b[2] - a[2]) * f,
  ).normalize();
  const h = Math.max(0, heightAt([out.x, out.y, out.z]));
  return out.multiplyScalar(radius + h + liftM);
}

/** A terrain-draped ribbon over `[s0, s1]` of a route, vertices relative to
 *  `center`. Normals point outward (the planet's up). */
function buildRibbon(
  route: PlanetRoute,
  s0: number,
  s1: number,
  segM: number,
  halfW: number,
  liftM: number,
  radius: number,
  heightAt: (dir: [number, number, number]) => number,
  center: THREE.Vector3,
  pos: number[],
  nrm: number[],
  idx: number[],
): void {
  const steps = Math.max(1, Math.ceil((s1 - s0) / segM));
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= steps; i++) {
    pts.push(samplePos(route, s0 + ((s1 - s0) * i) / steps, radius, heightAt, liftM, new THREE.Vector3()));
  }
  const base = pos.length / 3;
  const tan = new THREE.Vector3();
  const up = new THREE.Vector3();
  const side = new THREE.Vector3();
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    tan.copy(pts[Math.min(i + 1, pts.length - 1)]!).sub(pts[Math.max(i - 1, 0)]!);
    up.copy(p).normalize();
    side.crossVectors(up, tan);
    const l = side.length();
    if (l < 1e-9) side.set(1, 0, 0); else side.divideScalar(l);
    pos.push(
      p.x + side.x * halfW - center.x, p.y + side.y * halfW - center.y, p.z + side.z * halfW - center.z,
      p.x - side.x * halfW - center.x, p.y - side.y * halfW - center.y, p.z - side.z * halfW - center.z,
    );
    nrm.push(up.x, up.y, up.z, up.x, up.y, up.z);
    if (i + 1 < pts.length) {
      const v = base + i * 2;
      idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
    }
  }
}

function geometryOf(pos: number[], nrm: number[], idx: number[]): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  geo.setIndex(idx);
  return geo;
}

/** The cart-train instance geometry (forward = +Z): wagon, canopy, and a
 *  two-beast team, vertex-colored — one merged BufferGeometry, no loaders. */
function cartGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const c = new THREE.Color();
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, hex: number): void => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    c.set(hex);
    const p = g.getAttribute("position");
    const n = g.getAttribute("normal");
    const base = pos.length / 3;
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nrm.push(n.getX(i), n.getY(i), n.getZ(i));
      col.push(c.r, c.g, c.b);
    }
    const ix = g.getIndex()!;
    for (let i = 0; i < ix.count; i++) idx.push(base + ix.getX(i));
    g.dispose();
  };
  box(2.0, 0.5, 3.0, 0, 0.45, -1.2, 0x3a2c1e); // undercarriage
  box(1.8, 0.9, 3.2, 0, 1.05, -1.2, 0x6b4a2f); // wagon bed
  box(1.9, 0.8, 2.6, 0, 1.9, -1.3, 0xd8cfae);  // canopy
  box(0.8, 1.1, 1.6, -0.55, 0.75, 1.5, 0x8a6b4a); // the team
  box(0.8, 1.1, 1.6, 0.55, 0.75, 1.5, 0x7a5c3d);
  const geo = geometryOf(pos, nrm, idx);
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  return geo;
}

/** A route in the render's live set — interstate at founding, local nets
 *  and highway overrides as regions refine. `tag` names the region a
 *  regional entry leaves with. `carts` marks routes that OWN caravans:
 *  interstates and village roads do; highway overrides don't — their carts
 *  are the PARENT's closed form, projected onto the refined geometry. */
interface LiveRoute {
  route: PlanetRoute;
  /** Surface chords of the route vertices, for near-window distance scans. */
  pts: THREE.Vector3[];
  nearHalfW: number;
  tag: string | null;
  carts: boolean;
}

/** A refined span of a parent interstate (region-owned, render-only). */
interface Override {
  s0: number;
  s1: number;
  route: PlanetRoute;
  tag: string;
}

/** One pending far-ribbon build (drained a few per tick). */
interface FarJob {
  route: PlanetRoute;
  halfW: number;
  liftM: number;
  mat: THREE.Material;
  /** Where the built mesh registers for later disposal (a local net's
   *  sink) — null for founding-time meshes, which live until dispose(). */
  sink: THREE.Mesh[] | null;
  /** Which group the finished mesh joins — borders park in their own so
   *  the nation layer can be hidden without touching the road ribbons.
   *  Undefined = the far group. */
  group?: THREE.Object3D;
}

/**
 * Build the body's polity layer — territory, borders, roads, caravans — and
 * mount it under `body.group` (planet-local, so it orbits and spins with the
 * world). Null when the body has fewer than two cities to join. The claims
 * and route Dijkstras run here, synchronously — the tier-0 grid is a few
 * thousand cells, paid once per approached body.
 */
export function createTradeRoads(body: CelestialBody): TradeRoads | null {
  const built = body.geography;
  if (!built) return null;
  const cities = planetCities(built);
  if (cities.length < 2) return null;
  // The polity: capitals claim territory by travel cost; the road topology
  // is the adjacency graph those claims imply. A world whose capitals never
  // meet (island states) falls back to nearest-K so SOME net still joins
  // whatever the sea allows.
  const states = planetStates(built, cities);
  const pairs = statePairs(states);
  const routes = planetRoutes(built, cities, pairs.length ? { pairs } : {});
  if (!routes.length) return null;
  // WHO holds each state: the polity ledger (nations P1). Border ink draws
  // between POLITIES — at founding every state is its own city-state, so
  // this is byte-identical to the old all-state-borders map until the first
  // relabel; a merge erases the joined crowns' internal line on the next
  // update().
  const polities = createPolities(cities);
  const claimOf = claimReader(polities, states);
  // Deep history is derived, deterministic, and lazy — nobody pays for the
  // centuries until the scrubber asks. Seed = the body id hashed (FNV-1a),
  // so every client sharing the planet shares its past.
  let deepHistory: PoliticalHistory | null = null;
  const historySeed = ((): number => {
    let h = 0x811c9dc5;
    for (let i = 0; i < body.id.length; i++) {
      h = Math.imul(h ^ body.id.charCodeAt(i), 0x01000193);
    }
    return h >>> 0;
  })();

  const radius = body.radius;
  const heightAt = (dir: [number, number, number]): number => built.surface.heightAt(dir);

  const root = new THREE.Group();
  root.name = "trade-roads";
  const farGroup = new THREE.Group();
  const nearGroup = new THREE.Group();
  root.add(farGroup, nearGroup);
  body.group.add(root);

  // Political ink: a cool slate-blue thread, unmistakably not a road.
  const borderMat = roadMaterial(0x93a7c8, { emissive: 0x4f6ea8, emissiveIntensity: 0.5 });
  const nearMat = roadMaterial(0x8f7f63);

  const chordPts = (route: PlanetRoute): THREE.Vector3[] =>
    route.dirs.map(d => new THREE.Vector3(d[0], d[1], d[2]).multiplyScalar(radius));

  // ── The live set: interstate net now, local nets as regions refine ──────
  const live: LiveRoute[] = routes.map(r => ({
    route: r, pts: chordPts(r), nearHalfW: NEAR_HALF_W_M, tag: null, carts: true,
  }));
  const localSinks = new Map<string, THREE.Mesh[]>();
  // Refined interstate spans by PARENT index (live[i].route === routes[i]
  // for the founding entries). The worker derives the same deterministic
  // route list, so (a, b) identity matches without a wire.
  const overrides = new Map<number, Override[]>();
  const interstateIdx = new Map<string, number>(routes.map((r, i) => [`${r.a}:${r.b}`, i]));

  // ── TOWN SPLICES (render-only) ───────────────────────────────────────────
  // Mounted street plans by city cell, and the cuts they impose. Cuts are
  // keyed by ROUTE OBJECT (live indices shift as regions come and go); the
  // Override shape drives both span subtraction and caravan projection.
  const townSpecs = new Map<number, TownSpliceSpec>();
  let townCuts = new Map<PlanetRoute, Override[]>();
  // WHICH ROUTES END AT THIS TOWN is an IDENTITY question now: a route's
  // endpoint is the town's PORT (planet/routes.ts clips every route at the
  // extent), and `route.a`/`route.b` carry the town's own key — exact, no
  // float. The position check remains only to separate a parent route from
  // a REFINED HIGHWAY SPAN, which carries the parent's identities but
  // usually stops far short of the town.
  const TOWN_PORT_SLACK_M = 60;
  const _end = new THREE.Vector3();
  const _ctr = new THREE.Vector3();
  const rebuildTownSplices = (): void => {
    // Previous connectors leave the live set; cuts rebuild wholesale.
    for (let i = live.length - 1; i >= 0; i--) {
      if (live[i]!.tag?.startsWith("town:")) live.splice(i, 1);
    }
    townCuts = new Map();
    if (townSpecs.size) {
      const drawn = new Set<string>(); // one drawn connector per (town, tip)
      const snapshot = live.slice();   // appended connectors never re-splice
      // THE JOINT MUST BE PAINTED. The connector renders as a NEAR ribbon a
      // few metres wide and lifted a metre — at the altitude a town is read
      // from, that is sub-pixel, so a splice that fires perfectly still looks
      // like a road dead-ending in open ground. Terrain paint is what a
      // player reads as "road", so the connector paints too (truncated at the
      // building line — paintableConnector). Bucketed by (town, lane width)
      // because a paint key carries one width.
      const paintJobs = new Map<string, { cell: number; halfW: number; conns: PlanetRoute[] }>();
      for (const lr of snapshot) {
        const route = lr.route;
        for (const [cell, spec] of townSpecs) {
          _ctr.set(spec.frame.center[0], spec.frame.center[1], spec.frame.center[2]).multiplyScalar(radius);
          for (const endName of ["a", "b"] as const) {
            if ((endName === "a" ? route.a : route.b) !== cell) continue;
            const d = endName === "a" ? route.dirs[0]! : route.dirs[route.dirs.length - 1]!;
            _end.set(d[0], d[1], d[2]).multiplyScalar(radius);
            if (_end.distanceTo(_ctr) > spec.radiusM + TOWN_PORT_SLACK_M) continue;
            const cut = spliceRouteAtTown(route, endName, spec.frame, spec.radiusM, spec.tips, radius);
            if (!cut) continue;
            let list = townCuts.get(route);
            if (!list) { list = []; townCuts.set(route, list); }
            list.push({ s0: cut.s0, s1: cut.s1, route: cut.route, tag: `town:${cell}` });
            // A parent route AND its highway override both end at the town;
            // their connectors coincide — draw the first, project through both.
            const dk = `${cell}:${cut.street}:${cut.end}`;
            if (!drawn.has(dk)) {
              drawn.add(dk);
              live.push({
                route: cut.draw, pts: chordPts(cut.draw),
                nearHalfW: lr.nearHalfW, tag: `town:${cell}`, carts: false,
              });
              const halfW = lr.nearHalfW >= NEAR_HALF_W_M
                ? INTERSTATE_PAINT_HALF_W_M : LOCAL_PAINT_HALF_W_M;
              const paint = paintableConnector(cut.draw, spec, radius, halfW);
              if (paint) {
                const pk = `town-connector:${cell}:${halfW}`;
                let job = paintJobs.get(pk);
                if (!job) { job = { cell, halfW, conns: [] }; paintJobs.set(pk, job); }
                job.conns.push(paint);
              }
            }
          }
        }
      }
      // THE KEY IS THE SLOT, THE CONTENT IS THE LAY (growth phase C §3.4).
      // The key still carries only the town and the width, because that is
      // what the paint OCCUPIES and `replaceRoutes` has to be able to find
      // the standing connectors in order to take them back — a key that
      // carried the lay's identity would name a fresh slot on a re-lay and
      // leave the old connectors painted, which is the ghost it was meant to
      // prevent. Identity rides the CONTENT instead: replaceRoutes matches
      // the road asked for against the road standing, so a rebuild that
      // reproduces the same connectors is free (the old addRoutes
      // idempotency, only exact) and a town RE-LAID mid-session repaints.
      for (const [pk, job] of paintJobs) {
        const patch = built.routePaint.replaceRoutes(pk, job.conns, job.halfW);
        if (patch) body.refreshTerrain?.(patch.center, patch.radiusM);
      }
    }
    invalidateNear();
  };

  // ── ROADS ARE TERRAIN PAINT (planet/route-paint.ts) ─────────────────────
  // The far ribbon glyph floated/buried as the quadtree re-chorded the
  // ground and washed the map from altitude — the river-ribbon disease. The
  // net now paints into the terrain's own vertex colours at TRUE lane width
  // (fading below mesh resolution), and standing chunks re-sample once.

  /** ARCS OF A PARENT INTERSTATE A REFINED HIGHWAY HAS TAKEN OVER, by parent
   *  index — and it NEVER SHRINKS. `overrides` above is the near window's
   *  bookkeeping and leaves with its region; this does not, because painted
   *  road is world truth (route-paint's own law) and across a refined span
   *  the refined geometry IS the road. The parent's line diverges from it by
   *  a measured mean of 22.4 km, so painting both would put two roads on the
   *  ground where the world has one. */
  const paintedSpans = new Map<number, Array<{ s0: number; s1: number }>>();

  /** One refresh ball covering two patches, anchored on the first (already a
   *  unit direction, so no re-projection error creeps in). */
  const coverBoth = (p: PaintPatch | null, q: PaintPatch | null): PaintPatch | null => {
    if (!p) return q;
    if (!q) return p;
    const dx = (q.center[0] - p.center[0]) * radius;
    const dy = (q.center[1] - p.center[1]) * radius;
    const dz = (q.center[2] - p.center[2]) * radius;
    return { center: p.center, radiusM: Math.max(p.radiusM, Math.hypot(dx, dy, dz) + q.radiusM) };
  };

  /** (Re)paint the interstate net as the arcs no refinement has taken over.
   *  The span SET is order-independent (subtractSpans splits in place and
   *  the result is always ascending), so two sessions that load the same
   *  regions in different orders paint the same ground. */
  const repaintInterstates = (): PaintPatch | null => {
    const entries: RoutePaintEntry[] = [];
    for (let i = 0; i < routes.length; i++) {
      const route = routes[i]!;
      const cover = paintedSpans.get(i);
      if (!cover?.length) { entries.push(route); continue; }
      for (const [s0, s1] of subtractSpans([[0, route.lengthM]], cover)) {
        // The near window drops sub-20 m remnants too — a metre of parent
        // sticking out past a refinement is a seam, not a road.
        if (s1 - s0 > 20) entries.push({ route, s0, s1 });
      }
    }
    return built.routePaint.replaceRoutes("interstates", entries, INTERSTATE_PAINT_HALF_W_M);
  };
  {
    // Founding paint: nothing is refined yet, so this lays every route whole
    // — byte-identical to the append-only call it replaces.
    const patch = repaintInterstates();
    if (patch) body.refreshTerrain?.(patch.center, patch.radiusM);
  }

  // The far QUEUE remains for BORDER ink only — map information, not ground.
  const farQueue: FarJob[] = [];
  // Borders join the same build queue in their own ink (no caravans, no
  // near window — a border is map information, not a walkable surface).
  // They build into their OWN sink so a polity relabel can repaint them:
  // update() watches polities.version and requeues from the polity-filtered
  // border cells.
  let borderShapes = 0;
  const borderMeshes: THREE.Mesh[] = [];
  let borderVersionDrawn = -1;
  // Border ink lives in its own group so the nation layer is one flag away
  // from invisible — off by default, lit by the lab's 👑 Nations button.
  const borderGroup = new THREE.Group();
  borderGroup.visible = false;
  farGroup.add(borderGroup);
  const queueBorders = (): void => {
    borderVersionDrawn = polities.version;
    for (const m of borderMeshes) {
      borderGroup.remove(m);
      m.geometry.dispose();
    }
    borderMeshes.length = 0;
    // Drop any still-queued border jobs from a previous paint (their sink
    // is the array we just emptied — matching on it is exact).
    for (let i = farQueue.length - 1; i >= 0; i--) {
      if (farQueue[i]!.sink === borderMeshes) farQueue.splice(i, 1);
    }
    borderShapes = 0;
    const lines = stateBorders(built, { ...states, borderCells: polities.claimBorderCells(states) });
    for (let i = 0; i < lines.length; i++) {
      const shape = routeFromDirs(lines[i]!, radius, -1 - i, -1 - i);
      if (!shape) continue;
      borderShapes++;
      farQueue.push({
        route: shape, halfW: BORDER_HALF_W_M, liftM: BORDER_LIFT_M,
        mat: borderMat, sink: borderMeshes, group: borderGroup,
      });
    }
  };
  queueBorders();

  // ── TERRITORY FILL: the claim painted as AREA, not just outlined ────────
  // Geometry is built ONCE (the cell tiling never moves) and a relabel only
  // rewrites the COLOR attribute — which is the P1 law made literal: a
  // merge is a relabel, not new geometry. Blocks build through their own
  // drip so a planet's worth of wash never hitches the frame.
  const fillGroup = new THREE.Group();
  fillGroup.visible = false;
  farGroup.add(fillGroup);
  const fillMat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: FILL_OPACITY,
    depthWrite: false, // a wash tints what's under it; it never occludes
    side: THREE.FrontSide,
  });
  /** One built patch: its mesh, the CELL each vertex came from (the lookup
   *  a recolour walks — positions are never touched again), and the ledger
   *  version its colours were drawn from. Per-patch versioning is what lets
   *  a relabel that lands MID-DRIP repaint exactly the stale patches: a
   *  freshly built one is already current, so the sweep costs nothing until
   *  the map actually changes. */
  interface FillBlock { mesh: THREE.Mesh; cellOf: Int32Array; paintedAt: number }
  const fillBlocks: FillBlock[] = [];
  const fillQueue: number[][] = [];
  let fillBuilt = 0;
  const topo = built.grid.topo;

  // Group claimed cells into blocks of FILL_BLOCK² within a cube face, so
  // each mesh covers a compact patch (center-relative precision) and an
  // ocean-heavy world never queues an empty job.
  if (topo.cellPolygon && topo.pos3) {
    const faceN = built.spec.topology.faceN;
    const perFace = faceN * faceN;
    const blocks = new Map<string, number[]>();
    for (let c = 0; c < topo.n; c++) {
      if (claimOf(c) < 0) continue; // sea, or land no capital ever reached
      const f = Math.floor(c / perFace);
      const rem = c - f * perFace;
      const vi = Math.floor(rem / faceN);
      const ui = rem - vi * faceN;
      const k = `${f}:${Math.floor(ui / FILL_BLOCK)}:${Math.floor(vi / FILL_BLOCK)}`;
      const list = blocks.get(k);
      if (list) list.push(c);
      else blocks.set(k, [c]);
    }
    for (const list of blocks.values()) fillQueue.push(list);
  }

  const _fc = new THREE.Vector3();
  /** Build one block: every claimed cell fanned into FILL_SUB² sub-quads,
   *  each corner draped on the real surface. Bilinear-then-normalize is
   *  well under a pixel across a single cell, and the shared cell corners
   *  come from the lattice itself, so patches meet without cracks. */
  const buildFillBlock = (cells: number[]): void => {
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const owner: number[] = [];
    // Center-relative to the block's first cell (sub-metre residuals).
    const c0 = topo.pos3!(cells[0]!);
    _fc.set(c0[0], c0[1], c0[2]).multiplyScalar(radius + heightAt([c0[0], c0[1], c0[2]]));
    const corner = new THREE.Vector3();
    for (const cell of cells) {
      const p = topo.cellPolygon!(cell);
      const base = pos.length / 3;
      for (let a = 0; a <= FILL_SUB; a++) {
        for (let b = 0; b <= FILL_SUB; b++) {
          const s = a / FILL_SUB;
          const t = b / FILL_SUB;
          // Bilinear across the quad's corners, back onto the sphere.
          const x = (1 - s) * (1 - t) * p[0]![0] + s * (1 - t) * p[1]![0] + s * t * p[2]![0] + (1 - s) * t * p[3]![0];
          const y = (1 - s) * (1 - t) * p[0]![1] + s * (1 - t) * p[1]![1] + s * t * p[2]![1] + (1 - s) * t * p[3]![1];
          const z = (1 - s) * (1 - t) * p[0]![2] + s * (1 - t) * p[1]![2] + s * t * p[2]![2] + (1 - s) * t * p[3]![2];
          const m = Math.hypot(x, y, z);
          const d: [number, number, number] = [x / m, y / m, z / m];
          corner.set(d[0], d[1], d[2]).multiplyScalar(radius + heightAt(d) + FILL_LIFT_M).sub(_fc);
          pos.push(corner.x, corner.y, corner.z);
          col.push(0, 0, 0); // filled by repaintFill
          owner.push(cell);
        }
      }
      const row = FILL_SUB + 1;
      for (let a = 0; a < FILL_SUB; a++) {
        for (let b = 0; b < FILL_SUB; b++) {
          const q = base + a * row + b;
          idx.push(q, q + row, q + row + 1, q, q + row + 1, q + 1);
        }
      }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geom.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    geom.setIndex(idx);
    const mesh = new THREE.Mesh(geom, fillMat);
    mesh.position.copy(_fc);
    mesh.frustumCulled = false; // planet-sized spans defeat sphere culling
    mesh.renderOrder = -1; // under the road and border ribbons
    fillGroup.add(mesh);
    const block: FillBlock = { mesh, cellOf: Int32Array.from(owner), paintedAt: -1 };
    fillBlocks.push(block);
    // Paint it NOW: a patch arriving mid-drip colours itself, so the build
    // never drags the whole planet's colour buffers through a repaint on
    // every tick it is still queued.
    paintFillBlock(block, new Map<number, THREE.Color>());
    fillBuilt++;
  };

  /** Ink per polity id, rebuilt per repaint pass (ids are dense and few). */
  const inkFor = (cache: Map<number, THREE.Color>, id: number): THREE.Color => {
    let ink = cache.get(id);
    if (!ink) {
      ink = new THREE.Color(id < 0 ? "#666a72" : polities.get(id)?.color ?? "#666a72");
      cache.set(id, ink);
    }
    return ink;
  };

  /** Colour one patch from the live claim, stamping the version it read. */
  const paintFillBlock = (block: FillBlock, cache: Map<number, THREE.Color>): void => {
    block.paintedAt = polities.version;
    const attr = block.mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    for (let v = 0; v < block.cellOf.length; v++) {
      const ink = inkFor(cache, claimOf(block.cellOf[v]!));
      arr[v * 3] = ink.r;
      arr[v * 3 + 1] = ink.g;
      arr[v * 3 + 2] = ink.b;
    }
    attr.needsUpdate = true;
  };

  /** THE RELABEL: rewrite vertex colours from the live claim wherever they
   *  are stale. No geometry is rebuilt, so a merge, a cession or a whole
   *  scrubbed century repaints in one pass over the colour buffers — the
   *  P1 law ("a merge is a relabel, not new geometry") made literal. */
  const repaintStaleFill = (): void => {
    const cache = new Map<number, THREE.Color>();
    for (const block of fillBlocks) {
      if (block.paintedAt !== polities.version) paintFillBlock(block, cache);
    }
  };

  let farBuilt = 0;
  const buildSomeFar = (): void => {
    const center = new THREE.Vector3();
    for (let n = 0; n < FAR_BUILDS_PER_TICK && farQueue.length; n++) {
      const job = farQueue.shift()!;
      const pos: number[] = [];
      const nrm: number[] = [];
      const idx: number[] = [];
      // Center-relative to the route's midpoint chord (sub-metre residuals).
      samplePos(job.route, job.route.lengthM / 2, radius, heightAt, 0, center);
      buildRibbon(job.route, 0, job.route.lengthM, FAR_SEG_M, job.halfW, job.liftM,
        radius, heightAt, center, pos, nrm, idx);
      const mesh = new THREE.Mesh(geometryOf(pos, nrm, idx), job.mat);
      mesh.position.copy(center);
      mesh.frustumCulled = false; // planet-sized spans defeat sphere culling
      (job.group ?? farGroup).add(mesh);
      job.sink?.push(mesh);
      farBuilt++;
    }
  };

  // ── NEAR: the fine window around the ground focus ────────────────────────
  let nearMesh: THREE.Mesh | null = null;
  let nearVerts = 0;
  // Live-set indices with geometry built in the window (stats), and the
  // cart-owning routes near it — the ONLY routes whose caravans get
  // evaluated each tick (density is per ~13 km; the whole planet's carts
  // would be thousands of closed forms for nothing). Cart inclusion uses the
  // PRE-subtraction spans: a parent whose window is fully overridden still
  // drives its carts — they just render on the refined geometry.
  let nearRouteIdx: number[] = [];
  let nearCartIdx: number[] = [];
  const nearCenter = new THREE.Vector3();
  const lastNearFocus = new THREE.Vector3(Infinity, Infinity, Infinity);
  const disposeNear = (): void => {
    if (nearMesh) {
      nearGroup.remove(nearMesh);
      nearMesh.geometry.dispose();
      nearMesh = null;
    }
  };
  const rebuildNear = (focusSurf: THREE.Vector3): void => {
    disposeNear();
    lastNearFocus.copy(focusSurf);
    nearCenter.copy(focusSurf);
    nearRouteIdx = [];
    nearCartIdx = [];
    const pos: number[] = [];
    const nrm: number[] = [];
    const idx: number[] = [];
    const seg = new THREE.Vector3();
    const toF = new THREE.Vector3();
    const close = new THREE.Vector3();
    for (let ri = 0; ri < live.length; ri++) {
      const { route, pts, nearHalfW } = live[ri]!;
      // Segment-by-segment distance scan → clipped arc intervals (merged as
      // we go: segments are in route order, so overlaps only touch the tail).
      const spans: Array<[number, number]> = [];
      for (let j = 0; j + 1 < pts.length; j++) {
        const a = pts[j]!;
        seg.copy(pts[j + 1]!).sub(a);
        const len2 = seg.lengthSq();
        if (len2 < 1e-9) continue;
        toF.copy(focusSurf).sub(a);
        const t = Math.max(0, Math.min(1, toF.dot(seg) / len2));
        close.copy(a).addScaledVector(seg, t);
        const d = close.distanceTo(focusSurf);
        if (d >= NEAR_R_M) continue;
        const segM = route.cum[j + 1]! - route.cum[j]!;
        const sMid = route.cum[j]! + t * segM;
        const half = Math.sqrt(NEAR_R_M * NEAR_R_M - d * d);
        const s0 = Math.max(0, sMid - half);
        const s1 = Math.min(route.lengthM, sMid + half);
        const last = spans[spans.length - 1];
        if (last && s0 <= last[1] + NEAR_SEG_M) last[1] = Math.max(last[1], s1);
        else spans.push([s0, s1]);
      }
      if (spans.length) {
        if (live[ri]!.carts) nearCartIdx.push(ri);
        // The tier-0 line draws only where no refined override covers it —
        // the override's own live entry draws the physical road there. Town
        // cuts subtract the same way: the connector entry draws the joint.
        const ov = overrides.get(ri);
        const tc = townCuts.get(route);
        const cuts = tc ? (ov?.length ? [...ov, ...tc] : tc) : ov;
        const drawn = cuts?.length
          ? subtractSpans(spans, cuts).filter(([a, b]) => b - a > 20)
          : spans;
        if (drawn.length) nearRouteIdx.push(ri);
        for (const [s0, s1] of drawn) {
          buildRibbon(route, s0, s1, NEAR_SEG_M, nearHalfW, NEAR_LIFT_M,
            radius, heightAt, nearCenter, pos, nrm, idx);
        }
      }
    }
    nearVerts = pos.length / 3;
    if (!idx.length) return;
    nearMesh = new THREE.Mesh(geometryOf(pos, nrm, idx), nearMat);
    nearMesh.position.copy(nearCenter);
    nearMesh.frustumCulled = false;
    nearGroup.add(nearMesh);
  };
  /** The live set changed (a region's roads arrived or left) — the next
   *  update re-windows whatever the focus now sees. */
  const invalidateNear = (): void => {
    nearRouteIdx = [];
    lastNearFocus.set(Infinity, Infinity, Infinity);
  };

  // ── CARAVANS ─────────────────────────────────────────────────────────────
  const cartMat = surfaceMaterial({ roughness: 1, flatShading: false });
  const carts = new THREE.InstancedMesh(cartGeometry(), cartMat, CARAVAN_CAP);
  carts.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  carts.frustumCulled = false;
  carts.count = 0;
  // Instance translations are residuals against this anchor (float32 in the
  // instance matrix — planet-local metres would quantize to half a metre).
  const cartAnchor = new THREE.Group();
  cartAnchor.add(carts);
  root.add(cartAnchor);

  const _m = new THREE.Matrix4();
  const _p = new THREE.Vector3();
  const _ahead = new THREE.Vector3();
  const _up = new THREE.Vector3();
  const _fwd = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const driveCaravans = (tSec: number, focusSurf: THREE.Vector3): void => {
    cartAnchor.position.copy(focusSurf);
    let n = 0;
    const cutAt = (list: Override[] | undefined, s: number): Override | null => {
      if (list) for (const o of list) if (s >= o.s0 && s <= o.s1) return o;
      return null;
    };
    for (const ri of nearCartIdx) {
      const route = live[ri]!.route;
      const ovs = overrides.get(ri);
      const tcs = townCuts.get(route);
      const count = caravanCount(route);
      for (let i = 0; i < count && n < CARAVAN_CAP; i++) {
        // WORLD STATE is the parent arc (identical on every client sharing
        // the clock, whatever regions each has loaded); the refined span is
        // a local RENDER of that state — map the arc fraction across. Town
        // cuts win where both cover (the visibly spliced road).
        const { s, sign } = caravanArc(route, i, tSec);
        let geom = route;
        let gs = s;
        const o = cutAt(tcs, s) ?? cutAt(ovs, s);
        if (o) {
          geom = o.route;
          gs = ((s - o.s0) / Math.max(1e-9, o.s1 - o.s0)) * o.route.lengthM;
        }
        // Cheap cull first (no terrain read): surface chord distance.
        samplePos(geom, gs, radius, () => 0, 0, _p);
        if (_p.distanceTo(focusSurf) > CARAVAN_VIS_R_M) continue;
        samplePos(geom, gs, radius, heightAt, CARAVAN_LIFT_M, _p);
        samplePos(geom, gs + 25 * sign, radius, heightAt, CARAVAN_LIFT_M, _ahead);
        _up.copy(_p).normalize();
        _fwd.copy(_ahead).sub(_p);
        _fwd.addScaledVector(_up, -_fwd.dot(_up));
        if (_fwd.lengthSq() < 1e-9) _fwd.set(0, 0, 1);
        _fwd.normalize();
        _right.crossVectors(_up, _fwd);
        _m.makeBasis(_right, _up, _fwd);
        _m.setPosition(_p.x - focusSurf.x, _p.y - focusSurf.y, _p.z - focusSurf.z);
        carts.setMatrixAt(n++, _m);
      }
    }
    carts.count = n;
    carts.instanceMatrix.needsUpdate = true;
  };

  // ── The drive ────────────────────────────────────────────────────────────
  let farVisible = true;
  let fillVisible = false;
  /** null = the altitude gate decides; true/false pins it (lab tuning). */
  let fillForced: boolean | null = null;
  /** The nation layer's master switch — see nations(). Off until asked. */
  let nationsLit = false;
  let lastAlt = Infinity;
  let lastNearActive = false;
  const _local = new THREE.Vector3();
  const _focus = new THREE.Vector3();

  return {
    polities,
    history() {
      if (!deepHistory) {
        deepHistory = simulateHistory({
          cities, states, seed: historySeed, years: HISTORY_YEARS,
        });
      }
      return deepHistory;
    },
    fill(opts) {
      if (opts.opacity !== undefined) {
        fillMat.opacity = Math.max(0, Math.min(1, opts.opacity));
      }
      if (opts.force !== undefined) {
        fillForced = opts.force;
        if (opts.force !== null) fillGroup.visible = nationsLit && opts.force;
      }
    },
    nations(on) {
      nationsLit = on;
      borderGroup.visible = on;
      fillGroup.visible = on && (fillForced ?? fillVisible);
    },
    nationsOn() {
      return nationsLit;
    },
    polityAt(dir) {
      const cell = built.grid.topo.cellAt?.([dir[0], dir[1], dir[2]]) ?? -1;
      if (cell < 0) return null;
      const id = claimOf(cell);
      return id < 0 ? null : polities.get(id) ?? null;
    },
    update(tSec, playerWorld) {
      // A relabel (union, cession) repaints the border ink: internal lines
      // between joined crowns vanish, new frontiers appear.
      if (polities.version !== borderVersionDrawn) queueBorders();
      if (farQueue.length) buildSomeFar();
      // The territory wash builds on its own drip, then follows the same
      // version watermark — a merge recolours it without touching a vertex.
      for (let n = 0; n < FILL_BUILDS_PER_TICK && fillQueue.length; n++) {
        buildFillBlock(fillQueue.shift()!); // paints itself as it lands
      }
      // Cheap when nothing changed (a version compare per patch); a relabel
      // — including one that lands mid-drip — repaints exactly the stale
      // patches, once.
      if (fillBlocks.length) repaintStaleFill();
      // Planet-local through the world-maintained pose (current every frame;
      // the scene matrix lags a frame — kilometres at orbital speed).
      _local.copy(playerWorld).sub(body.worldPosition).applyQuaternion(body.inverseOrientation);
      const alt = _local.length() - radius;
      lastAlt = alt;
      if (farVisible && alt < FAR_HIDE_ALT_M) farVisible = false;
      else if (!farVisible && alt > FAR_SHOW_ALT_M) farVisible = true;
      farGroup.visible = farVisible;
      // The wash is map information: it wants the map's viewing distance,
      // well above where its draping seams could be read from a hillside.
      if (fillVisible && alt < FILL_HIDE_ALT_M) fillVisible = false;
      else if (!fillVisible && alt > FILL_SHOW_ALT_M) fillVisible = true;
      fillGroup.visible = nationsLit && (fillForced ?? fillVisible);

      const nearActive = alt < NEAR_MAX_ALT_M;
      lastNearActive = nearActive;
      nearGroup.visible = nearActive;
      cartAnchor.visible = nearActive;
      if (!nearActive) return;
      _focus.copy(_local).normalize().multiplyScalar(radius);
      if (_focus.distanceTo(lastNearFocus) > NEAR_REBUILD_MOVE_M) rebuildNear(_focus);
      driveCaravans(tSec, _focus);
    },
    addRegion(key, data) {
      if (localSinks.has(key)) return;
      const sink: THREE.Mesh[] = [];
      localSinks.set(key, sink);
      for (const r of data.roads) {
        live.push({ route: r, pts: chordPts(r), nearHalfW: LOCAL_NEAR_HALF_W_M, tag: key, carts: true });
      }
      // Village lanes paint like the interstates — narrower, same law. The
      // paint persists after eviction (world truth); `replaceRoutes` keeps it
      // free when a region re-lands with the same lanes and repaints it when
      // the refinement really changed.
      let patch = built.routePaint.replaceRoutes(key, data.roads, LOCAL_PAINT_HALF_W_M);
      const refined: PlanetRoute[] = [];
      for (const hw of data.highways) {
        const ri = interstateIdx.get(`${hw.a}:${hw.b}`);
        if (ri === undefined) continue; // a route this net never derived
        // The refined span renders as its own near-window route (interstate
        // width, no far ribbon — the tier-0 glyph keeps the map role) and
        // registers as the parent's override for suppression + cart mapping.
        live.push({ route: hw.route, pts: chordPts(hw.route), nearHalfW: NEAR_HALF_W_M, tag: key, carts: false });
        let list = overrides.get(ri);
        if (!list) { list = []; overrides.set(ri, list); }
        list.push({ s0: hw.s0, s1: hw.s1, route: hw.route, tag: key });
        // AND THE REFINED SPAN NOW PAINTS (growth phase C §3.4). It could not
        // before: the parent is painted end to end and diverges from the
        // refinement, so the ground would have carried both lines. It can
        // now, because the parent gives the span back.
        refined.push(hw.route);
        let cover = paintedSpans.get(ri);
        if (!cover) { cover = []; paintedSpans.set(ri, cover); }
        // A region that evicts and re-lands hands back the same spans; the
        // ledger records each once so it cannot grow with the churn.
        if (!cover.some(c => c.s0 === hw.s0 && c.s1 === hw.s1)) {
          cover.push({ s0: hw.s0, s1: hw.s1 });
        }
      }
      if (refined.length) {
        patch = coverBoth(patch, built.routePaint.replaceRoutes(
          `${key}:highways`, refined, INTERSTATE_PAINT_HALF_W_M));
        patch = coverBoth(patch, repaintInterstates());
      }
      // The region loader refreshes this same ground right after us on the
      // normal path; this call is what covers the OTHER one — a region that
      // refined before the net existed and sweeps in through ensureRoadNet,
      // where nobody else re-samples the chunks its paint just changed.
      if (patch) body.refreshTerrain?.(patch.center, patch.radiusM);
      if (data.roads.length || data.highways.length) {
        // New routes may end at an already-mounted town — re-derive cuts.
        if (townSpecs.size) rebuildTownSplices();
        else invalidateNear();
      }
    },
    removeRegion(key) {
      const sink = localSinks.get(key);
      if (!sink) return;
      localSinks.delete(key);
      for (const mesh of sink) {
        farGroup.remove(mesh);
        mesh.geometry.dispose();
      }
      let changed = false;
      for (let i = live.length - 1; i >= 0; i--) {
        if (live[i]!.tag === key) { live.splice(i, 1); changed = true; }
      }
      for (const [ri, list] of overrides) {
        const kept = list.filter(o => o.tag !== key);
        if (kept.length !== list.length) {
          changed = true;
          if (kept.length) overrides.set(ri, kept);
          else overrides.delete(ri);
        }
      }
      // `paintedSpans` is DELIBERATELY not swept here. The overrides above
      // are render bookkeeping and belong to the region; the paint under
      // them is ground, and ground does not leave with the streamer. Give
      // the parent its span back and the world would grow a second road
      // through the hills the refinement went round.
      for (let i = farQueue.length - 1; i >= 0; i--) {
        if (farQueue[i]!.sink === sink) farQueue.splice(i, 1);
      }
      if (changed) {
        if (townSpecs.size) rebuildTownSplices(); // drop cuts of evicted routes
        else invalidateNear();
      }
    },
    setTownSplice(cell, spec) {
      if (spec) townSpecs.set(cell, spec);
      else if (!townSpecs.delete(cell)) return;
      rebuildTownSplices();
    },
    incidentRoutes(cell) {
      const out: Array<{ route: PlanetRoute; end: "a" | "b" }> = [];
      for (const r of routes) {
        if (r.a === cell) out.push({ route: r, end: "a" });
        else if (r.b === cell) out.push({ route: r, end: "b" });
      }
      return out;
    },
    stats: () => ({
      cities: cities.length, routes: routes.length,
      localRoutes: live.filter(l => l.tag !== null && l.carts).length,
      borders: borderShapes,
      highways: [...overrides.values()].reduce((s, l) => s + l.length, 0),
      splices: townSpecs.size,
      farBuilt, farPending: farQueue.length, altM: Math.round(lastAlt),
      farVisible, nearActive: lastNearActive, nearVerts,
      nearRoutes: nearRouteIdx.length, carts: carts.count,
      fillBuilt, fillPending: fillQueue.length, fillVisible,
    }),
    dispose() {
      disposeNear();
      // The fill lives in its own subgroup, so it is disposed explicitly —
      // the farGroup sweep below only reaches Meshes, and would silently
      // leak a planet's worth of wash geometry.
      for (const { mesh } of fillBlocks) mesh.geometry.dispose();
      fillBlocks.length = 0;
      fillQueue.length = 0;
      farGroup.remove(fillGroup);
      // Border ink is in its own subgroup too — the sweep below only reaches
      // farGroup's direct Mesh children, so dispose it by hand.
      for (const m of borderMeshes) m.geometry.dispose();
      borderMeshes.length = 0;
      farGroup.remove(borderGroup);
      for (const m of [...farGroup.children]) {
        farGroup.remove(m);
        (m as THREE.Mesh).geometry?.dispose();
      }
      carts.geometry.dispose();
      cartMat.dispose();
      borderMat.dispose();
      fillMat.dispose();
      nearMat.dispose();
      body.group.remove(root);
    },
  };
}
