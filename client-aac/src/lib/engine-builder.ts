// client-aac/src/lib/engine-builder.ts
//
// Stage-3 builder merge: ONE backend interface the sentence builder talks to
// for engine-driven word surfacing, with TWO implementations:
//
//   - Bridge backend (in-game): lives in @client-shared/game/engine-builder
//     (also used by the clinician's call game surface) — correlates
//     `builder_state` / `glyph_input` requests with answers over the game
//     embed's postMessage bridge. The game's own (vendored) engine is the
//     parse authority.
//
//   - Local backend (out-of-game, AAC-only): runs the LIVE engine's pure
//     surfacer directly against the DEFAULT game objects, so the builder
//     offers the same engine lexicon even when no game is embedded. `play()`
//     returns null — there is no world to execute the sentence in.
//
// Home decides which backend the builder gets: bridge when a world-engine
// game is the active app, local otherwise.

// Deep import ONLY — the world-engine barrel would pull the whole engine into
// the AAC bundle. This module is the engine's pure, dependency-light surfacer.
import { builderSurfaceFor, defaultBuilderNouns } from "@shared/world-engine/interaction/intent/builder-surface";
import type { IntentKind } from "@shared/world-engine/interaction/intent/parse-intent";
import { BUILDER_ITEMS_WITH_MORE } from "@shared/aac-builder-paging";
import type { EngineBuilderBackend } from "@client-shared/game/engine-builder";

export {
  createBridgeBuilderBackend,
  type BridgeBuilderBackend,
  type BuilderSurfaceRequestOpts,
  type EngineBuilderBackend,
  type EnginePlayResult,
} from "@client-shared/game/engine-builder";

/**
 * HOW MANY RANKED WORDS THE AAC BUILDER ASKS FOR — three of its 9×2 grid
 * pages' worth; the grid pages through them with its More button.
 *
 * ONE CONSTANT, ONE OWNER: the number is the BOARD's display budget, so both
 * backends must be asked for the same thing or the same sentence pages
 * out-of-game and doesn't in-game (the 54/16 seam). The board sends it on every
 * request — the local surfacer takes it directly, the bridge puts it on
 * `builder_state` — and this default only covers a caller that asks for
 * nothing.
 */
export const BUILDER_SURFACE_CAPACITY = 54;

/**
 * Out-of-game backend: the engine's pure surfacer over the DEFAULT game
 * objects (`defaultBuilderNouns` — the engine's curated standard-object set,
 * so out-of-game compositions stay parseable in-game). Synchronous under the
 * hood; async to match the interface.
 */
export function createLocalBuilderBackend(opts?: { locale?: string }): EngineBuilderBackend {
  const nouns = defaultBuilderNouns();
  return {
    async requestSurface(glyph, category, group, req) {
      try {
        return (
          builderSurfaceFor(glyph, {
            nouns,
            locale: opts?.locale,
            category,
            group,
            capacity: req?.capacity ?? BUILDER_SURFACE_CAPACITY,
            // THE PAGE, not the budget: the grid shows 17 of the 54 it asks
            // for, and the surfacer drops a group chip whose members are all
            // already on the grid. Measured against the budget that rule hid
            // the chips on every board whose library fits in three pages —
            // including the places board, which is exactly where a child needs
            // them (2026-08-25).
            page: BUILDER_ITEMS_WITH_MORE,
            // The learned layer and the type-chip seed travel the same route
            // in-game (over `builder_state`) and out — the caller keeps them,
            // the surfacer reads them, this backend only hands them over.
            ...(req?.recency ? { recency: req.recency } : {}),
            ...(req?.seedKind ? { seedKind: req.seedKind as IntentKind } : {}),
          }) ?? null
        );
      } catch (e) {
        console.warn("[engine-builder] local surfacer failed", e);
        return null;
      }
    },
    // Nothing to execute the sentence in — the caller takes the LLM path.
    async play() {
      return null;
    },
  };
}
