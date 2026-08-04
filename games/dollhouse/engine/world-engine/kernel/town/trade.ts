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
import { roadRoute, type TownStreets } from "./streets";
import type { TownPlan } from "./plan";
// ⚖️ §7 step 6: the town rung reads the REGION rung's arithmetic. The 2026-08-02
// survey's whole indictment of freight.ts was "Real value−cost arithmetic. …
// NOT IMPORTED BY ANY TOWN OR BODY MODULE" — this import is that sentence
// being served. freight.ts is read-only from here, forever.
import { carryReachM, freightOf } from "../../freight";
import { DOLLHOUSE_SCALE, type WorldScale } from "../../scale";

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
  /** What arrives (goods the town doesn't make) / what leaves (the surplus). */
  imports: readonly string[];
  exports: readonly string[];
  /** TRAVEL COST made visible: how far the partner is (world meters; the
   *  abstract partner reads as a far one) and the RARE import it carries —
   *  the farther the road, the fewer arrive each visit. */
  distanceM: number;
  rare: { kind: string; perVisit: number };
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
  /** Export units piled at `t`: fills from the last departure toward the next
   *  (the caravan takes the pile with it). UN-damped — the host multiplies by
   *  producer attendance so absent crews truthfully thin the load. */
  exportPile(t: number): number;
  /** Bind the line to a REAL partner (a cluster hamlet; later a
   *  hierarchical-cells neighbor): re-aims the gate toward it, rebuilds the
   *  entry route, and re-scales the rare allotment by the true distance. */
  bindPartner(partner: { key: string; at: { x: number; y: number } }): void;
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
/** v1 import kinds: trinkets outside the subsistence economy (translated glyphs). */
export const TRADE_IMPORT_KINDS: readonly string[] = ["ball", "teddy", "blocks"];

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
  },
): TownTrade | null {
  const scale = opts.scale ?? DOLLHOUSE_SCALE;
  // Candidate GATES: every street tip. Unbound, the farthest tip is the road
  // out of town; bound to a real partner, the tip most ALIGNED with it wins
  // (weighted by length, so a stub pointing the right way doesn't beat the
  // arterial) — the caravan comes in from where the partner actually lies.
  const tips: Array<{ x: number; y: number }> = [];
  for (const st of streets.streets) {
    for (const pt of st.pts) tips.push(pt);
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
  // depot by design, goods.ts). Fallback: the plaza center.
  const hallIdx = plan.works.findIndex((wk) => wk.type === "hall");
  const hallDoor =
    hallIdx >= 0 ? workDoorstep(center, plan.works[hallIdx]!) : { x: center.x, y: center.y };
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

  return {
    route,
    depot,
    caravan,
    tradeDay: (t) => Math.floor(t / FOOD_DAY_SEC - arriveFrac - geo!.walk / FOOD_DAY_SEC),
    exportPile: (t) => {
      const departFrac = arriveFrac + (geo!.walk * 2 + TRADE_DWELL_SEC) / FOOD_DAY_SEC;
      const since = (((t / FOOD_DAY_SEC - departFrac) % 1) + 1) % 1;
      return opts.exportDaily * since;
    },
    bindPartner: (partner) => {
      const g2 = buildGeo(pickGate({ x: partner.at.x - center.x, y: partner.at.y - center.y }));
      if (g2) geo = g2;
      const g = geo!; // non-null since creation (we returned early otherwise)
      route.partnerKey = partner.key;
      route.gate = g.route[0]!;
      route.route = g.route;
      route.distanceM = Math.hypot(partner.at.x - center.x, partner.at.y - center.y);
      route.rare = { kind: RARE_IMPORT_KIND, perVisit: rarePerVisit(route.distanceM, scale) };
    },
  };
}
