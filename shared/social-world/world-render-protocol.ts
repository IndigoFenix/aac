// shared/social-world/world-render-protocol.ts
//
// The postMessage contract between the main thread (world-render-client.ts) and
// the OffscreenCanvas render worker (world-render.worker.ts). All payloads are
// structured-cloneable; `canvas` and `bitmap` are TRANSFERRED (noted below).
//
// Threading model: the worker runs the whole game loop (sim + camera + input
// mapping + render) on a transferred OffscreenCanvas. Main stays a thin bridge —
// it owns the call transport (WebSocket/RTC), the DOM (pointer/resize), and face
// images. Net is plain `WorldNetMessage[]` / `WorldPresence` either way, so it
// crosses the boundary without transferables.

import type { Vec2, WorldNetMessage, WorldSpec } from "../world-engine/index.js";
import type { WorldTunables } from "../world-engine/world-tunables.js";
import type { NpcEngagement, NpcProximity } from "./npc-controller.js";
import type { WorldPresence } from "./world-presence.js";

// --- Main → Worker ----------------------------------------------------------

export type MainToWorker =
  /** One-time. `canvas` is transferred via transferControlToOffscreen(). */
  | {
      type: "init";
      canvas: OffscreenCanvas;
      worldSpec?: WorldSpec;
      worldSpecKey?: string;
      localId: string;
      renderer: "2d" | "3d";
      spawnIndex: number;
      spawnAt?: Vec2;
      /** Host the spec's NPCs in the worker (the loop runs here). */
      hostNpcs?: boolean;
      width: number;
      height: number;
      dpr: number;
      /** Initial gaze/camera/comfort tunables (debug menu). */
      tunables?: WorldTunables;
    }
  | { type: "resize"; width: number; height: number; dpr: number }
  /** Live tunables update (debug menu) — applied to the interpreter + camera. */
  | { type: "tune"; tunables: WorldTunables }
  | { type: "pointer"; x: number; y: number }
  | { type: "pointer-leave" }
  /** The local user spoke — show a bubble over the local avatar + broadcast it. */
  | { type: "say"; text: string; glyph?: string }
  | { type: "net-inbound"; msgs: WorldNetMessage[] }
  | { type: "presence"; presence: WorldPresence }
  | { type: "presence-leave"; personId: string }
  /** A face image (or null) + display name for a participant. `bitmap` transferred. */
  | { type: "face"; id: string; bitmap: ImageBitmap | null; label: string }
  /** Decoded symbol images for a composed glyph string (the speech-bubble glyph
   *  strip). `bitmaps` transferred. Empty ⇒ nothing resolved (text-only bubble). */
  | { type: "glyph"; glyph: string; bitmaps: ImageBitmap[] }
  /** Bias a hosted NPC's body from its live conversation (mind → body). */
  | { type: "npc-engagement"; npcId: string; engagement: NpcEngagement | null }
  | { type: "dispose" };

// --- Worker → Main ----------------------------------------------------------

export type WorkerToMain =
  | { type: "ready" }
  | { type: "init-failed"; error: string }
  /** Outbound mesh messages — main forwards to the call net. */
  | { type: "net-outbound"; msgs: WorldNetMessage[] }
  /** Outbound presence — main forwards to the call net + local presence channel. */
  | { type: "publish-presence"; presence: WorldPresence }
  /** Worker saw a participant with no cached face; main should fulfil it. */
  | { type: "request-face"; id: string }
  /** Worker saw a speech bubble with an un-decoded glyph; main should fulfil it. */
  | { type: "request-glyph"; glyph: string }
  /** The set of NPCs the local player is in conversation range of changed. */
  | { type: "npc-proximity"; nearby: NpcProximity[] }
  /** Unrecoverable (WebGL context loss / exception) — main falls back to on-thread. */
  | { type: "fatal"; error: string };
