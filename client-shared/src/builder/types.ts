// client-shared/src/builder/types.ts
//
// SHARED BY THE AAC STUDENT BUILDER (SentenceConstructorBoard) AND THE
// CLINICIAN "EDIT VISUAL" BUILDER. Change it for both, or for neither.
//
// The injection point for everything a builder leaf needs that differs per
// client: the translator, the reading direction, the client's own Glyph
// wrapper, its bundled-icon path resolver, and (optionally) its people
// sources. Exactly the `BoardRenderDeps` pattern the shared board renderer
// already uses — the shared package never imports a `@/` module, so a leaf
// can render inside either client with no knowledge of which one it is in.
//
// Deps travel by CONTEXT (see deps.tsx), not by prop: the leaves sit three or
// four levels below the host and threading six values through every tile would
// be its own source of drift.

import type { ComponentType } from "react";
import type { GlyphRenderProps } from "../board/types";

export type { GlyphRenderProps };

/**
 * Client-specific behavior injected into the shared sentence-builder chrome.
 *
 * `t` is the raw translator: it returns the KEY when a key is missing, which is
 * truthy — so never write `t("x") || "fallback"` against it, the fallback can
 * never render. Compare against the key instead (`translated === key`).
 */
export interface BuilderRenderDeps {
  /** i18n lookup. Returns the key itself when the key is missing. */
  t: (key: string) => string;
  /** Right-to-left reading direction (chrome arrows, symbol mirroring). */
  rtl: boolean;
  /** The client's own Glyph wrapper (AAC = animated + fillSlot; clinician = plain). */
  GlyphComponent: ComponentType<GlyphRenderProps>;
  /** Resolve a registry `imagePath` to a bundled URL, or null when unbundled. */
  resolveIconPath: (relativePath: string) => string | null;
  /** Resolve a person id to a face image URL (camera capture or stored photo). */
  getFaceImage?: (personId: string) => string | null;
  /** Resolve a person id to a display name (so `face:<id>` never shows an id). */
  getPersonName?: (personId: string) => string | null;
}

/** The subset of a person the builder's photo tiles need. A structural
 *  superset of the AAC's `ConstructionPerson` and of the clinician's
 *  people-directory row, so neither host needs an adapter. */
export interface BuilderPerson {
  id: string;
  name: string;
}
