// client-shared/src/game/engine-builder.ts
//
// The transport half of the engine-driven sentence builder, shared by BOTH
// clients. A host page talks to an embedded world-engine game through one
// backend interface:
//
//   - `requestSurface` — what should the builder offer for this partial
//     sentence? (`builder_state` → `builder_surface` over the games bridge)
//   - `play` — execute a composed sentence in the game's world
//     (`glyph_input` → `glyph_result`)
//
// `createBridgeBuilderBackend` correlates requests with answers by requestId
// and resolves null on timeout, so a builder can never hang on a slow/absent
// game — the caller falls back to its registry content / LLM interpret path.
//
// The AAC's OUT-of-game backend (the live engine's surfacer over the default
// game objects) deliberately does NOT live here: it deep-imports the world
// engine, which the clinician bundle must not pull in. See
// client-aac/src/lib/engine-builder.ts.

import type {
  BuilderSurface,
  GameMessage,
  PlatformMessageInput,
} from "@shared/games-bridge";

/** Result of executing a composed sentence in the engine. */
export interface EnginePlayResult {
  /** True when the engine parsed AND executed the sentence in-world. */
  parsed: boolean;
  /** The engine's own natural-language rendering (its lang layer), for the
   *  platform to voice when it skips the LLM interpret pass. */
  spokenText?: string;
}

export interface EngineBuilderBackend {
  /** What should the builder offer for this partial sentence? `category`
   *  filters to one advertised `BuilderSurface.categories` tab; `group` to one
   *  of the active view's `BuilderSurface.groups` chips. null = no engine
   *  answer (timeout / error) — caller falls back to registry content. */
  requestSurface(glyph: string, category?: string, group?: string): Promise<BuilderSurface | null>;
  /** Execute a composed sentence in the engine. null = no engine to execute
   *  in (or no answer in time) — caller falls back to the LLM interpret path. */
  play(glyph: string): Promise<EnginePlayResult | null>;
}

/** Bridge flavor — host must feed it every GameMessage from the embed. */
export interface BridgeBuilderBackend extends EngineBuilderBackend {
  /** Route a message from the game embed into the pending-request maps.
   *  Non-builder messages are ignored, so the host can forward everything. */
  handleGameMessage(msg: GameMessage): void;
}

/** How long a `builder_state` may wait for its `builder_surface`. Short — the
 *  surfacer is pure and answers per keystroke; a hung builder is worse than a
 *  registry fallback frame. */
const SURFACE_TIMEOUT_MS = 1000;
/** How long a `glyph_input` may wait for its `glyph_result` before the caller
 *  falls back to the LLM interpret path. */
const PLAY_TIMEOUT_MS = 1500;

interface Pending<T> {
  resolve: (value: T | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

let requestSeq = 0;
function nextRequestId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${++requestSeq}`;
}

/**
 * In-game backend: `builder_state` / `glyph_input` down the given `send`,
 * answers matched by requestId via `handleGameMessage`.
 */
export function createBridgeBuilderBackend(
  send: (msg: PlatformMessageInput) => void,
): BridgeBuilderBackend {
  const pendingSurfaces = new Map<string, Pending<BuilderSurface>>();
  const pendingPlays = new Map<string, Pending<EnginePlayResult>>();

  const settle = <T>(map: Map<string, Pending<T>>, id: string, value: T | null) => {
    const pending = map.get(id);
    if (!pending) return;
    map.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(value);
  };

  return {
    requestSurface(glyph, category, group) {
      return new Promise<BuilderSurface | null>((resolve) => {
        const requestId = nextRequestId("bsurf");
        const timer = setTimeout(() => settle(pendingSurfaces, requestId, null), SURFACE_TIMEOUT_MS);
        pendingSurfaces.set(requestId, { resolve, timer });
        try {
          send({
            type: "builder_state",
            requestId,
            glyph,
            ...(category ? { category } : {}),
            ...(group ? { group } : {}),
          });
        } catch {
          settle(pendingSurfaces, requestId, null);
        }
      });
    },

    play(glyph) {
      return new Promise<EnginePlayResult | null>((resolve) => {
        const requestId = nextRequestId("bplay");
        const timer = setTimeout(() => settle(pendingPlays, requestId, null), PLAY_TIMEOUT_MS);
        pendingPlays.set(requestId, { resolve, timer });
        try {
          // voiced: true — the platform voices the sentence (student server
          // voice or local TTS); the game must only execute it.
          send({ type: "glyph_input", glyph, requestId, voiced: true });
        } catch {
          settle(pendingPlays, requestId, null);
        }
      });
    },

    handleGameMessage(msg) {
      if (msg.type === "builder_surface") {
        settle(pendingSurfaces, msg.requestId, msg.surface ?? null);
        return;
      }
      if (msg.type === "glyph_result") {
        const result: EnginePlayResult = { parsed: !!msg.parsed, spokenText: msg.spokenText };
        if (msg.requestId) {
          settle(pendingPlays, msg.requestId, result);
        } else if (pendingPlays.size > 0) {
          // Defensive: a game that echoes no requestId still answers the
          // oldest outstanding play (Map preserves insertion order).
          const oldest = pendingPlays.keys().next().value as string | undefined;
          if (oldest) settle(pendingPlays, oldest, result);
        }
      }
    },
  };
}
