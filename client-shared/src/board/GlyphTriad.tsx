// client-shared/src/board/GlyphTriad.tsx
//
// THE CATEGORY FACE: a group/category button drawn as a small cluster of the
// members it contains, instead of one member standing in for all of them. A
// single apple says "apple"; an apple, a banana and a cookie together say
// "food" — which is what the chip is actually for.
//
// Layout (user-specified): one face on each side and one below them in the
// middle — a triangle inside the button's square icon box. Two faces sit side
// by side; one face fills the box, so the component degrades to exactly the
// old single-glyph rendering when a group can only offer one example.
//
// Client-agnostic like the rest of this folder: geometry is inline styles (no
// Tailwind, no stylesheet) and the actual drawing is the caller's own Glyph
// wrapper, so the AAC bundle and the world-lab bench share one source of truth
// for how a category reads.

import type { ComponentType } from "react";
import type { GlyphRenderProps } from "./types";

export interface GlyphTriadProps {
  /** Faces to draw, BEST EXAMPLE FIRST. Beyond three are ignored. */
  glyphs: readonly string[];
  /** The client's own Glyph wrapper (AAC = animated + fillSlot; lab = bundled). */
  GlyphComponent: ComponentType<GlyphRenderProps>;
  /** Safe fallback glyph for every face (usually the group's own id). */
  fallback?: string;
  /** Label for the cluster as a whole; the faces themselves are decorative. */
  ariaLabel?: string;
}

/** Max faces the cluster draws — matches the engine's GROUP_EXEMPLARS. */
const MAX_FACES = 3;
/** Space between faces, as a share of the icon box (proportional, so the
 *  cluster reads the same at any chip size). */
const GAP = "6%";
/** One face's share of the box — what a grid column is once the gap is out.
 *  The bottom face spans both columns, so it has to be told this explicitly or
 *  it would draw wider than the pair above it. */
const FACE = `calc((100% - ${GAP}) / 2)`;

export function GlyphTriad({ glyphs, GlyphComponent, fallback, ariaLabel }: GlyphTriadProps) {
  const faces = glyphs.filter((g) => !!g).slice(0, MAX_FACES);
  if (faces.length === 0) {
    return fallback ? (
      <GlyphComponent glyph={fallback} ariaLabel={ariaLabel} noBackground />
    ) : null;
  }
  if (faces.length === 1) {
    return (
      <GlyphComponent glyph={faces[0]} fallback={fallback} ariaLabel={ariaLabel} noBackground />
    );
  }
  const pair = faces.length === 2;
  return (
    <div
      role="img"
      aria-label={ariaLabel}
      style={{
        width: "100%",
        height: "100%",
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        // A pair reads as one row centred in the box; a trio takes the
        // two-above-one-below triangle.
        gridTemplateRows: pair ? "1fr" : "1fr 1fr",
        // Separated, so the faces stay three things — touching, they read as
        // one blob rather than three examples.
        gap: GAP,
        placeItems: "center",
      }}
    >
      {faces.map((glyph, i) => (
        <span
          key={`${glyph}-${i}`}
          aria-hidden
          style={{
            // The third face spans both columns at one column's width, so it
            // sits centred UNDER the pair rather than beside them.
            ...(i === 2 ? { gridColumn: "1 / span 2", width: FACE } : { width: "100%" }),
            aspectRatio: "1",
            display: "block",
          }}
        >
          <GlyphComponent glyph={glyph} fallback={fallback} noBackground />
        </span>
      ))}
    </div>
  );
}
