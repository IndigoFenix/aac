/**
 * dual.ts — SHIM + composition binding. The DualWorld coupling moved into
 * the shared engine's civ layer (shared/engine/civ/dual.ts) in the engine
 * carve. PopuSim stays game-side (the demography backend is the game's
 * concern, like the town layer's economy registry): this wrapper binds
 * the shared coupling to `bootLab`, keeping the pre-carve signature for
 * every call site and test.
 */
export * from "@shared/engine/civ/dual";
import { bootDual as bootDualCore, type DualSpec, type DualWorld } from "@shared/engine/civ/dual";
import { bootLab } from "./boot";

/** The pre-carve signature: PopuSim is this game's composition layer. */
export async function bootDual(spec: DualSpec, seed: number): Promise<DualWorld> {
  return bootDualCore(spec, seed, bootLab);
}
