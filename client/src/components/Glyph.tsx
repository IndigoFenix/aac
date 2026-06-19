// client/src/components/Glyph.tsx
//
// Clinician-side mirror of the AAC client's Glyph wrapper. Both clients
// render glyphs through the shared `GlyphCompositor`, but each client
// provides its own image resolver (because the Vite glob that bundles
// the aac-icons is build-time-scoped to each client's root).

import { GlyphCompositor } from "@shared/glyph-compositor.tsx";
import type { ParsedGlyph } from "@shared/glyph-compositor";
import { defaultImageResolver, useDisplayGlyph } from "@/lib/glyph-images";
import { useLanguage } from "@/contexts/LanguageContext";

export interface GlyphProps {
  /**
   * Primary glyph — string ("i_me+want+water") or a pre-parsed
   * structure. May reference AI-generated keys whose symbols are still
   * being produced.
   */
  glyph?: string | ParsedGlyph;
  /**
   * Optional safe fallback glyph. When the primary glyph references
   * keys whose visuals aren't ready yet, the fallback renders instead.
   * Once every referenced key resolves (bundled icon / known emoji /
   * cached symbol), the renderer switches over to the primary glyph
   * automatically. String form only — a pre-parsed ParsedGlyph bypasses
   * the swap.
   */
  fallback?: string;
  /** Suppress the colored tone background — for use inside an outer button shell. */
  noBackground?: boolean;
  width?: number | string;
  height?: number | string;
  ariaLabel?: string;
  onSlotPress?: (slotIndex: number | null) => void;
  activeSlot?: number | null;
  /**
   * Override the right-to-left rendering. Defaults to the UI language's
   * direction; pass explicitly when the glyph's content language differs from
   * the UI (e.g. captioning a Hebrew video while the UI is English).
   */
  rtl?: boolean;
  /** Show empty-payload host art (sentence-builder affordance only). */
  showEmptyHostSlot?: boolean;
}

export function Glyph(props: GlyphProps) {
  const { isRTL } = useLanguage();
  const rtl = props.rtl ?? isRTL;
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
      rtl={rtl}
      resolveImage={defaultImageResolver}
      noBackground={props.noBackground}
      width={props.width}
      height={props.height}
      ariaLabel={props.ariaLabel}
      onSlotPress={props.onSlotPress}
      activeSlot={props.activeSlot}
      showEmptyHostSlot={props.showEmptyHostSlot}
    />
  );
}
