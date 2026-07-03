// shared/world-engine/world-view.ts
//
// The renderer-agnostic seam between the social-world canvas (which owns the
// simulation + transport) and however the world is DRAWN. The canvas computes
// one world `aim` from the pointer each frame and renders the WorldState — both
// of which are camera-dependent, so a renderer must supply BOTH: the screen→world
// mapping AND the draw call, sharing one camera.
//
// Two implementations:
//   • createWorld2DView  (here)            — the top-down canvas-2D view.
//   • createWorld3DView  (./render3d.ts)   — a Three.js tilted-down 3D view.
//
// Like render2d.ts this module is DOM-typed and deliberately NOT re-exported from
// index.js — the headless server consumes only the engine/net, never a view.

import type { Vec2 } from "./types.js";
import type { WorldState } from "./engine.js";
import type { WorldTunables } from "./world-tunables.js";
import {
  followCamera,
  renderWorld2D,
  screenToWorld as screenToWorldFromCam,
  type WorldCamera,
} from "./render2d.js";

/** Per-frame intent from the gaze interpreter that a renderer's camera may react
 *  to. `aim` is the same value the engine consumed (so the 3D camera commits to
 *  where the player is steering); `sitting` latches the calm WATCH framing. The 2D
 *  view ignores it (its camera is a fixed follow). */
export interface RenderIntent {
  aim: Vec2 | null;
  sitting: boolean;
  /** The entity the local player is about to INTERACT with (toy/peer/NPC), for a
   *  highlight. Undefined when the gaze isn't resting on anything engageable. */
  interactId?: string;
  /** When set, the 3D camera slews to FACE this world point regardless of `aim`
   *  (used during an NPC conversation, where the avatar is frozen but the view
   *  turns to the speaker). Null/undefined = normal aim-driven heading. */
  faceTarget?: Vec2 | null;
  /** Request the over-the-shoulder rig regardless of the travel rules — set when
   *  the gaze rests on a speech bubble (or the conversation speaker), so both the
   *  player and the speaker stay framed instead of the overhead top-down. */
  shoulder?: boolean;
  /**
   * The gaze-CURSOR payload for the flying-spark cursor (render3d). Deliberately
   * separate from `aim`/`interactId` — those get repurposed by the game (steering
   * re-target, carry suspension, conversation-facing), which would drag the spark
   * onto the carried item or the person being spoken to. This reflects where the
   * eyes actually REST and how far a dwell-to-select has progressed, so the spark
   * can BE the selection indicator (replacing a separate dwell ring).
   */
  cursor?: {
    /** Effective gaze fixation ground point, or null mid-saccade. */
    point: Vec2 | null;
    /** Entity the gaze rests on (screen pick), if any — the spark hovers over it. */
    hoverId?: string;
    hoverKind?: "avatar" | "object";
    /** 0..1 dwell-to-select progress at the fixation (carry pick/place + game dwell). */
    selectProgress?: number;
  };
}

/** What the gaze pixel is resting on, resolved in SCREEN space (the rendered
 *  sprite/mesh, not ground-point proximity) — see WorldView.pickScreen. */
export interface ScreenPick {
  kind: "bubble" | "avatar" | "object";
  /** Avatar/object id, or the bubble's `state.bubbles` key. */
  id: string;
}

/** World units shown across the smaller screen dimension by a follow camera. The
 *  3D view uses the same span to keep the two renderers' zoom comparable. */
export const FOLLOW_VIEW_SPAN = 30;

/** Everything a view needs that the canvas owns. Face/label are resolved live
 *  (the roster updates over time), so they're passed as functions, not values.
 *  `canvas` may be an OffscreenCanvas so the view runs unchanged inside a worker —
 *  hence the view NEVER reads window/clientWidth; the host injects size via
 *  `resize(width, height, dpr)`. */
export interface WorldViewDeps {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  /** The local participant's id (its avatar is drawn highlighted / camera-followed). */
  localId: string;
  /** A drawable face (decoded photo / live video frame / ImageBitmap) for a
   *  participant, or null to fall back to a coloured disc + initial. */
  faceFor: (id: string) => CanvasImageSource | null;
  /** Display name for a participant — its initial is the no-face fallback. */
  labelFor: (id: string) => string;
  /** Symbol images for a composed AAC glyph string (the speech-bubble glyph strip),
   *  or null/[] when none are available (plain speech, or not yet decoded). */
  glyphFor?: (glyph: string) => CanvasImageSource[] | null;
}

/** A pluggable renderer for the world engine. The host drives it once a frame. */
export interface WorldView {
  /** Map a canvas-relative pixel (CSS px, origin top-left) to a world ground
   *  point, or null when the pixel doesn't fall on the ground (e.g. above the 3D
   *  horizon) — null reads as "no aim", so the avatar coasts to a stop. */
  screenToWorld(px: number, py: number): Vec2 | null;
  /** What the pixel rests on VISUALLY (speech bubble, an avatar's body/sprite, an
   *  object's mesh) — the host snaps the effective gaze to the hit entity, which
   *  is what makes entities pickable by looking AT them in the shallow shoulder
   *  view (where their bodies extend far up-screen from their ground point).
   *  Optional: the 2D view omits it (its steep camera makes ground-point
   *  proximity exact already). `includeLocal` returns the local avatar instead of
   *  passing the ray through it (the spark cursor uses it to hover over the player). */
  pickScreen?(px: number, py: number, opts?: { includeLocal?: boolean }): ScreenPick | null;
  /** Draw one frame of `state`. `dt` (seconds) drives camera smoothing / animation.
   *  `intent` (optional) lets the camera react to gaze intent (3D); 2D ignores it. */
  render(state: WorldState, dt: number, intent?: RenderIntent): void;
  /** Set the logical size (CSS px) + device pixel ratio. The host owns the DOM
   *  measurement (or stored values in a worker); the view never reads them itself. */
  resize(width: number, height: number, dpr: number): void;
  /** Live-update tunables (debug menu). Optional — the 2D view has nothing to tune. */
  setTunables?(t: WorldTunables): void;
  dispose(): void;
}

/**
 * The top-down canvas-2D view: a follow camera centred on the local avatar at a
 * fixed zoom, the same transform used for both pointer→world aiming and drawing.
 * A thin adapter over the pure functions in render2d.ts (which stay independently
 * unit-tested).
 */
export function createWorld2DView(deps: WorldViewDeps): WorldView {
  const { canvas, localId, faceFor, labelFor, glyphFor } = deps;
  // getContext("2d") exists on both HTMLCanvasElement and OffscreenCanvas; the 2D
  // context APIs we use (fillRect/arc/drawImage/fillText/setTransform) are common to
  // both. Type as CanvasRenderingContext2D for renderWorld2D — duck-compatible.
  const ctx = (canvas as HTMLCanvasElement).getContext("2d") as CanvasRenderingContext2D | null;
  if (!ctx) throw new Error("createWorld2DView: 2D canvas context unavailable");

  // Injected logical size (CSS px) + DPR — set by resize(). The view never reads
  // window/clientWidth, so it runs unchanged on an OffscreenCanvas in a worker.
  let viewW = 1;
  let viewH = 1;
  let viewDpr = 1;
  const applyTransform = (): void => {
    canvas.width = Math.round(viewW * viewDpr);
    canvas.height = Math.round(viewH * viewDpr);
    ctx.setTransform(viewDpr, 0, 0, viewDpr, 0, 0);
  };

  const camFor = (state: WorldState): WorldCamera => {
    const me = state.avatars[localId];
    const center = me ?? { x: state.spec.manifold.width / 2, y: state.spec.manifold.height / 2 };
    return followCamera(viewW, viewH, center, FOLLOW_VIEW_SPAN);
  };

  // The pointer→aim call happens BEFORE the tick, so it reads the previous frame's
  // camera (the avatar barely moves in one frame — sub-pixel, negligible).
  let lastState: WorldState | null = null;

  return {
    screenToWorld(px, py) {
      if (!lastState) return null;
      return screenToWorldFromCam(camFor(lastState), px, py);
    },
    render(state) {
      lastState = state;
      renderWorld2D(ctx, state, camFor(state), {
        localId,
        viewWidth: viewW,
        viewHeight: viewH,
        faceFor,
        labelFor,
        glyphFor,
      });
    },
    resize(width, height, dpr) {
      viewW = Math.max(1, width);
      viewH = Math.max(1, height);
      viewDpr = dpr || 1;
      applyTransform();
    },
    dispose() {
      /* the canvas-2D context owns no resources to release */
    },
  };
}
