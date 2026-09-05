// client-shared/src/builder/index.ts
//
// SHARED BY THE AAC STUDENT BUILDER (SentenceConstructorBoard) AND THE
// CLINICIAN "EDIT VISUAL" BUILDER. Change it for both, or for neither.
//
// The whole surface a builder HOST needs. A host supplies orchestration —
// which words to show, what a press does to the glyph, what "done" means — and
// composes these three regions plus their leaves:
//
//   <BuilderDepsProvider value={deps}>
//     <BuilderSidebar tabs={…} chips={…} … />       // two measured columns
//     … action row of <ActionButton> / <ToneToggle> …
//     <ModifierBand … />                            // band + five picker rows
//     <BuilderGrid needsMore={…}>{tiles}</BuilderGrid>
//   </BuilderDepsProvider>
//
// The glyph MUTATION and PRESS-ROUTING laws are not here — they are pure and
// live in `@shared/glyph-builder-ops` (applyModifierPress, autoComposeSlot,
// slotKeyForSelection, …), which both hosts must route every press through.

export { BuilderDepsProvider, useBuilderDeps } from "./deps";
export type { BuilderRenderDeps, BuilderPerson, GlyphRenderProps } from "./types";

export {
  SIDEBAR_BUTTON_FILL,
  SIDEBAR_FALLBACK_BUTTONS,
  SIDEBAR_GAP_PX,
  SIDEBAR_MAX_BUTTONS,
  SIDEBAR_MIN_BUTTONS,
  SIDEBAR_MIN_BUTTON_PX,
  SIDEBAR_PAD_PX,
  sidebarCapacity,
  sidebarDensity,
  sidebarPage,
  type SidebarDensity,
} from "./sidebar-layout";

export {
  CONTACT_CHIP_FACES,
  CONTACTS_CHIP_ICON,
  ENGINE_CONTACTS_CHIP,
  contactChipGlyphs,
  mergeContactTiles,
  orderDirectoryPeople,
  type ContactDirectoryPerson,
  type ContactEngineWord,
  type ContactTile,
  type MergeContactTilesInput,
} from "./contacts";

export { BuilderSidebar, type BuilderSidebarEntry, type BuilderSidebarProps } from "./BuilderSidebar";
export { ModifierBand, type ModifierBandProps, type QualityPair } from "./ModifierBand";
export { BuilderGrid, BuilderGridEmpty, type BuilderGridProps } from "./BuilderGrid";

export {
  ActionButton,
  ColorPickerButton,
  ColorSwatchButton,
  EmotionPickerButton,
  EmotionSwatchButton,
  EngineModifierButton,
  EngineWordButton,
  GridButton,
  ImageTile,
  isLightColor,
  ModifierButton,
  MoreButton,
  PageBackButton,
  PersonButton,
  PickerToggleButton,
  QualityToggleButton,
  tabKeyActivate,
  ToneToggle,
  useItemLabel,
  type ActionButtonProps,
  type EngineWordButtonProps,
  type GridButtonProps,
  type ImageTileProps,
  type ModifierButtonProps,
  type PagingButtonProps,
  type PersonButtonProps,
  type ToneToggleProps,
} from "./buttons";

// Convenience re-exports so a host has one import for the grid's paging rule.
export {
  BUILDER_GRID_CELLS,
  BUILDER_ITEMS_WITH_MORE,
  pageBuilderGrid,
} from "@shared/aac-builder-paging";
