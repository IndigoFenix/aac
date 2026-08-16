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
// registry (products.ts killStockOf + harvestStockOf) — the same definition
// the abstract economy reads, never a name-keyed table here. Harvest stock
// REGROWS on the standing source (dueHarvestRegrowth, a pure calculator the
// host applies); emptying the kill stock fells the source — UNLESS the
// species declares a `growth` clock (S&D S3 H2), in which case felling
// RE-SEEDS it as a sapling instead of removing it (dueGrowthAdvance, the
// same pure-calculator/host-applies shape). Pure data — the quest host
// embodies it (seedWilderness); headless-tested in
// server/tests/symbol-game-wilderness.test.ts.

import {
  growthClassYield, harvestProductsOf, harvestStockOf, killStockOf, naturalSourceOf, orchardPlants,
  type GrowthSizeClass,
} from "../../products.js";
import { bioYearsGameDays, type WorldScale } from "../../scale.js";

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
}

export interface WildernessCreature {
  /** Creature id (`wild_<n>`, product animals `wild_<species>_<n>`) — the
   *  body is `npc_wild_<n>`, or wildAnimalBodyId() for a product animal. */
  id: string;
  /** Emoji face — doubles as the species pick (animal-person models).
   *  Empty for product animals (their body comes from `species`). */
  icon: string;
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
export function wildFeatureEmbodied(f: WildernessFeature): boolean {
  const src = naturalSourceOf(f.species);
  return src?.kind === "plant" && src.bodyHeightM !== undefined;
}
/** The container-map key a feature's stock lives under: its body id when
 *  embodied, its own id as a placeholder box. */
export function wildFeatureContainerId(f: WildernessFeature): string {
  return wildFeatureEmbodied(f) ? wildFloraBodyId(f) : f.id;
}

/** How small a fully-quarried feature gets, as a fraction of its declared
 *  radius. NOT zero: the last unit has to stay visible and dwellable — the
 *  source's removal is the felling rule's job (sourceKillExhausted), never a
 *  shrink to nothing. */
const SPENT_FEATURE_SCALE = 0.4;

/** THE DRAWN SIZE of a standing feature's body, metres: the source's declared
 *  `feature.radiusM` at full kill stock, shrinking toward a pebble as the
 *  stock is quarried out of it.
 *
 *  DEPLETION HAS TO BE VISIBLE. A rock with one stone left and a rock with
 *  four are the same object to the container path, so if they are also the
 *  same size on the ground the player has no way to read which is nearly
 *  spent — the whole quarry act becomes invisible until the outcrop suddenly
 *  vanishes. Size is measured against the SPECIES' maximum roll rather than
 *  against this feature's own initial roll, so "one stone left" looks the
 *  same whether it rolled that small or was cut down to it: size means
 *  REMAINING UNITS, always, and an outcrop worth one stone reads as a pebble
 *  wherever it came from.
 *
 *  PURE — no rng, no clock (same species + same stock ⇒ same radius), which
 *  is exactly what lets the spawner and the take path both call it and agree
 *  on one answer. Kill-less sources never shrink: a bush picked clean is
 *  still a whole bush. */
export function wildFeatureRadius(
  species: string,
  stock: Record<string, number> | undefined,
): number {
  const src = naturalSourceOf(species);
  const base = src?.feature?.radiusM ?? 0.6;
  const kill = (src?.products ?? []).filter((p) => p.method === "kill");
  if (!kill.length) return base;
  const max = kill.reduce((n, p) => n + p.yield.max, 0);
  if (max <= 0) return base;
  const left = kill.reduce((n, p) => n + (stock?.[p.glyph] ?? 0), 0);
  const frac = Math.max(0, Math.min(1, left / max));
  return base * (SPENT_FEATURE_SCALE + (1 - SPENT_FEATURE_SCALE) * frac);
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
  count: number;
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
): WildMixEntry[] {
  const scaled = (count: number): number => count;
  const orchard = orchardPlants();
  const fruit: WildMixEntry[] = orchard.length
    ? [{ species: orchard[(seed >>> 3) % orchard.length]!.species, count: scaled(2) }]
    : [];
  return biome === "mining"
    ? [{ species: "oak", count: scaled(8) }, ...fruit, { species: "rock", count: scaled(10) }]
    : [
        { species: "oak", count: scaled(8) },
        ...fruit,
        { species: "rock", count: scaled(4) },
        { species: "sheep", count: scaled(2) },
        { species: "cow", count: scaled(1) },
      ];
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
  /** Keep-clear disc override (city-founding: a town session scatters AROUND
   *  its plaza/site, not through it). Default: the centre spawn clearing. */
  clearAt?: { x: number; y: number };
  clearR?: number;
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

/** The possessable locals — icons the puzzle-character factory maps to real
 *  animal-person creature bodies (quest-host ANIMAL_SPECIES_BY_ICON). */
const CREATURE_ICONS = ["🐰", "🐻", "🐸", "🐶"] as const;

/** A feature record for one natural source: kill products rolled into the
 *  stock (the tree IS its wood), harvest products rolled as the standing
 *  bearing AND its capacity ceiling. Deterministic — killStockOf rolls
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
  const kill = killStockOf(species, rng, conversionDial);
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
    if (p.method !== "kill") continue;
    stock[p.glyph] = growthClassYield(p, g.classes[cls]!.yieldMul, conversionDial);
  }
  return { sizeClass: cls, stock, growAt: cls < g.classes.length - 1 ? at : undefined };
}

/** RE-SEED STATE (S3 H2's felling replacement): a freshly-felled
 *  growth-bearing feature's sapling stock (class 0) — PURE, the host arms
 *  `growAt` and writes the live containerStock (quest-host `fellIfConsumed`).
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
    if (p.method !== "kill") continue;
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
  const clearR = Math.max(0, params.clearR ?? 6); // keep the clearing open
  // ⚖️ S3 review: abundance is DIAL-FREE — params.conversionDial is an
  // inert seat (see ScatterOpts); the one-application law lives at
  // effectiveInPerOut / storehouseRawParAt / farmAcresPerPerson.
  const dial = 1;

  const place = (): { x: number; y: number } => {
    for (let tries = 0; tries < 12; tries++) {
      const x = 8 + rng() * (side - 16);
      const y = 8 + rng() * (side - 16);
      if (Math.hypot(x - clearAt.x, y - clearAt.y) < clearR) continue;
      return { x, y };
    }
    return { x: 8, y: 8 };
  };

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
  for (const m of mix) {
    const isAnimal = naturalSourceOf(m.species)?.kind === "animal";
    for (let i = 0; i < Math.max(0, m.count); i++) {
      if (!isAnimal) {
        features.push(makeFeature(`wild:${m.species}_${i}`, m.species, place(), rng, dial));
        continue;
      }
      const p = place();
      const kill = killStockOf(m.species, rng, dial);
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

  const nCreatures = Math.max(0, params.creatures ?? 3);
  for (let i = 0; i < nCreatures; i++) {
    const p = place();
    creatures.push({
      id: `wild_${i}`,
      icon: CREATURE_ICONS[Math.floor(rng() * CREATURE_ICONS.length)]!,
      x: p.x,
      y: p.y,
    });
  }

  return { side, seed: params.seed, spawn, features, creatures };
}
