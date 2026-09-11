// shared/world-engine/planet/ecology.ts
//
// BIOMES FROM SPECIES, NOT PAINT. A species is a NICHE (where it can live,
// read off the climate/terrain fields) plus INTERACTIONS with other species
// (competition, dependence). Evaluated per cell, this yields a per-species
// ABUNDANCE field; the dominant species is the cell's biome. Continuous
// climate in → discrete biomes out, with the separations (forest vs steppe)
// EMERGING from the rules instead of being hardcoded.
//
// The headline check the design targets: temperate FOREST (trees) and
// STEPPE (grass + horses) occupy DIFFERENT places even though both like
// "not-desert, not-frozen" land — because forest SHADES OUT grass, so
// grazers are pushed into the moisture gap between closed forest and true
// desert (the real Eurasian steppe belt). One competition rule does it.
//
// Pure and deterministic, like climate.ts / founding: worldgen composition,
// never the rule engine. Reads grid.fields (rain, tempC, height, fertility);
// writes grid.fields.biome (+ optional per-species fields).

import type { CellGrid } from "../kernel/cells/index.js";
import type { GridTopology } from "../kernel/cells/topology.js";
import { band, type ClimateSample, type SpeciesNiche } from "../products.js";

// ⚖️ THE NICHE VOCABULARY LIVES IN products.ts (2026-09-01). `Tolerance` and
// `band()` were defined here; the natural-sources catalogue needed them so
// its own rows could say where a plant grows, and that module is a PURE LEAF
// that may not import. They moved DOWN and are re-exported here verbatim —
// this module's public surface is unchanged (planet-game.ts, the games'
// ecology suites), and one band() serves both registries, which is what lets
// a catalogue niche be calibrated against TREE/GRASS below and mean it.
export { band } from "../products.js";
export type { Tolerance, SpeciesNiche, ClimateSample } from "../products.js";

export type SpeciesKind = "plant" | "animal";

export interface SpeciesInteraction {
  /** The other species' key. */
  with: string;
  /** suppress — the other's abundance SCALES THIS DOWN (canopy shading a
   *  meadow); require — this needs the other present (a grazer needs grass);
   *  boost — the other lifts this (a nurse plant). */
  effect: "suppress" | "require" | "boost";
  /** Strength 0..1+ (suppress/boost as a coefficient; require as the
   *  abundance of `with` that counts as "enough"). */
  weight: number;
}

export type EcoRGB = readonly [number, number, number];

export interface SpeciesDef {
  key: string;
  kind: SpeciesKind;
  /** Niche tolerances over the fields (any subset). rain ~0..1.3,
   *  tempC in °C, elevation in height units above sea, fertility 0..15.
   *  ONE OWNER OF THE SHAPE (products.ts `SpeciesNiche`) — the natural-
   *  sources catalogue declares its niches in the same type, so "where a
   *  species lives" is one fact with one definition, not two. */
  niche: SpeciesNiche;
  interactions?: SpeciesInteraction[];
  /** The GROUND COLOUR a cell this species dominates reads as from orbit
   *  (linear RGB) — the biome tint IS the dominant plant. An animal uses
   *  the sward it grazes (steppe green), so its range still reads as
   *  grassland. */
  color?: EcoRGB;
  /** The CREATURE-LIST model this organism IS — a stable id in the shared
   *  species registry (creatures/species.ts: "oak", "grass", "ungulate",
   *  …). Plants and animals alike resolve to a real body plan, so a
   *  ground-scatter / herd renderer places the actual model in this
   *  species' biome cells (not a stand-in). The ecology field is the
   *  distribution; this is what grows there. */
  model?: string;
  /**
   * ⚖️ HOW THICKLY IT STANDS — individuals per HECTARE at FULL suitability
   * (abundance 1). The species row is the one owner of "how much of X lives
   * here", so it owns the extensive half of that answer too: a scatter reads
   * `standDensityPerHa` and multiplies by its OWN ground area, and extent
   * stops being the same number as abundance.
   *
   * 🚫 NOT A BALANCE DIAL. Each value is calibrated so the SHIPPED render
   * density is reproduced at the abundance the shipped biosphere actually
   * reaches — see the constants on TREE/GRASS below for the measurement.
   */
  standPerHa?: number;
}

export interface EcologyOpts {
  species: SpeciesDef[];
  /** Substrate sea line (default 3) — sea cells hold no land species. */
  seaHeight?: number;
  /** Interaction relaxation passes (default 2 — a tree→grass→horse chain
   *  settles in one, the extra guards longer chains). */
  passes?: number;
  /** Abundance a cell needs to be claimed as that species' biome
   *  (default 0.15); below every species ⇒ biome "barren". */
  biomeFloor?: number;
  /** Ice field (climate.ts): a frozen cell holds no land ecology. */
  iceField?: string;
}

export interface EcologyResult {
  /** Per-species abundance, 0..1, keyed by species. */
  abundance: Record<string, Float64Array>;
  /** Dominant species index per cell into `keys`, or -1 (barren/ice/sea). */
  biome: Int32Array;
  /** Species keys in `biome`'s index order. */
  keys: string[];
}

/** Raw niche suitability (pre-interaction) for one species at a cell. */
function suitability(
  s: SpeciesDef, rain: number, tempC: number, elev: number, fert: number,
): number {
  return (
    band(rain, s.niche.rain) *
    band(tempC, s.niche.tempC) *
    band(elev, s.niche.elevation) *
    band(fert, s.niche.fertility)
  );
}

/**
 * Compute per-species abundance + the biome field over a settled, climated
 * substrate. Deterministic: fixed species order, fixed pass count.
 */
export function ecologyFields(grid: CellGrid, opts: EcologyOpts): EcologyResult {
  const topo: GridTopology = grid.topo;
  const n = topo.n;
  const seaHeight = opts.seaHeight ?? 3;
  const passes = Math.max(1, Math.floor(opts.passes ?? 2));
  const floor = opts.biomeFloor ?? 0.15;

  const height = grid.fields.height;
  const rain = grid.fields.rain;
  const tempC = grid.fields.tempC;
  const fert = grid.fields.fertility;
  const ice = opts.iceField ? grid.fields[opts.iceField] : grid.fields.ice;
  if (!height || !rain || !tempC) {
    throw new Error("ecologyFields: needs a climated substrate (height/rain/tempC — run applyClimate first)");
  }

  const keys = opts.species.map(s => s.key);
  const idx = new Map(keys.map((k, i) => [k, i] as const));
  const abundance: Record<string, Float64Array> = {};
  for (const k of keys) abundance[k] = new Float64Array(n);

  // Land mask + raw niche suitability.
  const land = new Uint8Array(n);
  for (let c = 0; c < n; c++) {
    if (height[c] < seaHeight || (ice && ice[c] >= 1)) continue;
    land[c] = 1;
    const elev = Math.max(0, height[c] - seaHeight);
    const f = fert ? fert[c] : 0;
    for (let si = 0; si < opts.species.length; si++) {
      abundance[keys[si]][c] = suitability(opts.species[si], rain[c], tempC[c], elev, f);
    }
  }

  // Interaction relaxation — fixed order, each species reads the CURRENT
  // abundances (so an early species' effect propagates within the pass).
  for (let p = 0; p < passes; p++) {
    for (const s of opts.species) {
      const inter = s.interactions;
      if (!inter?.length) continue;
      const self = abundance[s.key];
      for (let c = 0; c < n; c++) {
        if (!land[c]) continue;
        let a = suitability(s, rain[c], tempC[c], Math.max(0, height[c] - seaHeight), fert ? fert[c] : 0);
        for (const it of inter) {
          const other = idx.has(it.with) ? abundance[it.with][c] : 0;
          if (it.effect === "suppress") a *= Math.max(0, 1 - it.weight * other);
          else if (it.effect === "boost") a *= 1 + it.weight * other;
          else if (it.effect === "require") a *= Math.max(0, Math.min(1, other / (it.weight || 1e-9)));
        }
        self[c] = Math.max(0, Math.min(1, a));
      }
    }
  }

  // Biome = dominant species above the floor (ties broken by species order).
  const biome = new Int32Array(n).fill(-1);
  for (let c = 0; c < n; c++) {
    if (!land[c]) continue;
    let best = -1;
    let bestA = floor;
    for (let si = 0; si < keys.length; si++) {
      const a = abundance[keys[si]][c];
      if (a > bestA) { bestA = a; best = si; }
    }
    biome[c] = best;
  }

  return { abundance, biome, keys };
}

/** Fold ecology into a substrate: writes `grid.fields.biome` (species index
 *  + 1, so 0 = barren/sea/ice — a clean unsigned field) and, if `perSpecies`,
 *  `grid.fields.eco_<key>` (abundance ×100, 0..100). Renderers/economy read
 *  these downstream (biome tint, timberland from forest, pasture from
 *  steppe). Returns the result for callers that want the raw arrays. */
export function applyEcology(
  grid: CellGrid, opts: EcologyOpts & { perSpecies?: boolean },
): EcologyResult {
  const res = ecologyFields(grid, opts);
  const n = grid.topo.n;
  const biomeField = new Float64Array(n);
  for (let c = 0; c < n; c++) biomeField[c] = res.biome[c] + 1;
  grid.fields.biome = biomeField;
  if (opts.perSpecies) {
    for (const k of res.keys) {
      const a = res.abundance[k];
      const scaled = new Float64Array(n);
      for (let c = 0; c < n; c++) scaled[c] = Math.round(a[c] * 100);
      grid.fields[`eco_${k}`] = scaled;
    }
  }
  return res;
}

// ── READING THE BAKED ABUNDANCE BACK ───────────────────────────────────────
// `applyEcology({ perSpecies: true })` is the WRITER; everything below is the
// one reader. Consumers must not spell `eco_${key}` themselves — the prefix,
// the ×100 scaling and the "field absent ⇒ this substrate has no ecology"
// answer live here, so a caller cannot half-know the encoding.

/** The substrate field a species' abundance bakes into. */
export function ecoFieldName(key: string): string {
  return `eco_${key}`;
}

/** The minimum a grid must expose to be asked about its ecology. */
export interface EcoFieldSource {
  fields: Record<string, ArrayLike<number>>;
}

/**
 * Per-species abundance (0..1) at one cell, off the baked `eco_<key>` fields.
 *
 * NULL when this substrate carries no per-species ecology at all — an
 * un-baked grid, a region substrate (only the planet tier runs `applyEcology`),
 * or a bake serialized before `perSpecies` was switched on. Null is a REAL
 * answer and callers must keep their legacy arm for it: inventing an abundance
 * from the biome integer would be a second derivation of the very fact this
 * module exists to own, and it would silently disagree with this one.
 */
export function ecoAbundanceAt(
  grid: EcoFieldSource,
  cell: number,
  species: readonly SpeciesDef[] = DEFAULT_BIOSPHERE,
): Record<string, number> | null {
  const out: Record<string, number> = {};
  let any = false;
  for (const s of species) {
    const arr = grid.fields[ecoFieldName(s.key)];
    if (!arr) continue;
    any = true;
    out[s.key] = Math.max(0, Math.min(1, (arr[cell] ?? 0) / 100));
  }
  return any ? out : null;
}

/**
 * STANDING DENSITY, individuals per hectare, of the biosphere species whose
 * body plan is `model` ("oak", "grass" — the creature-registry id both the
 * flora field and the wilderness scatter name their content by).
 *
 * `abundance` is `ecoAbundanceAt`'s answer. Linear in it: a cell half as
 * suitable stands half the trees. A species with no `standPerHa`, or a model
 * no species claims, answers 0 — nothing of it stands anywhere, which is the
 * honest answer for a species nobody said how to scatter.
 */
export function standDensityPerHa(
  model: string,
  abundance: Readonly<Record<string, number>>,
  species: readonly SpeciesDef[] = DEFAULT_BIOSPHERE,
): number {
  const s = species.find((sp) => sp.model === model);
  if (!s || !s.standPerHa) return 0;
  return s.standPerHa * Math.max(0, Math.min(1, abundance[s.key] ?? 0));
}

/** Individuals of `model` standing on `areaHa` hectares of this cell's ground
 *  — the density above, resolved against a real extent and rounded to whole
 *  bodies. THE point of the density: extent may grow without thinning. */
export function standCountFor(
  model: string,
  abundance: Readonly<Record<string, number>>,
  areaHa: number,
  species: readonly SpeciesDef[] = DEFAULT_BIOSPHERE,
): number {
  return Math.max(0, Math.round(standDensityPerHa(model, abundance, species) * Math.max(0, areaHa)));
}

/**
 * ONE CELL as a niche query's input (products.ts `ClimateSample`, consumed by
 * `nicheSuitabilityOf` / `usefulPlants`). Reads the BIOSPHERE FIELDS exactly
 * as `ecologyFields` does — elevation is height above the sea line, fertility
 * falls back to 0 on a substrate that carries none — so "what can grow here"
 * and "what the biosphere actually put here" are answered off the same
 * numbers. The one honest way a caller turns a cell into a niche question:
 * anything else re-derives these units and starts the drift.
 *
 * ⛏️ AND THE SUBSTRATE AXES RIDE ALONG (2026-09-01): `ore` is exposed-ore
 * richness (`grid.fields.ore`, 0..15 — worldgen writes it, runtime only
 * depletes it), optional-with-0 exactly like fertility. The biosphere above
 * does NOT read it — no shipped species is lode-bound, and inventing an ore
 * term in `suitability` would move biomes — but a catalogue niche may
 * (products.ts `SpeciesNiche.ore`), and it must get its number from the SAME
 * builder every other axis comes from. Rain/tempC/height stay the REQUIRED
 * trio: un-climated ground is still an error, never a silent zero sample.
 */
export function climateSampleAt(grid: CellGrid, cell: number, seaHeight = 3): ClimateSample {
  const height = grid.fields.height;
  const rain = grid.fields.rain;
  const tempC = grid.fields.tempC;
  const fert = grid.fields.fertility;
  const ore = grid.fields.ore;
  if (!height || !rain || !tempC) {
    throw new Error("climateSampleAt: needs a climated substrate (height/rain/tempC — run applyClimate first)");
  }
  return {
    rain: rain[cell],
    tempC: tempC[cell],
    elevation: Math.max(0, height[cell] - seaHeight),
    fertility: fert ? fert[cell] : 0,
    ore: ore ? ore[cell] : 0,
  };
}

// ── Default biosphere: the trees-vs-horses check ───────────────────────────
// Temperate forest, temperate grassland, and horses (grazers) — authored so
// forest and steppe SEPARATE by competition, not by fiat.

export const TREE: SpeciesDef = {
  key: "tree",
  kind: "plant",
  // Closed forest wants real moisture and non-freezing temperate warmth;
  // tolerates modest elevation, indifferent to soil fertility (roots reach).
  niche: {
    rain: { lo: 0.45, opt: 1.0 },      // needs it wet; more is fine
    tempC: { lo: 0, opt: 18, hi: 34 },
    elevation: { opt: 0, hi: 30 },
  },
  color: [0.11, 0.29, 0.13], // deep forest green
  model: "oak",              // creatures/species.ts — the actual tree body
  // 🌲 43 oaks/ha AT FULL SUITABILITY. Calibrated, not chosen: the shipped
  // flora field stands 60 oaks on a 200 m tile (4 ha) in a tree-dominant
  // cell — 15.0 oaks/ha — and a tree-dominant cell's MEASURED median
  // `eco_tree` is 0.35 (seeds 1 / 7 / 42, faceN 24: medians 0.36 / 0.35 /
  // 0.35). 15.0 / 0.35 = 43, and 43 × 0.35 × 4 ha = 60.2 ⇒ 60, the shipped
  // count reproduced exactly at the median forest cell. Everything else
  // follows continuously instead of in four buckets.
  //
  // ⚠️ THE CEILING IS NOT 1. `band()` returns 1 only AT the optimum, and no
  // shipped forest cell is optimal on all three axes at once — the whole
  // planet's `eco_tree` maxes at ~0.44. So "at full suitability" is a
  // definition, not a place: read this row against the medians above.
  standPerHa: 43,
};

export const GRASS: SpeciesDef = {
  key: "grass",
  kind: "plant",
  // Grassland's niche is the MIDDLE of the moisture axis: too dry = desert,
  // too wet = forest takes it. The forest suppression carves the wet edge.
  niche: {
    rain: { lo: 0.2, opt: 0.5, hi: 1.1 },
    tempC: { lo: -2, opt: 16, hi: 38 },
    elevation: { opt: 0, hi: 45 },
  },
  interactions: [
    // Canopy shades the meadow: dense forest all but eliminates grass.
    { with: "tree", effect: "suppress", weight: 1.1 },
  ],
  color: [0.42, 0.55, 0.24], // steppe / meadow green
  model: "grass",            // the grass-tuft body plan
  // 🌾 30 tufts/ha at full suitability, calibrated the same way: the flora
  // field stands 44 tufts on a 4 ha tile in a grass-dominant cell (11.0/ha),
  // whose MEASURED median `eco_grass` is 0.37 (seeds 1 / 7 / 42: 0.34 /
  // 0.37 / 0.40). 11.0 / 0.37 ≈ 30, and 30 × 0.37 × 4 = 44.4 ⇒ 44.
  //
  // ⚖️ A FOREST FLOOR NOW READS NEARLY GRASSLESS, and that is the ecology
  // speaking, not a regression: the canopy-suppression rule above puts
  // `eco_grass` at a median of 0.00 in tree-dominant cells. The old bucket
  // table stood 16 tufts/tile there on no authority at all.
  standPerHa: 30,
};

export const HORSE: SpeciesDef = {
  key: "horse",
  kind: "animal",
  // Grazers want the open, warm-ish plain — but ONLY where grass actually
  // grows, which (post-suppression) is the steppe belt, not the forest.
  niche: {
    rain: { lo: 0.2, opt: 0.5, hi: 1.0 },
    tempC: { lo: -5, opt: 14, hi: 34 },
    elevation: { opt: 0, hi: 40 },
  },
  interactions: [
    { with: "grass", effect: "require", weight: 0.5 }, // needs a real sward
  ],
  color: [0.50, 0.56, 0.28], // its range reads as the grassland it grazes
  model: "ungulate",         // the hooved-grazer body plan (creatures/species.ts)
};

/** The biome-tint lookup for a species list: index 0 = barren fallback
 *  (null — the surface keeps its fertility tint), index k+1 = species k's
 *  colour. Matches applyEcology's `biome` encoding (species idx + 1). */
export function biomePalette(species: SpeciesDef[]): Array<EcoRGB | null> {
  return [null, ...species.map(s => s.color ?? null)];
}

/** The default biosphere (order matters: trees settle, then grass reads
 *  them, then horses read grass). */
export const DEFAULT_BIOSPHERE: SpeciesDef[] = [TREE, GRASS, HORSE];

// ── 🌿 THE UNDERSTORY (plant-growth-render-round.md PART 6, 2026-09-08) ─────
//
// THE COMPLAINT THIS ANSWERS, verbatim: *"it looks like they wander off-screen
// to get food — I can't see them because there are none in the immediate
// area."* And he was right: on the shipped forest cell the canopy stood at
// 15.05 oaks/ha and the whole larder at **3.32 food plants/ha**, so a founding
// party's 0.28 ha ownership disc held ONE bearing plant — a forest floor with
// no forest floor on it.
//
// 🚨 WHY THESE ROWS ARE NOT IN `DEFAULT_BIOSPHERE`, and it is not tidiness.
// That list is the BAKE: `applyEcology({ perSpecies: true })` writes one
// `eco_<key>` field per member and encodes the dominant member's INDEX as
// `fields.biome` (0 barren, 1 forest, 2 steppe, 3 grazer range — the very
// integers `wildMixForBiome` switches on). Appending to it would renumber
// every biome on every planet ever baked and hand `ecoAbundanceAt` five keys
// no serialized substrate carries — which `ecoAbundanceAt` answers by leaving
// them OUT of the record, so the new densities would silently read 0 on
// exactly the worlds this round exists to fix.
//
// ⚖️ SO AN UNDERSTORY ROW RIDES A CANOPY FIELD. Its `key` names the BAKED
// abundance it is read against — `tree` for the wood's own shrubs and
// understory trees, `grass` for the open country's bulbs and weeds — and its
// `model` names the plant that actually stands there. `standDensityPerHa`
// finds a row by MODEL and scales by `abundance[key]`, so two rows may share a
// key and a thicker wood carries a thicker hedge, off ONE number, with no
// second bake and no new field. That is the whole mechanism.
//
// 🚫 NOT A BALANCE DIAL — the same law TREE/GRASS carry. Each figure is a real
// stand density, and their PRODUCT with the catalogue's regrow cadence is
// pinned to the forage anchor (`scale.ts REAL_FORAGE_HA_PER_PERSON`, 30 ha a
// head ⇒ 1/30 rations/ha/day raw). At the shipped forest cell (`eco_tree`
// 0.35), summing `density ÷ regrowDays` over the four bearing rows:
//
//   bush  15.05/ha ÷ 120 = 0.12542      hazel  8.05/ha ÷ 240 = 0.03354
//   apple  1.05/ha ÷ 180 = 0.00583      carrot 0.277/ha ÷ 120 = 0.00231
//   ─────────────────────────────────────────────────────────────────
//   Σ = 0.1671 units/ha/day = 0.0334 rations/ha/day  (anchor 0.0333, 100.3 %)
//   × `resource_compression` 7.5 (the GL preset) ⇒ 0.251 rations/ha/day
//
// ⚖️ THE DENSITY AND THE CADENCE MOVED TOGETHER, and that is the law in action:
// PART 6b roughly doubled the standing rows (22→43, 12→23, 2→3) and doubled the
// cadences beside them (berry 60→120, nut 125→240) so the PRODUCT did not move.
// A round that had raised only the density would have doubled what the
// countryside feeds you, silently, under cover of "more plants".
//
// Move a density and the cadence beside it has to move back, or the
// countryside quietly stops matching the anchor.
const understory = (key: string, model: string, standPerHa: number): SpeciesDef => ({
  key,
  kind: "plant",
  // ⚠️ THE NICHE IS DELIBERATELY EMPTY, and it is not an omission. These rows
  // never reach `applyEcology` (see above), so nothing ever evaluates a niche
  // on them — WHICH plants a cell admits is `wildFoodPlants(climate)`'s
  // question and is answered off the species' OWN catalogue row, which is the
  // one place a niche is written. A copy here would be a second statement of
  // it, free to drift.
  niche: {},
  model,
  standPerHa,
});

/**
 * WHAT GROWS UNDER THE CANOPY AND BETWEEN THE TUFTS — the forage layer's
 * standing densities, individuals per hectare at abundance 1. Read against the
 * shipped medians (`eco_tree` 0.35 in a tree-dominant cell, `eco_grass` 0.37
 * in a grass-dominant one, ~0.00 under closed canopy) for the realized number.
 *
 * 🚨 THESE FOUR `standPerHa` FIGURES ARE NOW THE **LEGACY** DENSITY, NOT THE
 * AUTHORITY (resource-packing round). Where a caller stands on a real cell —
 * a climate sample AND a baked `eco` field — `planet/packing.ts packStands` is
 * the ONE authority on how many of each plant a hectare carries, derived from
 * the catalogue's crown/root geometry against the cell's light, water and
 * nutrient budgets. These numbers answer only for callers that have no cell
 * under them (a preset town, a flat test world, the charter arm, a region
 * substrate) — the same place an absolute scatter count was always the honest
 * form.
 *
 * ⚖️ WHY THE FIELD STAYS. Deleting it would make `standDensityPerHa` answer 0
 * for bush/hazel/apple/onion, which is a LIE on exactly the no-ecology callers
 * that still need an answer, and it would quietly drop the understorey out of
 * the "which lines does the density law claim" set the scatter derives from
 * these rows. The row still names model ↔ baked-field, which is the mechanism
 * the block note above describes and is unchanged.
 *
 * ⚖️ AND THE PAIRING NOTE ABOVE NO LONGER BINDS THE PACKED ARM. "Move a
 * density and the cadence beside it has to move back" was the law while these
 * numbers were hand-balanced against the anchor. On the packed arm the flow
 * FALLS OUT of the geometry: move a crown radius and the density moves,
 * nobody moves a cadence, and `forage-flow-anchor.test.ts` ② re-derives the
 * anchor from the pass rather than from these four figures.
 */
export const FORAGE_UNDERSTORY: SpeciesDef[] = [
  // 🫐 THE SHRUB LAYER — 43/ha, realized 15.1/ha in the median wood: the
  // canopy's OWN figure, and still conservative against reality. A temperate
  // mixed wood carries hundreds of shrub stems a hectare against ~150 canopy
  // trees, and this world already renders the canopy at a tenth of that (see
  // TREE); standing the hedge at parity keeps that one reduction instead of
  // inventing a second. A wood with fewer shrubs than trees is not a wood.
  understory("tree", "bush", 43),
  // 🌰 THE UNDERSTORY TREE — 23/ha, realized 8.1/ha. A hazel is scattered
  // through the wood rather than forming it: about half the shrub layer, which
  // is what "grows under the canopy" looks like when you count stems.
  understory("tree", "hazel", 23),
  // 🍏 THE CRAB APPLE — 3/ha, realized 1.05/ha. The row's own `rarity: 0.2`
  // said this in the count vocabulary ("occasional, and worth noticing when
  // you find one"); ~1/ha is that sentence as a density.
  understory("tree", "apple_tree", 3),
  // 🧅 THE GRASSLAND BULB — 40/ha, realized 14.8/ha on the steppe and ~0 under
  // closed canopy, because it rides `grass` and the canopy suppression puts
  // `eco_grass` at 0.00 there. An allium is a plant of the open sward, and the
  // ecology says so without a switch. ⚖️ OPEN COUNTRY IS POORER FORAGE THAN A
  // WOOD and stays so: even at 40/ha the steppe bears ~60 % of the woodland's
  // per-hectare flow, which is the ethnographic picture (grassland sits at the
  // 50-ha end of the 10–100 ha/head range, which is why steppe peoples herded)
  // and not a gap to be closed by inventing onions.
  understory("grass", "wild_onion", 40),
];

// ⚠️ THESE FIGURES ONCE SHIPPED AT HALF, AND THE HISTORY IS THE WARNING
// (PART 6 §4 / PART 6b). Authored at the woodland numbers above, they measured
// WORSE than a thin wood — 3.28 rations/day against 4.20, and 24 starvation
// body-days against 0 — and the temptation was to call that "too dense" and
// halve the ecology. It was halved, under protest and with the measurement
// written down, because the cause was known and was not ecology:
// `forageCandidates` ranked loaded features and tile records by DISTANCE
// ALONE, so five settlers converged on one record's single shelf point, bunched
// there, and their plans died mid-walk (22 blocked pursuits against 0 in every
// thin run) while 190 rations stood unreached.
//
// ✅ THAT SEAT IS FIXED (PART 5b's forage claims + K stand points, crowd-seconds
// 318 → 19; the emergent-plans round's 1b re-select on a lost precondition,
// blocked 22 → 0), and the honest density is back — measured, not restored on
// faith. The lesson worth keeping: a DENSITY that reads wrong in play is
// evidence about the CONSUMER of the density at least as often as about the
// number, and halving an anchor to fit a defect hides the defect twice.

/** The biosphere a SCATTER reads: the baked three, plus the understory that
 *  rides their fields. `DEFAULT_BIOSPHERE` first, so `oak`/`grass` still
 *  resolve to TREE/GRASS and every shipped density is byte-identical. */
export const SCATTER_BIOSPHERE: SpeciesDef[] = [...DEFAULT_BIOSPHERE, ...FORAGE_UNDERSTORY];
