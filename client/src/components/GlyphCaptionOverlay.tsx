// client/src/components/GlyphCaptionOverlay.tsx
//
// Presentational glyph "subtitle" overlay for the Video Caption Studio. Renders
// the currently-active glyph SENTENCE as a centered, legible band over a video.
// It is positioned ABSOLUTELY, so the caller must place it inside a
// `position: relative` container that also holds the <video>.
//
// Kept as a standalone, state-free component so the same visual contract (which
// glyph, where, how big) can be mirrored by the WebCodecs canvas compositor in
// the export step.

import { Glyph } from '@/components/Glyph';

export type OverlayPosition = 'bottom' | 'top';

interface GlyphCaptionOverlayProps {
  /** The glyph SENTENCE to show, or empty/undefined to show nothing. */
  glyph?: string;
  /** Vertical placement over the video. Defaults to bottom. */
  position?: OverlayPosition;
  /**
   * Glyph height. Number → px; string → any CSS length. Defaults to a clamp
   * that scales with the player width while staying readable.
   */
  height?: number | string;
}

export function GlyphCaptionOverlay({
  glyph,
  position = 'bottom',
  height = 'clamp(40px, 11vw, 88px)',
}: GlyphCaptionOverlayProps) {
  if (!glyph) return null;

  return (
    <div
      className={
        'pointer-events-none absolute inset-x-0 flex justify-center px-3 ' +
        (position === 'bottom' ? 'bottom-3' : 'top-3')
      }
      data-testid="glyph-caption-overlay"
    >
      <div className="rounded-lg bg-black/55 backdrop-blur-sm px-3 py-1.5 shadow-lg">
        <Glyph glyph={glyph} height={height} noBackground />
      </div>
    </div>
  );
}
