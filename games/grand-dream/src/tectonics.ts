/**
 * tectonics.ts — SHIM. The plate-tectonics provider moved into the shared
 * engine's geology layer (shared/engine/geology/tectonics.ts) in the
 * engine carve; it was already dependency-free. Its output contract is
 * unchanged: `bakeAuthors` plugs straight into `prepareSubstrate`.
 */
export * from "@shared/engine/geology/tectonics";
