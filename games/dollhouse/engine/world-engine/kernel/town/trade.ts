/**
 * trade.ts — INTERCITY TRADE at the ground level, v1: the ABSTRACT PARTNER.
 *
 * A caravan from "away" enters the town each street day on the road out of
 * town, unloads IMPORTS at the depot beside the hall, loads the town's EXPORT
 * surplus, and leaves the way it came. Everything the player can see and touch
 * is real today — the crates, the carriers, the pile that thins when the farm
 * crew was poached — while the PARTNER stays an opaque address:
 *
 *   • `partnerKey` is a string the hierarchical-cells work
 *     (planning-docs/games/world-engine/hierarchical-cells.md) will bind to a real
 *     neighboring settlement's (region, cell) address once tier-1 lands —
 *     day's-walk villages make caravans between REAL economies; this module's
 *     cycle, depot and streaming stay as-is (the seam is the point).
 *   • v1 IMPORTS are goods the town does not make (trinkets — toys the
 *     children want), deliberately OUTSIDE the subsistence commodities, so no
 *     aggregate scalars are faked. EXPORTS are the food surplus, host-damped
 *     by producer attendance (jobs→economy) — steal the crew, the caravan
 *     leaves light.
 *
 * Time-pure like every street routine (goods.ts): the caravan is a closed-form
 * function of `t`; a body exists only mid-visit; same seed, same caravan,
 * forever.
 */

import { FOOD_DAY_SEC, workDoorstep } from "./goods";
import { roadRoute, townPorts, type TownStreets } from "./streets";
import { townPlaza, type TownPlan } from "./plan";
// ⚖️ §7 step 6: the town rung reads the REGION rung's arithmetic. The 2026-08-02
// survey's whole indictment of freight.ts was "Real value−cost arithmetic. …
// NOT IMPORTED BY ANY TOWN OR BODY MODULE" — this import is that sentence
// being served. freight.ts is read-only from here, forever.
import { carryReachM, freightOf } from "../../freight";
import { DOLLHOUSE_SCALE, type WorldScale } from "../../scale";
// R&T ⑤ (T2): the pair's complementary read. It lives in a LEAF sibling of
// barter.ts precisely so this call can exist — barter.ts itself reads
// transfer.ts, which reads this module, and a value edge into it would be a
// cycle. `BarterSignals`/`PartnerGeography` are TYPE ONLY (erased).
import { complementaryRanking } from "./complementary";
import type { BarterSignals, PartnerGeography } from "./barter";
import { allocate } from "./allocate";

export interface TradeRoute {
  /** Opaque partner settlement key — `"away:<seed>"` until a REAL neighbor is
   *  bound (a cluster hamlet's key, or the hierarchical-cells (region, cell)
   *  address once tier-1 lands). */
  partnerKey: string;
  /** Where the caravan enters/leaves the town (world meters): the road-out tip
   *  most ALIGNED with the partner (falls back to the farthest tip). */
  gate: { x: number; y: number };
  /** Road polyline, gate → depot (world meters). */
  route: Array<{ x: number; y: number }>;
  /** What arrives / what leaves. AUTHORED until the line is bound with both
   *  sides' scarcity reads (`bindPartner`), from which point they are the
   *  pair's own complementary lists — their surplus ∩ our shortage, and the
   *  mirror (complementary.ts). The constants below are the fallback for a
   *  line with no partner to read, never a floor under a derived list. */
  imports: readonly string[];
  exports: readonly string[];
  /** TRAVEL COST made visible: how far the partner is (world meters; the
   *  abstract partner reads as a far one) and the RARE import it carries —
   *  the farther the road, the fewer arrive each visit. */
  distanceM: number;
  rare: { kind: string; perVisit: number };
  /** ⚖️ THE PARTNER'S OWN PLACE (world metres) — present only once
   *  `bindPartner` bound a REAL neighbour. Its absence is the honest marker of
   *  the abstract `away:` line, whose only "place" is our own gate: a caller
   *  that measured that would be pricing a fiction. Present ⇒ `distanceM` is a
   *  road (or the chord to a real town) and the caravan leg may be priced on
   *  it (`barterLegSeconds`) instead of the flat fallback day. */
  partnerAt?: { x: number; y: number };
  /** ⚖️ WHAT THE PARTNER'S TERRAIN DECLARES (barter.ts `PartnerGeography`) —
   *  passed through by `bindPartner` from the tier that knows the neighbour's
   *  node reading. Absent ⇒ nothing is known and the closed-form proxy stays
   *  pure hash (byte-identical to the shipped stub). */
  partnerGeo?: PartnerGeography;
}

/** The caravan's position in its daily visit — `away` = no body exists. */
export interface CaravanTrip {
  phase: "away" | "arriving" | "trading" | "leaving";
  pos: { x: number; y: number };
  /** Remaining waypoints (ending back at the gate), for `setNpcErrand` —
   *  null when away. The depot point carries the trading dwell. */
  walkTo: Array<{ x: number; y: number; dwell?: number }> | null;
  /** Street day of this visit (edge detection). */
  day: number;
  /** Carrier pace (m/s) — the streaming body must use it. */
  speed: number;
}

export interface TownTrade {
  route: TradeRoute;
  /** The depot spot (beside the hall door) where the trade crates stand. */
  depot: { x: number; y: number };
  /** The caravan at `t` (closed form). */
  caravan(t: number): CaravanTrip;
  /** The VISIT bucket at `t` — increments as each day's caravan finishes
   *  arriving. The import crate holds `IMPORT_ALLOTMENT` per bucket; the host
   *  keys its consumed offset to the bucket, so takes persist between visits
   *  and the crate refreshes the moment a new caravan lands. */
  tradeDay(t: number): number;
  /** How far through the CURRENT visit bucket `t` falls, [0,1) — 0 the instant
   *  a caravan finishes arriving. The depot shelf's sawtooth runs on THIS, not
   *  on the farms' dawn (⑤ T3a: `ImportDepotReading.dayFrac`). */
  dayPhase(t: number): number;
  /** ⚖️ R&T ⑤ (T3) — UNITS OF `good` ONE VISIT LANDS, the ONE definition: the
   *  visit allotment split across whatever the line actually carries, and the
   *  rare treat's own distance-scaled count. 0 for a good this line does not
   *  carry. Read by the crate the player opens AND by the depot shelf the
   *  households shop — the same caravan cannot land two different amounts.
   *
   *  ⚖️ G3 — the split is WEIGHTED by the cargo ranking's own `want` (the
   *  worse the shortage, the bigger the share) and conserves the allotment
   *  exactly. An authored list, or any list whose wants are equal, deals the
   *  even share it always did. */
  importUnitsPerVisit(good: string): number;
  /** ⚖️ R&T ⑤ (T3) — RE-DERIVE THE CARGO off TODAY's books, without touching
   *  the geometry. `bindPartner` is a ONE-SHOT at boot; scarcity is not, and a
   *  cargo list frozen on bind-day would have the caravan hauling last season's
   *  complement forever. The host calls this once per visit bucket. No-op
   *  before a partner is bound (an abstract line carries the authored kinds). */
  refreshCargo(scarcity: { us: BarterSignals; them: BarterSignals; goods: readonly string[] }): void;
  /** Export units piled at `t`: fills from the last departure toward the next
   *  (the caravan takes the pile with it). UN-damped by ATTENDANCE — the host
   *  multiplies by producer attendance so absent crews truthfully thin the
   *  load — but ⚖️ G2-SCALED BY SPARENESS: a town short of its own export good
   *  piles proportionally less, reaching zero at the want gate that already
   *  decides whether the good is on the export list at all. */
  exportPile(t: number): number;
  /** ⚖️ BATCH 3 · B5 — THE DAY'S WHOLE SHIPMENT, at today's spare scale:
   *  `exportDaily × exportScale()`, i.e. the LIMIT the sawtooth above ramps to
   *  between two departures. The pile is 0 at the instant the caravan leaves
   *  (it just took it), so a caller settling the departure cannot read the
   *  load off `exportPile` — this is the same number, named. Un-damped by
   *  attendance, exactly like `exportPile`. */
  exportDailyUnits(): number;
  /** Bind the line to a REAL partner (a cluster hamlet; later a
   *  hierarchical-cells neighbor): re-aims the gate toward it, rebuilds the
   *  entry route, and re-scales the rare allotment by the true distance.
   *
   *  TRADE PRICES THE ROAD, NOT THE CHORD: pass `distanceM` when a real
   *  route joins the two settlements — its port-to-port `lengthM` is what a
   *  caravan actually walks (a road around a mountain is longer than the
   *  line of sight, and the rare allotment must feel that). Omitted = the
   *  straight-line fallback, for partners with no road between them.
   *
   *  ⚖️ THE BIND IS ALSO WHAT THE HOST READS. Binding records the partner's
   *  own place (`route.partnerAt`) and, where the tier knows it, its terrain
   *  (`geo`): the road length used to be re-discarded downstream because
   *  nothing on the route said "this partner is real". Both are additive —
   *  a caller that passes neither binds exactly as it always did.
   *
   *  ⚖️ AND WHERE BOTH SIDES' BOOKS ARE IN HAND (`scarcity`), the two cargo
   *  lists stop being constants: `complementaryTrade` derives what this pair
   *  actually has for each other over this exact road, and the authored
   *  `TRADE_IMPORT_KINDS`/`exportGood` fall back to being what an UNBOUND
   *  line carries. Omitted ⇒ the authored lists stand, untouched. */
  bindPartner(partner: {
    key: string;
    at: { x: number; y: number };
    distanceM?: number;
    /** The partner's terrain reading, for the closed-form scarcity proxy. */
    geo?: PartnerGeography;
    /** BOTH sides' live scarcity reads + the goods vocabulary they share —
     *  the pair's facts, from which the two cargo lists are derived. */
    scarcity?: { us: BarterSignals; them: BarterSignals; goods: readonly string[] };
  }): void;
}

/** Units of imports each visit lands (split across the import kinds). */
export const IMPORT_ALLOTMENT = 6;
/** The RARE far-away import — a treat no town makes (in demand everywhere). */
export const RARE_IMPORT_KIND = "cookie";
/** The most a single visit ever lands (and the ladder's rung count — one unit
 *  is lost per 1/RARE_MAX_PER_VISIT of the reach the road eats). */
export const RARE_MAX_PER_VISIT = 3;
/**
 * ONE PORTER PER UNIT of the treat — the payload `carryReachM` prices the
 * rare import's reach at. A caravan hauling a scarce delicacy is not a grain
 * train: each unit rides its own pair of legs, and those legs eat. So the
 * honest reach of ONE rare unit is `haulBreakEvenDays` at `payloadBulk = 1`,
 * which for a `concentrated` good (valueDensity 16) is 8 hunger-periods of
 * one-way walking — the Ox Paradox, per unit.
 */
export const RARE_PORTER_BULK = 1;
/**
 * Rare units per visit BY DISTANCE: a near neighbor's caravan carries a few, a
 * far one barely any — travel cost as scarcity.
 *
 * ⚖️ DERIVED, not stepped (scope-behaviors.md §4.7: "`rarePerVisit`'s 900/1600
 * m breakpoints — the two literals that should be `carryReachM`"). The road is
 * measured against the treat's OWN carry reach, and the allotment thins by one
 * unit each time the road eats another `1/RARE_MAX_PER_VISIT` of it:
 *
 *   reachM   = carryReachM(scale, freight(kind), land, payloadBulk = 1)
 *   eaten    = distanceM / reachM                    ← the exchange rate
 *   perVisit = RARE_MAX_PER_VISIT − floor(eaten × RARE_MAX_PER_VISIT)
 *
 * THE EXCHANGE RATE IN WORDS: **a rare import survives one-third of its own
 * carry reach per unit** — cross a third of the break-even road and one fewer
 * arrives; cross the whole road and only the floor of one is left, because a
 * caravan that shows up empty is not a caravan.
 *
 * OLD LITERALS, and where they now sit. `perVisit` was `d ≤ 900 ? 3 : d ≤ 1600
 * ? 2 : 1`. On the SHIPPED street profile (DOLLHOUSE_SCALE: a 240 s day, real
 * legs, real appetite) the cookie's one-porter reach is 2918 m, so the
 * breakpoints land at 973 m and 1946 m: the ladder answers 3 / 2 / 1 at exactly
 * the old 900 / 1600 / 3000 (AWAY_DISTANCE_M) probes. What MOVED is the band
 * between each old literal and its derived breakpoint — a partner at 900–973 m
 * now gets 3 instead of 2, one at 1600–1946 m gets 2 instead of 1 — and the
 * fact that the number now follows the world: on REAL_SCALE a 3 km neighbour is
 * next door (reach 737 km) and the caravan arrives full, which is what "the
 * farther the road" means once the road has a scale.
 */
export function rarePerVisit(
  distanceM: number,
  scale: WorldScale = DOLLHOUSE_SCALE,
  kind: string = RARE_IMPORT_KIND,
): number {
  const reachM = carryReachM(scale, freightOf(kind), "land", undefined, {
    payloadBulk: RARE_PORTER_BULK,
  });
  const eaten = reachM > 0 ? Math.max(0, distanceM) / reachM : Infinity;
  const lost = Number.isFinite(eaten) ? Math.floor(eaten * RARE_MAX_PER_VISIT) : RARE_MAX_PER_VISIT;
  return Math.max(1, Math.min(RARE_MAX_PER_VISIT, RARE_MAX_PER_VISIT - lost));
}
/** How far the ABSTRACT partner reads (no real neighbor bound): far. */
export const AWAY_DISTANCE_M = 3000;
/** Seconds the caravan trades at the depot. */
export const TRADE_DWELL_SEC = 36;
/** v1 import kinds: trinkets outside the subsistence economy (translated
 *  glyphs). ⚖️ DEMOTED TO THE UNBOUND FALLBACK (R&T ⑤ T2): what a line with a
 *  bound partner and both sides' books carries is DERIVED
 *  (`complementaryTrade`); this is what an abstract `away:` caravan brings
 *  when there is no partner to read. */
export const TRADE_IMPORT_KINDS: readonly string[] = ["ball", "teddy", "blocks"];

/**
 * ⚖️ G3 — THE PAYLOAD IS A CAPACITY MANY GOODS BID FOR: split `total` whole
 * units across `weights` by LARGEST REMAINDER, conserving exactly.
 *
 * The integer sibling of `allocateDistrictFill` (city-districts.ts) and
 * `allocateHands` (scope-shape.ts) — the same law at the hold's rung: floor
 * every share, then deal the remainder to the largest fractional parts, ties
 * by the CALLER's order (which is the cargo ranking's own, i.e. worst
 * shortage first). Pure; Σ output === floor(total) for any finite input.
 *
 * EQUAL WEIGHTS reproduce the even share the flat split dealt — and, where
 * the allotment does not divide evenly, they also deal the remainder the flat
 * split silently DROPPED (6 units across 4 kinds: 2/2/1/1, not 1/1/1/1 with
 * two units vanishing at the depot gate). Conservation is the point of the
 * shape; the shipped 3-kind line divides evenly and is untouched.
 *
 * A thin call into allocate.ts's shared conserving allocator (the
 * "largest-remainder" policy) — see that file for the shape this shares
 * with city-districts.ts `allocateDistrictFill` and scope-shape.ts
 * `allocateHands`.
 */
export function allotmentSplit(weights: readonly number[], total: number): number[] {
  return allocate({ mode: "largest-remainder", weights, total });
}

function hashSeed(seed: number, key: string): number {
  let h = 0x811c9dc5 ^ seed;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Build the town's trade line: gate (the longest street's tip), the road route
 * to the hall depot, and the daily caravan cycle. `exportDaily` = the town's
 * daily surplus of the export good (the caller derives it from the goods
 * layer). Null when the town has no streets to come in by.
 */
export function createTownTrade(
  center: { x: number; y: number },
  plan: TownPlan,
  streets: TownStreets,
  seed: number,
  opts: {
    exportGood: string;
    exportDaily: number;
    /** ⚖️ The world's compression, for the freight-derived rare allotment
     *  (`rarePerVisit`). Absent = the street profile this module's FOOD_DAY_SEC
     *  schedules are already paced to, so a caller that never declared a scale
     *  keeps exactly the numbers it had. */
    scale?: WorldScale;
    /**
     * ⚖️ G2 — HOW MUCH OF THE DAILY SURPLUS THIS TOWN ACTUALLY LETS OUT, 0..1,
     * read LIVE (a thunk, not a number: `exportDaily` is fixed at construction
     * and scarcity is the one thing about a town that moves).
     *
     * The town rung supplies `exportSpareScale(ourShortage(exportGood))` —
     * complementary.ts's want gate as a slope. ABSENT ⇒ 1 ⇒ every number this
     * module produces is bit-for-bit what it produced before the seat existed,
     * which is what a caller with no books to read must get.
     */
    exportScale?: () => number;
  },
): TownTrade | null {
  const scale = opts.scale ?? DOLLHOUSE_SCALE;
  // Candidate GATES: THE TOWN'S PORTS when the street tree declares any —
  // growth-phase-B makes the road out of town a real output (the baseline's
  // own ends and the arterials that continue it), so a caravan enters where
  // the road actually is instead of at whichever tip happened to be
  // farthest. Only a net with no ports at all falls back to every street
  // point. Unbound, the farthest candidate is the road out of town; bound to
  // a real partner, the one most ALIGNED with it wins (weighted by length,
  // so a stub pointing the right way doesn't beat the arterial).
  const declared = townPorts(streets);
  const tips: Array<{ x: number; y: number }> = declared.length
    ? declared.map(p => ({ x: p.x, y: p.y }))
    : [];
  if (!tips.length) {
    for (const st of streets.streets) {
      for (const pt of st.pts) tips.push(pt);
    }
  }
  if (!tips.length) return null;
  const pickGate = (towardLocal: { x: number; y: number } | null): { x: number; y: number } => {
    let best = tips[0]!;
    let bestScore = -Infinity;
    for (const pt of tips) {
      const d = Math.hypot(pt.x, pt.y);
      if (d < 1e-3) continue;
      let score = d;
      if (towardLocal) {
        const td = Math.hypot(towardLocal.x, towardLocal.y) || 1;
        score = ((pt.x * towardLocal.x + pt.y * towardLocal.y) / (d * td)) * Math.sqrt(d);
      }
      if (score > bestScore) {
        bestScore = score;
        best = pt;
      }
    }
    return best;
  };

  // The DEPOT: beside the hall's door (every town has a hall — the imports
  // depot by design, goods.ts). Fallback: the town's PLAZA — the widened
  // junction the civic buildings front, which is where a hall-less town's
  // crates would stand anyway (growth-phase-B: no berth at the origin).
  const hallIdx = plan.works.findIndex((wk) => wk.type === "hall");
  const sq = townPlaza(plan);
  const hallDoor =
    hallIdx >= 0 ? workDoorstep(center, plan.works[hallIdx]!) : { x: center.x + sq.x, y: center.y + sq.y };
  const depot = { x: hallDoor.x + 2.2, y: hallDoor.y + 1.2 };

  interface Geo {
    route: Array<{ x: number; y: number }>;
    cum: number[];
    len: number;
    speed: number;
    walk: number;
  }
  const buildGeo = (gateLocal: { x: number; y: number }): Geo | null => {
    const local = roadRoute(streets, gateLocal, {
      x: depot.x - center.x,
      y: depot.y - center.y,
    });
    if (local.length < 2) return null;
    const route = local.map((pt) => ({ x: pt.x + center.x, y: pt.y + center.y }));
    const cum = [0];
    for (let i = 1; i < route.length; i++) {
      cum.push(cum[i - 1]! + Math.hypot(route[i]!.x - route[i - 1]!.x, route[i]!.y - route[i - 1]!.y));
    }
    const len = cum[cum.length - 1]!;
    if (len < 1e-3) return null;
    // Timing: the whole visit fits comfortably in the day whatever the length.
    const speed = Math.max(2.2, (len * 2) / Math.max(30, FOOD_DAY_SEC * 0.35 - TRADE_DWELL_SEC));
    return { route, cum, len, speed, walk: len / speed };
  };

  // MUTABLE geometry + partner facts: `bindPartner` re-aims the gate and
  // re-scales the rare allotment; the closed-form cycle reads whatever is
  // current (the clocks stay put — only the path and the cargo change).
  let geo = buildGeo(pickGate(null));
  if (!geo) return null;
  const arriveFrac = 0.26 + (hashSeed(seed, "trade:arrive") / 4294967296) * 0.08;
  const route: TradeRoute = {
    partnerKey: `away:${seed}`,
    gate: geo.route[0]!,
    route: geo.route,
    imports: TRADE_IMPORT_KINDS,
    exports: [opts.exportGood],
    distanceM: AWAY_DISTANCE_M,
    rare: { kind: RARE_IMPORT_KIND, perVisit: rarePerVisit(AWAY_DISTANCE_M, scale) },
  };

  const along = (d: number): { pos: { x: number; y: number }; idx: number } => {
    const g = geo!;
    const dd = Math.max(0, Math.min(g.len, d));
    let i = 0;
    while (i < g.cum.length - 1 && g.cum[i + 1]! < dd) i++;
    const a = g.route[i]!;
    const b = g.route[Math.min(i + 1, g.route.length - 1)]!;
    const seg = g.cum[Math.min(i + 1, g.cum.length - 1)]! - g.cum[i]!;
    const f = seg > 1e-9 ? (dd - g.cum[i]!) / seg : 0;
    return { pos: { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }, idx: i };
  };

  const caravan = (t: number): CaravanTrip => {
    const g = geo!;
    const day = Math.floor(t / FOOD_DAY_SEC);
    const uSec = (((t / FOOD_DAY_SEC) % 1) - arriveFrac) * FOOD_DAY_SEC;
    const gate = g.route[0]!;
    const market = g.route[g.route.length - 1]!;
    const base = { day, speed: g.speed };
    if (uSec < 0 || uSec >= g.walk * 2 + TRADE_DWELL_SEC) {
      return { ...base, phase: "away", pos: gate, walkTo: null };
    }
    const back = g.route.slice(0, -1).reverse();
    if (uSec < g.walk) {
      const { pos, idx } = along(uSec * g.speed);
      const out: Array<{ x: number; y: number; dwell?: number }> = g.route.slice(idx + 1);
      if (out.length) out[out.length - 1] = { ...out[out.length - 1]!, dwell: TRADE_DWELL_SEC };
      return { ...base, phase: "arriving", pos, walkTo: [...out, ...back] };
    }
    if (uSec < g.walk + TRADE_DWELL_SEC) {
      return {
        ...base,
        phase: "trading",
        pos: market,
        walkTo: [{ ...market, dwell: g.walk + TRADE_DWELL_SEC - uSec }, ...back],
      };
    }
    const { pos, idx } = along(g.len - (uSec - g.walk - TRADE_DWELL_SEC) * g.speed);
    return { ...base, phase: "leaving", pos, walkTo: g.route.slice(0, Math.max(1, idx)).reverse() };
  };

  /** ⚖️ G2 — the live export scale, clamped to [0,1] at the boundary so a
   *  misbehaving reader can neither mint surplus nor invert the pile. Absent
   *  reader ⇒ EXACTLY 1 (not a clamp of 1 — the same literal), so an unscaled
   *  line's arithmetic is untouched. */
  const exportScaleNow = (): number => {
    const s = opts.exportScale?.();
    if (s === undefined) return 1;
    return Number.isFinite(s) ? Math.max(0, Math.min(1, s)) : 1;
  };

  /** ⚖️ G3 — the ranking's own wants for the CURRENT import list, or null for
   *  an authored (unbound) list, which has no reading behind it and therefore
   *  shares the hold alike — exactly what the flat split did. */
  let importWants: Map<string, number> | null = null;
  /** Memo of the weighted split, keyed on the cargo array's IDENTITY: the one
   *  thing that replaces it is `deriveCargo`, which mints a new array. */
  let splitOf: readonly string[] | null = null;
  let splitUnits = new Map<string, number>();
  const importSplit = (): Map<string, number> => {
    if (splitOf === route.imports) return splitUnits;
    const kinds = route.imports;
    const shares = allotmentSplit(
      kinds.map((k) => importWants?.get(k) ?? 1),
      IMPORT_ALLOTMENT,
    );
    splitUnits = new Map(kinds.map((k, i) => [k, shares[i]!]));
    splitOf = kinds;
    return splitUnits;
  };

  /** ⚖️ THE CARGO, DERIVED (R&T ⑤ T2) — ONE definition, called by the bind
   *  (which has the pair's books in hand) and by the host's per-visit refresh
   *  (which has today's). Both sides' reads ⇒ the lists are this pair's
   *  complementary scarcity over this exact road; never called ⇒ the authored
   *  constants stand, which is what an unbound `away:` line carries. */
  const deriveCargo = (scarcity: {
    us: BarterSignals;
    them: BarterSignals;
    goods: readonly string[];
  }): void => {
    const pair = complementaryRanking(
      scarcity.us,
      scarcity.them,
      scarcity.goods,
      route.distanceM,
      scale,
    );
    route.imports = pair.imports.map((r) => r.good);
    route.exports = pair.exports.map((r) => r.good);
    // ⚖️ G3 — KEEP THE EVIDENCE. The ranking's `want` per import good is what
    // weights the hold; it was computed and discarded on this very line.
    importWants = new Map(pair.imports.map((r) => [r.good, r.want]));
  };

  return {
    route,
    depot,
    caravan,
    tradeDay: (t) => Math.floor(t / FOOD_DAY_SEC - arriveFrac - geo!.walk / FOOD_DAY_SEC),
    dayPhase: (t) => {
      const u = t / FOOD_DAY_SEC - arriveFrac - geo!.walk / FOOD_DAY_SEC;
      return ((u % 1) + 1) % 1;
    },
    importUnitsPerVisit: (good) => {
      // The RARE treat is carried BESIDE the allotment (travel cost as
      // scarcity — it has its own distance-scaled count), and wins where a
      // line happens to list it as ordinary cargo too.
      if (good === route.rare.kind) return Math.max(0, route.rare.perVisit);
      if (!route.imports.includes(good)) return 0;
      // ⚖️ G3: the hold is bid for, not divided by headcount. The share is the
      // ranking's own `want` through `allotmentSplit` — worst shortage, biggest
      // share, Σ exactly IMPORT_ALLOTMENT.
      return importSplit().get(good) ?? 0;
    },
    refreshCargo: (scarcity) => {
      if (!route.partnerAt) return; // nobody real to read — the authored list stands
      deriveCargo(scarcity);
    },
    exportPile: (t) => {
      const departFrac = arriveFrac + (geo!.walk * 2 + TRADE_DWELL_SEC) / FOOD_DAY_SEC;
      const since = (((t / FOOD_DAY_SEC - departFrac) % 1) + 1) % 1;
      // ⚖️ G2: SPARENESS, read live. `exportDaily` was fixed at construction —
      // a town could be starving and still pile the same third of its draw at
      // the depot every day, because nothing between the books and the crate
      // ever asked. The thunk is absent for every caller with no books, and
      // then this line is `exportDaily * since` bit for bit.
      return opts.exportDaily * since * exportScaleNow();
    },
    // ⚖️ B5: the pile's own ceiling — `since` at its supremum of 1. ONE
    // definition of "what this line ships in a day", shared with the ramp.
    exportDailyUnits: () => opts.exportDaily * exportScaleNow(),
    bindPartner: (partner) => {
      const g2 = buildGeo(pickGate({ x: partner.at.x - center.x, y: partner.at.y - center.y }));
      if (g2) geo = g2;
      const g = geo!; // non-null since creation (we returned early otherwise)
      route.partnerKey = partner.key;
      route.gate = g.route[0]!;
      route.route = g.route;
      // The ROAD's length when one joins the pair; the chord only when no
      // road does (`at` still aims the gate either way).
      route.distanceM = partner.distanceM !== undefined && partner.distanceM > 0
        ? partner.distanceM
        : Math.hypot(partner.at.x - center.x, partner.at.y - center.y);
      route.rare = { kind: RARE_IMPORT_KIND, perVisit: rarePerVisit(route.distanceM, scale) };
      // ⚖️ THE PARTNER IS NOW REAL, AND THE ROUTE SAYS SO. Downstream readers
      // (the host's trade-partner table) used to have no way to tell a bound
      // line from the `away:` fiction and threw the road away on every one.
      route.partnerAt = { x: partner.at.x, y: partner.at.y };
      if (partner.geo) route.partnerGeo = partner.geo;
      // ⚖️ THE CARGO, DERIVED. Both sides' books in hand ⇒ the lists are this
      // pair's complementary scarcity over this exact road; absent ⇒ the
      // authored constants stand (the unbound fallback).
      if (partner.scarcity) deriveCargo(partner.scarcity);
    },
  };
}
