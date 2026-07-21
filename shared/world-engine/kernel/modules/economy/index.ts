/**
 * The economy capability as an ENGINE MODULE — the first one, and the
 * template: `parse` is the structural boot gate (path-exact errors,
 * unknown fields rejected), and compiling stays the typed call
 * (`compileEconomy(docs, opts)`) at the game's composition root.
 */

import type { EngineModule } from "../../manifest";
import type { EconomyDoc } from "./economy";
import { parseEconomyDoc } from "./json";

export * from "./economy";
export { parseEconomyDoc } from "./json";

/** Owns the "economy" section: one EconomyDoc per pack, composed by
 *  `compileEconomy` in pack order (cross-pack key override). */
export const ECONOMY_MODULE: EngineModule<EconomyDoc> = {
  key: "economy",
  parse: (section, path) => parseEconomyDoc(section, path),
};
