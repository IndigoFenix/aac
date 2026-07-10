/**
 * economy-wildlife.ts — URBAN WILDLIFE as content: the loader shim for
 * content/wildlife.economy.json. Rats are the founding commensal — a
 * settlement SCALAR chasing a derived carrying capacity (2% of the
 * civic population, at 5%/day), never a PopuSim identity: vermin scale
 * with the city, nobody owns them, and the street renders them as
 * ambient scurries after dark. The compiler emits the whole mechanism
 * (pop var + cap process + `toward` rule) from the one species entry.
 */

import raw from "./content/wildlife.economy.json";
import { parseEconomyDoc } from "./economy-json";
import type { EconomyDoc } from "./economy";

export const WILDLIFE: EconomyDoc = parseEconomyDoc(raw, "wildlife.economy.json");
