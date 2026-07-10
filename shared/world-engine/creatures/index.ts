// shared/world-engine/creatures/index.ts — public surface of the creature
// builder ported from seagull-dream.
//
// The body-plan data + geometry builders (blueprint, skeleton, mesh, growth,
// animation) plus the game-facing SPECIES REGISTRY and the runtime CreatureModel
// (dynamic vs. preloaded/baked animation). Graphics-touching, so — like
// render3d.ts — this is NOT re-exported from world-engine/index.ts; import it by
// its subpath. For pure lookups, import ./species directly (no THREE/mesh load).

export * from "./species";
export type { Blueprint } from "./blueprint";
export { clampBlueprint, defaultBlueprint, plantBlueprint } from "./blueprint";
export { buildSkeleton } from "./skeleton";
export { buildCreatureMesh, buildFruitMesh } from "./mesh";
export { CreatureAnimator } from "./animation";
export {
  createBakedCreature,
  createDynamicCreature,
  createCreatureAvatarFactory,
  getSpeciesAssets,
  disposeSpeciesAssets,
  type CreatureModel,
  type CreatureLook,
  type CreatureDriveOptions,
  type CreateCreatureOptions,
  type SpeciesAssets,
  type CreatureAvatarFactoryOptions,
} from "./creature-model";
