// shared/social-world/default-game.ts
//
// The built-in social game: a basic multiplayer world available to every
// student by default (the app-registry "social_world" entry is enabledByDefault).
// It is delivered like any other multiplayer custom app — it just ships in-tree
// instead of living in a custom_apps row. This constant is the CallGame
// reference attached to a call when the default game is started (Phase 4), and
// the always-present first option in the in-call "start a game" picker.

import type { CallGame } from "../realtime-events.js";
import { WORLD_APP_TYPE } from "../world-engine/types.js";
import { socialFieldSpec, socialFieldNpcsSpec } from "../world-engine/specs/index.js";

/** App id of the built-in default social game (matches the app-registry entry). */
export const DEFAULT_SOCIAL_GAME_APP_ID = "social_world";

/** The world spec key the default game runs. */
export const DEFAULT_SOCIAL_WORLD_SPEC_KEY = "social-field";

/** CallGame reference for the built-in default social game. */
export const DEFAULT_SOCIAL_GAME: CallGame = {
  appId: DEFAULT_SOCIAL_GAME_APP_ID,
  engine: WORLD_APP_TYPE,
  worldSpecKey: DEFAULT_SOCIAL_WORLD_SPEC_KEY,
  name: socialFieldSpec.meta.title,
  maxPlayers: socialFieldSpec.multiplayer.maxPlayers,
  // The default field forms proximity conversation circles — walk near someone
  // to hear them. This is the flag that turns on Phase 2 media gating.
  conversationCircles: true,
};

/**
 * CallGame reference for the Dollhouse iframe world game. Unlike the in-page
 * "aivota-world" surface, an iframe-quest game is a packaged game every
 * participant mounts LOCALLY (its own vendored engine) at `src`; the platform
 * only ferries opaque world payloads between the iframe and the call
 * transports (games bridge `world_session` / `world_data` / `world_cmd`).
 */
export const DOLLHOUSE_CALL_GAME: CallGame = {
  appId: "dollhouse",
  engine: "iframe-quest",
  src: "/games/dollhouse/",
  name: "Dollhouse",
};

/** World spec key for the NPC demo field (social-field + AI characters). */
export const NPC_DEMO_WORLD_SPEC_KEY = "social-field-npcs";

/**
 * CallGame reference for the NPC demo world. NOT a default call game — it's the
 * target of the clinician "Test game room" button, so NPC steering can be driven
 * solo before owner election wires NPCs into real multiplayer calls (Phase 2).
 */
export const NPC_DEMO_GAME: CallGame = {
  appId: DEFAULT_SOCIAL_GAME_APP_ID,
  engine: WORLD_APP_TYPE,
  worldSpecKey: NPC_DEMO_WORLD_SPEC_KEY,
  name: socialFieldNpcsSpec.meta.title,
  maxPlayers: socialFieldNpcsSpec.multiplayer.maxPlayers,
  conversationCircles: true,
};
