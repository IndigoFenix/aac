/**
 * tri.ts — SHIM + composition binding. The TriWorld (all three layers
 * over one map) moved into the shared engine's civ layer
 * (shared/engine/civ/tri.ts) in the engine carve. This wrapper binds the
 * shared foundTri to PopuSim's `bootLab`, keeping the pre-carve
 * signature for every call site and test.
 */
export * from "@shared/engine/civ/tri";
import { foundTri as foundTriCore, type TriPrep, type FoundTriOpts, type TriWorld } from "@shared/engine/civ/tri";
import { bootLab } from "./boot";

/** The pre-carve signature: PopuSim is this game's composition layer. */
export async function foundTri(prep: TriPrep, opts: FoundTriOpts): Promise<TriWorld> {
  return foundTriCore(prep, opts, bootLab);
}
