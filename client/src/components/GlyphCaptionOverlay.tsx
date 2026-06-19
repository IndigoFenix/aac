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

import { useEffect, useRef, useState } from 'react';
import { Glyph } from '@/components/Glyph';
import { parseGlyph } from '@shared/glyph-compositor';

export type OverlayPosition = 'bottom' | 'top';

interface GlyphCaptionOverlayProps {
  /** The glyph SENTENCE to show, or empty/undefined to show nothing. */
  glyph?: string;
  /** Stand-in glyph shown until a `generate:` image resolves. */
  fallback?: string;
  /** Vertical placement over the video. Defaults to bottom. */
  position?: OverlayPosition;
  /** Preferred glyph height in px (the CAP). Actual height shrinks to fit a
   *  narrow video so the band never overflows. Width follows the slot count. */
  height?: number;
  /** Mirror glyphs for RTL caption languages (Hebrew/Arabic). */
  rtl?: boolean;
}

// Horizontal chrome the band eats: outer px-3 (12+12) + inner px-3 (12+12).
const HORIZONTAL_CHROME = 48;

export function GlyphCaptionOverlay({
  glyph,
  fallback,
  position = 'bottom',
  height = 64,
  rtl = false,
}: GlyphCaptionOverlayProps) {
  // Measure the band's available width (it spans the video via inset-x-0) so
  // the glyph scales DOWN to fit a narrow/portrait video instead of spilling
  // past its edges. ResizeObserver tracks the video being resized/responsive.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [availWidth, setAvailWidth] = useState(0);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      setAvailWidth(entries[0]?.contentRect.width ?? 0);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (!glyph) return null;

  // The compositor fills its container (width defaults to 100%), so it needs an
  // explicitly-sized box or it collapses to zero width. Size the box to the
  // glyph's slot count (1–3 GLYPHs), each roughly square, then shrink the
  // per-slot size so slots*size fits the measured width.
  const slots = Math.min(3, Math.max(1, parseGlyph(glyph).slots.length));
  const usableWidth = availWidth > 0 ? Math.max(0, availWidth - HORIZONTAL_CHROME) : 0;
  const maxByWidth = usableWidth > 0 ? Math.floor(usableWidth / slots) : height;
  const size = Math.max(20, Math.min(height, maxByWidth));

  return (
    <div
      ref={wrapRef}
      className={
        'pointer-events-none absolute inset-x-0 flex justify-center px-3 ' +
        (position === 'bottom' ? 'bottom-3' : 'top-3')
      }
      data-testid="glyph-caption-overlay"
    >
      <div className="rounded-lg bg-black/55 backdrop-blur-sm px-3 py-1.5 shadow-lg">
        <div style={{ height: size, width: slots * size }}>
          <Glyph glyph={glyph} fallback={fallback} noBackground rtl={rtl} />
        </div>
      </div>
    </div>
  );
}
