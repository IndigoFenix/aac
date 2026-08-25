// client-shared/src/board/types.ts
//
// Shared types for the unified AAC board renderer used by BOTH React clients
// (the student AAC app and the clinician editor). The shared components never
// import a client-specific module directly — instead each client injects its
// behavior through `BoardRenderDeps`, mirroring the GlyphCompositor ⟶ per-client
// Glyph wrapper pattern.

import type { ComponentType, ReactNode } from "react";

/**
 * A resolved description of what to draw in a button's icon area. The shared
 * renderer switches on `kind`; each client's `resolveIcon` folds its own path
 * logic (resolveStaticIconPath / symbol-store / apiUrl / __FACE__/__SYMBOL__ /
 * face cache) into producing one of these.
 */
export type IconVisual =
  | { kind: "glyph"; glyph?: string; fallback?: string }
  | { kind: "image"; src: string; rounded?: boolean }
  | { kind: "emoji"; text: string }
  | { kind: "fontawesome"; className: string }
  | { kind: "spinner"; emoji: string } // legacy imageKey pending
  | { kind: "placeholder" };

/** Optional accessory rendered as an absolute overlay (e.g. a link arrow). */
export type CornerIndicator = ReactNode;

/**
 * The subset of a board button the renderer needs. A structural superset of both
 * `BoardButton` (`@shared/schema`) and the clinician `ButtonIR`, so an adapter on
 * either side is trivial.
 */
export interface BoardButtonInput {
  label: string;
  sentence?: string;
  glyph?: string;
  glyphFallback?: string;
  /** Color token or raw CSS color (server-filled). Painted via mapColorToHex. */
  color?: string;
  iconRef?: string;
  symbolPath?: string;
  imageKey?: string;
  buttonType?: string;
  /** Conversational role. "bid" (a question or request that hands the turn
   *  back) is the third and last fill a board carries, after yes-green and
   *  no-red — see `resolveButtonColorToken`. */
  role?: string;
  action?: {
    type?: string;
    toPageId?: string;
    toBoardId?: string;
    url?: string;
    text?: string;
  };
}

/** Props the shared renderer needs from a client's own Glyph wrapper. */
export interface GlyphRenderProps {
  glyph?: string;
  fallback?: string;
  noBackground?: boolean;
  /** "none" suppresses the compositor's inline corner marks — a BUTTON draws
   *  them at its own corners instead (see BoardButtonVisual). */
  badges?: "inline" | "none";
  ariaLabel?: string;
}

/**
 * Client-specific behavior injected into the shared board renderer. Each client
 * supplies these from its own modules; the shared package stays free of `@/`
 * imports.
 */
export interface BoardRenderDeps {
  /** Resolve a button to its icon visual (folds in all client path logic). */
  resolveIcon: (button: BoardButtonInput) => IconVisual;
  /** The client's own Glyph wrapper (AAC = animated + fillSlot; clinician = plain). */
  GlyphComponent: ComponentType<GlyphRenderProps>;
  /**
   * Override how a button's background hex is computed. Defaults to
   * `resolveButtonBackground(color, glyph, buttonType, role)` from @shared/button-color
   * (which doubles as the pre-server-fill fallback). Most clients can omit this.
   */
  resolveColor?: (button: BoardButtonInput) => string;
  /** Right-to-left layout flag (back/home arrow direction, etc.). */
  rtl?: boolean;
}
