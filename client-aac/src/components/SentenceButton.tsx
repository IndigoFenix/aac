// client-aac/src/components/SentenceButton.tsx
//
// AAC-side thin wrapper over the shared <BoardButtonVisual />. It injects the
// AAC client's behavior — the icon-resolution chain (glyph → __FACE__ →
// __SYMBOL__ → static path → imageKey spinner → iconRef → 💬), the AAC Glyph
// wrapper (animated SYMBOLs + fillSlot), and the face-image cache — while the
// actual layout/markup/sizing live in client-shared so the clinician editor
// renders identical buttons.
//
// Color now resolves in `@shared/button-color` (server-filled in production);
// `resolveButtonBackground` is re-exported here for the few callers that still
// compute a background locally (DynamicBoard's getButtonColor) and as the
// pre-server-fill fallback.

import { type ReactNode } from "react";
import { Glyph } from "@/components/Glyph";
import { apiUrl } from "@/lib/queryClient";
import { resolveStaticIconPath } from "@/lib/utils";
import { BoardButtonVisual } from "@client-shared/board/BoardButtonVisual";
import type { BoardRenderDeps, GlyphRenderProps, IconVisual } from "@client-shared/board/types";
import {
  resolveButtonBackground,
  detectYesNoDefaultColor,
} from "@shared/button-color";

// Re-export the color helpers from their canonical home so existing importers
// (e.g. DynamicBoard) keep working unchanged.
export { resolveButtonBackground, detectYesNoDefaultColor };

/** The shape every SENTENCE BUTTON surface speaks. (Superset-compatible with BoardButtonInput.) */
export interface SentenceButtonInput {
  /** Short on-button text. */
  label: string;
  /** The natural-language SENTENCE the TTS voices on press. */
  sentence?: string;
  /** Visual encoding — composed GLYPHs + MODIFIER SYMBOLs + OPERATORs. */
  glyph?: string;
  /** Fallback `sentence` encoding using no `generate:` SYMBOLs. */
  glyphFallback?: string;
  /** Optional explicit background color (named or hex). Overrides defaults. */
  color?: string;
  /** Single-SYMBOL paths used when the button doesn't carry a full glyph. */
  iconRef?: string;
  symbolPath?: string;
  imageKey?: string;
}

/** The AAC Glyph wrapper, adapted to the shared GlyphRenderProps shape. */
const AacGlyph = (p: GlyphRenderProps) => (
  <Glyph glyph={p.glyph} fallback={p.fallback} noBackground={p.noBackground} ariaLabel={p.ariaLabel} />
);

/**
 * Resolve a button to its icon visual — the AAC chain. `__FACE__`/`__SYMBOL__`
 * pseudo-paths and the imageKey spinner are AAC-only; the clinician editor uses
 * a different resolver.
 */
function makeAacResolveIcon(getFaceImage?: (id: string) => string | null) {
  return (button: SentenceButtonInput): IconVisual => {
    const symbolPath = button.symbolPath;

    // Glyph wins over everything except the __FACE__/__SYMBOL__ pseudo-paths.
    if (
      (button.glyph || button.glyphFallback) &&
      !symbolPath?.startsWith("__FACE__:") &&
      !symbolPath?.startsWith("__SYMBOL__:")
    ) {
      return { kind: "glyph", glyph: button.glyph, fallback: button.glyphFallback };
    }
    if (symbolPath?.startsWith("__FACE__:")) {
      const contactId = symbolPath.substring(9);
      const cached = getFaceImage?.(contactId);
      if (cached) return { kind: "image", src: cached, rounded: true };
      return { kind: "emoji", text: "👤" };
    }
    if (symbolPath?.startsWith("__SYMBOL__:")) {
      const symbolId = symbolPath.substring(11);
      return { kind: "image", src: apiUrl(`/api/custom-symbols/${symbolId}/image`) };
    }
    if (symbolPath) {
      return { kind: "image", src: resolveStaticIconPath(symbolPath) };
    }
    // Legacy single-concept imageKey — show emoji + spinner while generating.
    if (button.imageKey) {
      const emoji =
        button.iconRef && /[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]/u.test(button.iconRef)
          ? button.iconRef
          : "💬";
      return { kind: "spinner", emoji };
    }
    if (button.iconRef) {
      if (button.iconRef.startsWith("fa")) return { kind: "fontawesome", className: button.iconRef };
      return { kind: "emoji", text: button.iconRef };
    }
    return { kind: "placeholder" };
  };
}

interface SentenceButtonProps {
  button: SentenceButtonInput;
  onClick: () => void;
  /** Sizing + chrome preset. */
  variant: "board" | "overlay";
  /** Override border styling (board variant uses this for link/back/guess buttons). */
  borderClassName?: string;
  /** Resolve __FACE__:id pseudo-paths against the client-side face cache. */
  getFaceImage?: (id: string) => string | null;
  /** Board-variant icon/text sizing — computed by the host to match the grid. */
  iconFontSize?: string;
  textFontSize?: string;
  /** Accepted for backward-compat; layout is driven by CSS fill, not these. */
  iconFlex?: number;
  textFlex?: number;
  /** Show the entrance animation (board variant). */
  entering?: boolean;
  /** Stagger the overlay variant's spring entrance. */
  overlayEntranceDelay?: number;
  /** Override overlay-variant dimensions (defaults sized for two big options). */
  overlaySize?: { button: string; icon: string };
  /** Optional accessible label override (defaults to the button's label). */
  ariaLabel?: string;
  /** Optional extra content rendered as an absolute overlay (e.g. link arrow). */
  cornerIndicator?: ReactNode;
  /** Passed through to motion.button so callers can pin data-dwell-cell etc. */
  extraButtonProps?: Record<string, unknown>;
}

export function SentenceButton(props: SentenceButtonProps) {
  const deps: BoardRenderDeps = {
    resolveIcon: makeAacResolveIcon(props.getFaceImage),
    GlyphComponent: AacGlyph,
  };
  return (
    <BoardButtonVisual
      button={props.button}
      deps={deps}
      onClick={props.onClick}
      variant={props.variant}
      borderClassName={props.borderClassName}
      iconFontSize={props.iconFontSize}
      textFontSize={props.textFontSize}
      entering={props.entering}
      overlayEntranceDelay={props.overlayEntranceDelay}
      overlaySize={props.overlaySize}
      ariaLabel={props.ariaLabel}
      cornerIndicator={props.cornerIndicator}
      extraButtonProps={props.extraButtonProps}
    />
  );
}
