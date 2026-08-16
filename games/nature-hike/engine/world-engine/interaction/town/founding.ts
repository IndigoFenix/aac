// shared/world-engine/interaction/town/founding.ts
//
// FOUNDING (city-expansion step 0): wilderness → a new settlement SITE.
//
// A FoundedSite is the record a spoken "build" creates in open country: a
// position, a material STOCK (one glyph→count stack map — the same shape as
// every container in the game; feedback_items_stack_one_container), and the
// CONSTRUCTION OVERLAY (kernel/town/construction.ts TownDeltas) that the
// existing construction system (annex / placement / put-directive) accrues
// into once the site raises buildings. Nothing here is a new inventory or a
// new construction concept — the site is the SEAM between the wilderness and
// town-play's documented founding path (`TownPlayConfig.key/charter/startPop`
// + `deltas`): `siteTownConfig` hands the site to `buildTownPlay` unchanged
// when the settlement grows a real town.
//
// EMPTINESS (the abandonment contract — see siteIsEmpty): a site is EMPTY
// exactly when it has
//   • no buildings   (`buildings === 0` — nothing raised on the ground), and
//   • no residents   (`residents` empty — no creature homed to it), and
//   • no construction (every TownDeltas building delta is empty — no annex,
//     no demolition, no placed furniture has ever been kept).
// Deposited MATERIALS do NOT make a site non-empty: an abandoned empty site
// spills its stock back onto the ground (abandonSite), so nothing is lost and
// no ghost site remains.
//
// Pure data + functions — no DOM, no THREE, headless-tested
// (server/tests/town-founding.test.ts).

import {
  createTownDeltas,
  deltaIsEmpty,
  type TownDeltas,
} from "@shared/world-engine/kernel/town/construction.js";
import type { TownPlayConfig } from "./town-play.js";
import { headOf } from "../../variations.js";
import { buildingChainGlyphs } from "../../products.js";
import { forageRadiusM, type WorldScale } from "../../scale.js";
import { TOWN_DIMS } from "@shared/world-engine/kernel/town/dimensions.js";

/** The BUILDING-MATERIAL stack glyphs a site's stock accepts — DERIVED from
 *  the natural-sources registry (products.ts): every `use: "building"`
 *  product glyph (wood from the trees, stone from the rocks) PLUS their
 *  refined targets (blocks — phase 3: the yard holds the whole chain).
 *  Everything else (food, toys) stays personal — a site stockpile is a
 *  builder's yard, not a pantry. */
export const SITE_MATERIAL_GLYPHS: readonly string[] = buildingChainGlyphs();

export function isSiteMaterial(glyph: string): boolean {
  // Stack signatures are composed glyphs — "wood" and any facted variant of
  // it ("wood.wet") are the same material head.
  const head = headOf(glyph);
  return SITE_MATERIAL_GLYPHS.includes(head);
}

/** Leaving an EMPTY site farther than this (metres, world/sim units) clears
 *  it. Hosts on small manifolds clamp it down (see siteAbandonRadius). */
export const SITE_ABANDON_RADIUS_M = 120;

/** The abandon radius for a world `side` metres across — the constant,
 *  clamped so a small demo manifold can still be "left". */
export function siteAbandonRadius(side: number): number {
  return Math.min(SITE_ABANDON_RADIUS_M, Math.max(24, side * 0.45));
}

/** The founded site's stockpile container object id (ONE site per session). */
export const SITE_STOCK_ID = "site:stock";

export interface FoundedSite {
  /** Settlement key — street-plan identity when the town builds (town-play). */
  key: string;
  /** Deterministic seed the site's town will build from. */
  seed: number;
  /** The founding point (world/sim coords). */
  at: { x: number; y: number };
  /** Town-clock day the site was founded (0 when the host has no clock). */
  foundedDay: number;
  /** Building materials deposited at the site — glyph → count. The host
   *  aliases this object as the stock container's stack map, so the ordinary
   *  container put/take path IS the site's deposit/draw path. */
  stock: Record<string, number>;
  /** The construction overlay the existing system (annex/placement) accrues
   *  into. Fresh (empty) at founding; serialized into the town config. */
  deltas: TownDeltas;
  /** Structures raised on the site (0 at founding). */
  buildings: number;
  /** Creature ids homed to the site (none at founding). */
  residents: string[];
}

export interface FoundSiteOpts {
  seed: number;
  at: { x: number; y: number };
  /** Settlement key; default derives from the seed. */
  key?: string;
  /** Town-clock day of the founding. Default 0. */
  day?: number;
  /** THE SITE'S DOOR (world/sim coords) — where its access lane meets the
   *  ground. Default: the founding point itself. */
  door?: { x: number; y: number };
  /** THE NETWORK THIS SITE JOINS (world/sim coords): points on standing
   *  circulation the founder can already reach — a neighbouring homestead's
   *  door, the track they walked in on. See `foundSite` for what is done
   *  with it. Absent/empty = a lone founder in trackless wilderness. */
  network?: ReadonlyArray<{ x: number; y: number }>;
}

/**
 * Found a new, EMPTY site. Deterministic in its options.
 *
 * THE ACCESS LANE (growth phase C §3.2, growth-unification §3 "seeds, not
 * centers"). A homestead is not a point: it is a door and the lane that
 * reaches it. When the founder can name any standing circulation, the site
 * records `door → the nearest of it` as a SPINE seed in its own construction
 * overlay — the same `deltas.addSeed` pipe the street tree's seed set rides
 * (phase B §2.1), which `siteTownConfig` already serializes and `town-play`
 * already replays into `growStreets`. So the lane a settler actually walked
 * becomes the baseline their town grows along, and the `spine` seed kind —
 * shipped in phase B and fed by nothing until now — gets its first producer.
 *
 * V1 IS A CHORD, deliberately. The lane is the straight `[door, nearest]`
 * pair, which is exactly what `attachSeedPath` lays inside a town when a
 * secondary seed joins the network; bending it around standing ground is the
 * obstacle-rect work the tree already does once the town exists, and pricing
 * it is phase F's (a road with a bill).
 *
 * TOWN-LOCAL FRAME: the site IS its town's origin, so the lane is recorded
 * relative to `at`. A lane of zero length (the door is already on the
 * network) records nothing — a seed the tree could not grow along is worse
 * than no seed, and the stub baseline is the honest degenerate case.
 */
export function foundSite(opts: FoundSiteOpts): FoundedSite {
  const deltas = createTownDeltas();
  const at = { x: opts.at.x, y: opts.at.y };
  const door = opts.door ?? at;
  const lane = accessLane(at, door, opts.network ?? []);
  if (lane) deltas.addSeed({ kind: "spine", lanes: [lane] });
  return {
    key: opts.key ?? `site-${(opts.seed >>> 0).toString(36)}`,
    seed: opts.seed,
    at,
    foundedDay: Math.max(0, Math.floor(opts.day ?? 0)),
    stock: {},
    deltas,
    buildings: 0,
    residents: [],
  };
}

/** Metres below which a lane is not a lane — the door already stands on the
 *  network. Half a street step (`streets.ts STEP` is 24 m): a seed shorter
 *  than one growth step densifies to a single point and the tree can lay
 *  nothing along it. */
const MIN_LANE_M = 12;

/** `door → the nearest network point`, in the site's own (town-local)
 *  frame — the chord v1 of the access lane. Null when there is nothing to
 *  join, or when the door is already on it. Deterministic: ties fall to the
 *  earliest network point (strict improvement only). */
function accessLane(
  at: { x: number; y: number },
  door: { x: number; y: number },
  network: ReadonlyArray<{ x: number; y: number }>,
): Array<{ x: number; y: number }> | null {
  let best: { x: number; y: number } | null = null;
  let bestD2 = Infinity;
  for (const p of network) {
    const d2 = (p.x - door.x) ** 2 + (p.y - door.y) ** 2;
    if (d2 < bestD2) { bestD2 = d2; best = p; }
  }
  if (!best || bestD2 < MIN_LANE_M * MIN_LANE_M) return null;
  return [
    { x: door.x - at.x, y: door.y - at.y },
    { x: best.x - at.x, y: best.y - at.y },
  ];
}

/** THE SITE'S ACCESS LANE, town-local, read back off the overlay (the spine
 *  seeds `foundSite` recorded). Empty for a lone founder in trackless
 *  wilderness. The cluster pass (§3.3) merges these into the town's spine. */
export function siteLanes(site: FoundedSite): Array<Array<{ x: number; y: number }>> {
  const out: Array<Array<{ x: number; y: number }>> = [];
  for (const s of [...site.deltas.seeds()].sort((a, b) => a.ord - b.ord)) {
    if (s.kind === "spine") out.push(...s.lanes.map(l => l.map(p => ({ x: p.x, y: p.y }))));
  }
  return out;
}

/** Move every BUILDING-MATERIAL stack out of `from` into the site's stock
 *  (mutates both — pass the pocket / a pile's stack map directly). Non-material
 *  stacks are left untouched. Returns the units moved, by glyph. */
export function depositSiteStock(
  site: FoundedSite,
  from: Record<string, number>,
): Record<string, number> {
  const moved: Record<string, number> = {};
  for (const [glyph, n] of Object.entries(from)) {
    if (!isSiteMaterial(glyph) || n <= 0) continue;
    site.stock[glyph] = (site.stock[glyph] ?? 0) + n;
    moved[glyph] = n;
    delete from[glyph];
  }
  return moved;
}

/** The emptiness contract (see the module doc): no buildings, no residents,
 *  no construction ever kept in the overlay. Materials do NOT count. */
export function siteIsEmpty(site: FoundedSite): boolean {
  if (site.buildings > 0 || site.residents.length > 0) return false;
  if (site.deltas.founded().length > 0) return false; // a founded building IS construction (①b)
  for (const key of site.deltas.keys()) {
    if (!deltaIsEmpty(site.deltas.get(key))) return false;
  }
  return true;
}

/** Record a raised structure / a creature homed to the site — the mutators
 *  future construction/settlement systems call so `siteIsEmpty` stays true
 *  to the ground. */
export function noteSiteBuilding(site: FoundedSite): void {
  site.buildings += 1;
}
export function noteSiteResident(site: FoundedSite, creatureId: string): void {
  if (!site.residents.includes(creatureId)) site.residents.push(creatureId);
}

/** Abandon the site: empties its stock and returns the SPILL (glyph → count)
 *  for the host to lay back on the ground as loose piles. The caller drops
 *  the record + the stock container — nothing of the site remains. */
export function abandonSite(site: FoundedSite): Record<string, number> {
  const spill = { ...site.stock };
  for (const g of Object.keys(site.stock)) delete site.stock[g];
  return spill;
}

// ─────────────────────── HOMESTEAD CLUSTERING (growth phase C §3.3) ────────
//
// growth-unification.md §4, the observed arm: "when N homesteads stand within
// one shared service radius, a town scope is founded OVER them — scope
// re-parenting, the homesteads annexed as standing buildings, their lanes
// joining the seed set. The first building founded is NOT the hub; there is
// no hub."
//
// The whole thing is ONE re-parenting, so it reuses the shipped seam rather
// than minting a second one: N `FoundedSite`s merge into ONE (the eldest's
// identity — its cell, its key, its seed, so the planet registration is a
// RELABEL and not a new address: `registerFoundedPlanetSite`/`snapshotLive`,
// world-lab main.ts), and `siteTownConfig` then builds the town from it
// exactly as it builds any site's town. Nothing new travels to town-play.

/**
 * THE SHARED RADIUS a cluster is measured at: `forageRadiusM` — the one-way
 * reach a camp can work and still sleep at home (`scale.ts`, the forage-side
 * twin of `serviceRadiusM`, and the carved seat this is the first consumer
 * of). Two homesteads inside one camp's reach are working the same land;
 * that is what makes them a village rather than two farms.
 *
 * `side` clamps it to a small manifold the way `siteAbandonRadius` does — a
 * demo world whose whole ground is narrower than the reach would otherwise
 * declare every site in it one cluster.
 */
export function clusterRadiusM(scale: WorldScale, side?: number): number {
  const reach = forageRadiusM(scale);
  return side === undefined ? reach : Math.min(reach, Math.max(24, side * 0.45));
}

/** How many homesteads make a town. Two is a hamlet and already wants a lane
 *  between them; the bar is deliberately the smallest number that is a
 *  SETTLEMENT rather than a farm. Content — a host may raise it. */
export const CLUSTER_MIN_SITES = 3;

/** FOUNDING ORD, deterministic: the day it was founded, then its key. A
 *  `FoundedSite` carries no ordinal of its own (one site per session was the
 *  shipped world), and this pair is total and stable across hosts. */
export function foundingOrder(a: FoundedSite, b: FoundedSite): number {
  return a.foundedDay - b.foundedDay || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/**
 * The clusters standing in `sites`: single-link groups whose members are
 * within `radiusM` of one another (transitively — a chain of homesteads a
 * camp-reach apart IS one village street). Groups smaller than `minSites`
 * are not clusters and are left alone.
 *
 * Deterministic: sites are visited in founding order and each group comes
 * back in founding order, so the same ground always yields the same towns in
 * the same sequence however the host happened to store its sites.
 */
export function clusterSites(
  sites: readonly FoundedSite[],
  radiusM: number,
  minSites: number = CLUSTER_MIN_SITES,
): FoundedSite[][] {
  const ordered = [...sites].sort(foundingOrder);
  const r2 = radiusM * radiusM;
  const seen = new Set<number>();
  const out: FoundedSite[][] = [];
  for (let i = 0; i < ordered.length; i++) {
    if (seen.has(i)) continue;
    // Flood the single-link neighbourhood, lowest index first — the visit
    // order is the ordinal order, so the group is built deterministically.
    const group = [i];
    seen.add(i);
    for (let g = 0; g < group.length; g++) {
      const a = ordered[group[g]!]!;
      for (let j = 0; j < ordered.length; j++) {
        if (seen.has(j)) continue;
        const b = ordered[j]!;
        if ((a.at.x - b.at.x) ** 2 + (a.at.y - b.at.y) ** 2 > r2) continue;
        seen.add(j);
        group.push(j);
      }
    }
    if (group.length >= minSites) out.push(group.sort((p, q) => p - q).map(k => ordered[k]!));
  }
  return out;
}

/** A footprint the street tree must bend around (`GrowOpts.obstacles`) —
 *  an ANNEXED homestead sits off-lattice, on ground it chose before the
 *  town existed. */
export interface SiteRect { x: number; y: number; w: number; h: number }

/** The standing footprints in a site's overlay that stand on GROUND rather
 *  than on a frontage lot (`slot < 0` — see `mergeSites`). Town-local. The
 *  street tree takes these as obstacles so its lanes bend around the
 *  homesteads it grew up between, which is the "building-aware street
 *  growth" growth-unification §3 deferred until something needed it. */
export function siteObstacles(site: FoundedSite): SiteRect[] {
  return site.deltas.founded()
    .filter(b => b.slot < 0)
    .map(b => ({ x: b.dx, y: b.dy, w: b.w, h: b.h }));
}

/**
 * A LANE STOPS AT THE FARMYARD, never through the parlour. Trim `lane` to the
 * maximal run of it standing clear of every annexed footprint, taken about
 * its midpoint — the open ground between two homesteads. Both ends need it:
 * a lane between two farms starts inside one yard and finishes inside the
 * other, and the street tree would refuse to grow on either (streets.ts pads
 * every obstacle by `lotClear` and skips both centrelines and frontage
 * inside it), so a seed laid there is a baseline nothing can front.
 *
 * Sampled rather than clipped analytically: a lane is a chord of at most a
 * camp's reach, the sample is a metre, and the answer is deterministic.
 * Null when no clear ground is left — two homesteads that close are ONE yard.
 */
function trimLane(
  lane: ReadonlyArray<{ x: number; y: number }>,
  rects: ReadonlyArray<SiteRect>,
  pad: number,
): Array<{ x: number; y: number }> | null {
  if (lane.length < 2 || rects.length === 0) return lane.length >= 2 ? [...lane] : null;
  const a = lane[0]!;
  const b = lane[lane.length - 1]!;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (!(len > 0)) return null;
  const n = Math.max(8, Math.ceil(len));
  const inside = (t: number): boolean => {
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    return rects.some(r =>
      x > r.x - pad && x < r.x + r.w + pad && y > r.y - pad && y < r.y + r.h + pad);
  };
  const mid = Math.round(n / 2);
  if (inside(mid / n)) return null;
  let lo = mid;
  while (lo > 0 && !inside((lo - 1) / n)) lo--;
  let hi = mid;
  while (hi < n && !inside((hi + 1) / n)) hi++;
  const at = (i: number): { x: number; y: number } => ({
    x: a.x + ((b.x - a.x) * i) / n,
    y: a.y + ((b.y - a.y) * i) / n,
  });
  const p0 = at(lo);
  const p1 = at(hi);
  return Math.hypot(p1.x - p0.x, p1.y - p0.y) >= MIN_LANE_M ? [p0, p1] : null;
}

/** The clearance a spine seed keeps from a standing footprint — the same
 *  `lotClear` the street tree pads every obstacle by, so a lane the merge
 *  laid is ground the tree will actually accept. */
const LANE_CLEAR_M = TOWN_DIMS.lotClear;

/**
 * FOUND A TOWN OVER A CLUSTER — the re-parenting. Returns ONE `FoundedSite`
 * carrying the whole cluster: hand it to `siteTownConfig` and the ordinary
 * founding path builds the town.
 *
 * The eldest site (founding order) is the town's IDENTITY and its frame
 * origin — not because it is a hub (there is none; the plaza is an OUTPUT of
 * the network, phase C §1.3) but because a re-parenting must keep an address:
 * the planet already knows that cell, so the town is a relabel of a thing
 * that stands, never a new thing beside it.
 *
 * What merges, and under which law:
 *  - **STOCK — item conservation.** Every site's yard and its overlay's yard
 *    are summed into the town's. Nothing is created and nothing is lost; a
 *    plank that was at a homestead is at the town.
 *  - **STANDING BUILDINGS — annexed rows + obstacle rects.** Each absorbed
 *    site's founded rows travel with their construction record (the
 *    `registerFoundedPlanetSite` precedent: "a ground-owned thing acquires a
 *    new parent identity, its construction record travels"), translated into
 *    the town's frame and re-keyed `slot: -1` — they stand where they stand,
 *    on GROUND, not on a lot the tree will lay. `siteObstacles` then reads
 *    them back as the rects streets bend around.
 *  - **LANES — spine seeds.** Each site's recorded access lane (§3.2)
 *    translates into the town frame and joins the seed set; a site that
 *    recorded none (a lone founder) gets its connector synthesized to the
 *    nearest ALREADY-PLACED site's ground, so the spine is connected by
 *    construction and `growStreets` can lay a baseline along it.
 *
 * ORDINALS. The eldest's rows keep their ordinals (its `f_<ord>` work keys
 * and `sitepile:<ord>` endpoints are immortal and its session may still be
 * live); absorbed rows are renumbered past its high-water mark, and their
 * per-building deltas are re-keyed with them. An absorbed site's session is
 * over by definition — it is being annexed — so no live agreement names the
 * old numbers.
 */
export function mergeSites(cluster: readonly FoundedSite[]): FoundedSite {
  if (cluster.length === 0) throw new Error("mergeSites: no sites to merge");
  const ordered = [...cluster].sort(foundingOrder);
  const head = ordered[0]!;
  if (ordered.length === 1) return head;

  const json = head.deltas.toJSON();
  const orders = [...(json.orders ?? [])];
  const buildings = { ...json.buildings };
  const seeds = [...(json.seeds ?? [])];
  const stock: Record<string, number> = { ...(json.stock ?? {}) };
  for (const [g, n] of Object.entries(head.stock)) stock[g] = (stock[g] ?? 0) + n;
  let nextOrd = Math.max(json.ordSeq ?? 0, orders.reduce((m, o) => Math.max(m, o.ord + 1), 0));
  let nextSeedOrd = seeds.reduce((m, s) => Math.max(m, s.ord + 1), 0);
  /** Ground already joined to the spine, in the town frame — what a laneless
   *  homestead's connector aims at. */
  const placed: Array<{ x: number; y: number }> = [{ x: 0, y: 0 }];
  /** Every standing footprint in the town frame, head's included: lanes are
   *  trimmed against ALL of them (a lane may not run through the eldest's
   *  house either). */
  const standing: SiteRect[] = ordered.flatMap(s => s.deltas.founded().map(b => ({
    x: b.dx + (s.at.x - head.at.x), y: b.dy + (s.at.y - head.at.y), w: b.w, h: b.h,
  })));
  let buildingsCount = head.buildings;
  const residents = [...head.residents];

  for (let i = 1; i < ordered.length; i++) {
    const site = ordered[i]!;
    const ox = site.at.x - head.at.x;
    const oy = site.at.y - head.at.y;
    const sj = site.deltas.toJSON();

    // Stock — the conservation half.
    for (const [g, n] of Object.entries(sj.stock ?? {})) stock[g] = (stock[g] ?? 0) + n;
    for (const [g, n] of Object.entries(site.stock)) stock[g] = (stock[g] ?? 0) + n;

    // Standing buildings — annexed, translated, re-keyed onto the ground.
    const remap = new Map<number, number>();
    for (const o of sj.orders ?? []) {
      if (o.kind !== "found") continue;
      const ord = nextOrd++;
      remap.set(o.ord, ord);
      orders.push({
        ...JSON.parse(JSON.stringify(o)) as typeof o,
        ord,
        slot: -1, // stands on GROUND: no frontage lot was ever laid for it
        dx: o.dx + ox,
        dy: o.dy + oy,
      });
    }
    for (const [k, d] of Object.entries(sj.buildings)) {
      const m = /^f_(\d+)$/.exec(k);
      const to = m ? remap.get(Number(m[1])) : undefined;
      const key = to === undefined ? `${site.key}:${k}` : `f_${to}`;
      buildings[key] = JSON.parse(JSON.stringify(d)) as typeof d;
    }

    // Lanes — the spine. Recorded first (they are history), else synthesized
    // to the nearest ground already on the spine.
    const lanes = siteLanes(site).map(l => l.map(p => ({ x: p.x + ox, y: p.y + oy })));
    if (!lanes.length) {
      let best = placed[0]!;
      let bestD2 = Infinity;
      for (const p of placed) {
        const d2 = (p.x - ox) ** 2 + (p.y - oy) ** 2;
        if (d2 < bestD2) { bestD2 = d2; best = p; }
      }
      if (bestD2 >= MIN_LANE_M * MIN_LANE_M) lanes.push([{ x: ox, y: oy }, { x: best.x, y: best.y }]);
    }
    for (const lane of lanes) {
      // The chord aims at a homestead; the SEED is the open ground on the way.
      const clear = trimLane(lane, standing, LANE_CLEAR_M);
      if (!clear) continue;
      seeds.push({ ord: nextSeedOrd++, kind: "spine", lanes: [clear] });
      for (const p of lane) placed.push({ x: p.x, y: p.y });
    }

    buildingsCount += site.buildings;
    for (const r of site.residents) if (!residents.includes(r)) residents.push(r);
  }

  return {
    key: head.key,
    seed: head.seed,
    at: { x: head.at.x, y: head.at.y },
    foundedDay: head.foundedDay,
    stock: {},                       // folded into the overlay's yard above
    deltas: createTownDeltas({ ...json, orders, buildings, seeds, stock, ordSeq: nextOrd }),
    buildings: buildingsCount,
    residents,
  };
}

/** The town-play seam: the config that builds THIS site's town — town-play's
 *  documented founding path (key/charter/startPop are "the SITE's town"), the
 *  construction overlay riding along as serialized deltas. Deterministic:
 *  same site ⇒ same config ⇒ byte-identical town. */
export function siteTownConfig(
  site: FoundedSite,
  opts?: {
    startPop?: number;
    charter?: { farmland: number; ore_access: number; timberland?: number };
    /** THE WORLD'S DECLARED SPACE-TIME SCALE (`game.scale`, resolved). A
     *  founded site stands on the SAME planet its neighbours' roads were
     *  ported at, so its town must lay out to the same `townExtentM` — a
     *  config with no scale grows the real-scale 450 m town on a world whose
     *  roads stop at 195 m, and the interstates cross the new buildings the
     *  moment they exist. Absent = realism. */
    scale?: WorldScale;
  },
): TownPlayConfig {
  // The site's gathered materials become the town's builder's-yard stock
  // (①b) — the same stack map "build" costs draw from, riding the deltas.
  const deltas = site.deltas.toJSON();
  const stock = { ...(deltas.stock ?? {}) };
  for (const [glyph, n] of Object.entries(site.stock)) {
    stock[glyph] = (stock[glyph] ?? 0) + n;
  }
  deltas.stock = stock;
  return {
    seed: site.seed,
    key: site.key,
    days: 1, // a founding is day one — no fast-forwarded history
    questCount: 0,
    startPop: opts?.startPop ?? 0,
    charter: opts?.charter ?? { farmland: 60, ore_access: 0 },
    // The site WAS open country — its town keeps the gatherable
    // surroundings (explicit, not the founding-age default).
    wilderness: true,
    deltas,
    ...(opts?.scale ? { scale: opts.scale } : {}),
  };
}
