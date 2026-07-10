/**
 * economy-dwarves.ts — a SECOND SAPIENT PEOPLE as content: the loader
 * shim for content/dwarves.economy.json (step 6f, the wild-field seam).
 *
 * Dwarves are full citizens with DIFFERENT NEEDS (twice the human
 * metal demand — mountain folk love their iron) and, crucially, their
 * own WILD substrate field: `dwarves` pools on the ORE (capacity =
 * ore × 2, the `people` logistic pattern via `wildSubstrate`), so
 * dwarven crowds condense on the ridges where human crowds condense in
 * the river valleys. Foundings scout every species' field and harvest
 * everyone in the box — ore-ridge camps found dwarven-majority, border
 * towns found MIXED, and since mountain charters seed separatism, the
 * dwarven mining civ secedes emergently, not by script.
 */

import raw from "./content/dwarves.economy.json";
import { parseEconomyDoc } from "./economy-json";
import type { EconomyDoc } from "./economy";

export const DWARVES: EconomyDoc = parseEconomyDoc(raw, "dwarves.economy.json");
