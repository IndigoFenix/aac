// shared/call/video-layout.ts
//
// Pure, transport-agnostic helpers for arranging multi-participant video tiles.
// Shared by the clinician CallView and the AAC large-video window so both speak
// the same layout vocabulary. No React, no DOM — just which tile is prominent
// and in what order the rest are laid out, so it is trivially unit-testable.

export type VideoLayoutMode =
  | "spotlight" // one prominent tile + a thumbnail strip of the rest
  | "grid"      // everyone in an even grid (gallery)
  | "compact"   // a thin strip of small tiles (board/app keeps the space)
  | "auto";     // like spotlight, but the prominent tile follows the speaker

/** The four selectable modes, in display order. */
export const VIDEO_LAYOUT_MODES: VideoLayoutMode[] = ["spotlight", "grid", "compact", "auto"];

export interface ArrangedLayout {
  /** The single prominent tile id (spotlight / auto), or null (grid / compact). */
  spotlightId: string | null;
  /** The remaining tiles in display order. For spotlight/auto this EXCLUDES the
   *  prominent tile; for grid/compact it is every tile. */
  strip: string[];
  /** Suggested column count for a grid of `strip` (≈ square). 1 when empty. */
  gridColumns: number;
}

export interface SpotlightInputs {
  /** A tile the user explicitly pinned as prominent (highest priority). */
  manualPin?: string | null;
  /** The current active speaker (drives "auto", and a fallback for spotlight). */
  activeSpeakerId?: string | null;
}

/** Choose which participant should occupy the prominent slot.
 *  Priority: a still-present manual pin → the active speaker → the first tile. */
export function pickSpotlightId(tileIds: string[], inputs: SpotlightInputs = {}): string | null {
  if (tileIds.length === 0) return null;
  const { manualPin, activeSpeakerId } = inputs;
  if (manualPin && tileIds.includes(manualPin)) return manualPin;
  if (activeSpeakerId && tileIds.includes(activeSpeakerId)) return activeSpeakerId;
  return tileIds[0];
}

/** ~square column count for `n` tiles (1,2→2 cols handled by ceil(sqrt)). */
export function gridColumnsFor(n: number): number {
  if (n <= 1) return 1;
  return Math.ceil(Math.sqrt(n));
}

/** Arrange `tileIds` for the given mode. `spotlightId` is honored only by
 *  spotlight/auto; grid/compact lay every tile out evenly. */
export function arrangeTiles(
  mode: VideoLayoutMode,
  tileIds: string[],
  spotlightId: string | null,
): ArrangedLayout {
  if (mode === "spotlight" || mode === "auto") {
    const prominent = spotlightId && tileIds.includes(spotlightId) ? spotlightId : (tileIds[0] ?? null);
    const strip = tileIds.filter((id) => id !== prominent);
    return { spotlightId: prominent, strip, gridColumns: gridColumnsFor(strip.length) };
  }
  // grid / compact: everyone, no prominent tile.
  return { spotlightId: null, strip: [...tileIds], gridColumns: gridColumnsFor(tileIds.length) };
}
