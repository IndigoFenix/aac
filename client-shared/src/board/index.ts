// client-shared/src/board/index.ts
// Barrel for the unified AAC board renderer shared by both React clients.

export * from "./types";
export { BoardButtonVisual } from "./BoardButtonVisual";
export type { BoardButtonVisualProps } from "./BoardButtonVisual";
export { GlyphTriad } from "./GlyphTriad";
export type { GlyphTriadProps } from "./GlyphTriad";
// Note: the full board GRID renderer is the AAC client's DynamicBoard, reused by
// PrebuiltBoardSection. Only the per-button visual is shared cross-client, since
// the grid is bound to AAC-only contexts (TTS / language / dual-agent).
