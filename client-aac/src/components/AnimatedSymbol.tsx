// client-aac/src/components/AnimatedSymbol.tsx
//
// Generic hover-animated sprite. Driven entirely by a registry SYMBOL's
// `animatedSprite` facet — pass the facet, the component picks up the
// asset, frame layout, and frame sequence from there. Hover detection
// uses the same [data-dwell] ancestor mechanism as YesNoSprite did so
// the animation triggers on mouse hover OR eyegaze dwell on the
// enclosing SENTENCE BUTTON.
//
// Adding a new animated SYMBOL is now a two-step job:
//   1. Add the asset to SPRITE_SHEETS below.
//   2. Set the SYMBOL's `animatedSprite` facet in shared/glyph-registry.ts.
// No bespoke component per symbol — the compositor automatically routes
// any SYMBOL with this facet through AnimatedSymbol.

import { useEffect, useRef, useState } from "react";
import { useEyeTrackingDwell } from "@/contexts/EyeTrackingDwellContext";
import type { AnimatedSpriteFacet } from "@shared/glyph-registry";
import yesNoSpritesUrl from "@assets/aac-icons/basic/yes-no-sprites.png";

/**
 * Maps a registry `sheet` id to the bundled asset URL. Kept on the client
 * side so the registry (imported by server code) stays free of bundler-
 * specific asset imports. Add new spritesheets here and reference them by
 * `sheet` in the registry entry.
 */
const SPRITE_SHEETS: Record<string, string> = {
  "yes-no-sprites": yesNoSpritesUrl,
};

const DEFAULT_FRAME_DURATION_MS = 130;

interface AnimatedSymbolProps {
  facet: AnimatedSpriteFacet;
  /** Pixel size or any CSS length (e.g. "100%"). */
  size: number | string;
  className?: string;
  /**
   * Override the auto-detected dwell target. Mostly used by surfaces that
   * render outside a [data-dwell] ancestor (e.g. a preview tile).
   */
  forceAnimating?: boolean;
}

/**
 * Renders one sprite frame as a CSS background-positioned div. The sheet
 * is sized so each frame is one viewport tile — moving the
 * `background-position` by `(100 / (cols - 1))%` advances exactly one
 * frame. Same trick the previous YesNoSprite used; the math is now
 * derived from the facet's `cols`/`rows` so any sheet layout works.
 */
export function AnimatedSymbol({ facet, size, className = "", forceAnimating }: AnimatedSymbolProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [mouseHover, setMouseHover] = useState(false);
  const [frame, setFrame] = useState(facet.frames[0] ?? 0);
  const [dwellHost, setDwellHost] = useState<Element | null>(null);
  const { dwellTarget } = useEyeTrackingDwell();

  // Latch the enclosing dwell target once mounted so we can match against dwellTarget.
  useEffect(() => {
    if (ref.current) {
      setDwellHost(ref.current.closest("[data-dwell]"));
    }
  }, []);

  // Mouse hover on the host button.
  useEffect(() => {
    if (!dwellHost) return;
    const enter = () => setMouseHover(true);
    const leave = () => setMouseHover(false);
    dwellHost.addEventListener("pointerenter", enter);
    dwellHost.addEventListener("pointerleave", leave);
    return () => {
      dwellHost.removeEventListener("pointerenter", enter);
      dwellHost.removeEventListener("pointerleave", leave);
    };
  }, [dwellHost]);

  const dwellHover = !!dwellHost && dwellTarget?.element === dwellHost;
  const animating = forceAnimating ?? (mouseHover || dwellHover);

  useEffect(() => {
    const sequence = facet.frames.length > 0 ? facet.frames : [0];
    if (!animating) {
      setFrame(sequence[0]);
      return;
    }
    let i = 0;
    setFrame(sequence[0]);
    const interval = setInterval(() => {
      i = (i + 1) % sequence.length;
      setFrame(sequence[i]);
    }, facet.frameDuration ?? DEFAULT_FRAME_DURATION_MS);
    return () => clearInterval(interval);
  }, [animating, facet]);

  const sheetUrl = SPRITE_SHEETS[facet.sheet];
  if (!sheetUrl) {
    // Unknown sheet — render nothing rather than crash. Surfaces that need
    // a fallback should detect missing sheets upstream and fall back to the
    // SYMBOL's emoji/imagePath.
    return null;
  }

  // With background-size at `cols*100% × rows*100%`, the sprite tiles the
  // container `cols` × `rows` times; moving background-position by
  // `100/(cols-1)%` advances one column / one row.
  const bgX = facet.cols > 1 ? `${(frame / (facet.cols - 1)) * 100}%` : "0%";
  const bgY = facet.rows > 1 ? `${(facet.row / (facet.rows - 1)) * 100}%` : "0%";
  const sizeStyle = typeof size === "number" ? `${size}px` : size;

  return (
    <div
      ref={ref}
      className={className}
      style={{
        width: sizeStyle,
        height: sizeStyle,
        backgroundImage: `url(${sheetUrl})`,
        backgroundSize: `${facet.cols * 100}% ${facet.rows * 100}%`,
        backgroundPosition: `${bgX} ${bgY}`,
        backgroundRepeat: "no-repeat",
      }}
      aria-hidden="true"
    />
  );
}
