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
// host applies); kill stock never does — emptying it fells the source. Pure data — the quest host
// embodies it (seedWilderness); headless-tested in
// server/tests/symbol-game-wilderness.test.ts.

import { harvestProductsOf, harvestStockOf, killStockOf, naturalSourceOf } from "../../products.js";

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

export interface WildernessContent {
  /** The square manifold side, metres. */
  side: number;
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
 *  so legacy oak/rock scatters stay byte-identical). */
function makeFeature(id: string, species: string, p: { x: number; y: number }, rng: () => number): WildernessFeature {
  const kill = killStockOf(species, rng);
  const cap = harvestStockOf(species, rng);
  const f: WildernessFeature = { id, species, x: p.x, y: p.y, stock: { ...kill, ...cap } };
  if (Object.keys(cap).length) f.harvestCap = cap;
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

/** Build the wilderness scatter for a seed. Same seed ⇒ identical content. */
export function buildWilderness(params: WildernessParams): WildernessContent {
  const side = Math.max(60, params.side ?? 240);
  const rng = mulberry(params.seed);
  const spawn = { x: side / 2, y: side / 2 };
  const clearAt = params.clearAt ?? spawn;
  const clearR = Math.max(0, params.clearR ?? 6); // keep the clearing open

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
        features.push(makeFeature(`wild:${m.species}_${i}`, m.species, place(), rng));
        continue;
      }
      const p = place();
      const kill = killStockOf(m.species, rng);
      const cap = harvestStockOf(m.species, rng);
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

  return { side, spawn, features, creatures };
}
