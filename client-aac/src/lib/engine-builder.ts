// client-aac/src/lib/engine-builder.ts
//
// Stage-3 builder merge: ONE backend interface the sentence builder talks to
// for engine-driven word surfacing, with TWO implementations — both now owned
// by `@client-shared/game/engine-builder`, because the clinician's "Edit
// visual" builder drives the same two:
//
//   - Bridge backend (in-game) — correlates `builder_state` / `glyph_input`
//     requests with answers over the game embed's postMessage bridge. The
//     game's own (vendored) engine is the parse authority.
//
//   - Local backend (out-of-game) — runs the LIVE engine's pure surfacer
//     directly against the DEFAULT game objects, so the builder offers the same
//     engine lexicon even when no game is embedded. `play()` returns null.
//
// Home decides which backend the builder gets: bridge when a world-engine
// game is the active app, local otherwise.
//
// This file is now a re-export so the AAC's existing `@/lib/engine-builder`
// call sites keep working; add nothing here.

export {
  createBridgeBuilderBackend,
  createLocalBuilderBackend,
  BUILDER_SURFACE_CAPACITY,
  type BridgeBuilderBackend,
  type BuilderSurfaceRequestOpts,
  type EngineBuilderBackend,
  type EnginePlayResult,
} from "@client-shared/game/engine-builder";
