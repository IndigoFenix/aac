/**
 * food.ts — the game face of the shared street-goods machinery
 * (shared/engine/town/goods.ts, this file until the engine carve) plus
 * the CONTENT that stays grand-dream's: the founding FOOD and TOOLS
 * descriptors and the wrappers that resolve THIS game's registry
 * (`tri.economy`, falling back to the standard DEFAULT_ECONOMY). Every
 * pre-carve call site keeps its exact signature and behavior — hash
 * draws included, so towns and routines stay byte-identical.
 */

import {
  createTownGoods as sharedCreateTownGoods, hasLedger, streetGoods,
  PANTRY_DAYS, SHOP_SEC,
  type GoodSpec, type TownFood, type TownGoods,
} from "@shared/world-engine/kernel/town/goods";
import type { TownPlan } from "@shared/world-engine/kernel/town/plan";
import type { TownStreets } from "@shared/world-engine/kernel/town/streets";
import type { TriWorld } from "./tri";
import { DEFAULT_ECONOMY } from "./economy-core";

export * from "@shared/world-engine/kernel/town/goods";

/** This world's work/goods registry — the compiled economy it was built
 *  from, or the standard one (pre-content worlds and stub tris). */
const ecoOf = (tri: Pick<TriWorld, "economy">) => tri.economy ?? DEFAULT_ECONOMY;

/** The founding instance: food, exactly as it behaved before the
 *  descriptor existed (hash keys included — same towns, same routines). */
export const FOOD_GOOD: GoodSpec = {
  key: "food",
  needScalar: "food_need",
  gotScalar: "food_got",
  sellers: ["market", "farm"],
  shelved: ["market"],
  producers: ["farm", "hall"],
  perCapitaDaily: 1,
  capDays: PANTRY_DAYS,
  shopSec: SHOP_SEC,
  cartRations: 25,
  unit: "rations",
  stockColor: "#e0b25c",
  boxLabel: "Pantry",
  errandName: "shopping",
  slot: 0,
};

/** The SECOND need — tools, the goods2 manufactured commodity. Humans
 *  have demanded these at the aggregate since step 5b (trait demand →
 *  `tools_need`, flow net → `tools_got`); this descriptor makes the
 *  street render it: smithies sell over a stocked shelf, and in a town
 *  with none the hall hands out what the roads bring (the same fallback
 *  food uses). Tools LAST — capDays 9 paces the errand at a third of the
 *  food cadence, so the wares run reads as the occasional trip it is.
 *  The unit stays the ration doctrine: one person-day of the good. */
export const TOOLS_GOOD: GoodSpec = {
  key: "tools",
  needScalar: "tools_need",
  gotScalar: "tools_got",
  sellers: ["smithy"],
  shelved: ["smithy"],
  producers: ["smithy"],
  // ⚖️ F4 RIPPLE (economy-arc-opening.md, 2026-08-09): the RATION is the unit —
  // one person-day of the founding staple — and the compiler now quotes every
  // street good against it instead of hard-setting 1 for all of them. This
  // world's own books have always said `tools` is drawn at 0.0002 a head
  // against food's 0.001, i.e. a FIFTH of a ration, and the frozen descriptor
  // has to say what the compiler emits or `economy-equivalence` is measuring
  // nothing. Wares boxCap 45 → 9 tool-days follows; the cadence (`capDays 9`)
  // is untouched — `shopPeriod` never read this number.
  perCapitaDaily: 0.2,
  capDays: 9,
  shopSec: 26,
  cartRations: 40,
  unit: "tool-days",
  stockColor: "#9aa4b2",
  boxLabel: "Wares chest",
  errandName: "wares",
  slot: 1,
};

/** Pre-carve signature: the registry resolves from the world. */
export function createTownGoods(
  tri: TriWorld,
  town: { key: string; center: { x: number; y: number }; plan: TownPlan },
  seed: number,
  good: GoodSpec,
  roads?: TownStreets,
): TownGoods {
  return sharedCreateTownGoods(tri, ecoOf(tri), town, seed, good, roads);
}

/** The FOOD instance — the founding good; every pre-descriptor call site
 *  is this. Behavior (hash draws included) is unchanged from when food
 *  was the only commodity the streets knew. */
export function createTownFood(
  tri: TriWorld,
  town: { key: string; center: { x: number; y: number }; plan: TownPlan },
  seed: number,
  roads?: TownStreets,
): TownFood {
  return createTownGoods(tri, town, seed, FOOD_GOOD, roads);
}

/** ALL of a town's street goods, in slot order — the world's compiled
 *  economy registry (or the standard fallback), filtered to the ledgers
 *  this settlement actually keeps. */
export function streetGoodsFor(
  tri: TriWorld,
  town: { key: string; center: { x: number; y: number }; plan: TownPlan },
  seed: number,
  roads?: TownStreets,
): TownGoods[] {
  return streetGoods(tri, ecoOf(tri), town, seed, roads);
}

/** The TOOLS instance — null in worlds whose aggregate never learned the
 *  commodity (no `tools_need`/`tools_got` vars ⇒ nothing to project; the
 *  street never invents a ledger the settlement doesn't keep). */
export function createTownWares(
  tri: TriWorld,
  town: { key: string; center: { x: number; y: number }; plan: TownPlan },
  seed: number,
  roads?: TownStreets,
): TownGoods | null {
  if (!hasLedger(tri, TOOLS_GOOD) || !(tri.dual as unknown as { entityWorld?: unknown }).entityWorld) return null;
  return createTownGoods(tri, town, seed, TOOLS_GOOD, roads);
}
