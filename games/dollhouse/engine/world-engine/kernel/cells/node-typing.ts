// Cell Systems — NODE TYPING for founding sites (resources-and-trade.md §②).
//
// The SITES pass gains a taxonomy: every committed settlement site is read
// off terrain the world already has — rivers (flow accumulation), the sea
// line, the treeline, fertility and ore — and classified as the ECONOMIC
// NODE its geography makes it. **Geography chooses, spec marks**: nothing
// here is hand-placed (the emergent-over-scripted law), and nothing here is
// a new dynamic — a pure, deterministic read like the founding scan itself.
//
// The node type is the settlement's JOB-DESCRIPTION SEED (the fractal law:
// "this city exists because…" must be PRINTABLE from spec + derivation).
// `sentence` is that derivation, printed. A site matching NO taxon gets
// `type: null` and an honest sentence — which is exactly what Gate C
// (settlement-emergence.md §5) will later cap at village: a settlement with
// no hinterland job.
//
// WATER-FIRST VETO: a node with no fresh water within its charter box caps
// at waystation regardless of what the geography wanted — recorded as
// `freshWater: false` (the CAP is §④'s business; the FACT is worldgen's).
//
// Thresholds default to the substrate's own established lines (sea 3,
// treeline 40, watercourse 16, unwalkable river 45, charter radius 3) and
// are all overridable — ratios in the engine, absolutes in the spec.
//
// `shadow` is the one taxon that is NOT local: fertile land outside every
// market's raw-bulk reach (DISTANCE is the reason refining exists — §③
// reads this). It needs the founded set and a reach, so it is a SECOND
// pass (`markShadows`) over committed cities, with the reach derived from
// the freight arithmetic (`rawBulkReachCells` — the Ox Paradox in cells).

import { carryReachM, REAL_ASYMMETRY, type TransportAsymmetry } from "../../freight";
import type { WorldScale } from "../../scale";

/** The economic node taxonomy (resources-and-trade.md §②). */
export type NodeType =
  | "mouth"       // river meets sea — cargo changes keels
  | "anchorage"   // a sheltered bay on an open coast
  | "chokepoint"  // the one passable way through blocked ground
  | "junction"    // watercourses meet — traffic mingles
  | "extraction"  // the ground yields what the lowlands lack
  | "surplus"     // flat, wet, fertile — the caloric battery
  | "shadow";     // fertile but beyond every market's raw-bulk reach

/** Precedence when several taxa match — the rarer constraint outranks the
 *  commoner blessing (a fertile river mouth is a MOUTH that also farms). */
export const NODE_PRECEDENCE: readonly NodeType[] = [
  "mouth", "anchorage", "chokepoint", "junction", "extraction", "shadow", "surplus",
];

export interface NodeReading {
  /** Primary job seed (first match in NODE_PRECEDENCE), or null — land
   *  with no distinguishing constraint (Gate C's village-cap case). */
  type: NodeType | null;
  /** Every taxon the terrain matched, in precedence order. */
  types: NodeType[];
  /** Fresh water within the charter box (a watercourse, rain above the
   *  desert line, or fertile ground — the substrate's own water proxy).
   *  false = the water-first veto: caps at waystation whatever the type. */
  freshWater: boolean;
  /** The printed job description — derivation, never prose authored. */
  sentence: string;
}

export interface NodeTypingOpts {
  /** Charter/scan radius in cells (default 3 — the charter box). */
  radius?: number;
  /** Below this height a cell is SEA (default 3 — the substrate sea line). */
  seaHeight?: number;
  /** At/above this height a cell is high ground (default 40 — treeline). */
  treeline?: number;
  /** Flow at/over which a cell carries a genuine watercourse (default 16 —
   *  travel.ts's fording line). */
  watercourse?: number;
  /** Flow at/over which the river is MAJOR (default 45 — the unwalkable
   *  channel; a mouth needs a river worth shipping on). */
  majorRiver?: number;
  /** Share of the box that must be blocked ground (high or sea) to read as
   *  a chokepoint (default 0.45). v1 measures NARROWNESS, not through-ness
   *  — a dead-end bowl can false-positive until the route graph (§⑤). */
  chokeBlockedFrac?: number;
  /** Sea share of the box that reads as a sheltered BAY: above the floor
   *  there is real water, below the ceiling it is mostly enclosed.
   *  Defaults 0.08–0.25: a straight open coast two cells off already puts
   *  ~0.29 of the box under water (two full rows of 7), so the ceiling
   *  sits just below it — a pocket bay (~0.12) reads, a beachfront
   *  doesn't. A shape heuristic, not a bathymetric truth (v1). */
  bayFrac?: { min: number; max: number };
  /** Charter-box fertility sum at/over which land is surplus country
   *  (default 180 — a rich river band, ~¼ of the box at full fertility). */
  surplusFarmland?: number;
  /** Land relief (max − min height over the box) at/under which the box is
   *  FLAT enough to farm at scale (default 6). */
  flatRelief?: number;
  /** Charter-box ore sum at/over which the ground is worth traveling for
   *  (default 50 — the acceptance world's mine-country line). Must also
   *  out-yield the box's fertility (mine country, not farm country). */
  extractionOre?: number;
  /** Rain at/over which the sky waters a riverless site (default 0.25 —
   *  climate.ts's desert floor). Read only when the grid carries `rain`. */
  rainFloor?: number;
}

/** What the classifier reads — a CellGrid satisfies it structurally.
 *  `neighbours`/`dist2` are optional so thinner grids degrade (junction
 *  detection needs neighbours; the shadow pass needs dist2). */
export interface NodeGrid {
  topo: {
    n?: number;
    disk(i: number, r: number, visit: (cell: number, dist: number) => void): void;
    neighbours?(i: number, out: number[]): number;
    maxDegree?: number;
    dist2?(a: number, b: number): number;
  };
  fields: Record<string, ArrayLike<number>>;
}

const DEFAULTS = {
  radius: 3, seaHeight: 3, treeline: 40, watercourse: 16, majorRiver: 45,
  chokeBlockedFrac: 0.45, bayFrac: { min: 0.08, max: 0.25 },
  surplusFarmland: 180, flatRelief: 6, extractionOre: 50, rainFloor: 0.25,
} as const;

/** The printed derivations — the fractal job-description law's test: if the
 *  sentence can't be generated, the derivation is missing, not the prose.
 *  Exported as NODE_SENTENCES: Gate C (civ/jobs.ts) prints each matched
 *  taxon's own sentence, not only the primary's. */
export const NODE_SENTENCES: Record<NodeType, string> = {
  mouth: "exists because the river meets the sea here, and cargo must change keels",
  anchorage: "exists because this bay shelters hulls the open coast would break",
  chokepoint: "exists because the one passable way through the blocked ground runs here",
  junction: "exists because watercourses meet here, and their traffic mingles",
  extraction: "exists because the ground yields what the lowlands lack",
  surplus: "exists because flat wet land grows more here than its farmers can eat",
  shadow:
    "exists because its grain cannot reach a market as grain — it refines what it grows, or stays a village",
};
const NO_JOB_SENTENCE = "has no reason to be more than the land around it";
const NO_WATER_SUFFIX = " — but there is no fresh water: a waystation, whatever the geography wanted";

function sentenceFor(types: NodeType[], freshWater: boolean): string {
  const body = types.length ? NODE_SENTENCES[types[0]] : NO_JOB_SENTENCE;
  return freshWater ? body : body + NO_WATER_SUFFIX;
}

/**
 * Classify one site cell — a pure, deterministic read over the charter box.
 * The shadow taxon never appears here (it needs the founded set — see
 * `markShadows`); everything else is local terrain.
 */
export function classifyNode(grid: NodeGrid, cell: number, opts: NodeTypingOpts = {}): NodeReading {
  const o = { ...DEFAULTS, ...opts, bayFrac: { ...DEFAULTS.bayFrac, ...opts.bayFrac } };
  const height = grid.fields.height;
  const river = grid.fields.river;
  const fert = grid.fields.fertility;
  const ore = grid.fields.ore;
  const rain = grid.fields.rain;

  let diskCount = 0;
  let seaCount = 0;
  let blockedCount = 0;
  let seaMinDist = Infinity;
  let maxRiverAtSeaEdge = 0; // strongest flow within 1 cell of the sea
  let maxRiver = 0;
  let boxFert = 0;
  let boxOre = 0;
  let rainOk = false;
  let minLandH = Infinity;
  let maxLandH = -Infinity;
  const riverCells: number[] = [];

  grid.topo.disk(cell, o.radius, (c, dist) => {
    diskCount++;
    const h = height ? height[c] : 0;
    const sea = h < o.seaHeight;
    const high = h >= o.treeline;
    if (sea) {
      seaCount++;
      if (dist < seaMinDist) seaMinDist = dist;
    } else {
      if (h < minLandH) minLandH = h;
      if (h > maxLandH) maxLandH = h;
    }
    if (sea || high) blockedCount++;
    const rv = river ? river[c] : 0;
    if (rv > maxRiver) maxRiver = rv;
    if (rv >= o.watercourse) riverCells.push(c);
    if (fert) boxFert += fert[c];
    if (ore) boxOre += ore[c];
    if (rain && rain[c] >= o.rainFloor) rainOk = true;
  });

  // A river reaching the sea: the strongest flow adjacent to a sea cell.
  if (river && height && seaCount > 0) {
    grid.topo.disk(cell, o.radius, (c) => {
      if (height[c] < o.seaHeight) return;
      if ((river[c] ?? 0) < o.watercourse) return;
      // does this watercourse cell touch the sea?
      const nb: number[] = new Array(grid.topo.maxDegree ?? 8).fill(0);
      if (!grid.topo.neighbours) return;
      const k = grid.topo.neighbours(c, nb);
      for (let j = 0; j < k; j++) {
        if (height[nb[j]] < o.seaHeight) {
          if (river[c] > maxRiverAtSeaEdge) maxRiverAtSeaEdge = river[c];
          return;
        }
      }
    });
  }

  // Confluence: a watercourse cell fed by ≥2 smaller watercourses — where
  // two arms of the network become one (needs neighbour access).
  let confluence = false;
  if (river && grid.topo.neighbours) {
    const nb: number[] = new Array(grid.topo.maxDegree ?? 8).fill(0);
    for (const c of riverCells) {
      const own = river[c];
      let feeders = 0;
      const k = grid.topo.neighbours(c, nb);
      for (let j = 0; j < k; j++) {
        const f = river[nb[j]];
        if (f >= o.watercourse && f < own) feeders++;
      }
      if (feeders >= 2) { confluence = true; break; }
    }
  }

  const freshWater = maxRiver >= o.watercourse || rainOk || boxFert > 0;
  const seaFrac = diskCount > 0 ? seaCount / diskCount : 0;
  const relief = maxLandH >= minLandH ? maxLandH - minLandH : 0;

  const types: NodeType[] = [];
  // mouth: a genuine river actually entering the sea inside the box (with a
  // neighbour-less grid, fall back to "major river + sea both present").
  if (seaCount > 0 && (maxRiverAtSeaEdge >= o.watercourse || (!grid.topo.neighbours && maxRiver >= o.majorRiver))) {
    types.push("mouth");
  }
  // anchorage: shore of a SHELTERED bay (some sea, mostly enclosed), and
  // not already a mouth (the river names the job there).
  if (!types.includes("mouth") && seaMinDist <= 2 && seaFrac >= o.bayFrac.min && seaFrac <= o.bayFrac.max) {
    types.push("anchorage");
  }
  // chokepoint: the box is mostly blocked ground and this site is the way
  // through (narrowness; through-ness waits for the route graph).
  if (blockedCount / Math.max(1, diskCount) >= o.chokeBlockedFrac && seaFrac < 1) {
    types.push("chokepoint");
  }
  if (confluence) types.push("junction");
  if (boxOre >= o.extractionOre && boxOre > boxFert) types.push("extraction");
  if (boxFert >= o.surplusFarmland && relief <= o.flatRelief && freshWater) types.push("surplus");

  types.sort((a, b) => NODE_PRECEDENCE.indexOf(a) - NODE_PRECEDENCE.indexOf(b));
  return {
    type: types[0] ?? null,
    types,
    freshWater,
    sentence: sentenceFor(types, freshWater),
  };
}

/**
 * THE SHADOW PASS (second pass, over the committed set): a surplus node
 * with no OTHER settlement within `reachCells` is fertile land whose raw
 * bulk dies on the road — it becomes a `shadow` node (upgrading its
 * primary), which is what licenses refining there (§③). Markets are simply
 * the other settlements; reach comes from the freight arithmetic
 * (`rawBulkReachCells`). Mutates the readings in place and returns them.
 */
export function markShadows(
  grid: NodeGrid,
  cities: Array<{ cell: number; node: NodeReading }>,
  reachCells: number,
  opts: { alsoBare?: boolean } = {},
): Array<{ cell: number; node: NodeReading }> {
  if (!grid.topo.dist2) return cities;
  const reach2 = reachCells * reachCells;
  for (const c of cities) {
    const surplusish = c.node.types.includes("surplus") || (opts.alsoBare && c.node.type === null);
    if (!surplusish) continue;
    let reached = false;
    for (const other of cities) {
      if (other === c) continue;
      if (grid.topo.dist2!(c.cell, other.cell) <= reach2) { reached = true; break; }
    }
    if (reached) continue;
    if (!c.node.types.includes("shadow")) {
      c.node.types.push("shadow");
      c.node.types.sort((a, b) => NODE_PRECEDENCE.indexOf(a) - NODE_PRECEDENCE.indexOf(b));
    }
    c.node.type = c.node.types[0] ?? null;
    c.node.sentence = sentenceFor(c.node.types, c.node.freshWater);
  }
  return cities;
}

/**
 * The raw-bulk market reach in CELLS — the bridge from the freight
 * arithmetic to the lattice. Value density 1 is the caloric anchor (the
 * UNIT, not a named good): the distance at which hauling staple bulk
 * overland stops paying, under this world's own legs, appetite and day.
 */
export function rawBulkReachCells(
  scale: WorldScale,
  cellM: number,
  asym: TransportAsymmetry = REAL_ASYMMETRY,
): number {
  return carryReachM(scale, { valueDensity: 1, transit: "selfConsuming" }, "land", asym) / Math.max(1e-9, cellM);
}
