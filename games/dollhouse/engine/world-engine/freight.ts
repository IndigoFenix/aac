// shared/world-engine/freight.ts
//
// HOW GOODS SURVIVE THE ROAD — the product transport attributes of
// resources-and-trade.md step ① ("the cost of moving mass is the master
// variable of a pre-modern economy").
//
// Two laws govern this file:
//
//   • RATIOS IN THE ENGINE, ABSOLUTES IN THE SPEC. The engine owns only the
//     SHAPES — a carry-reach function of value density, a transit-loss
//     function of transit behavior, refinement as ratio'd conversions. Every
//     number is either a dimensionless ratio of declared quantities (the
//     scale.ts idiom — settlement-emergence.md §4) or default CONTENT that a
//     world spec / registry row overrides. No engine function names a
//     particular good, ratio or radius.
//
//   • ONE VOCABULARY AT EVERY SCALE. The same `valueDensity`/`transit` pair
//     prices the walk from field to granary, the band's decision to stop
//     moving (Gate A spoilage), and the caravan on the region road — same
//     attributes, different radius. Settlement founding and intercity trade
//     read THESE fields, never their own copies.
//
// Attributes are PER GOOD (the stack glyph / commodity key), not per source:
// wood is wood whether an oak or an apple tree yielded it, so hanging the
// numbers on `NaturalProduct` rows would let two sources disagree about one
// good. products.ts declares WHAT a source yields; this registry declares how
// what it yielded travels. PURE LEAF like products.ts/variations.ts — imports
// scale.ts only (also a leaf), safe from kernel and interaction alike.
//
// UNITS — the caloric anchor. One BULK unit is the bulk of one ration of
// staple food; `valueDensity` is rations-worth per bulk unit, so the staple
// itself is exactly 1 (grain is the anchor the way hunger anchors
// NEED_FILL_DAYS). A hauler's wage/appetite is 1 ration per hunger period,
// which is what makes every reach below a RATIO of declared quantities: the
// Ox Paradox — the haul animal eats the cargo — is `carryDays` (scale.ts)
// read against the cargo's worth.

import {
  dailyTravelM,
  needFillDays,
  yearGameDays,
  type WorldScale,
} from "./scale.js";

// ------------------------------------------------------------------- the attrs

/**
 * How a good survives the road (resources-and-trade.md §①):
 *  - `selfConsuming` — the cargo IS what the hauler eats (grain, fruit): the
 *    load thins with every travel day, and reach dies where the round trip
 *    has eaten it all. The Ox Paradox good.
 *  - `fragile`      — effectively does not travel (charcoal crumbles, milk
 *    sours): loss compounds so fast the processing must come TO it (the
 *    smelter moves to the fuel — step ③'s siting rule reads this).
 *  - `durable`      — "the ox never eats the cargo" (salt, metal, cloth):
 *    no loss; distance costs wages, not substance. THE DEFAULT.
 */
export type TransitBehavior = "selfConsuming" | "fragile" | "durable";

/** All transit behaviors (the JSON gate validates against this list). */
export const TRANSIT_BEHAVIORS: readonly TransitBehavior[] = [
  "selfConsuming", "fragile", "durable",
];

/** How the good moves — the three carry modes whose ASYMMETRY is the physics
 *  (land reach ≪ upstream ≪ downstream). The multipliers live in the world
 *  spec (`TransportAsymmetry`), never in code. */
export type TransportMode = "land" | "downstream" | "upstream";

/** One good's transport attributes — worth per unit bulk, and how it
 *  survives the road. THE fields settlement-emergence.md Gate A reads for
 *  band-store spoilage and resources-and-trade.md reads for caravan reach. */
export interface Freight {
  /** Rations-worth per bulk unit (staple ≡ 1). A continuous scalar on
   *  purpose: the "Spice" end of the axis — tiny, absurdly valuable — is
   *  just a big number here, never a special case. */
  valueDensity: number;
  transit: TransitBehavior;
  /** STORAGE half-life in REAL-anchor days — how long the good KEEPS in a
   *  pile, a separate axis from how it travels: grain moves
   *  self-consumingly (the porter eats it) yet stores for years, which is
   *  the entire reason granaries work; milk is fragile both ways. Absent =
   *  the transit class's default (KEEP_DAYS_DEFAULT). Spoilage rides the
   *  METABOLISM dial (rot is microbes eating your food — one factor per
   *  process class, ecosystem-wide), so a world that eats faster also rots
   *  faster and "keeps through a winter" stays a ratio, not a duration. */
  keepDays?: number;
}

/** Named default tiers for `valueDensity` — CONTENT calibration (the
 *  Grainbound tables' proportional structure), not engine constants. Rows
 *  may use any scalar; these are the legible rungs. */
export const VALUE_TIER = {
  /** Raw bulk that barely repays its own haul (timber, stone). */
  rawBulk: 0.5,
  /** The caloric anchor: one ration's worth per ration's bulk (grain). */
  staple: 1,
  /** One refinement in (cloth, ale, charcoal-tier goods). */
  refined: 4,
  /** Concentrated worth (salt, metal) — crosses a region. */
  concentrated: 16,
  /** The Spice end: produced almost nowhere, worth crossing a world for. */
  precious: 64,
} as const;

// ------------------------------------------------------------- the registry

/**
 * DEFAULT CONTENT for the shipped goods vocabulary (products.ts glyphs,
 * street commodity keys, trade imports). Substantial defaults, all
 * overridable: `registerFreight` replaces a row at runtime the way
 * `registerNaturalSource` does, and an `EconomyDoc` commodity's `freight`
 * block overrides for its own world at compile.
 */
export const FREIGHT_CATALOGUE: ReadonlyArray<{ good: string } & Freight> = [
  // Raw bulk — cheap, heavy, durable. Dies within a short radius, which is
  // why the sawyer and the quarry sit AT the stand (step ③'s siting).
  { good: "wood", valueDensity: VALUE_TIER.rawBulk, transit: "durable" },
  { good: "stone", valueDensity: VALUE_TIER.rawBulk / 2, transit: "durable" },
  // The worked-wood rung (construction phase 3): raws refine into blocks
  // at the bench — value exceeds both raws (the refinement law), short of
  // the true refined tier (a plank is not cloth).
  { good: "block", valueDensity: 2, transit: "durable" },
  // Staple food — the hauler eats the cargo (the Ox Paradox anchor). Grain
  // KEEPS ~two harvests (the transit default); the fresh fruits store as
  // long as a cellar really holds them — per-good keep is CONTENT.
  { good: "food", valueDensity: VALUE_TIER.staple, transit: "selfConsuming" },
  { good: "apple", valueDensity: VALUE_TIER.staple, transit: "selfConsuming", keepDays: 90 },
  { good: "banana", valueDensity: VALUE_TIER.staple, transit: "selfConsuming", keepDays: 7 },
  { good: "grape", valueDensity: VALUE_TIER.staple, transit: "selfConsuming", keepDays: 30 },
  // The perishables: worth more than grain and gone before the second day —
  // milk is why cheese exists; meat is why herds walk to market on the hoof.
  { good: "milk", valueDensity: VALUE_TIER.staple, transit: "fragile", keepDays: 1 },
  { good: "meat", valueDensity: 2, transit: "fragile", keepDays: 4 },
  // PRESERVATION IS REFINING (§③'s other half): milk refined into a pile
  // that crosses a winter — refinement multiplies keepDays along with
  // valueDensity. Not a law (grain outlasts the ale it becomes; the value
  // multiplication IS the law) but the preservation rows do both, which is
  // the pastoralists' one exit from Gate A's fragile-staple plateau.
  { good: "cheese", valueDensity: VALUE_TIER.refined, transit: "durable", keepDays: 180 },
  // Fiber and its refinement — the value-multiplication rung the wool→cloth
  // catalogue row (products.ts refinesTo) is the worked example of.
  { good: "wool", valueDensity: 2, transit: "durable" },
  { good: "cloth", valueDensity: VALUE_TIER.refined, transit: "durable" },
  { good: "clothing", valueDensity: 2 * VALUE_TIER.refined, transit: "durable" },
  // The trade-line imports (trade.ts): durable trinkets worth hauling a town
  // over, and the rare far treat — its scarcity-by-distance mechanic
  // (rarePerVisit) is exactly a high value density surviving a long road.
  { good: "ball", valueDensity: VALUE_TIER.refined, transit: "durable" },
  { good: "teddy", valueDensity: VALUE_TIER.refined, transit: "durable" },
  { good: "blocks", valueDensity: VALUE_TIER.refined, transit: "durable" },
  { good: "cookie", valueDensity: VALUE_TIER.concentrated, transit: "durable" },
];

const BY_GOOD = new Map<string, Freight>(
  FREIGHT_CATALOGUE.map(({ good, ...f }) => [good, f]),
);

/** The undeclared good: staple-worth and durable (resources-and-trade.md §①
 *  — "default durable"). A good nobody priced still trades, at the anchor. */
export const DEFAULT_FREIGHT: Freight = { valueDensity: VALUE_TIER.staple, transit: "durable" };

/** A good's transport attributes — declared row or the durable default. */
export function freightOf(good: string): Freight {
  return BY_GOOD.get(good) ?? DEFAULT_FREIGHT;
}

/** Has the catalogue (or a registration) priced this good explicitly? */
export function freightDeclared(good: string): boolean {
  return BY_GOOD.has(good);
}

/** Add (or override) a good's freight at runtime — a game contributing its
 *  own goods (the registerNaturalSource pattern). */
export function registerFreight(good: string, f: Freight): void {
  BY_GOOD.set(good, f);
}

// --------------------------------------------- the asymmetry (world spec side)

/**
 * The MODE ASYMMETRY — how much farther one hauling cost carries a good by
 * water than by land. This is the physics the worksheets' absolute miles
 * dissolve into: land ≪ upstream ≪ downstream is what shapes every
 * pre-modern trade map, whatever the numbers. Land is the unit (always 1);
 * the water multipliers are WORLD SPEC (`game.transport`), defaulting to the
 * Earth-premodern anchor below.
 */
export interface TransportAsymmetry {
  /** The unit mode — always 1 (the others are multiples of it). */
  land: 1;
  downstream: number;
  upstream: number;
}

/** Earth-premodern anchor (cribbed from the classic freight-cost ratios:
 *  a barge crew moves an order of magnitude more ton-miles per ration than
 *  an ox crew going downstream, a fraction of that fighting the current).
 *  Inspiration, never a law — a world declares its own. */
export const REAL_ASYMMETRY: TransportAsymmetry = { land: 1, downstream: 20, upstream: 4 };

/** The authored form (the `game.transport` block — scale.ts idiom: parse
 *  gates shape, resolve fills the anchor). Land is not declarable: it is
 *  the unit the others are expressed in. */
export interface TransportSpec {
  downstream?: number;
  upstream?: number;
}

function failAt(path: string, msg: string): never {
  throw new Error(`${path}: ${msg}`);
}

/** Structural gate for `game.transport` — path-exact refusals, never skips. */
export function parseTransportSpec(raw: unknown, path: string): TransportSpec {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    failAt(path, "expected an object (the transport asymmetry declaration)");
  }
  const o = raw as Record<string, unknown>;
  const allowed = ["downstream", "upstream"];
  for (const k of Object.keys(o)) {
    if (k === "land") failAt(`${path}.land`, "land is the unit mode (always 1) — declare the water modes as multiples of it");
    if (!allowed.includes(k)) failAt(`${path}.${k}`, `unknown field (allowed: ${allowed.join(", ")})`);
  }
  const out: TransportSpec = {};
  for (const k of allowed as Array<keyof TransportSpec>) {
    if (k in o) {
      const v = o[k];
      if (typeof v !== "number" || !Number.isFinite(v)) failAt(`${path}.${k}`, "must be a number");
      if (v < 1 || v > 10_000) failAt(`${path}.${k}`, "must be in 1..10000 (a multiple of the land mode)");
      out[k] = v;
    }
  }
  return out;
}

/** A document's declaration → the world's resolved asymmetry. Absent fields
 *  anchor to the Earth-premodern ratios. */
export function resolveTransportAsymmetry(spec?: TransportSpec | null): TransportAsymmetry {
  return {
    land: 1,
    downstream: spec?.downstream ?? REAL_ASYMMETRY.downstream,
    upstream: spec?.upstream ?? REAL_ASYMMETRY.upstream,
  };
}

/** Incoherence as readable sentences, never a throw (the scaleWarnings
 *  doctrine): a world where rowing upstream beats floating downstream is
 *  legal — and should know it said that. */
export function asymmetryWarnings(asym: TransportAsymmetry): string[] {
  const out: string[] = [];
  if (asym.downstream < asym.upstream) {
    out.push(
      `transport: downstream (${asym.downstream}×) carries less far than upstream ` +
        `(${asym.upstream}×) — rivers run backwards here`,
    );
  }
  if (asym.upstream < asym.land) {
    out.push(
      `transport: upstream (${asym.upstream}×) is worse than carrying overland — ` +
        `boats are decoration here`,
    );
  }
  return out;
}

// ------------------------------------------------------------------ the shapes
//
// Every function below is a RATIO of declared quantities: the hauler's
// appetite (needFillDays), their legs (dailyTravelM — locomotion × the day),
// the load on their back (`payloadBulk`), the cargo's worth (valueDensity)
// and the mode multiplier. Compress any dial and the reach moves with it —
// which is why a compressed world grows compact hinterlands the same way it
// grows compact towns (serviceRadiusM), with no literal anywhere.

/** A porter's pack, in bulk units (~rations carried): the default payload
 *  anchor. CONTENT, not law — carts, oxen and barges are bigger payloads a
 *  caller passes (a vehicle is a payload, not a new mechanic). */
export const REAL_PORTER_BULK = 20;

/** Loss per travel day of a FRAGILE good — it crumbles/sours faster than any
 *  road is short. Content default; override per call where a good declares
 *  better. At 0.5, half the load is gone each day. */
export const FRAGILE_LOSS_PER_DAY = 0.5;

export interface HaulOpts {
  /** Bulk units on the hauler's back (default: the porter anchor). */
  payloadBulk?: number;
  /** Fragile decay per travel day (default FRAGILE_LOSS_PER_DAY). */
  fragileLossPerDay?: number;
}

/**
 * BREAK-EVEN game-days of one-way travel: the point where the round trip's
 * hauling cost (one ration per hunger period, out AND back) equals the
 * cargo's whole worth. Past this the trade destroys value — the load was
 * eaten, in substance (selfConsuming) or in wages (durable).
 *
 * `payload × valueDensity × needFillDays / 2` — for a selfConsuming staple
 * this is literally scale.ts `carryDays` halved: the Ox Paradox, priced.
 */
export function haulBreakEvenDays(
  scale: WorldScale,
  valueDensity: number,
  payloadBulk: number = REAL_PORTER_BULK,
): number {
  return (payloadBulk * valueDensity * needFillDays(scale, "hunger")) / 2;
}

/** Game-days of one-way travel a FRAGILE load survives to half strength —
 *  the honest reach of a good that rots faster than it travels. */
export function fragileHalfLifeDays(lossPerDay: number = FRAGILE_LOSS_PER_DAY): number {
  return Math.log(0.5) / Math.log(1 - lossPerDay);
}

/**
 * THE CARRY REACH: one-way metres a good is worth moving, by mode.
 *
 *   reach = dailyTravel × breakEvenDays × asymmetry[mode]
 *
 * — with a fragile good's days capped at its loss half-life, which is what
 * makes "charcoal doesn't travel" an OUTPUT of the arithmetic rather than a
 * rule: the smelter walks to the fuel because this number says so (step ③).
 * Everything scales: more valuable ⇒ farther; downstream ⇒ farther; faster
 * legs or a slower appetite ⇒ farther; a compressed day ⇒ nearer (compact
 * hinterlands for compact towns).
 */
export function carryReachM(
  scale: WorldScale,
  f: Freight,
  mode: TransportMode = "land",
  asym: TransportAsymmetry = REAL_ASYMMETRY,
  opts: HaulOpts = {},
): number {
  let days = haulBreakEvenDays(scale, f.valueDensity, opts.payloadBulk);
  if (f.transit === "fragile") {
    days = Math.min(days, fragileHalfLifeDays(opts.fragileLossPerDay));
  }
  return dailyTravelM(scale) * days * asym[mode];
}

/**
 * TRANSIT LOSS: the fraction of the load that ARRIVES after `oneWayDays` of
 * travel (the hauler still has to get home — the round trip is what eats).
 *  - durable: 1 — distance costs wages, never substance.
 *  - fragile: compounding decay.
 *  - selfConsuming: the cargo fed the trip. The hauler eats one ration-worth
 *    per hunger period, so a denser food thins slower in BULK — and the
 *    fraction hits exactly 0 at `haulBreakEvenDays` for every valueDensity
 *    (the two shapes agree by construction).
 * The SAME function prices a granary walk and a caravan — only the days
 * differ (the fractal-job-description law).
 */
export function deliveredFraction(
  scale: WorldScale,
  f: Freight,
  oneWayDays: number,
  opts: HaulOpts = {},
): number {
  if (oneWayDays <= 0) return 1;
  switch (f.transit) {
    case "durable":
      return 1;
    case "fragile":
      return Math.pow(1 - (opts.fragileLossPerDay ?? FRAGILE_LOSS_PER_DAY), oneWayDays);
    case "selfConsuming": {
      const payload = opts.payloadBulk ?? REAL_PORTER_BULK;
      return Math.max(
        0,
        1 - (2 * oneWayDays) / (payload * needFillDays(scale, "hunger") * f.valueDensity),
      );
    }
  }
}

// ----------------------------------------------------------- storage (keeping)
//
// HOW GOODS SURVIVE THE PILE — the storage axis Gate A reads
// (settlement-emergence.md: a band's store spoils; the granary's grain
// mostly doesn't). Same laws as the road: the engine owns one shape
// (exponential half-life decay, applied at day boundaries, zero per-step
// cost), the numbers are per-good content. Spoilage rides the METABOLISM
// dial because rot IS metabolism — microbes eating the food — and the
// one-ledger law (space-time-compression §4) applies one factor per
// process class across the whole ecosystem, microbes included. A world
// that eats 3× faster rots 3× faster, and every gate that compares a
// store against an appetite stays a pure ratio.
//
// The emergent consequence, wanted on purpose: a fragile good can never
// BE the granary — a milk-fed band cannot pile a store past its own
// carry, so pastoralists stay mobile (Gate A's negative case), and
// PRESERVATION becomes a reason to refine (milk→cheese, meat→smoked:
// refinement multiplies keepDays along with valueDensity — step ③'s
// other half).

/** Default storage half-life per transit class (real-anchor days) —
 *  CONTENT: the durable pile never rots, the staple keeps ~two harvests
 *  (grain's real cellar life — what makes the granary invariant
 *  satisfiable at all), the fragile good is gone in days. */
export const KEEP_DAYS_DEFAULT: Record<TransitBehavior, number> = {
  durable: Infinity,
  selfConsuming: 730,
  fragile: 2,
};

/** A good's storage half-life in real-anchor days: its declared `keepDays`
 *  or its transit class's default. */
export function keepDaysOf(f: Freight): number {
  return f.keepDays ?? KEEP_DAYS_DEFAULT[f.transit];
}

/** The half-life in GAME days on a given world — the metabolism dial is
 *  the conversion (rot is microbial appetite, same clock as hunger). */
export function keepHalfLifeGameDays(scale: WorldScale, f: Freight): number {
  return keepDaysOf(f) / scale.metabolism;
}

/** Fraction of a stored pile remaining after `days` GAME days —
 *  exponential in the half-life; 1 for the durable pile. Deterministic
 *  and memoryless, so day-boundary application needs no history. */
export function storedFraction(scale: WorldScale, f: Freight, days: number): number {
  if (days <= 0) return 1;
  const half = keepHalfLifeGameDays(scale, f);
  if (!Number.isFinite(half)) return 1;
  return Math.pow(0.5, days / half);
}

/** THE GRANARY RATIO — keep half-life over the lean window, dimensionless:
 *  above 1 the good can cross its world's winter as a pile; well below 1
 *  it must be eaten, moved, or REFINED into something that keeps. This is
 *  the diagnostic a world's staple must clear for settlement to be
 *  possible at all (a readable number, never an ambush — the
 *  scaleWarnings doctrine). */
export function keepThroughLean(scale: WorldScale, f: Freight): number {
  const leanDays = scale.leanFraction * yearGameDays(scale);
  if (leanDays <= 0) return Infinity;
  return keepHalfLifeGameDays(scale, f) / leanDays;
}

// ------------------------------------------------------------------ refinement

/**
 * A ratio'd refinement (products.ts `refinesTo`): `inPerOut` units of the
 * raw make one unit of the refined. LAW (tested off the catalogue, never
 * enforced in code): refinement is LOSSY IN MASS (inPerOut ≥ 1) and
 * MULTIPLICATIVE IN VALUE (the refined good's valueDensity exceeds the
 * raw's) — DISTANCE IS THE REASON REFINING EXISTS, and a refinement that
 * concentrated no value would never be worth the work.
 */
export function refineOutUnits(unitsIn: number, inPerOut: number): number {
  return Math.floor(unitsIn / Math.max(1e-9, inPerOut));
}

/** A chain's compound ratio: raw units per final unit (wood→charcoal→iron
 *  compounds — the arithmetic that makes bottlenecks emerge). */
export function chainInPerOut(ratios: readonly number[]): number {
  return ratios.reduce((a, r) => a * r, 1);
}

// ------------------------------------------- refinery emergence (§③ shapes)
//
// DISTANCE IS THE REASON REFINING EXISTS. The two reads below are the
// engine's whole share of resources-and-trade.md step ③ — everything else
// (which goods, which ratios, which buildings) is spec:
//
//   • the LICENSE — a town whose raw good cannot reach a market at its
//     value density MUST refine it or stay a village. The gate is a
//     dimensionless ratio (market distance over the raw good's reach);
//     `shadow` node typing is this same test run by worldgen, and the
//     economy compiler turns the verdict into a build-rule gate.
//   • the SITING — one rung down (the fractal job-description law), the
//     same fields place the workshop INSIDE the town's geography: a
//     process whose input rots faster than it travels walks to the input
//     (the smelter to the fuel, the dairy to the herd); everything else
//     stands at the market, where the customers are.
//
// Both print their sentence: if the derivation can't be generated, the
// derivation is missing, not the prose. Engine-diagnostic English, not UI.

/** A freight row that knows its good's name — what `CompiledEconomy.
 *  freights` carries and both refinery reads take (the sentence needs
 *  the noun). */
export type NamedFreight = { good: string } & Freight;

export interface RefineryVerdict {
  /** The raw good dies on the road to the nearest market — refining is
   *  the town's reason to exist (the build-rule gate reads this). */
  licensed: boolean;
  /** THE GATE RATIO, dimensionless: market distance over the raw good's
   *  reach. > 1 = stranded (licensed); Infinity = no market at all. */
  stranded: number;
  /** One-way metres each form is worth moving (carryReachM). */
  rawReachM: number;
  refinedReachM: number;
  /** The printed derivation (the fractal law's test). */
  sentence: string;
}

/**
 * THE LICENSE (resources-and-trade.md §③): may this town refine `raw`
 * into `refined`? Yes exactly when its nearest market sits beyond the
 * raw good's carry reach — the town refines what it grows, or stays a
 * village. Pass `Infinity` for a town with no market at all (the lone
 * settlement is the shadow case at its purest). Every quantity is a
 * ratio of declared dials — compress the world and the verdict moves
 * with it.
 */
export function refineryLicense(
  scale: WorldScale,
  raw: NamedFreight,
  refined: NamedFreight,
  marketDistM: number,
  opts: { mode?: TransportMode; asym?: TransportAsymmetry; haul?: HaulOpts } = {},
): RefineryVerdict {
  const mode = opts.mode ?? "land";
  const asym = opts.asym ?? REAL_ASYMMETRY;
  const rawReachM = carryReachM(scale, raw, mode, asym, opts.haul);
  const refinedReachM = carryReachM(scale, refined, mode, asym, opts.haul);
  const stranded = rawReachM > 0 ? marketDistM / rawReachM : Infinity;
  const licensed = stranded > 1;

  const m = (x: number): string => (Number.isFinite(x) ? `${Math.round(x)} m` : "beyond any road");
  const sentence = !Number.isFinite(marketDistM)
    ? `refines its ${raw.good} because no market exists to ship it to — as ${refined.good} its worth waits for one (reach ${m(refinedReachM)})`
    : licensed
      ? `refines its ${raw.good} because the nearest market (${m(marketDistM)}) lies beyond raw ${raw.good}'s reach (${m(rawReachM)})` +
        (refinedReachM >= marketDistM
          ? ` — as ${refined.good} it carries ${m(refinedReachM)}`
          : ` — and even as ${refined.good} (${m(refinedReachM)}) it falls short`)
      : `ships raw ${raw.good} — a market (${m(marketDistM)}) sits inside its reach (${m(rawReachM)})`;

  return { licensed, stranded, rawReachM, refinedReachM, sentence };
}

/**
 * THE SITING, one rung down: where does the refine process stand inside
 * its town? A FRAGILE input rots faster than any road is short, so the
 * works come TO it — the smelter to the fuel, the kiln to the clay, the
 * dairy to the herd. Every other input survives the road in, so the
 * workshop stands at the market, where the labor and the customers are.
 * (A fragile OUTPUT needs no rule of its own: its consumer's fragile
 * INPUT drags that consumer here, and the pair co-locates — the charcoal
 * kiln and the smelter meet in the forest by two applications of the
 * same read.)
 */
export function refinerySiting(
  input: NamedFreight,
  output: NamedFreight,
): { at: "input" | "market"; sentence: string } {
  if (input.transit === "fragile") {
    return {
      at: "input",
      sentence: `stands at its ${input.good} — ${input.good} rots faster than it travels, so the works come to it`,
    };
  }
  return {
    at: "market",
    sentence: `stands at the market — ${input.good} survives the road in, and ${output.good} sells where the customers are`,
  };
}
