// shared/world-engine/interaction/quest/wilderness.ts
//
// WILDERNESS CONTENT (city-expansion step 0): the deterministic scatter a
// quest-host session lays over open ground — resource FEATURES (natural
// sources: trees, rock outcrops) and free-roaming CREATURES the spirit can
// possess. Everything reuses existing machinery:
//   • a feature is an ordinary openable CONTAINER (the one container
//     abstraction) whose stack map holds material glyphs — gathering IS the
//     container take path, no new verb, no new animation;
//   • a creature is an ordinary quest-host creature (a needless "resident
//     with no house") whose body wanders — talking/possessing rides the
//     one conversation system.
// A feature names its SPECIES; what it holds comes from the natural-sources
// registry (products.ts bodyStockOf + harvestStockOf) — the same definition
// the abstract economy reads, never a name-keyed table here. Harvest stock
// REGROWS on the standing source (dueHarvestRegrowth, a pure calculator the
// host applies). A source ENDS one of three ways, by the method of the
// products it is made of (products.ts AcquisitionMethod): a `deplete` source
// is taken from until it is spent (the outcrop); a `kill` source is CUT, and
// only then are its products there to carry (the tree); a pure-harvest source
// is cut too, and simply goes. Whichever ending it reaches, a species with a
// `growth` clock RE-SEEDS as a sapling instead of vanishing (dueGrowthAdvance,
// the same pure-calculator/host-applies shape). Pure data — the quest host
// embodies it (seedWilderness); headless-tested in
// server/tests/symbol-game-wilderness.test.ts.

import {
  growthClassYield, harvestProductsOf, harvestStockOf, isBodyProduct, bodyStockOf, naturalSourceOf,
  nicheSuitabilityOf, usefulPlants,
  type ClimateSample, type GrowthSizeClass,
} from "../../products.js";
import { bioYearsGameDays, serviceRadiusM, type WorldScale } from "../../scale.js";
// ⚖️ THE NEAR STAND IS MEASURED IN THE TOWN'S OWN UNITS (2026-09-02) — the
// clearing a founding gets and one building's frontage, never two new
// literals beside them. `dimensions.ts` imports only `scale.ts`, so the edge
// is one-way and cycle-free.
import { TOWN_DIMS } from "../../kernel/town/dimensions.js";
// The BODY-ID GRAMMAR's own constants (`isNaturalSourceBodyId` below) — the
// same two prefixes `parseScopeId` reads a `wild:` scope's `flora`/`fauna`
// form off, so the hover lane and the item ledger can never disagree about
// what a `flora:` id names. scope.ts imports nothing from this layer.
import { FAUNA_BODY_PREFIX, FLORA_BODY_PREFIX } from "../../kernel/town/scope.js";
// ⚖️ THE ONE OWNER OF "how much of species X lives here" (2026-09-02). The
// scatter reads the biosphere's density law rather than keeping a second
// per-biome table beside it; `planet/ecology.ts` is worldgen composition and
// imports nothing from this layer, so the edge is one-way.
import { DEFAULT_BIOSPHERE, standDensityPerHa } from "../../planet/ecology.js";
import { listSpecies, speciesCanSpeak } from "../../creatures/species.js";
import { getVocabularyItem } from "@shared/glyph-registry.js";

export interface WildernessFeature {
  id: string;
  /** Natural-source species (products.ts) — "oak", "rock". Decides both the
   *  feature's presentation and its yield. */
  species: string;
  x: number;
  y: number;
  /** The feature's initial material stack (glyph → count) — the source's
   *  rolled kill products (the tree IS its wood) plus its rolled harvest
   *  bearing (the fruit it hangs ripe). */
  stock: Record<string, number>;
  /** LIVE-BEARING CAPACITY (glyph → units): how much of each harvest
   *  product the standing source carries at once — rolled at scatter, the
   *  ceiling regrowth refills back to. Absent for kill-only sources. */
  harvestCap?: Record<string, number>;
  /** REGROW LEDGER (glyph → absolute clock seconds when the NEXT unit
   *  matures). An entry exists only while the glyph sits below capacity —
   *  armed by a live take, advanced and retired by regrowth. Session
   *  state, like the live stock the host keeps. */
  regrowAt?: Record<string, number>;
  /** ⚖️ S&D S3 H2 — GROWTH-CLASS index into the species' `growth.classes`
   *  (products.ts). Absent = the SCATTER default: a freshly-laid feature
   *  stands MATURE (the catalogue's own last class) — byte-identical to
   *  every feature built before this field existed, since nothing reads it
   *  as anything but "mature" when unset (`wildFeatureSizeRank`,
   *  `dueGrowthAdvance`). Only a RE-SEED after felling ever sets it. */
  sizeClass?: number;
  /** GROWTH CLOCK (absolute taskClock seconds when this feature next climbs
   *  a size class). Present only while re-growing toward maturity — mirrors
   *  `regrowAt`'s "an entry exists only while below the ceiling" law. A
   *  mature (or growth-less) feature never carries this. */
  growAt?: number;
  /**
   * ⚖️ THIS SOURCE HAS BEEN CUT — it is DOWN, not standing (user ruling
   * 2026-09-02: *"A destroyed tree should create a pile of wood which can be
   * carried"*). Absent (the only state anything before the cut act could be
   * in) = standing, so every saved world and every scatter reads as it always
   * did.
   *
   * 🚨 CALLED `downed`, NEVER `pile`, AND THE NAME IS LOAD-BEARING. "Pile" is
   * spoken for three times over in construction (`SITE_PILE_EP`,
   * `ORDER_PILE_EP`, `ANNEX_PILE_EP` — a build order's staged materials), and
   * `completeFounding` DELETES that pile: *"consumed — the materials are the
   * building"*. A felled tree's timber is the exact opposite kind of thing —
   * it is stock that must survive until somebody carries it away — so it must
   * not be able to borrow that word, or that behaviour, by accident.
   *
   * WHAT IT CHANGES, and nothing else: the source keeps its id, its container,
   * its stock and its position. It stops standing as a body (it stands as a
   * heap object under the same container key), its kill stock becomes
   * REACHABLE (`glyphTakeableFrom`) and cheaper to take
   * (`takeUnitsOf`'s downed arm), and the size it draws at follows what is
   * left of it instead of what class it grew to. Drained to nothing it retires
   * exactly as a quarried-out outcrop does — re-seeding where the species has
   * a growth ladder, which is where the sapling comes back from.
   */
  downed?: boolean;
}

export interface WildernessCreature {
  /** Creature id (`wild_<n>`, product animals `wild_<species>_<n>`) — the
   *  body is `npc_wild_<n>`, or wildAnimalBodyId() for a product animal. */
  id: string;
  /** Emoji face — DISPLAY ONLY, and DERIVED (never the other way round: see
   *  `bodySpecies`). Empty when the species names no glyph, and empty for
   *  product animals (their body comes from `species`). */
  icon: string;
  /** THE LOCAL'S BODY (creature-registry species id) — its IDENTITY. A
   *  wilderness local is FAUNA: `wildLocalCast()` picks a bodied,
   *  non-speaking creature and the `icon` above is derived from it.
   *
   *  ⚖️ THE EMOJI IS NOT AN IDENTITY KEY (2026-09-02). It used to be: the
   *  scatter picked one of four hand-written faces and the host mapped the
   *  FACE to an animal-person body. That coupling broke twice over — the
   *  animal people became a creature MOD (so the map's species stopped
   *  existing in most worlds and every local rendered `human`), and a
   *  talking bear-person was never wildlife in the first place. Sapient
   *  bodies belong to the puzzle/person cast; the countryside gets
   *  animals. */
  bodySpecies?: string;
  x: number;
  y: number;
  /** PRODUCT ANIMAL (step ④ hunting/husbandry): a natural-source species
   *  (registry kind "animal") whose products this WALKING BODY yields
   *  through the one container path — milk/wool are live takes that
   *  regrow on the animal; emptying its kill stock (meat) IS the kill,
   *  and the body goes with it. Absent = a plain possessable local. */
  species?: string;
  /** Rolled initial stock / bearing capacity / regrow ledger — the same
   *  yield state a feature carries (product animals only). */
  stock?: Record<string, number>;
  harvestCap?: Record<string, number>;
  regrowAt?: Record<string, number>;
}

/** A product animal's BODY id: the `fauna:<species>:<id>` convention the
 *  model factories already route to registry-height species bodies. */
export function wildAnimalBodyId(c: WildernessCreature): string {
  return `fauna:${c.species}:${c.id}`;
}

/** An EMBODIED feature's BODY id — a plant standing as a real grown body
 *  (`flora:<species>:<id>`, the town-orchard convention) instead of the
 *  placeholder container box. A feature is embodied exactly when its
 *  source declares `bodyHeightM` (products.ts: "standing-body height when
 *  embodied") — a data flip, never a species-name rule. */
export function wildFloraBodyId(f: WildernessFeature): string {
  return `flora:${f.species}:${f.id}`;
}

/**
 * ⚖️ IS THIS BODY A NATURAL SOURCE'S OWN BODY — the question the HOVER LANE
 * asks (quest-host `hoverTargetOf`), and the reason a standing oak was
 * unselectable in the live game for as long as trees have stood as bodies.
 *
 * A rooted plant and a walking product animal are AVATARS: `spawnWildFeature`
 * stands the tree with `addNpc`, `seedWilderness` stands the sheep the same
 * way. So the GL screen pick answers `kind:"avatar"` for both, the hover
 * resolver classified every non-player avatar as a CREATURE, and the creature
 * lane has nothing to give either of them — no menu cell (dwell-interaction's
 * creature row is `talk`), and no mind for the talk to reach. The gaze died on
 * the tree while a rock (an ObjectSpec, never a body) opened its board fine.
 *
 * They are not creatures in any sense the interaction layer means. They are
 * THINGS YOU TAKE FROM, and `seedWilderness` says so in as many words at the
 * product-animal spawn: *"No mind: livestock is takeable, not talkable
 * (dialogue would race the container board on the same dwell)."* So BOTH
 * spellings are here, not just `flora:` — a sheep's board (its wool, its milk,
 * the `tame:` claim) reaches the screen through exactly the path a tree's
 * does, and leaving `fauna:` in the creature lane would have fixed one half of
 * one bug and left its twin standing.
 *
 * 🚨 SYNTAX ONLY — the caller must ALSO ask whether the id is a registered
 * container. Town scenery uses these same prefixes for bodies with no
 * container row at all (`seedTownFauna`'s herds and orchard rows: "at town
 * rung the ABSTRACT account is the physics"), and those have nothing to open.
 * The pair of questions is the honest predicate; this half is the vocabulary.
 */
export function isNaturalSourceBodyId(id: string): boolean {
  return id.startsWith(FLORA_BODY_PREFIX) || id.startsWith(FAUNA_BODY_PREFIX);
}

export function wildFeatureEmbodied(f: WildernessFeature): boolean {
  const src = naturalSourceOf(f.species);
  return src?.kind === "plant" && src.bodyHeightM !== undefined;
}

/** IS IT STANDING AS A LIVING BODY RIGHT NOW — the question the SPAWNER and
 *  the re-size ask, as against `wildFeatureEmbodied`'s data question ("could
 *  it ever"). A CUT plant is down: it stands as a heap object under the very
 *  same container key, so the two questions had to come apart the day the cut
 *  landed. Keyed on nothing but `downed`, so a saved world with no such field
 *  answers exactly as it always did. */
export function wildFeatureStandsAsBody(f: WildernessFeature): boolean {
  return wildFeatureEmbodied(f) && !f.downed;
}

/** The container-map key a feature's stock lives under: its body id when it is
 *  the kind of thing that embodies, its own id as a placeholder box.
 *
 *  🚨 READS `wildFeatureEmbodied`, NEVER `wildFeatureStandsAsBody` — THE KEY
 *  MAY NOT MOVE. A cut tree keeps its container, its stock, and every
 *  reservation and in-flight haul already pointing at it; if the key changed
 *  when it came down, the wood a hauler was walking toward would cease to
 *  exist at the exact moment it was felled. WHAT it stands as is a rendering
 *  fact; WHERE its stock lives is a ledger fact, and they are not the same
 *  fact. */
export function wildFeatureContainerId(f: WildernessFeature): string {
  return wildFeatureEmbodied(f) ? wildFloraBodyId(f) : f.id;
}

/** How small a fully-quarried feature gets, as a fraction of its declared
 *  radius. NOT zero: the last unit has to stay visible and dwellable — the
 *  source's removal is the felling rule's job (sourceSpent), never a
 *  shrink to nothing. */
const SPENT_FEATURE_SCALE = 0.4;

/**
 * THE DRAWN SIZE of a feature, metres: the source's declared
 * `feature.radiusM`, scaled by how much of it is there.
 *
 * ⚖️ SIZE FOLLOWS WHAT IS ACTUALLY BEING TAKEN AWAY — and that is a different
 * quantity for each of the three product methods (user ruling 2026-09-02:
 * *"the whole 'harvest it and it shrinks' path is incorrect for this — might
 * still be relevant for other product types, like stone sources"*):
 *
 *   • `deplete` (the outcrop, a moss patch) — the take IS the shrinking, so
 *     the size is the LIVE STOCK's fraction of the species' maximum roll. This
 *     is the original behaviour, now confined to the method it was written
 *     for. DEPLETION HAS TO BE VISIBLE: a rock with one stone left and a rock
 *     with four are the same object to the container path, so if they are also
 *     the same size the player cannot read which is nearly spent. Measured
 *     against the SPECIES' maximum rather than this feature's own roll, so
 *     "one stone left" looks the same whether it rolled that small or was cut
 *     down to it.
 *   • a STANDING body (`kill` products, un-cut) — nothing is coming off it at
 *     all, so its size is its GROWTH CLASS and nothing else. A tree that
 *     shrank while its wood was hauled was the visible half of the bug this
 *     round retires; a sapling that draws small is the growth clock working.
 *   • a DOWNED body — now the timber IS coming off it, so the heap shrinks on
 *     the same curve the outcrop uses, off the same live stock. The player
 *     watches the pile go down as it is carried away.
 *
 * Pure-harvest sources never shrink under any of the three: a bush picked
 * clean is still a whole bush.
 *
 * PURE — no rng, no clock (same inputs ⇒ same radius), which is exactly what
 * lets the spawner and the take path both call it and agree on one answer.
 */
export function wildFeatureRadius(
  species: string,
  stock: Record<string, number> | undefined,
  opts?: { sizeClass?: number; downed?: boolean },
): number {
  const src = naturalSourceOf(species);
  const base = src?.feature?.radiusM ?? 0.6;
  const shrinking = (src?.products ?? []).filter(
    (p) => p.method === "deplete" || (p.method === "kill" && opts?.downed),
  );
  const scale = (frac: number): number =>
    base * (SPENT_FEATURE_SCALE + (1 - SPENT_FEATURE_SCALE) * Math.max(0, Math.min(1, frac)));
  if (shrinking.length) {
    const max = shrinking.reduce((n, p) => n + p.yield.max, 0);
    if (max <= 0) return base;
    return scale(shrinking.reduce((n, p) => n + (stock?.[p.glyph] ?? 0), 0) / max);
  }
  // STANDING: the growth ladder's own multiplier, which is the ONE number that
  // says how much tree there is. A species with no ladder stands full-size,
  // which is what "no growth clock" already means everywhere else.
  const g = src?.growth;
  if (!g) return base;
  const cls = g.classes[opts?.sizeClass ?? g.classes.length - 1];
  return cls ? scale(cls.yieldMul) : base;
}

/**
 * ⚖️ THE RADIUS OF *THIS* FEATURE — `wildFeatureRadius` with the feature's OWN
 * class and downed mark supplied, and the form every caller holding a
 * `WildernessFeature` must use.
 *
 * 🚨 ONE DERIVATION, N READERS, BECAUSE THE OPTS ARE NOT OPTIONAL IN PRACTICE.
 * Omitting them does not mean "don't care" — it means MATURE AND STANDING, so
 * three occupancy sites that dropped them measured a class-0 sapling against a
 * grown oak's disc: the founding mount refused to lay saplings that fit, the
 * near-stand step skipped them, and the growth clock suppressed a sapling's own
 * climb using the size it has not reached yet. Building the opts by hand at
 * each site is what let them drift apart, so it is done once here instead.
 *
 * `stock` overrides the row's own roll where the caller has the LIVE ledger
 * (the host's container record), so a half-quarried outcrop occupies what it
 * actually occupies.
 */
export function wildFeatureRadiusOf(
  f: Pick<WildernessFeature, "species" | "stock" | "sizeClass" | "downed">,
  stock?: Record<string, number>,
): number {
  return wildFeatureRadius(f.species, stock ?? f.stock, {
    sizeClass: f.sizeClass,
    downed: f.downed,
  });
}

export interface WildernessContent {
  /** The square manifold side, metres. */
  side: number;
  /** The scatter seed this content came from — kept WITH the content because
   *  an offloaded area re-lays its own stand from it (S&D S4,
   *  `wild-area.ts`), and "same seed ⇒ identical content" is only a usable
   *  law if the content can still say which seed that was. */
  seed: number;
  /** Where the spirit's parked walker starts (the centre clearing). */
  spawn: { x: number; y: number };
  features: WildernessFeature[];
  creatures: WildernessCreature[];
}

/** One line of a scatter mix: this many features of this natural source. */
export interface WildMixEntry {
  species: string;
  /** ABSOLUTE feature count — the extent-blind form, and the only one a
   *  no-ecology caller produces. When `perHa` is present this stays as the
   *  density's reading at `LEGACY_SCATTER_SIDE_M` (so a caller that only
   *  looks at `count` still sees a sane number) and `buildWilderness`
   *  ignores it. */
  count: number;
  /**
   * ⚖️ STANDING DENSITY, features per HECTARE — the extent-free form
   * (2026-09-02).
   *
   * An absolute count makes EXTENT AND ABUNDANCE THE SAME NUMBER: the same
   * mix laid on a founding town's 190 m rect and on a 320 m planet chunk
   * described two countrysides 2.8× apart in density, and neither could
   * agree with the flora field's streamed forest outside the town hole
   * (measured: 15.00 oaks/ha rendered against 2.77 oaks/ha scattered, a
   * 5.4× seam). A density is resolved against the scatter's OWN area by
   * `buildWilderness` — the one place that knows the extent — so extent may
   * grow without thinning the land.
   */
  perHa?: number;
}

/**
 * The ground area the ABSOLUTE counts in this file were authored against: a
 * FOUNDING-AGE town's rect (`town-stage.ts` — `plan.radius * 2 + 80`, 190 m
 * at age 0), 3.61 ha. Every density derived from a legacy count is pinned to
 * it, so a founding-age scatter resolves back to the count it always had and
 * only the ecology-driven lines move.
 *
 * 🚫 NOT AN EXTENT KNOB — nothing lays a scatter at this side. It is a
 * CALIBRATION reference and the reason this round changes no balance.
 */
export const LEGACY_SCATTER_SIDE_M = 190;
const LEGACY_SCATTER_HA = (LEGACY_SCATTER_SIDE_M * LEGACY_SCATTER_SIDE_M) / 10_000;

/** A legacy absolute count re-read as the density it always implied. */
function legacyPerHa(count: number): number {
  return count / LEGACY_SCATTER_HA;
}

// ── ⚖️ RELEVANCE AND VISIBILITY ARE TWO DIFFERENT RADII (user, 2026-09-02) ──
//
//   "generally speaking, only the near stand should be relevant. The only
//    exception is for rendering purposes at levels of detail where more
//    distant objects SHOULD be visible; we shouldn't stop *rendering* trees
//    that should be on-camera just because they're not technically part of the
//    site or its sources, but they shouldn't be selectable."
//
// RELEVANCE is what a site HAS — the sources a build may draw on, the things a
// player may select. It is a SIM fact: deterministic in the seed, blind to the
// camera, and it is what `WildernessParams.keep` bounds. VISIBILITY is what is
// drawn, and it is the renderer's business — a streamed flora field, a scenery
// instance, an LOD tier. The two never share a number and never share an owner.

/**
 * THE NEAR STAND'S RADIUS, metres — the ONE owner of "how far out is this
 * site's own ground". The scatter reads it (`keep`), the driver's border ring
 * reads it, and the render layer reads it to stop drawing a second forest on
 * top of the one that materialized.
 *
 * 🚧 A NAMED STOPGAP, and named for the same reason `planet/cities.ts`
 * `charterReachCells` is: the honest source for a settlement's reach is the
 * walk-budget family, and at TOWN scale it does not discriminate. MEASURED on
 * the shipped frontier homestead (street clock — `rotation 360`, real legs,
 * real appetite) against its own 190 m rect, whose half-side is 95 m:
 *
 * ```
 * serviceRadiusM(hunger)  =    96 m   ← 1.01× the rect. The district IS the town.
 * serviceRadiusM(thirst)  =   120 m
 * forageRadiusM           =   182 m
 * carryReachM(wood)       = 1 824 m
 * ```
 *
 * Every budget answers AT OR BEYOND the extent, so none of them can say which
 * trees are the site's — asking them returns "all of them", which is exactly
 * the status quo this radius exists to end. (The prior round ruled the same
 * family out at PLANET scale for the opposite failure: `forageRadiusM` against
 * a ~417 km tier-0 cell pitch rounds to zero cells. The family is right and
 * lands at neither of the two scales that consume it; joining them is a design
 * decision, not a wiring change — reported, not smuggled in.)
 *
 * So the ladder below, in the town's OWN units and in `charterReachCells`'
 * exact shape — ONE MORE BUILDING'S FRONTAGE OF STAND PER DOUBLING of what
 * stands, never less than the clearing a founding gets:
 *
 *   built  0 │ 1–2 │ 3–6 │ 7–14 │ 15–30 │ 31+
 *   r (m) 30 │  45 │  60 │   75 │    90 │  96 (capped)
 *
 * DISCRETE BY CONSTRUCTION, which is the load-bearing property: the answer is
 * a step function of an INTEGER over a monotone counter, so it changes at
 * building events and never per tick or per frame. A radius that drifted would
 * move the lot lattice, the border and the source list under a player
 * mid-harvest — the same failure the charter-reach work was shaped to avoid.
 *
 * `serviceRadiusM` still does real work as the CEILING: past a need cycle's
 * walk the stand is not this settlement's district, whatever it has built. At
 * street clock that binds at 96 m; at REAL_SCALE it is ~34.5 km and the
 * caller's own extent clamp binds instead.
 *
 * 🚫 NOT A BALANCE DIAL. The two terms are `TOWN_DIMS` readings, not tuned
 * numbers, and nothing here touches yields, bills or `conversionDial`.
 */
export function nearStandRadiusM(scale: WorldScale, built: number): number {
  const n = Math.max(0, Math.floor(built));
  const ladder =
    NEAR_STAND_BASE_M + NEAR_STAND_STEP_M * Math.floor(Math.log2(1 + n));
  return Math.min(serviceRadiusM(scale, "hunger"), ladder);
}

/** The stand a site has before it has built anything: the clearing a founding
 *  gets (`TOWN_DIMS.plazaR` — "the scale of a STUB baseline, so a lone
 *  founder's town starts with a street rather than a point"). */
export const NEAR_STAND_BASE_M = TOWN_DIMS.plazaR;
/** …and one more building's FRONTAGE per doubling (`TOWN_DIMS.lotPitch`, lot
 *  centre to lot centre along the street). */
export const NEAR_STAND_STEP_M = TOWN_DIMS.lotPitch;

// ── ⚖️ THE CLIMATE ARM'S TWO CORRECTIONS (2026-09-01) ──────────────────────
// Both helpers below are reachable ONLY from a pick site that was handed a
// `ClimateSample`. Neither is exported, and neither sits on a code path a
// no-climate caller can enter: the legacy arms keep their own expressions
// verbatim, because the headless bench transcripts byte-hold on them.

/**
 * A SUITABILITY-WEIGHTED deterministic pick over the bearers.
 *
 * ⚖️ A PLANT AT ITS RANGE EDGE IS RARE THERE, NOT EQUALLY LIKELY. The niche
 * filter asked one question — "does this cell admit it?" — and then handed the
 * survivors to a uniform modulo, so a vine clinging on at 2 % suitability
 * stood as often as the crop that peaks here. That is the banana bug's quieter
 * sibling: the filter moved the ABSURD cases out and left the IMPROBABLE ones
 * at full odds. The weights are `nicheSuitabilityOf` itself — the very number
 * the filter thresholded — so "lives here" and "is common here" are one
 * continuous answer with one owner, never a bound plus a separate abundance
 * table that can disagree with it.
 *
 * DETERMINISTIC per (seed, climate), which is the whole contract a scatter
 * site has: the fraction is a hash of the seed alone (Knuth's 2654435761 —
 * the golden-ratio multiplier, so neighbouring seeds walk a well-spread cycle
 * instead of the modulo's hard march), and the cumulative walk runs the rows
 * in catalogue order. No rng, no clock; the same cell answers the same species
 * forever. A ZERO-weight row can never be picked (the walk steps over it), so
 * the filter and the pick agree even if a caller hands over an unfiltered list.
 */
function weightedPickBySeed<T>(
  rows: readonly T[],
  weightOf: (row: T) => number,
  seed: number,
): T | undefined {
  if (!rows.length) return undefined;
  const w = rows.map(weightOf);
  const total = w.reduce((a, b) => a + b, 0);
  // Every candidate is already > 0 here (the list came from the same query),
  // so this only ever catches a weightless caller — answer the LEGACY uniform
  // pick rather than nothing, since "none of them" is not a true answer when
  // the rows exist.
  if (!(total > 0)) return rows[(seed >>> 3) % rows.length];
  let r = ((((seed >>> 3) * 2654435761) >>> 0) / 4294967296) * total;
  for (let i = 0; i < rows.length; i++) {
    r -= w[i]!;
    if (r < 0) return rows[i];
  }
  return rows[rows.length - 1];
}

/**
 * THE BIOME SAYS WHAT SHOULD GRAZE THIS KIND OF GROUND; THE CELL SAYS WHETHER
 * THIS ONE CAN. A biome index is a CLASS of ground — "grazer range" — and the
 * switch below names its livestock literally at fixed counts. But a class
 * spans a continent: one steppe index covers a Mediterranean meadow and a
 * Mongolian winter, and only one of those is cattle country. So the switch's
 * animals are re-asked the one uniform Layer-1 question — `nicheSuitabilityOf`
 * against the animal's OWN catalogue row — and dropped where the answer is 0.
 * A frigid steppe has no cattle; it still has sheep, and it says so without
 * either fact being written into the switch.
 *
 * PASS-THROUGH IS THE DEFAULT, twice over: an entry with no catalogue row and
 * an entry whose row declares no niche both survive (`nicheSuitabilityOf`
 * answers 1 with no niche — the band convention that keeps a rock placeable
 * everywhere). ANIMALS ONLY, deliberately: the fruit line already arrived
 * pre-filtered from `usefulPlants(climate)`, and oak/rock are the switch's own
 * STRUCTURAL content — a biome that says "forest" has already decided there
 * are trees, and re-litigating that here would let one cell's climate empty a
 * forest the biome field put there.
 */
function climateAdmitsEntry(e: WildMixEntry, climate: ClimateSample): boolean {
  const src = naturalSourceOf(e.species);
  if (src?.kind !== "animal") return true;
  return nicheSuitabilityOf(src, climate) > 0;
}

/** The bearer this site stands, or undefined when nothing grows here. WITH a
 *  climate: the suitability-weighted pick above. WITHOUT one: the LEGACY
 *  `(seed >>> 3) % len` modulo over the unfiltered list, expression-for-
 *  expression as it has always been — the bench law. */
function pickBearer(
  bearers: ReturnType<typeof usefulPlants>,
  seed: number,
  climate?: ClimateSample,
): { species: string } | undefined {
  return climate
    ? weightedPickBySeed(bearers, (s) => nicheSuitabilityOf(s, climate), seed)
    : bearers.length
      ? bearers[(seed >>> 3) % bearers.length]!
      : undefined;
}

/**
 * A FOUNDING-AGE town's gatherable surroundings, from its charter biome
 * (plan.ts TownPlan.biome — the site's ground character): farmland country
 * carries an orchard sprinkle and wild livestock to tame; mining country is
 * timber over heavy stone. The fruit is picked from the products registry by
 * the landing seed, so neighbouring sites bear different fruit and a
 * live-harvest (regrowing) source stands in every founding.
 *
 * 📦 LIVES HERE, NOT IN A GAME (moved from `games/world-lab/src/wilderness-boot.ts`,
 * 2026-08-12 — ONE definition). Three boots need the same mix and one of them is
 * the HEADLESS harness (`shared/world-engine/headless/text-quest.ts`), which
 * cannot import from `games/`; that import barrier is exactly why text mode
 * shipped with no wilderness at all and every play-level measurement of the
 * block economy was taken in a world with no timber (the GL closing sweep's
 * handoff item 2). `wilderness-boot.ts` re-exports this symbol, so the two
 * browser boots are unchanged.
 *
 * 🚫 THE COUNTS ARE NOT TUNED HERE. They are one half of a supply curve whose
 * other half is the structure bill (`products.ts:134` — "MOVE THIS WITH THE
 * BILL, never alone"); the world-size design round owns both.
 *
 * ⚖️ S&D S3 H1 — multiplier ⑤ of five: a SUPPLY quantity (how many features
 * stand). ⚖️ DIAL-FREE (corrected in review): wild counts and yields are
 * natural ABUNDANCE, not natural→usable conversion — the
 * `resource_compression` dial applies at exactly one boundary
 * (`effectiveInPerOut` / `storehouseRawParAt` / `farmAcresPerPerson`);
 * scaling abundance here compounded the dial (~dial⁴ end to end in the
 * reviewed draft). Standing-stock realism is the world-size design round's
 * business (region reach + offload), never a hidden multiplier.
 */
export function homesteadWildMix(
  biome: "farmland" | "mining",
  seed: number,
  climate?: ClimateSample,
): WildMixEntry[] {
  const scaled = (count: number): number => count;
  // ⚖️ PICKED BY SEED, FROM WHAT GROWS HERE (2026-09-01 — the niche join).
  // The bearers are the GROWER'S query (`usefulPlants` — plants worth
  // putting in the ground, i.e. carrying a live renewable take), never the
  // food vocabulary: a sentence board must name a banana everywhere, a
  // homestead must not stand one everywhere.
  // WITH a climate sample the list is filtered to what this cell admits, and
  // an EMPTY answer STANDS: nothing grows here, so the mix carries no fruit
  // line at all. Never fall back to the unfiltered list on empty — that
  // fallback IS the banana-on-a-cold-homestead bug, moved one branch in.
  // WITHOUT one, the legacy contract, byte-identical: a caller with no cell
  // under it (flat test worlds, charter-only boots, the headless text
  // harness's founding) still gets a fruit, picked by the seed off the
  // unfiltered list. `biome` cannot stand in for the sample — it is a
  // LAND-USE label ("farmland" / "mining", from the charter's
  // fertility-vs-ore scores), never an ecological one.
  // ⚖️ AND PICKED BY SUITABILITY, not merely by admission (2026-09-01) — the
  // climate arm weights the pick by `nicheSuitabilityOf` (weightedPickBySeed);
  // the no-climate arm keeps the bare modulo. Same determinism either way.
  const bearers = usefulPlants(climate);
  const pick = pickBearer(bearers, seed, climate);
  const fruit: WildMixEntry[] = pick ? [{ species: pick.species, count: scaled(2) }] : [];
  const mix: WildMixEntry[] = biome === "mining"
    ? [{ species: "oak", count: scaled(8) }, ...fruit, { species: "rock", count: scaled(10) }]
    : [
        { species: "oak", count: scaled(8) },
        ...fruit,
        { species: "rock", count: scaled(4) },
        { species: "sheep", count: scaled(2) },
        { species: "cow", count: scaled(1) },
      ];
  // ⚖️ THE LIVESTOCK IS RE-ASKED (climateAdmitsEntry): "farmland" is a
  // LAND-USE label off the charter's fertility-vs-ore scores, so it says a
  // homestead keeps animals — never which animals THIS ground feeds. A frigid
  // holding keeps its flock and loses its herd. No sample ⇒ nothing to ask,
  // and the legacy mix returns untouched.
  return climate ? mix.filter((e) => climateAdmitsEntry(e, climate)) : mix;
}

/** What a biome grazes — the walking half of a wild cell's population, kept
 *  beside the scatter mix because a boot reads both off one biome index. */
export interface WildFauna {
  horses: number;
}

/** What the landing/spawn cell's biome grazes (grid.fields.biome: 0 =
 *  barren/sea/ice, then DEFAULT_BIOSPHERE order — 1 tree, 2 grass,
 *  3 horse). */
// 📋 FOLLOW-UP, DELIBERATELY NOT DONE (2026-09-02): this is the THIRD
// bucket table on the same fact. `eco_horse` is now baked and HORSE is a
// biosphere row like TREE and GRASS, so these counts could read
// `standDensityPerHa` exactly as the scatter's vegetation line does — herds
// would then thin and thicken across the steppe instead of stepping 0/4/6.
// Left alone because it is absolute-count fauna on a different consumer
// (`WildFauna`, wander bodies rather than scatter entries) and this round was
// chartered for the two TREE authorities. Give HORSE a `standPerHa` and this
// becomes one line.
export function faunaForBiome(biome: number): WildFauna {
  switch (biome) {
    case 2: return { horses: 4 };  // steppe / meadow
    case 3: return { horses: 6 };  // grazer range
    default: return { horses: 0 }; // barren / forest
  }
}

/**
 * What the landing/spawn cell's biome SCATTERS as gatherable quest content
 * (step ④ biome selection — the seam `buildWilderness`'s `mix` param was cut
 * for). Forest is oak-dominant; open grazing country is sparse trees but
 * wild flocks (animal entries scatter as WALKING product bodies —
 * milk/shear/hunt); barren ground is stone outcrops only. One plant from the
 * registry's GROWER'S query (`usefulPlants` — a live renewable take, never
 * the food vocabulary) joins any GROWING biome, picked deterministically by
 * the cell seed, so neighbouring cells bear different fruit and a
 * live-harvest (regrowing) source stands in every walkable wild. Species come
 * from the registry, never named in the engine.
 *
 * 📦 LIVES HERE, NOT IN A GAME (2026-09-01) — the `homesteadWildMix`
 * precedent in this same file, applied to its sibling. Two games carried
 * byte-identical copies (`games/world-lab/src/wilderness-boot.ts`,
 * `games/nature-hike/src/wilderness.ts`) and a third consumer is the
 * HEADLESS harness, which cannot import from `games/` at all. Duplication is
 * how they went stale: both copies still called `orchardPlants()`, a name
 * the registry dropped when the property query was renamed `foodPlants()`,
 * so the games did not build. The game modules re-export these symbols, so
 * their own consumers are unchanged.
 *
 * 🚫 THE COUNTS ARE NOT TUNED HERE — the same law `homesteadWildMix` states:
 * they are one half of a supply curve whose other half is the structure
 * bill, and the world-size design round owns both.
 *
 * ⚖️ `climate` follows `homesteadWildMix` exactly, in all three of its parts:
 * present ⇒ bearers are filtered to what grows at this cell (an EMPTY answer
 * means NO fruit line, never a fallback to the unfiltered list), the surviving
 * bearer is picked by SUITABILITY WEIGHT rather than uniformly, and the
 * switch's ANIMALS are re-asked whether this cell carries them; absent ⇒ the
 * legacy seed-only pick over the whole list with no filtering of any kind,
 * byte-identical. Barren stays fruitless and stockless either way — the biome
 * switch already said nothing grows and named no livestock.
 *
 * ⚖️ `eco` IS THE FOURTH ARM AND THE POINT OF THE 2026-09-02 ROUND: the
 * cell's PER-SPECIES ABUNDANCE (`planet/ecology.ts ecoAbundanceAt`, 0..1 per
 * biosphere key). Present ⇒ every line comes back as a DENSITY (`perHa`), and
 * the vegetation line reads the abundance field rather than the biome bucket —
 * so this function and the flora field, which now reads the same field through
 * the same `standDensityPerHa`, cannot disagree about how thick a wood is.
 * The non-vegetation lines (rock, livestock, the fruit sprinkle) keep the
 * switch's counts, re-expressed as their density at `LEGACY_SCATTER_SIDE_M`,
 * because the biosphere ships three species and has no opinion about outcrops
 * or sheep. Absent ⇒ absolute counts, byte-identical, for every caller with no
 * baked ecology under it (a preset town, a flat test world, the headless
 * harness, a region substrate).
 *
 * 🚫 STILL NOT A CONVERSION: this is a SCATTER SHAPE, so `conversionDial`
 * stays out of it (the one-application law lives at `effectiveInPerOut` /
 * `storehouseRawParAt` / `farmAcresPerPerson`).
 */
export function wildMixForBiome(
  biome: number,
  seed: number,
  climate?: ClimateSample,
  eco?: Readonly<Record<string, number>>,
): WildMixEntry[] {
  const bearers = usefulPlants(climate);
  const pick = pickBearer(bearers, seed, climate);
  const fruit: WildMixEntry[] = pick
    ? [{ species: pick.species, count: biome === 1 ? 2 : 1 }]
    : [];
  let mix: WildMixEntry[];
  switch (biome) {
    case 1: // forest
      mix = [{ species: "oak", count: 10 }, ...fruit, { species: "rock", count: 6 }];
      break;
    case 2: // steppe / meadow — open country, wild flocks
      mix = [
        { species: "oak", count: 3 },
        ...fruit,
        { species: "rock", count: 5 },
        { species: "sheep", count: 2 },
      ];
      break;
    case 3: // grazer range — flocks and wild cattle
      mix = [
        { species: "oak", count: 3 },
        ...fruit,
        { species: "rock", count: 5 },
        { species: "sheep", count: 2 },
        { species: "cow", count: 1 },
      ];
      break;
    default: // barren / sea-edge / ice — nothing grows
      mix = [{ species: "rock", count: 8 }];
  }
  // ⚖️ THE LIVESTOCK IS RE-ASKED (climateAdmitsEntry) — the switch names what
  // a biome CLASS grazes, this asks whether this cell's version of that class
  // can. Barren is unaffected (it names no animals), and so is every
  // no-climate caller: with no sample the switch's answer is returned as-is.
  const admitted = climate ? mix.filter((e) => climateAdmitsEntry(e, climate)) : mix;
  return eco ? admitted.map((e) => withEcoDensity(e, eco)) : admitted;
}

/** One mix line as a DENSITY: the biosphere's own abundance where it has an
 *  opinion (a species whose `model` is this line's source), the line's legacy
 *  count re-read at the reference area where it has none. */
function withEcoDensity(
  e: WildMixEntry,
  eco: Readonly<Record<string, number>>,
): WildMixEntry {
  const ecological = DEFAULT_BIOSPHERE.some((s) => s.model === e.species && s.standPerHa);
  return {
    ...e,
    perHa: ecological ? standDensityPerHa(e.species, eco) : legacyPerHa(e.count),
  };
}

export interface WildernessParams {
  seed: number;
  /** Square side, metres. Default 240. */
  side?: number;
  /** Manifold walls: false = the rect is CONTENT extent only (a chunk mounted
   *  on a real planet, whose ground sampler answers everywhere — the edge must
   *  never be a wall). Default true (standalone scope: nothing beyond the rect). */
  bounded?: boolean;
  /** EXPLICIT SCATTER MIX (step ④ biome selection): plant/mineral source
   *  species → feature counts, chosen by the CALLER from whatever biome
   *  authority it stands on (planet ecology, world spec, town charter) —
   *  the engine never names species here. Absent = the legacy oak-and-rock
   *  defaults below. Animal sources join the scatter with the
   *  hunting/taming rework, as creatures — not box features. */
  mix?: ReadonlyArray<WildMixEntry>;
  /** Legacy oak/rock counts — read only when `mix` is absent. */
  trees?: number;
  rocks?: number;
  creatures?: number;
  /** EXPLICIT LOCAL CAST — the creature-registry species the `creatures`
   *  wanderers may be, supplied by the CALLER from whatever biome authority
   *  it stands on, exactly as `mix` is. Absent/empty = `wildLocalCast()`,
   *  the whole registry's bodied non-speaking fauna.
   *
   *  ⚖️ THE SEAM EXISTS SO THE ENGINE NEVER HAS TO CHOOSE. A desert and a
   *  forest scatter the same faces today because nothing upstream has an
   *  answer to give: creature rows carry no ecological niche (products.ts
   *  niches cover natural SOURCES only), so there is nothing yet to filter
   *  a wild cast by. When species rows gain habitat, this is the parameter
   *  the biome fills — no engine change. */
  locals?: ReadonlyArray<string>;
  /** Keep-clear disc override (city-founding: a town session scatters AROUND
   *  its plaza/site, not through it).
   *
   *  ⚖️ A CLEARING MUST BE ASKED FOR (user ruling, 2026-09-02: *"the land
   *  should still be untouched"*). `clearR` DEFAULTS TO 0 — the scatter's
   *  ordinary answer is that the ground is whatever the seed says it is, and
   *  a hole in it is a caller's deliberate request, never the shape of a
   *  spawn point. The old default (6 m around the centre spawn) put an
   *  actorless hole in every wilderness ever laid. */
  clearAt?: { x: number; y: number };
  clearR?: number;
  /** ADDITIONAL keep-clear discs (sim coords) — settlements inside or
   *  bordering the scatter square. A planet chunk mounted at a village edge
   *  must not scatter oaks through its streets (round-2 GL defects: the
   *  boundary "trees appearing"); the driver passes every known settlement
   *  footprint here. Composes with clearAt/clearR; absent = byte-identical. */
  clears?: ReadonlyArray<{ x: number; y: number; r: number }>;
  /**
   * ⚖️ THE RELEVANCE DISC (user ruling 2026-09-02 — *"only the near stand
   * should be relevant"*): the site's OWN ground. A FEATURE outside it is not
   * laid, so it is never a container, never a source, never selectable, never
   * reachable by a build's material enumeration or its clearing prerequisite —
   * it simply is not a thing in the sim. What is DRAWN out there is the
   * renderer's business and no concern of this function's (`nearStandRadiusM`
   * is the one owner of the number; the driver's flora field is the one owner
   * of the picture).
   *
   * 🚨 THE INVERSE OF `clears`, AND THE SAME MECHANISM: a post-filter over a
   * scatter drawn as if it did not exist, never a rejection loop. So the near
   * stand is a strict SUBSET of the clear-less scatter at identical
   * coordinates and identical ids — the draw sequence is untouched, the same
   * seed still produces the same world, and widening the disc later reveals
   * exactly the trees that were always going to be there (which is what lets
   * the stand GROW without re-rolling the countryside).
   *
   * ⚖️ FEATURES ONLY, deliberately. Walking bodies — product animals, the
   * possessable locals — are the streamer's business, by the same law the
   * fold already states ("Creatures are NOT folded: a body with a mind is the
   * streamer's business"). A herd is not a stand; it moves.
   *
   * ⚖️ AND IT DESTROYS NOTHING. The scatter is being CREATED — a tree that is
   * not laid never held a unit, exactly as `clears`' own note argues. Item
   * conservation has nothing to weigh here.
   *
   * Absent ⇒ byte-identical to every scatter ever laid.
   */
  keep?: { x: number; y: number; r: number };
  /** ⚖️ INERT (S3 review): abundance is DIAL-FREE — never pass the session's
   *  `resourceCompression` here; the conversion dial applies only at
   *  effectiveInPerOut / storehouseRawParAt / farmAcresPerPerson. The seat
   *  stays for tests that pin the invariance. */
  conversionDial?: number;
}

/** Deterministic scatter RNG (mulberry32 — the landing-cell convention). */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** THE WILD CAST — every species a wilderness local's body may be, DERIVED
 *  from the live species registry rather than listed here.
 *
 *  ⚖️ A WILDERNESS LOCAL IS FAUNA. The filter is exactly that sentence, in
 *  the registry's own vocabulary:
 *    • `kind: "creature"` — an animal, not a plant or a fruit body;
 *    • NOT `stub` and NOT `bodiless` — 🚨 a stub's blueprint is EMPTY and
 *      `createBakedCreature` → `requireSpecies` THROWS on it. `bear`, `frog`
 *      and `rabbit` are stub rows today (they are the bases the
 *      `animal_people` mod derives from), so the old four-face scatter has
 *      no body to stand even where its species exist;
 *    • NOT `speciesCanSpeak` — SAPIENCE IS NOT WILDLIFE. Somebody you greet
 *      by name is a person; a world's speaking cast is the puzzle/person
 *      path's to draw from, never the countryside's. This one clause is the
 *      whole of the "frontier homestead spawns wild humans" fix;
 *    • carries `words` — a body plan nobody can NAME (`quadruped`,
 *      `ungulate`, the palaeo plans) is scaffolding the world builds with,
 *      per species.ts's own rule, not an animal a child meets. Those ids
 *      stay buildable by id (the barter caravan's `ungulate` mount is
 *      unaffected); they just do not wander into the scatter unnamed.
 *
 *  Order is REGISTRY order, so the seeded pick is stable for a given world.
 *  Which species exist is a property of the WORLD (mods register their own),
 *  which is exactly why nothing here may spell one. Empty is impossible in
 *  practice; the caller falls back to no locals rather than inventing one. */
export function wildLocalCast(): string[] {
  return listSpecies()
    .filter(
      (sp) =>
        sp.kind === "creature" &&
        !sp.stub &&
        !sp.bodiless &&
        !speciesCanSpeak(sp.id) &&
        sp.words !== undefined,
    )
    .map((sp) => sp.id);
}

/** A local's FACE, derived from its body: the AAC glyph registry's emoji for
 *  the species word, or "" when the vocabulary has no picture for it. Display
 *  only — the model factory reads the SPECIES. */
export function wildLocalIcon(species: string): string {
  return getVocabularyItem(species)?.emoji ?? "";
}

/** A feature record for one natural source: kill products rolled into the
 *  stock (the tree IS its wood), harvest products rolled as the standing
 *  bearing AND its capacity ceiling. Deterministic — bodyStockOf rolls
 *  first, then harvestStockOf (kill-only species consume no extra rolls,
 *  so legacy oak/rock scatters stay byte-identical). Exported for LIVE
 *  additions (flora twins: a host materializes a feature at a streamed
 *  tree's exact spot, rolling its stock off a per-placement seed). */
export function makeFeature(
  id: string,
  species: string,
  p: { x: number; y: number },
  rng: () => number,
  conversionDial = 1,
): WildernessFeature {
  const kill = bodyStockOf(species, rng, conversionDial);
  const cap = harvestStockOf(species, rng, conversionDial);
  const f: WildernessFeature = { id, species, x: p.x, y: p.y, stock: { ...kill, ...cap } };
  if (Object.keys(cap).length) f.harvestCap = cap;
  // GROWTH-BEARING species stand MATURE at scatter (the last class, the
  // catalogue's own yield.min/max above — `sizeClass`/`growAt` stay UNSET,
  // never explicitly "last index", so a freshly-laid forest is byte-
  // identical to every feature built before growth classes existed).
  return f;
}

/** Any wild yield-bearer — a standing FEATURE or a product ANIMAL: the
 *  regrow calculators read the same three fields off either. */
export interface WildSource {
  species: string;
  harvestCap?: Record<string, number>;
  regrowAt?: Record<string, number>;
}

/** REGROWTH DUE by `now` — PURE: reads the source's ledger + the LIVE
 *  stock (the host's copy, not the initial roll), returns the units that
 *  have matured and the advanced ledger. The quest host — the one stack
 *  mutator — applies both. One unit matures per regrow period; a long
 *  absence catches up whole periods but stops at capacity, where the
 *  ledger entry retires. Null = nothing pending. */
export interface HarvestRegrowth {
  /** glyph → units matured since the last look (host adds to live stock). */
  add: Record<string, number>;
  /** Replacement ledger (entries only for glyphs still below capacity). */
  regrowAt: Record<string, number>;
}
export function dueHarvestRegrowth(
  source: WildSource,
  liveStock: Record<string, number>,
  now: number,
  dayS: number,
): HarvestRegrowth | null {
  const pending = source.regrowAt;
  if (!pending) return null;
  let changed = false;
  const add: Record<string, number> = {};
  const regrowAt: Record<string, number> = {};
  for (const p of harvestProductsOf(source.species)) {
    let at = pending[p.glyph];
    if (at === undefined) continue;
    const cap = source.harvestCap?.[p.glyph] ?? 0;
    const period = Math.max(1e-3, (p.regrowDays ?? 1) * dayS);
    let have = liveStock[p.glyph] ?? 0;
    while (at <= now && have < cap) {
      have++;
      add[p.glyph] = (add[p.glyph] ?? 0) + 1;
      at += period;
      changed = true;
    }
    if (have < cap) regrowAt[p.glyph] = at;
    else changed = true; // full again — the entry retires
  }
  return changed ? { add, regrowAt } : null;
}

/** Arm the regrow clock after a LIVE take: the glyph's next unit matures
 *  one regrow period from `now`. No-op unless the glyph is one of the
 *  species' harvest products, and never rewinds an already-armed clock —
 *  takes during regrowth keep the standing cadence. */
export function armHarvestRegrow(
  source: WildSource,
  glyph: string,
  now: number,
  dayS: number,
): void {
  if (source.regrowAt?.[glyph] !== undefined) return;
  const p = harvestProductsOf(source.species).find((q) => q.glyph === glyph);
  if (!p) return;
  (source.regrowAt ??= {})[glyph] = now + Math.max(1e-3, (p.regrowDays ?? 1) * dayS);
}

// ── ⚖️ S&D S3 H2 — THE TIMBER GROWTH CLOCK ─────────────────────────────────
// The sibling of the harvest-regrow pair above, same shape: a PURE
// calculator here, the host applies it (quest-host `growWildFeature`). A
// felled wood-bearing feature RE-SEEDS (sizeClass 0) instead of vanishing,
// then climbs `growth.classes` on a clock anchored in REAL YEARS
// (`bioYearsGameDays` — the generation/growth family precedent, scale.ts).
// A species with no `growth` declared (rock, sheep, cow, banana, grape) —
// or a feature that was never felled — never carries `growAt`, so none of
// this fires; that is how stone stays finite without a special case.

/** Real-years-per-class → GAME SECONDS, evenly dividing the maturity span
 *  across the size classes (N classes ⇒ N−1 steps from sapling to mature).
 *  `scale.dayLengthS` converts `bioYearsGameDays`'s game-DAYS into the same
 *  taskClock seconds `regrowAt`/`growAt` are quoted in. */
export function growthClassPeriodS(
  scale: WorldScale,
  growth: { maturityYears: number; classes: readonly GrowthSizeClass[] },
): number {
  const steps = Math.max(1, growth.classes.length - 1);
  return (bioYearsGameDays(scale, growth.maturityYears) * scale.dayLengthS) / steps;
}

/** RANK KEY for "larger cut first" (USER LAW, verbatim: *"larger trees will
 *  typically be cut first"*): the CURRENT size class, negated so a bigger
 *  class sorts FIRST under an ascending comparator (`rankPricedSources`'
 *  `rankKey`, transfer.ts). Unset `sizeClass` = mature (the scatter default,
 *  `makeFeature`) = the LAST class = the most negative key = picked first,
 *  same as every feature that has never been felled. A species with no
 *  `growth` (rock) answers 0 for every feature — no size preference, purely
 *  the walk's ordinary distance order, which is "stone stays finite" read
 *  the other way: there is no size story to prefer. */
export function wildFeatureSizeRank(f: WildernessFeature): number {
  const g = naturalSourceOf(f.species)?.growth;
  if (!g) return 0;
  const cls = f.sizeClass ?? g.classes.length - 1;
  return -cls;
}

/** GROWTH ADVANCE due by `now` — PURE, mirrors `dueHarvestRegrowth`'s
 *  catch-up loop exactly (a long absence climbs whole classes, stopping at
 *  mature, where the clock retires): `null` = nothing pending (no clock
 *  armed, species has no `growth`, or already mature). The returned
 *  `stock` REPLACES the feature's kill-glyph stock (a felled tree's wood is
 *  a function of its CURRENT class, not an accumulation — the same "size
 *  means units left, not a fraction" law `wildFeatureRadius` already
 *  states for depletion, read forward for growth). */
export interface GrowthAdvance {
  sizeClass: number;
  stock: Record<string, number>;
  growAt?: number;
}
export function dueGrowthAdvance(
  f: Pick<WildernessFeature, "species" | "sizeClass" | "growAt">,
  now: number,
  classPeriodS: number,
  conversionDial = 1,
): GrowthAdvance | null {
  const src = naturalSourceOf(f.species);
  const g = src?.growth;
  if (!g || f.growAt === undefined) return null;
  let cls = f.sizeClass ?? 0;
  let at = f.growAt;
  let changed = false;
  while (at <= now && cls < g.classes.length - 1) {
    cls++;
    at += Math.max(1e-3, classPeriodS);
    changed = true;
  }
  if (!changed) return null;
  const stock: Record<string, number> = {};
  for (const p of src!.products) {
    if (!isBodyProduct(p)) continue;
    stock[p.glyph] = growthClassYield(p, g.classes[cls]!.yieldMul, conversionDial);
  }
  return { sizeClass: cls, stock, growAt: cls < g.classes.length - 1 ? at : undefined };
}

/** RE-SEED STATE (S3 H2's felling replacement): a freshly-felled
 *  growth-bearing feature's sapling stock (class 0) — PURE, the host arms
 *  `growAt` and writes the live containerStock (quest-host `depleteWildSource`).
 *  Kill glyphs only; a source's harvest glyphs (fruit) are the regrow
 *  ledger's own business and untouched here. */
export function reseedGrowthStock(
  species: string,
  growth: { classes: readonly GrowthSizeClass[] },
  conversionDial = 1,
): Record<string, number> {
  const src = naturalSourceOf(species);
  const stock: Record<string, number> = {};
  for (const p of src?.products ?? []) {
    if (!isBodyProduct(p)) continue;
    stock[p.glyph] = growthClassYield(p, growth.classes[0]!.yieldMul, conversionDial);
  }
  return stock;
}

/** Build the wilderness scatter for a seed. Same seed ⇒ identical content. */
export function buildWilderness(params: WildernessParams): WildernessContent {
  const side = Math.max(60, params.side ?? 240);
  const rng = mulberry(params.seed);
  const spawn = { x: side / 2, y: side / 2 };
  const clearAt = params.clearAt ?? spawn;
  const clearR = Math.max(0, params.clearR ?? 0);
  // Every keep-clear disc in one list: the clearing + any settlement
  // footprints the driver declared.
  const clears = [{ x: clearAt.x, y: clearAt.y, r: clearR }, ...(params.clears ?? [])];
  // ⚖️ S3 review: abundance is DIAL-FREE — params.conversionDial is an
  // inert seat (see ScatterOpts); the one-application law lives at
  // effectiveInPerOut / storehouseRawParAt / farmAcresPerPerson.
  const dial = 1;

  /**
   * ⚖️ A CLEARING IS A HOLE, NOT A RE-ROLL (user ruling, 2026-09-02).
   *
   * `place()` draws ONE pair and returns it — every candidate is accepted,
   * whatever disc it lands in. The keep-clear test moved OUT of the draw loop
   * to the post-filter at the foot of this function, and that is the whole of
   * the fix: the old rejection loop re-drew a rejected candidate, so a
   * rejected draw shifted every LATER feature's draws too. Measured on
   * (seed 4242, side 240, the farmland mix): `clearR=61` against `clearR=0`
   * left 0 of 14 features in the same place. The file's own "absent ⇒
   * byte-identical" claims were true only for the ABSENT case; a clear
   * silently regenerated the whole countryside.
   *
   * ⚠️ WHAT IS AND IS NOT PRESERVED, HONESTLY. The equivalence that holds is
   * the NEW one — an unasked scatter is exactly a `clearR: 0` scatter, and
   * a clear now yields a strict SUBSET of the clear-less scatter at identical
   * coordinates and identical ids (`arrival-untouched.test.ts` pins it).
   * The OLD world moved: `clearR` defaulted to `?? 6` around the spawn centre,
   * so a no-clear caller DID have a live disc and DID re-draw whenever a
   * candidate landed in it — π·6² over the draw rect, measured at 0.24 % of
   * draws on the 240 m default, which shifted 3.8 % of seeds at the 16-feature
   * legacy mix and 21 % at a 62-feature forest (one rejection moves every
   * LATER feature too). That shift is real and accepted — it is the actorless
   * hole coming out of every wilderness ever laid — and it is written down
   * here rather than papered over with a "byte-identical to the old first try"
   * claim that was only true for callers already passing `clearR: 0`.
   */
  const place = (): { x: number; y: number } => {
    const x = 8 + rng() * (side - 16);
    const y = 8 + rng() * (side - 16);
    return { x, y };
  };
  /** Is this point inside a declared keep-clear disc? */
  const excluded = (p: { x: number; y: number }): boolean =>
    clears.some((c) => c.r > 0 && Math.hypot(p.x - c.x, p.y - c.y) < c.r);
  /** …and is it inside the RELEVANCE disc (see `keep`)? No disc declared ⇒
   *  everything is the site's, which is every pre-2026-09-02 caller. */
  const keep = params.keep;
  const relevant = (p: { x: number; y: number }): boolean =>
    !keep || Math.hypot(p.x - keep.x, p.y - keep.y) <= keep.r;

  const features: WildernessFeature[] = [];
  const creatures: WildernessCreature[] = [];
  // The scatter mix: caller-supplied (biome/spec-derived), else the legacy
  // oak-forest-over-rocky-ground default. Stocks come from the registry's
  // products (rolled in product order — deterministic; the default mix
  // makes the same rng calls the pre-mix scatter made). A mix entry whose
  // source is an ANIMAL scatters walking bodies, not box features — same
  // rolled yield state, carried on the creature.
  const mix: ReadonlyArray<WildMixEntry> = params.mix ?? [
    { species: "oak", count: params.trees ?? 10 },
    { species: "rock", count: params.rocks ?? 6 },
  ];
  // ⚖️ THE ONE PLACE THAT KNOWS THE EXTENT resolves the density (2026-09-02).
  // A `perHa` line is multiplied by THIS scatter's own ground; an absolute
  // line is laid verbatim, exactly as it always was. That split is what keeps
  // extent and abundance from being the same number: a caller may widen the
  // rect without thinning the country, and two scatters of different sizes
  // over the same cell describe the same land.
  const areaHa = (side * side) / 10_000;
  const countOf = (m: WildMixEntry): number =>
    m.perHa !== undefined
      ? Math.max(0, Math.round(m.perHa * areaHa))
      : Math.max(0, m.count);
  for (const m of mix) {
    const isAnimal = naturalSourceOf(m.species)?.kind === "animal";
    const n = countOf(m);
    for (let i = 0; i < n; i++) {
      if (!isAnimal) {
        features.push(makeFeature(`wild:${m.species}_${i}`, m.species, place(), rng, dial));
        continue;
      }
      const p = place();
      const kill = bodyStockOf(m.species, rng, dial);
      const cap = harvestStockOf(m.species, rng, dial);
      creatures.push({
        id: `wild_${m.species}_${i}`,
        icon: "", // the body comes from the species, never an emoji face
        x: p.x,
        y: p.y,
        species: m.species,
        stock: { ...kill, ...cap },
        ...(Object.keys(cap).length ? { harvestCap: cap } : {}),
      });
    }
  }

  // THE WANDERING LOCALS. The SPECIES is picked (from the caller's cast, else
  // the registry's fauna) and the face is DERIVED from it — never the reverse.
  // Same rng shape as before (one `place()`, then one draw), so the scatter
  // stays seed-deterministic; the drawn VALUES move, which is the fix.
  const cast = params.locals?.length ? params.locals : wildLocalCast();
  const nCreatures = cast.length ? Math.max(0, params.creatures ?? 3) : 0;
  for (let i = 0; i < nCreatures; i++) {
    const p = place();
    const species = cast[Math.floor(rng() * cast.length)]!;
    creatures.push({
      id: `wild_${i}`,
      icon: wildLocalIcon(species),
      x: p.x,
      y: p.y,
      bodySpecies: species,
    });
  }

  // ⚖️ THE POST-FILTER (see `place`): the exclusion is applied ONCE, here,
  // over a scatter that was drawn as if no disc existed. A cleared disc is
  // therefore a HOLE — the features outside it stand exactly where they stood
  // with no clear at all, keeping their ids — and never a re-roll.
  return {
    side,
    seed: params.seed,
    spawn,
    // ⚖️ …and the RELEVANCE disc rides the SAME post-filter (see `keep`): a
    // feature outside the near stand is not the site's, so it is not laid.
    // Walking bodies are exempt on purpose — a herd is not a stand.
    features: features.filter((f) => !excluded(f) && relevant(f)),
    creatures: creatures.filter((c) => !excluded(c)),
  };
}
