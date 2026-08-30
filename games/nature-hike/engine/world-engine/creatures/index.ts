// shared/world-engine/creatures/index.ts — public surface of the creature
// builder ported from seagull-dream.
//
// The body-plan data + geometry builders (blueprint, skeleton, mesh, growth,
// animation) plus the game-facing SPECIES REGISTRY and the runtime CreatureModel
// (dynamic vs. preloaded/baked animation). Graphics-touching, so — like
// render3d.ts — this is NOT re-exported from world-engine/index.ts; import it by
// its subpath. For pure lookups, import ./species directly (no THREE/mesh load).

export * from "./species";
export {
  parseCreatureMod,
  applyAppearanceMods,
  appearanceModTag,
  deriveModSpecies,
  speciesMatches,
  setActiveCreatureMods,
  activeCreatureMods,
  type CreatureMod,
  type DerivedSpecies,
  type FieldRule,
  type SpeciesSelector,
} from "./mods";
export { listCreatureMods, getCreatureMod, resolveCreatureMods } from "./mod-library";
export { applyWorldCreatureMods, previewModSpecies, type InstalledCreatureMods } from "./world-mods";
export type { Blueprint } from "./blueprint";
export { clampBlueprint, defaultBlueprint, plantBlueprint } from "./blueprint";
export {
  GARMENT_KINDS,
  GARMENT_RANGES,
  MAX_GARMENTS,
  OUTFIT_PRESET_COUNT,
  GARMENT_WEARABLE_HEADS,
  GARMENT_COLORS,
  GARMENT_COLOR_HEX,
  DEFAULT_DRESS_PALETTE,
  clampGarment,
  clampOutfit,
  defaultGarment,
  outfitPresetFor,
  outfitIndexOf,
  outfitIndexForDress,
  dressPaletteFrom,
  garmentOfIndex,
  garmentGlyphOfIndex,
  type GarmentBlueprint,
  type GarmentKind,
  type OutfitBlueprint,
  type WearableHead,
  type GarmentColorGlyph,
  type DressPalette,
} from "./clothing";
export { buildSkeleton } from "./skeleton";
export { buildCreatureMesh, buildFruitMesh } from "./mesh";
export { CreatureAnimator, type BodyActivity } from "./animation";
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
