// client-aac/src/components/Glyph.tsx
//
// Thin wrapper around <GlyphCompositor /> that wires in the AAC client's
// default image resolver and RTL preference. Use this anywhere a glyph
// string needs to be rendered as a self-contained visual — board buttons,
// the sentence-builder display, the AI strip, etc. Centralising the wiring
// keeps the resolver/glob set-up in exactly one place and lets us swap in
// a different resolver later without touching every render site.

import { GlyphCompositor } from "@shared/glyph-compositor.tsx";
import type { ParsedGlyph } from "@shared/glyph-compositor";
import type { AnimatedSpriteFacet } from "@shared/glyph-registry";
import { defaultImageResolver, markSymbolUrlFailed, useDisplayGlyph } from "@/lib/glyph-images";
import { useLanguage } from "@/contexts/LanguageContext";
import { AnimatedSymbol } from "@/components/AnimatedSymbol";

/**
 * Renderer wired into the compositor for SYMBOLs with an `animatedSprite`
 * facet. Defined once here so every Glyph mount shares the same identity,
 * and so the asset-import side (AnimatedSymbol → Vite-bundled PNGs) stays
 * isolated from the shared compositor.
 */
const renderAnimatedSymbolAac = (facet: AnimatedSpriteFacet, _key: string) => (
  <AnimatedSymbol facet={facet} size="100%" />
);

export interface GlyphProps {
  /**
   * Primary glyph — string ("i_me+want+water.big#question") or a
   * pre-parsed structure. May reference AI-generated keys whose symbols
   * are still being produced.
   */
  glyph?: string | ParsedGlyph;
  /**
   * Optional safe fallback glyph string. When provided AND the primary
   * `glyph` references keys whose visuals aren't ready yet, the fallback
   * is rendered instead. Once every referenced key resolves (bundled
   * icon / known emoji / cached symbol), the renderer switches over to
   * the primary glyph automatically. String form only — a pre-parsed
   * ParsedGlyph bypasses the swap.
   */
  fallback?: string;
  /** Suppress the colored tone background — for use inside an outer button shell. */
  noBackground?: boolean;
  /** Optional explicit pixel/percent size; otherwise fills container. */
  width?: number | string;
  height?: number | string;
  ariaLabel?: string;
  onSlotPress?: (slotIndex: number | null) => void;
  activeSlot?: number | null;
}

export function Glyph(props: GlyphProps) {
  const { isRTL } = useLanguage();
  // Always run the hook (Rules of Hooks). When glyph is a string, the
  // hook picks between glyph and fallback based on per-slot resolution
  // and re-subscribes to symbol generations so the result reactively
  // updates as symbols become available.
  const primaryString = typeof props.glyph === "string" ? props.glyph : undefined;
  const swapped = useDisplayGlyph(primaryString, props.fallback);

  const finalGlyph: string | ParsedGlyph | undefined =
    props.glyph && typeof props.glyph !== "string"
      ? props.glyph
      : swapped;

  if (!finalGlyph) return null;

  return (
    <GlyphCompositor
      glyph={finalGlyph}
      rtl={isRTL}
      resolveImage={defaultImageResolver}
      noBackground={props.noBackground}
      width={props.width}
      height={props.height}
      ariaLabel={props.ariaLabel}
      onSlotPress={props.onSlotPress}
      activeSlot={props.activeSlot}
      onImageError={markSymbolUrlFailed}
      renderAnimatedSymbol={renderAnimatedSymbolAac}
    />
  );
}
