// shared/world-engine/interaction/town/town-play.ts
//
// ONE SERIALIZABLE CONFIG → a whole live town session. The config crosses
// the games bridge (an iframe boundary — no live objects), and the player
// rebuilds the identical session from it: same seed ⇒ same town, same
// plan, same quests, same stage. Determinism IS the transport.
//
// The payload rides the existing `load_game` channel, discriminated by
// `engine: "town-play"` — hosts that predate it reject it harmlessly.

import { compileEconomy, type CompiledEconomy, type EconomyDoc } from "@shared/world-engine/kernel/modules/economy/index.js";
import { HOUSEHOLD, streetServiceWarnings } from "@shared/world-engine/kernel/town/goods.js";
import { createTownWorld, type TownWorld } from "@shared/world-engine/kernel/town/town-world.js";
import {
  FOUNDING_AGE_DAYS, PLAZA_WELL, townPlanSteps, wellVergePoint, type TownHouse, type TownPlan,
} from "@shared/world-engine/kernel/town/plan.js";
import { WELL_FOUND_MASS, foundServicePoints } from "@shared/world-engine/kernel/town/districts.js";
import { buildTownQuestGame, type TownQuestBundle } from "@shared/world-engine/interaction/town/town-quests.js";
import { createTownStageSteps, type TownStage } from "@shared/world-engine/interaction/town/town-stage.js";
import { resolveWorkstationRegistry } from "@shared/world-engine/kernel/town/workstations.js";
import type { WorldArchitectureSpec } from "@shared/world-engine/culture.js";
import { TOWN_HOUSE_PALETTE } from "@shared/world-engine/interaction/dialogue/directions.js";
import {
  createTownDeltas, seedFoundingWorkshops, type FoundedBuilding, type SerializedTownDeltas, type TownDeltas,
} from "@shared/world-engine/kernel/town/construction.js";
import {
  resolveStructure,
  structureCosts,
  structureDisplayGlyph,
  type StructureSpec,
} from "@shared/world-engine/kernel/town/structures.js";
import {
  programOverridesOf,
  roomDisplayGlyph,
  structureProgramDisplayGlyph,
} from "@shared/world-engine/kernel/town/programs.js";
import { registerPlaceArt } from "@shared/glyph-place-art.js";
import { BLOCK_GLYPH } from "@shared/world-engine/products.js";
import { clothingFillDays, REAL_SCALE, serviceRadiusM, type WorldScale } from "@shared/world-engine/scale.js";

export interface TownPlayConfig {
  seed: number;
  /** Days the town has lived before the visit (default 220). */
  days?: number;
  /** Quest-giving residents (0..3; default 0 — no quests unless asked). */
  questCount?: number;
  /** THE BUILD-UP KNOB (storeys above ground under housing pressure) —
   *  capability × cost, the host's judgment. Default 0: a village
   *  spreads, it doesn't rise. */
  buildUp?: number;
  syntax?: "a" | "b" | "c";
  locale?: string;
  // ── The FOUNDING (optional — defaults are brookmill, the standalone
  //    village). A host descending from a map sets all three so the town
  //    is the SITE's town: charter from its substrate box, population from
  //    its crowd, key naming it. Plain numbers/strings — the payload stays
  //    the transport.
  /** The settlement key (street-plan identity + status lines). */
  key?: string;
  /** THE CONSTRUCTING SPECIES (creature registry id) — the town's residents'
   *  species, and the body its houses are BUILT FOR (doors, halls, furniture
   *  lanes all size to its speciesBodyRadius). Absent = the people default. */
  species?: string;
  /** The site's GROUND CHARACTER. The town build is terrain-blind (plan/
   *  stage/sim are plan-view 2D); the HOST maps this to a GroundSampler so
   *  the whole session is PLACED on real relief (engine ground seam).
   *  "hills" = synthetic rolling relief; "planet" = REAL planet terrain
   *  charted at a founding site (planet/walk-chart.ts). Default "flat". */
  terrain?: "flat" | "hills" | "planet";
  /** NEIGHBOR HAMLETS streamed into the same walking session (town-cluster:
   *  the window on the chart goes BEYOND one town). 0-4; default 0. Each
   *  neighbor is a full living town at a walkable offset. */
  cluster?: number;
  /** The site's endowment — what the substrate chartered. */
  charter?: { farmland: number; ore_access: number; timberland?: number };
  /** Founding population (primary species). */
  startPop?: number;
  /** DECLARED RESOURCES (city-founding): the supply box a spec hands the
   *  settlement — glyph → count, folded into the builder's-yard stock
   *  (deltas.stock) on a FRESH overlay. An age-0 town starts with exactly
   *  this (townStockSeed is houses-gated); an established town gets it on
   *  top of its usual yard seed. */
  stock?: Record<string, number>;
  /** WILDERNESS SURROUNDINGS (city-founding): scatter gatherable trees/rocks
   *  (and a few wild locals) over the town chart. A HOST flag — the build is
   *  untouched; quest-host seeds the scatter. Default: on for a founding-age
   *  town (days ≤ FOUNDING_AGE_DAYS), off for an established one. */
  wilderness?: boolean;
  /** A DEFINED FAMILY (the document's `entities.creatures`, town-interpreted):
   *  the focused household's hand-authored members. Mode "all" changes who is
   *  GENERATED (the other members never exist), so it lives in the config —
   *  replay rebuilds the same family. `house` absent = the roomiest house. */
  family?: TownFamily;
  /** Hand-authored items placed in the family house (`entities.objects`). */
  items?: TownDefinedItem[];
  /** CONSTRUCTION deltas to restore (construction v1): the serialized
   *  overlay of annexes / demolitions / placed furniture a previous
   *  session accrued. Same seed + same deltas ⇒ the identical mutated
   *  town — determinism stays the transport. */
  deltas?: SerializedTownDeltas;
  /** The BUILDABLE-STRUCTURE catalog override (①b) — a world doc that
   *  wants different structures swaps this list, nothing else (the same
   *  modding loop as the economy doc). Absent = TOWN_PLAY_STRUCTURES. */
  structures?: StructureSpec[];
  /** THE TRACKED-RESIDENT CAP (④ cohorts): souls simulated individually
   *  (named, full needs, dollhouse-visible). Households beyond it pool
   *  into per-district COHORTS (population.ts). Absent =
   *  TRACKED_RESIDENTS_DEFAULT; the tier is strictly dormant while the
   *  town fits under the cap. */
  trackedResidents?: number;
  /** THE NUMERAIRE override (E4 — nations P3): the commodity this town's
   *  quotes route through once its trade network is dense (money.ts).
   *  Must name a street good of the compiled economy (validated at
   *  build). Absent = the economy doc's own `numeraire` (TOWN_PLAY's is
   *  none — villages barter). */
  numeraire?: string;
  /** HOW THIS CULTURE BUILDS (game.culture.architecture): per-station
   *  placement overrides, resolved into the workstation registry the town
   *  furnishes from. Serializable (kind → { placement, room }); folded in at
   *  buildTownScope from the world's culture. Absent = the default placement. */
  architecture?: WorldArchitectureSpec;
  /** SPACE-TIME COMPRESSION (scale.ts, resolved): sizes the plan's SERVICE
   *  DISTRICTS — needs-aware construction founds market stalls on the
   *  hunger-cycle walk radius and wells on the thirst-cycle one, so a
   *  faster clock lays a denser town. Folded in at buildTownScope from the
   *  document's `game.scale`. Absent = the clock-blind legacy layout. */
  scale?: WorldScale;
}

export interface TownFamilyMember {
  /** Display name (debug panel, toasts). */
  name?: string;
  /** Species id (creature registry) — a frog_person aunt is legal. */
  species?: string;
  /** Outfit preset index (creatures/clothing.ts). */
  outfit?: number;
  /** Liked fruit kinds (dialogue preference + shelf choice). */
  likes?: string[];
}

/** A household PET — a family member of a non-person species. Its body is a
 *  `pet_<house>_<n>` avatar; behaviorally it runs the SAME need templates as
 *  everyone (one behavior model), with `grasp: false` capability — so it can't
 *  open the pantry, its hunger surfaces, and the family feeds its bowl through
 *  the general adoption rule. */
export interface TownFamilyPet {
  name?: string;
  /** Species id (creature registry) — default "quadruped". */
  species?: string;
  /** Liked fruit kinds. */
  likes?: string[];
}

export interface TownFamily {
  mode: "some" | "all";
  members: TownFamilyMember[];
  pets?: TownFamilyPet[];
  house?: number;
}

export interface TownDefinedItem {
  glyph: string;
  at: "table" | "box" | "floor";
}

/** The ONE roomiest-house policy — the focus resolver and the family builder
 *  must agree on where an index-less household lands. */
export function roomiestHouseIndex(houses: ReadonlyArray<{ index: number; w: number; h: number }>): number | null {
  let best: { index: number; area: number } | null = null;
  for (const h of houses) {
    const area = h.w * h.h;
    if (!best || area > best.area) best = { index: h.index, area };
  }
  return best ? best.index : null;
}

/** The bridge payload: the config plus its discriminant. */
export interface TownPlayPayload extends TownPlayConfig {
  engine: "town-play";
  engineVersion: 1;
}

export function isTownPlayPayload(v: unknown): v is TownPlayPayload {
  return (
    typeof v === "object" && v !== null &&
    (v as { engine?: unknown }).engine === "town-play" &&
    (v as { engineVersion?: unknown }).engineVersion === 1 &&
    typeof (v as { seed?: unknown }).seed === "number"
  );
}

/**
 * ⚖️ THE CALORIC ANCHOR — one person's daily draw of the STAPLE, and the
 * numeraire of every other household want in this document (the street layer
 * quotes each good's `perCapitaDaily` against it: food is 1 RATION by
 * definition). Byte-identical to the value it has always carried; F4 named it
 * so the derived rows below could point at something instead of restating a
 * literal.
 */
const FOOD_PER_PERSON_DAILY = 0.001;

/**
 * Garments a household WARDROBE holds — the one absolute in clothing's box, and
 * the reason `capDays` below is derived rather than typed.
 *
 * With demand grounded (a garment per person per `clothingFillDays`), the box
 * formula `HOUSEHOLD × capDays × perCapitaDaily` DEGENERATES if `capDays` stays
 * a hand-typed street-day count: at the shipped 20 it holds 5 × 20 × (1/180) ≈
 * 0.56 of an outfit — a wardrobe that cannot contain one garment. Inverting the
 * same formula for the box we want (`capDays = boxUnits × clothingFillDays ÷
 * HOUSEHOLD`) makes `boxCap` come out at EXACTLY `CLOTHING_BOX_UNITS` at any
 * metabolism, and leaves the pinned box/period algebra (goods.ts `shopPeriod`,
 * `pantryLevel`, `boxCap`) untouched — it is an INPUT that was re-derived, not
 * a formula that was edited.
 */
const CLOTHING_BOX_UNITS = 2;

/**
 * The symbol game's own village CONTENT: two goods whose vocabularies the
 * quest pools already speak (food → treats, cloth → clothing). Farms grow
 * the food (banked in the granary — the stockpile session deliveries
 * credit); the weaver clothes the town. Content, not machinery: a game
 * that wants a richer village swaps this doc, nothing else.
 *
 * ⚖️ A FUNCTION OF THE WORLD'S SCALE (F4), because two of its numbers are
 * DERIVED from a real anchor and the metabolic multiplier — and `scale` is not
 * in reach of a module-level const. `TOWN_PLAY_ECONOMY` below is this document
 * at the engine default (realism, metabolism 1), which is what every shipped
 * profile declares today (`DOLLHOUSE_SCALE.metabolism === 1`); the live founder
 * calls this with the session's own scale, so a world that eats faster also
 * wears out faster without a second seat to keep in step.
 */
export function townPlayEconomy(scale: WorldScale = REAL_SCALE): EconomyDoc {
  const wearDays = clothingFillDays(scale);
  return {
    stockpiles: [
      { key: "granary", max: 400, construction: true },
      // ⚖️ R&T ⑤ (T3b) — THE TOWN'S CLOTH STORE. Clothing had NOWHERE to bank:
      // `transport: {}` declares the convention scalars and nothing else, so a
      // landed import had no stockpile to credit and the books could not see the
      // lane at all. Not construction-gated (unlike the granary, whose contents
      // are also a build material): a town owns its cloth store from day one.
      { key: "drapery", max: 120 },
    ],
    commodities: [
      {
        // ⚖️ THE CALORIC ANCHOR — one ration a day, and the denominator every
        // other household want in this document is quoted against. Byte-
        // identical to the literal it replaces (0.001); it must stay so.
        key: "food", scalarMax: 200, perPersonDaily: FOOD_PER_PERSON_DAILY,
        transport: { drift: "granary", driftRequiresConstruction: true },
        street: {
          capDays: 3, shopSec: 18, cartRations: 25, unit: "rations", producers: ["farm"], market: true,
          stockColor: "#e0b25c", boxLabel: "Pantry", errandName: "shopping",
        },
      },
      {
        // PURE INTERMEDIATE: cloth is the TAILOR's raw material (the weaver's
        // cloth_out → tailor's clothing_out chain below), NOT something a
        // household consumes — only CLOTHING is worn. So it carries no
        // `perPersonDaily` demand and no `street` box, the documented
        // convention for intermediates (ore, planks, wool). `transport` stays
        // ONLY to declare its cloth_out/_need/_got convention scalars, which
        // the sew process reads. Previously the household `street` box made
        // every resident run a spurious provision:cloth errand ("I'm going to
        // get cloth") for a material nothing in the home ever uses.
        key: "cloth", scalarMax: 50,
        transport: {},
      },
      {
        // The wool chain's last link: the TAILOR sews the weaver's cloth into
        // CLOTHING (the sheep → wool → cloth → clothing → store flow). Households
        // stock a wardrobe of it; residents visibly wear it (outfit presets).
        // ⚖️ R&T ⑤ (T3b) — AND THE ONE GOOD THIS TOWN CAN IMPORT. The drapery
        // banks the tailor's surplus and, with `driftFeeds`, is EATEN by a
        // shortfall (the granary feedback: `fed = min(stock, shortage)`), so a
        // caravan that lands clothing in a town with no tailor relieves the
        // wardrobe the households actually open. Food's granary keeps the flag
        // OFF — flipping THAT is a town-wide pacing change (granary-feed.test.ts
        // pins the off-state), and the staple stays yard-bound this batch.
        // ⚖️ F4 — DEMAND GROUNDED (scale.ts `REAL_CLOTHING_DAYS`). USER LAW
        // (2026-08-09): *"people need new food a lot more than they need new
        // clothes … ground it in a roughly normal value … and assume that the
        // need scales at the metabolic multiplier."* One garment per person per
        // `clothingFillDays` against one ration per person per day, so the ratio
        // IS the anchor — 180:1 at metabolism 1, and 60:1 in a world that eats
        // three times a game-day, because wear is a metabolic process. The
        // number this replaces (a typed 0.0001, i.e. 10:1) was a guess, and the
        // street layer never even honoured that much.
        key: "clothing", scalarMax: 30, perPersonDaily: FOOD_PER_PERSON_DAILY / wearDays,
        transport: { drift: "drapery", driftFeeds: true },
        street: {
          // ⚖️ TWO PLACEMENT LAWS MAY NOT BE MIXED (economy arc, GL-feedback
          // round). A good sold ONLY at its producer's gate is placed by the
          // work's PRODUCTION CAP — a fraction of population, blind to distance
          // — while the market channel founds stalls on the SERVICE RADIUS ("a
          // district is a need cycle's walk across"). Seed 12's two tailors for
          // 199 households put the mean clothing walk at 539 m against food's
          // 96 m radius: a 693 s round trip, and the good-blind street-body
          // budget then let the long trip crowd food's walkers off the street
          // (32 clothing shoppers embodied against 9 for food — the reported
          // flood). Clothing therefore JOINS THE MARKET CHANNEL: the tailors
          // still sell at their gates, and the stalls the radius already founded
          // sell it too (sources 2 → 16, the trip ~693 s → ~114 s). The
          // invariant that catches the next one is `streetServiceWarnings`.
          // ⚖️ F4 — `capDays` IS DERIVED, not chosen. The box formula is a pinned
          // contract (`boxCap = HOUSEHOLD × capDays × perCapitaDaily`), so with the
          // demand grounded the only coherent way to hold `CLOTHING_BOX_UNITS`
          // garments is to invert it: `capDays = boxUnits × wearDays ÷ HOUSEHOLD`.
          // At metabolism 1 that is 2 × 180 ÷ 5 = 72 street days, and `boxCap`
          // comes out at exactly 2 outfits at ANY metabolism. The shipped 20 was
          // the last cadence lever anyone had while `perCapitaDaily` was hard-set
          // to 1; it is not one any more.
          capDays: (CLOTHING_BOX_UNITS * wearDays) / HOUSEHOLD,
          shopSec: 20, cartRations: 8, unit: "outfits", producers: ["tailor"], market: true,
          stockColor: "#c47ba0", boxLabel: "Wardrobe", errandName: "clothes",
        },
      },
    ],
    buildings: [
      {
        key: "farm", countScalar: "farms", cap: { by: "farmland", rate: 1 / 60 },
        processes: [
          { id: "farm", input: "farmland", output: "grain_out", efficiency: 0.08, capacityRate: 5 },
          { id: "mill", input: "grain_out", output: "food_out", efficiency: 1 },
        ],
        vars: [{ name: "grain_out", max: 200 }],
        construction: { tier: "base", costs: [{ stockpile: "granary", amount: 20 }] },
        sells: ["food"], leansToward: "fertility", mapCap: 8, district: "farm",
        style: { color: "#7d9c53", w: 18, h: 12 }, vignette: { w: 5, h: 4 },
        glyph: "🌾", title: "🌾 Farmstead", info: ["{farms} farms."],
      },
      {
        key: "weaver", countScalar: "weavers", cap: { by: "population", rate: 0.002 },
        processes: [{ id: "weave", input: "farmland", output: "cloth_out", efficiency: 0.001, capacityRate: 2 }],
        construction: { tier: "industry", costs: [{ stockpile: "granary", amount: 25 }] },
        sells: ["cloth"], shelved: true, leansToward: null, mapCap: 2, district: "craft",
        style: { color: "#8a7fae", w: 14, h: 10 }, vignette: { w: 4, h: 4 },
        glyph: "🧵", title: "🧵 Weaver", info: ["{weavers} weavers."],
      },
      {
        // Sews the weaver's cloth into clothing — a process whose INPUT is the
        // cloth commodity's own site var, so the chain is real in the aggregate:
        // more cloth ⇒ more clothing; a starving weaver starves the tailor.
        key: "tailor", countScalar: "tailors", cap: { by: "population", rate: 0.0015 },
        processes: [{ id: "sew", input: "cloth_out", output: "clothing_out", efficiency: 0.5, capacityRate: 1 }],
        construction: { tier: "industry", costs: [{ stockpile: "granary", amount: 20 }] },
        sells: ["clothing"], shelved: true, leansToward: null, mapCap: 2, district: "craft",
        style: { color: "#a06a8a", w: 12, h: 10 }, vignette: { w: 4, h: 3 },
        glyph: "👕", title: "👕 Tailor", info: ["{tailors} tailors."],
      },
    ],
  };
}

/** The shipped document at the ENGINE DEFAULT (realism, metabolism 1) — the
 *  name every pre-F4 reader already imports, and the only reading that differs
 *  from `townPlayEconomy(scale)` is in a world that declares a metabolism.
 *  Evaluated once; `townPlayEconomy` builds a fresh object per call, so a
 *  caller may not mutate this one and expect the founder to agree. */
export const TOWN_PLAY_ECONOMY: EconomyDoc = townPlayEconomy();

/**
 * The DEFAULT BUILDABLE-STRUCTURE CATALOG (①b) — world content beside
 * TOWN_PLAY_ECONOMY, one row per structure a spoken "build <x>" can raise.
 * Each row UNIFIES the two half-catalogs: `economy` references its
 * BuildingDef (produces/consumes/cap/district) by key; `program` is its
 * interior half (rooms.ts buildingRoomPlan). Costs are wood/stone — the
 * wilderness gathering stacks (founding.ts SITE_MATERIAL_GLYPHS), so the
 * frontier loop (gather → found → build) closes. A game that wants a
 * richer catalog swaps `TownPlayConfig.structures`, nothing else.
 */
export const TOWN_PLAY_STRUCTURES: StructureSpec[] = [
  {
    // `symbol` on the next three rows: "house" / "farm" / "market" are WORDS
    // the glyph lexicon has no picture for, so each names the symbol that
    // stands for it — the family, the crop, the coin. Without them the plate
    // framed a ❓.
    //
    // `family` and not `home`: a plate around a house icon says the word twice
    // and the thing once — what makes a building a dwelling is who lives in it.
    // Mirrors DEFAULT_STRUCTURE_PROGRAMS' house row.
    type: "house", glyph: "house", label: "house", role: "house",
    frame: "building", symbol: "family",
    footprint: { w: 9, d: 8 },
    program: { sleepCells: 2, wet: true, kitchen: true },
    jobs: 0, costs: {}, buildDays: 1, color: "#a8875f", default: true,
  },
  {
    type: "farm", glyph: "farm", label: "farm", role: "work",
    frame: "building", symbol: "grain",
    footprint: { w: 18, d: 12 },
    program: { store: true }, economy: "farm",
    jobs: 2, costs: {}, buildDays: 2, color: "#7d9c53", default: true,
  },
  {
    type: "market", glyph: "market", label: "market", role: "work",
    frame: "building", symbol: "money",
    footprint: { w: 14, d: 10 },
    program: {}, // an open hall — the stalls ARE the floor
    jobs: 2, costs: {}, buildDays: 2, color: "#c9803a", default: true,
  },
  {
    // The CARPENTRY rename (phase 3, decision 3): `type`/`glyph` stay
    // "workshop" (save + speech identity), the LABEL wears the trade —
    // resolveStructure matches labels too, so "build carpentry" works.
    // Phase 5 finally splits the masonry off it (the next row); metalworking
    // still waits.
    type: "workshop", glyph: "workshop", label: "carpentry", role: "work",
    frame: "building", symbol: "workbench",
    footprint: { w: 10, d: 8 },
    program: { store: true },
    jobs: 2, costs: {}, buildDays: 1.5, color: "#8a7fae", default: true,
  },
  {
    // THE MASONRY (construction phase 5) — the carpentry's twin, and the row
    // that finishes the block chain. Stone has always refined into blocks
    // (products.ts), but until now it did so at a CARPENTER's bench, because
    // the carpentry was the only work type `refineSpotOf` knew. The catalogue
    // says where each raw belongs (`refinesTo.at`); this is the building that
    // claim finally points at.
    //
    // Named the way the carpentry is: the `type`/`glyph` is the PLACE
    // ("masonry" — what the town has, and the word a hauler's intent line
    // speaks), the `label` is the BENCH ("stonecutter"), so both "build
    // masonry" and "build stonecutter" reach this row through
    // resolveStructure's type → glyph → label ladder. The icon frames the
    // bench for the place-making reason below: `building(stonecutter)` draws,
    // where `building(masonry)` would frame a ❓.
    //
    // Wider than the smithy at the same depth, mirroring CLUSTERS.masonry: a
    // mason needs a STOCK LANE (rough stone waiting, cut block stacked) that
    // a smith working at one anvil never did. `store: true` for the same
    // reason — the stock band is the point, not an afterthought.
    //
    // `default: true`: a town that cannot raise this one is a town whose
    // stone keeps routing to the carpenter's bench, which is the very thing
    // the split exists to end.
    type: "masonry", glyph: "masonry", label: "stonecutter", role: "work",
    frame: "building", symbol: "stonecutter",
    footprint: { w: 12, d: 9 },
    program: { store: true }, stations: ["stonecutter"],
    jobs: 2, costs: {}, buildDays: 1.5, color: "#9a968f", default: true,
  },
  // ── THE PLACE-MAKING BUILDINGS ──────────────────────────────────────
  // Each is one row: a footprint, a program, and the STATION that makes it
  // what it is (`stations` — the seam workExtraStationDefs already served,
  // now with fixtures to put through it). The room its fixture stands in
  // derives the room kind, and the room derives the building's character, so
  // "a building with an anvil in it" and "a smithy" are the same fact
  // reached from either direction. The MASONRY above is one of these too —
  // it is filed beside the carpentry instead because what it is FOR is the
  // refinement split, and a reader looking for the other half of that split
  // should find it in the next row, not four rows down.
  //
  // Not `default: true` on all four: the SMITHY and the WEAVER ride the
  // existing craft economy and ship, while the TEMPLE and the LIBRARY are
  // civic buildings with no economic half yet (no `economy` key, no goods
  // flow) — they are catalog rows a world doc can unlock, which is what
  // `default: false` means.
  {
    type: "smithy", glyph: "smithy", label: "smithy", role: "work",
    frame: "building", symbol: "anvil",
    footprint: { w: 11, d: 9 },
    program: { store: true }, stations: ["anvil"],
    jobs: 2, costs: {}, buildDays: 2, color: "#6f6b66", default: true,
  },
  {
    type: "weaver", glyph: "weaver", label: "weaver", role: "work",
    frame: "building", symbol: "loom",
    footprint: { w: 10, d: 9 },
    program: { store: true }, stations: ["loom"],
    jobs: 2, costs: {}, buildDays: 1.5, color: "#a97fa2", default: true,
  },
  {
    // `book`, not the `shelf` station: the shelf derives the STUDY room inside,
    // but the building is one of books. Mirrors the library structure program.
    type: "library", glyph: "library", label: "library", role: "work",
    frame: "building", symbol: "book",
    footprint: { w: 12, d: 10 },
    program: {}, stations: ["shelf"], // an open reading hall
    jobs: 1, costs: {}, buildDays: 2, color: "#7f93ae", default: false,
  },
  {
    type: "temple", glyph: "temple", label: "temple", role: "work",
    frame: "building", symbol: "altar",
    footprint: { w: 13, d: 11 },
    program: {}, stations: ["altar"], // the hall IS the room
    jobs: 1, costs: {}, buildDays: 3, color: "#c8bfa4", default: false,
  },
  {
    // THE EMPTY SHELL (pipeline ⑤b): a building with NO role — completes
    // as a bare doored box (open interior, nothing furnished, no staff,
    // no books). Rooms are added by interior subdivision; what it IS is
    // derived from what ends up inside (programs.ts buildingKindOf).
    type: "building", glyph: "building", label: "building", role: "work",
    footprint: { w: 10, d: 9 },
    program: {}, shell: true,
    jobs: 0, costs: {}, buildDays: 1, color: "#9b8a6d", default: true,
  },
  {
    // THE STOREHOUSE (phase 3): the town's raw-material bank — a store
    // program whose communal crates hold the chain's stock (felled wood,
    // milled blocks). The par-stock logging loop keeps it fed, refine
    // commits land their blocks here first, and construction hauls draw
    // from it like any other communal container. No staff: a storehouse
    // is shelving, not a trade.
    type: "storehouse", glyph: "storehouse", label: "storehouse", role: "work",
    frame: "building", symbol: "box",
    footprint: { w: 10, d: 8 },
    program: { store: true },
    jobs: 0, costs: {}, buildDays: 1.5, color: "#8d7f63", default: true,
  },
];

/** The founding STOCK an established town keeps on hand (the builder's
 *  yard) — seeded once on a fresh overlay so a town-scope "build" has a
 *  town stock to draw on. A founded site brings its own gathered stock. */
export function townStockSeed(houses: number): Record<string, number> {
  if (houses <= 0) return {};
  // Phase 3 mix: milled blocks for immediate building (an established
  // town has built before) plus raws so the refine loop has something to
  // draw the day the blocks run out.
  //
  // SIZED IN BUILDINGS (phase 6), not in units: bills are derived from
  // footprints now (block-bill.ts — a cottage is 120 blocks), and the flat
  // 10–30 this used to seed stopped being a yard and became a rounding error
  // the day that landed. One dwelling's worth of milled block on hand, and the
  // raws to mill a second, growing slowly with the town — an established town
  // can start ONE building today and has the timber for the next.
  const dwelling = structureCosts(
    TOWN_PLAY_STRUCTURES.find((s) => s.type === "house") ?? { costs: {}, footprint: { w: 9, d: 8 } },
  )[BLOCK_GLYPH] ?? 1;
  const growth = 1 + Math.min(1, houses / 24); // 1× at a hamlet → 2× at a town
  return {
    "block.material_wood": Math.round(dwelling * growth),
    wood: Math.round(dwelling * growth * 2), // the 2:1 mill — a second building's worth
    stone: Math.round(dwelling * growth),
  };
}

/**
 * Materialize the FOUNDED BUILDINGS (①b construction deltas) into the built
 * plan: each becomes a TownWork row (geometry EXACTLY from its delta; the
 * interior program + roster jobs decorated from its StructureSpec), appended
 * after the base works so base indices never shift. Radius grows to cover
 * the lots (the manifold must hold them). An unknown type (a catalog swap
 * after founding) keeps the building standing with the generic program —
 * loudly, never silently (the ORDER path refuses unknown names up front).
 *
 * MOVE-IN (④): a house-role founding whose HOUSEHOLD fact is written
 * (population.ts moveInStep → admitHousehold) materializes as a REAL
 * plan.houses row instead — appended after the base houses in founding
 * order, so base indices never shift and rebuilds deal the same indices
 * forever. An empty founded house (no household yet) stays a work row,
 * exactly the ①b behavior.
 */
/** The plan.houses row a HOUSEHOLDED founded house materializes as — ONE
 *  shape shared by the rebuild path (applyFoundedBuildings) and the host's
 *  live conversion, so both deal identical rows. Geometry EXACTLY from the
 *  delta; index appends at the tail (base indices never shift). */
export function foundedHouseRow(
  plan: Pick<TownPlan, "houses">,
  b: FoundedBuilding,
  spec: StructureSpec,
): TownHouse {
  return {
    // Max+1, not length: stall conversions leave gaps in the base index
    // sequence, and a resident id (`resident_<index>_<m>`) must never
    // collide with a standing household's.
    index: plan.houses.reduce((m, h) => Math.max(m, h.index + 1), 0),
    dx: b.dx,
    dy: b.dy,
    w: b.w,
    h: b.h,
    door: b.door,
    color: spec.color,
    floors: 1,
    slot: b.slot,
  };
}

export function applyFoundedBuildings(
  plan: TownPlan,
  founded: readonly FoundedBuilding[],
  catalog: ReadonlyArray<StructureSpec>,
): void {
  for (const b of founded) {
    const spec = resolveStructure(catalog, b.type);
    if (!spec) {
      // eslint-disable-next-line no-console
      console.warn(`applyFoundedBuildings: no StructureSpec for founded "${b.type}" — generic interior`);
    }
    if (b.household && spec?.role === "house") {
      plan.houses.push(foundedHouseRow(plan, b, spec));
      const hr = Math.hypot(b.dx + b.w / 2, b.dy + b.h / 2) + Math.max(b.w, b.h) / 2 + 18;
      if (hr > plan.radius) plan.radius = hr;
      continue;
    }
    plan.works.push({
      type: b.type,
      dx: b.dx, dy: b.dy, w: b.w, h: b.h, door: b.door,
      color: spec?.color ?? "#9b8a6d",
      program: spec?.program ?? { store: true },
      ...(spec?.stations ? { stations: spec.stations } : {}),
      ...(spec?.shell ? { bare: true } : {}),
      // Staff only a COMPLETED building (the host writes `completed` and
      // re-decorates jobs when construction finishes live).
      jobs: b.completed ? (spec?.jobs ?? 0) : 0,
      foundedOrd: b.ord,
    });
    const rr = Math.hypot(b.dx + b.w / 2, b.dy + b.h / 2) + Math.max(b.w, b.h) / 2 + 18;
    if (rr > plan.radius) plan.radius = rr;
  }
}

const TOWN_KEY = "brookmill";
const CHARTER = { farmland: 420, ore_access: 0 };
const START_POP = 120;

export interface TownPlay {
  /** The config this session rebuilds from (replay = build again). */
  config: TownPlayConfig;
  town: TownWorld;
  eco: CompiledEconomy;
  plan: TownPlan;
  bundle: TownQuestBundle;
  stage: TownStage;
  /** THE CONSTRUCTION OVERLAY (construction v1) — the one mutable
   *  geometry store this session owns. The generators consume it as
   *  input, the stage watches its version, and the session serializes
   *  `deltas.toJSON()` alongside its stacks. */
  deltas: TownDeltas;
  /** The session's BUILDABLE-STRUCTURE catalog (config override or the
   *  default set) — what a spoken "build <x>" resolves against. */
  structures: StructureSpec[];
  /** Where the DEFINED FAMILY lives (config.family resolved against the built
   *  plan — the roomiest house when the config names none). Null = no family. */
  familyHouse: number | null;
}

/** Resolve the family house + the residents a mode-"all" family EXCLUDES from
 *  generation (members beyond the hand-authored ones never exist). */
function familyPlan(config: TownPlayConfig, plan: TownPlan): { house: number | null; excluded: string[] } {
  if (!config.family) return { house: null, excluded: [] };
  const house = config.family.house ?? roomiestHouseIndex(plan.houses);
  if (house === null) return { house: null, excluded: [] };
  const excluded: string[] = [];
  if (config.family.mode === "all") {
    for (let m = config.family.members.length; m < HOUSEHOLD; m++) {
      excluded.push(`resident_${house}_${m}`);
    }
  }
  return { house, excluded };
}

/**
 * `buildTownPlay`, staged: the identical pipeline with an `onStage` await
 * between the expensive steps (and the day-stepping in slices), so a live
 * host can found a town WHILE its frames keep drawing — the approach-load
 * story: a city's town builds as the ship flies in, not as a freeze when
 * the player presses Enter. Same config ⇒ byte-identical result to
 * `buildTownPlay` (the sync builder below is the spec; keep them in step).
 */
export async function buildTownPlayStaged(
  config: TownPlayConfig,
  onStage: (note: string) => void | Promise<void>,
): Promise<TownPlay> {
  const gen = buildTownPlaySteps(config);
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
    await onStage(r.value);
  }
}

/** Build the live session a config describes. Deterministic end to end. */
export function buildTownPlay(config: TownPlayConfig): TownPlay {
  const gen = buildTownPlaySteps(config);
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
  }
}

/**
 * THE ONE FOUNDING PATH — a generator yielding a progress note before each
 * chunk of work. `buildTownPlay` drains it synchronously; `buildTownPlayStaged`
 * awaits between chunks. One implementation, so the two CANNOT drift (the old
 * pair of hand-kept twins is gone), and the chunks are FINE-GRAINED: day
 * slices, house batches (townPlanSteps), goods/residents/furniture batches
 * (createTownStageSteps) — each small enough that a live host never blocks a
 * frame on founding.
 */
export function* buildTownPlaySteps(config: TownPlayConfig): Generator<string, TownPlay> {
  // ⚖️ F4 — THE DOCUMENT IS READ AT THIS WORLD'S SCALE. Clothing's demand and
  // box are derived from `REAL_CLOTHING_DAYS ÷ metabolism`, and a module-level
  // const cannot see a session's scale; this is the first seat that can. A
  // config with no scale (the clock-blind legacy layout) reads the engine
  // default, which is byte-identical to `TOWN_PLAY_ECONOMY`.
  const compiled = compileEconomy([townPlayEconomy(config.scale ?? REAL_SCALE)], { construction: true });
  // E4 numeraire override: config wins over the doc; a medium naming no
  // street good fails at build, named (never a silent barter-forever).
  if (config.numeraire && !compiled.goods.some((g) => g.key === config.numeraire)) {
    throw new Error(
      `town-play: numeraire "${config.numeraire}" is not a street good (have: ${compiled.goods.map((g) => g.key).join(", ")})`,
    );
  }
  const eco: CompiledEconomy = config.numeraire ? { ...compiled, numeraire: config.numeraire } : compiled;
  const key = config.key ?? TOWN_KEY;
  const startPop = config.startPop ?? START_POP;
  const structures = config.structures ?? TOWN_PLAY_STRUCTURES;
  // THE PLACE ART THIS SESSION DRAWS WITH (shared/glyph-place-art.ts). A room or
  // a building is ONE symbol — the shell plate plus the fixture that names it —
  // and the word is what travels: `structureDoneLine(spec.glyph)` speaks
  // "smithy", a board button carries "bedroom". The static table covers the
  // DEFAULT culture; these two lists are what it cannot know, so they register
  // themselves from their own specs (never re-authored here):
  //   - a swapped catalogue (`TownPlayConfig.structures`) — its `farm`;
  //   - culture-authored programs — the same bath program is a bathROOM in a
  //     house and a bathHOUSE in a town that bathes together, which is the
  //     `frame` and nothing else.
  // Rooms register before buildings so a word that names both (`workshop`,
  // `masonry`) draws the BUILDING — `placeBuilderNouns`' buildings-first rule.
  const authoredPrograms = programOverridesOf(config.architecture);
  for (const r of authoredPrograms.rooms ?? []) {
    registerPlaceArt(r.word ?? r.kind, roomDisplayGlyph(r));
  }
  for (const b of authoredPrograms.buildings ?? []) {
    registerPlaceArt(b.word ?? b.type, structureProgramDisplayGlyph(b));
  }
  for (const s of structures) registerPlaceArt(s.glyph, structureDisplayGlyph(s));
  // Age 0 is legal (city-founding): a `days: 0` town is founded TODAY — the
  // fast-forward loop simply never runs and the clock starts at day 0.
  const days = Math.max(0, Math.min(5000, Math.floor(config.days ?? 220)));
  yield "chartering";
  const town = createTownWorld({
    economy: eco,
    charter: config.charter ?? CHARTER,
    startPop,
    // The founding farm (villageSeed's shape) — but a ZERO-POP founded site
    // starts with NO buildings at all (①b zero-building growth), and a
    // FOUNDING-AGE town (city-founding) hasn't built one yet either: its
    // farms are the ones its settlers raise through founded deltas.
    seedScalars: { farms: startPop > 0 && days > FOUNDING_AGE_DAYS ? 1 : 0 },
    key,
  });
  // Slicing the fast-forward is exactly equivalent to one big step (the
  // byte-identical test pins it) — 15-day slices keep each under a frame.
  const SLICE = 15;
  for (let d = 0; d < days; d += SLICE) {
    town.step(Math.min(SLICE, days - d));
    yield `day ${town.day}`;
  }
  yield "laying streets";
  // The construction overlay is created BEFORE the plan (①b): founded
  // buildings are generator INPUT — the street tree covers their slots and
  // base houses skip them. Restored from the config's serialized deltas
  // when a previous session accrued any.
  const deltas = createTownDeltas(config.deltas);
  // A restored session's street clock starts at 0 — an UNFINISHED build
  // restarts its remaining time from now (only the serialized `completed`
  // fact survives reboots; a build never waits on a clock that's gone).
  for (const b of deltas.founded()) {
    if (!b.completed && b.startedDay > 0) b.startedDay = 0;
  }
  // The transfer LEDGER resumes on the new clock the same way: a mid-haul
  // row's executor body is gone (back to pending — the load it carried is
  // serialized and a new hauler picks it up), and a standing leg's due time
  // belonged to the dead clock (due now — the route visibly resumes on the
  // first sweep instead of waiting out a phantom interval).
  for (const a of deltas.transfers.active()) {
    if (a.status === "moving") {
      a.status = "pending";
      delete a.executor;
    }
    if (a.mode === "scheduled") a.nextDueAt = 0;
  }
  // Distinct, nameable house colours so residents can point you to "the blue
  // house" (and the wall the player sees matches what they're told).
  const plan = yield* townPlanSteps(
    town, eco, key, config.seed, config.buildUp ?? 0, TOWN_HOUSE_PALETTE,
    deltas.founded().map((b) => b.slot),
    config.species,
    days,
    config.scale,
  );
  // Founded buildings materialize as work rows (geometry exactly from the
  // deltas; program/jobs from the structure catalog).
  applyFoundedBuildings(plan, deltas.founded(), structures);
  // FOUNDED HOUSEHOLDS get their service wells too (needs-aware districts):
  // move-ins joined plan.houses above, so the thirst pass runs once more
  // over the full set, anchored on the wells already laid — base wells stay
  // prefix-stable, founded quarters append theirs. The live session digs
  // the same wells at move-in (quest-host); this is the rebuild's half.
  if (config.scale && plan.wells) {
    const more = foundServicePoints(plan.houses, [PLAZA_WELL, ...plan.wells], plan.streets, {
      convenientM: serviceRadiusM(config.scale, "thirst"),
      foundMass: WELL_FOUND_MASS,
    });
    for (const h of more) plan.wells.push(wellVergePoint(h));
  }
  // FOUNDED PRODUCERS JOIN THE BOOKS (city-founding): a COMPLETED founded
  // building with an economy row raises its count scalar, exactly as live
  // completion injects it (quest-host stepFoundedConstruction) — a reloaded
  // farm keeps making food. AFTER the plan: the base layout must stay blind
  // to founded counts (the founded row IS the building; a pre-plan inject
  // doubled it with a phantom base farm).
  for (const b of deltas.founded()) {
    if (!b.completed) continue;
    const spec = resolveStructure(structures, b.type);
    const work = spec?.economy ? eco.works.find((w) => w.key === spec.economy) : null;
    if (work) town.inject(work.countScalar, 1);
  }
  // ⚖️ R&T ⑤ (T3b) — AND SO DOES WHAT THE CARAVANS ALREADY LANDED. The town
  // world steps ONLY in the fast-forward above; a live session's import
  // credits are therefore injections into a world that never steps again, and
  // they would vanish with it. The bank is the durable half: replayed HERE,
  // after the fast-forward and the plan, so a reloaded town's books still show
  // the cloth its partner sent. Same shape, same place, same reason as the
  // founded producers directly above.
  for (const [scalar, units] of Object.entries(deltas.driftBank)) {
    if (units > 0) town.inject(scalar, units);
  }
  yield "meeting residents";
  const bundle = buildTownQuestGame(town, eco, plan, key, {
    seed: config.seed,
    questCount: config.questCount,
    ...(config.syntax ? { syntax: config.syntax } : {}),
    ...(config.locale ? { locale: config.locale } : {}),
  });
  yield "raising the town";
  // The goal-tree player embodies the cast itself (npc_{nodeId} bodies at
  // the cast anchors), so the stage ships without spec-time cast NPCs.
  const fam = familyPlan(config, plan);
  // A FRESH overlay founds the town's OPTIONAL ROOMS (a deterministic
  // minority of houses raise a carpenter's workshop annex — construction
  // v1) and its BUILDER'S-YARD stock (①b: the town stock a "build" order
  // spends); a restored one already carries them.
  if (!config.deltas) {
    seedFoundingWorkshops({ x: plan.radius + 40, y: plan.radius + 40 }, plan, deltas, config.seed);
    Object.assign(deltas.stock, townStockSeed(plan.houses.length));
    // DECLARED RESOURCES (city-founding): the spec's supply box, folded into
    // the yard. An age-0 town has no houses, so this IS its whole stock.
    for (const [glyph, n] of Object.entries(config.stock ?? {})) {
      if (n > 0) deltas.stock[glyph] = (deltas.stock[glyph] ?? 0) + Math.floor(n);
    }
  }
  // A DEFINED family member's own species overrides the town's for its BODY
  // (the frog_person aunt walks and plans at her own girth).
  const famSpecies = (npcId: string): string | undefined => {
    const f = config.family;
    if (!f || fam.house === null) return undefined;
    const m = npcId.match(/^resident_(\d+)_(\d+)$/);
    if (m && Number(m[1]) === fam.house) return f.members[Number(m[2])]?.species;
    return undefined;
  };
  // How this culture BUILDS (game.culture.architecture) — the workstation
  // registry the town furnishes from (default placement when unset).
  const workstations = resolveWorkstationRegistry(config.architecture?.workstations);
  const stage = yield* createTownStageSteps(town, eco, plan, bundle, {
    seed: config.seed,
    castNpcs: false,
    deltas,
    registry: workstations,
    // The catalog a construction site names itself from (⑦ site icons).
    structures,
    // Real-planet terrain ⇒ the planet is the reference frame: the town rect
    // is content, not walls (bodies/followers may leave town). Synthetic
    // ground ("flat"/"hills") has no world beyond the rect, so it stays bounded.
    onPlanet: config.terrain === "planet",
    residentSpecies: famSpecies,
    ...(fam.excluded.length ? { excludedResidents: fam.excluded } : {}),
  });
  // ⚖️ THE SERVICE-RADIUS INVARIANT, said out loud (goods.ts
  // `streetServiceWarnings`, the scaleWarnings doctrine): a street good whose
  // households out-walk the radius its stalls would be founded on is mixing
  // two placement laws, and the flood that follows is invisible until somebody
  // counts walkers. Never a throw — the world is legal, and the sentence is
  // the whole point. Measured against the SAME radius the plan sites stalls on.
  if (config.scale) {
    for (const w of streetServiceWarnings(
      stage.goods,
      plan.houses,
      serviceRadiusM(config.scale, "hunger"),
    )) {
      console.warn(`[town] service radius — ${w}`);
    }
  }
  return { config, town, eco, plan, bundle, stage, deltas, structures, familyHouse: fam.house };
}
