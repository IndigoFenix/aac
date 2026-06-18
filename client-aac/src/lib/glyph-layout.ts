// client-aac/src/lib/glyph-layout.ts
//
// Sizing helpers for glyphs rendered at a FIXED HEIGHT with natural width —
// e.g. the glyphInputTranslation strips (header + binary-choice overlay).
//
// <Glyph> renders an absolutely-positioned SVG inside a `width:100%; height:100%`
// wrapper, so it can't claim an intrinsic width: the parent must supply one.
// In a shrink-to-fit container (a flex item that isn't stretched) `width:100%`
// collapses to 0 and the glyph renders blank. These helpers give such a
// container an explicit width that matches the glyph's slot-count aspect ratio
// (each slot is ~square), so the SVG has a real box to fill.

/**
 * Count the displayed slots in a glyph string, ignoring the trailing `#tone`
 * operator part. Mirrors the compositor's body-split (`+` separates slots) and
 * its MAX_SLOTS=16 clamp. Always ≥1 so an empty/odd string still gets a box.
 */
export function countGlyphSlots(glyph: string | undefined): number {
  const body = (glyph ?? "").split("#")[0];
  const n = body.split("+").map((s) => s.trim()).filter(Boolean).length;
  return Math.min(Math.max(n, 1), 16);
}

/**
 * CSS width for a glyph rendered at `heightRem` tall, sized to its slot-count
 * aspect ratio (square slots). Capped at `capVw` viewport-width so a long
 * translation can't overflow the screen — past the cap the SVG meet-scales
 * down and letterboxes within the fixed height.
 */
export function glyphStripWidth(
  glyph: string | undefined,
  heightRem = 5,
  capVw = 90,
): string {
  return `min(${countGlyphSlots(glyph) * heightRem}rem, ${capVw}vw)`;
}
