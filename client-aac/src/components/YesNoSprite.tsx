// client-aac/src/components/YesNoSprite.tsx
//
// Thin convenience wrapper around AnimatedSymbol that hard-codes the
// yes/no sheet metadata. Kept around because QuickActions and any future
// fixed-position UI affordance want to render the animated yes/no glyph
// without going through the full SYMBOL registry lookup. New animated
// symbols should live in shared/glyph-registry.ts with an
// `animatedSprite` facet — the GlyphCompositor picks those up
// automatically via Glyph.tsx.

import { AnimatedSymbol } from "@/components/AnimatedSymbol";
import type { AnimatedSpriteFacet } from "@shared/glyph-registry";

interface YesNoSpriteProps {
  variant: "yes" | "no";
  size: number | string;
  className?: string;
}

const YES_FACET: AnimatedSpriteFacet = {
  sheet: "yes-no-sprites",
  cols: 3,
  rows: 2,
  row: 0,
  frames: [0, 1, 2, 1],
};

const NO_FACET: AnimatedSpriteFacet = {
  sheet: "yes-no-sprites",
  cols: 3,
  rows: 2,
  row: 1,
  frames: [0, 1, 0, 2],
};

export function YesNoSprite({ variant, size, className = "" }: YesNoSpriteProps) {
  return (
    <AnimatedSymbol
      facet={variant === "yes" ? YES_FACET : NO_FACET}
      size={size}
      className={className}
    />
  );
}
