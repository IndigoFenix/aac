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
import type { EngineBuilderBackend } from "@client-shared/game/engine-builder";

export {
  createBridgeBuilderBackend,
  type BridgeBuilderBackend,
  type EngineBuilderBackend,
  type EnginePlayResult,
} from "@client-shared/game/engine-builder";

/** How many ranked words to ask the local surfacer for — three builder grid
 *  pages' worth; the grid pages through them with its More button. */
const LOCAL_SURFACE_CAPACITY = 54;

/**
 * Out-of-game backend: the engine's pure surfacer over the DEFAULT game
 * objects (`defaultBuilderNouns` — the engine's curated standard-object set,
 * so out-of-game compositions stay parseable in-game). Synchronous under the
 * hood; async to match the interface.
 */
export function createLocalBuilderBackend(opts?: { locale?: string }): EngineBuilderBackend {
  const nouns = defaultBuilderNouns();
  return {
    async requestSurface(glyph, category, group) {
      try {
        return (
          builderSurfaceFor(glyph, {
            nouns,
            locale: opts?.locale,
            category,
            group,
            capacity: LOCAL_SURFACE_CAPACITY,
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
