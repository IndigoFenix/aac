/**
 * economy-pastoral.ts — HORSES, the grazing economy's working animal
 * (substrate-civilization-rules.md). The chain lives in
 * content/pastoral.economy.json, shape-checked at import like clothing:
 *
 *   pasture (chartered grass) → stables (industry tier, granary 30 —
 *   a plank cost is unreachable: the smiths' standing draw outruns
 *   sawmill output, so the plank store never banks; the fed-transient
 *   law, measured) → a horse herd that breeds only into stable headroom
 *   (no stables ⇒ the founding string dwindles) → `horsepower`,
 *   mustered from the ACTUAL herd (capacityRate 8 per stable).
 *
 * Horses eat no commodity — they graze the commons the pasture charter
 * stands for (a diet-free, pens-capped domestic; contrast sheep, which
 * eat cut fodder off the farms). Their economic output is TRANSPORT:
 * `horsepower` is what a composition feeds to the travel rules as
 * `mount` (TravelOpts.mount) — mounted routes fly on open grass and on
 * roads, so a horse town trades farther and its rare imports come easier.
 *
 * This pack is for BIOSPHERE worlds (an applied ecology): on a bare
 * substrate `pasture` charters 0 and no stable is ever built — honest,
 * not an error.
 */

import raw from "./content/pastoral.economy.json";
import { parseEconomyDoc } from "./economy-json";
import type { EconomyDoc } from "./economy";

export const PASTORAL: EconomyDoc = parseEconomyDoc(raw, "pastoral.economy.json");

/** One working mount per 50 souls fully mounts a town's traffic —
 *  couriers and carts, not everyone in a saddle. */
export const MOUNT_PER_CAPITA = 0.02;

/** A town's mount saturation (TravelOpts.mount) from its books:
 *  horsepower against what its population's traffic can use. */
export function mountLevel(horsepower: number, population: number): number {
  if (!(population > 0)) return 0;
  return Math.max(0, Math.min(1, horsepower / (population * MOUNT_PER_CAPITA)));
}
