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
import { buildingMaterialGlyphs } from "../../products.js";

/** The BUILDING-MATERIAL stack glyphs a site's stock accepts — DERIVED from
 *  the natural-sources registry (products.ts): every `use: "building"`
 *  product glyph (wood from the trees, stone from the rocks). Everything
 *  else (food, toys) stays personal — a site stockpile is a builder's yard,
 *  not a pantry. */
export const SITE_MATERIAL_GLYPHS: readonly string[] = buildingMaterialGlyphs();

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
}

/** Found a new, EMPTY site. Deterministic in its options. */
export function foundSite(opts: FoundSiteOpts): FoundedSite {
  return {
    key: opts.key ?? `site-${(opts.seed >>> 0).toString(36)}`,
    seed: opts.seed,
    at: { x: opts.at.x, y: opts.at.y },
    foundedDay: Math.max(0, Math.floor(opts.day ?? 0)),
    stock: {},
    deltas: createTownDeltas(),
    buildings: 0,
    residents: [],
  };
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

/** The town-play seam: the config that builds THIS site's town — town-play's
 *  documented founding path (key/charter/startPop are "the SITE's town"), the
 *  construction overlay riding along as serialized deltas. Deterministic:
 *  same site ⇒ same config ⇒ byte-identical town. */
export function siteTownConfig(
  site: FoundedSite,
  opts?: { startPop?: number; charter?: { farmland: number; ore_access: number; timberland?: number } },
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
  };
}
