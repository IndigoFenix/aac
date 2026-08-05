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
   * WHO IS TALKING RIGHT NOW — the conversation the camera should frame, or null
   * when nobody is. The DOLLHOUSE camera's conversation dolly reads this and
   * nothing else.
   *
   * `members` are AVATAR IDS, not points, because the camera must frame the
   * bodies (and turn them three-quarter toward itself), so it looks them up in
   * the live `WorldState` every frame — points captured once would lag a body
   * that shifts its feet. Any id may be absent from `state.avatars` (a formless
   * spirit "conversing" has no body, a member may have streamed out); the camera
   * frames whichever bodies it can actually see, so a roster with ONE visible
   * body is legal and means "frame this one person".
   *
   * `id` is the CAMERA LATCH KEY — the conversation's own identity, stable
   * across membership churn. The dolly keys its hysteresis on this and never on
   * the roster, so somebody joining or leaving mid-exchange re-frames smoothly
   * (the tracked point simply widens) instead of being read as a DIFFERENT
   * conversation that has to wait out the hold and then re-dolly from scratch.
   * Two different conversations must therefore never share an id.
   *
   * `speaker` (optional) is who is talking this instant. RESERVED: the v1 camera
   * IGNORES it — it frames the whole roster evenly. It is published now so a
   * later framing bias (weight the centre toward the speaker, or hold a slightly
   * tighter span on them) needs no new plumbing through the host.
   *
   * The GAME LAYER is the authority — a conversation is not a geometric fact
   * (two bodies standing close are not talking) and there is no way to infer it
   * from the state the renderer sees. Published by the world host from whatever
   * the game knows: the player's own conversation, or an ambient NPC exchange
   * while its words are on screen.
   */
  conversation?: { id: string; members: string[]; speaker?: string } | null;
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
  /** Same glyph images WITHOUT the tone plate, for a model-less object that IS
   *  its glyph in the world (a background square would read as a floating card).
   *  Omit to reuse `glyphFor`. */
  glyphIconFor?: (glyph: string) => CanvasImageSource[] | null;
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
  /** Building ids whose roof is currently NOT fully opaque — the see-inside fade
   *  is active, so the room is on show. A 3D concern (the streamer keeps a room's
   *  interior populated while its roof is open); the top-down 2D view has no roofs
   *  to occlude and omits it. */
  revealedBuildings?(): Set<string>;
  /** Draw one frame of `state`. `dt` (seconds) drives camera smoothing / animation.
   *  `intent` (optional) lets the camera react to gaze intent (3D); 2D ignores it. */
  render(state: WorldState, dt: number, intent?: RenderIntent): void;
  /** Set the logical size (CSS px) + device pixel ratio. The host owns the DOM
   *  measurement (or stored values in a worker); the view never reads them itself. */
  resize(width: number, height: number, dpr: number): void;
  /** Live-update tunables (debug menu). Optional — the 2D view has nothing to tune. */
  setTunables?(t: WorldTunables): void;
  /** HOST-EMBED (seamless walk↔fly): hand the shared camera to (true) or away from
   *  (false) this view's grounded chase rig. Only the 3D view embedded in a flight
   *  scene implements it — WALKING drives the camera, the flight camera owns it
   *  airborne. Omitted by the owner-mode / 2D views. */
  setDriveCamera?(on: boolean): void;
  /** HOST-EMBED: turn on the SPIRIT (dollhouse) cutaway for a focused building
   *  WITHOUT taking the camera — an owner-camera host (the flight world orbiting
   *  a town) reveals a building's interior with the footprint, clears with null.
   *  3D-only. */
  setSpiritFocus?(frame: { x: number; y: number; w: number; h: number } | null): void;
  /** CONSTRUCTION SITES (city-founding): replace the marked-plot set — flat
   *  ground markings over ordered-but-unbuilt lots (staked border + packed
   *  earth), draped like roads. Empty array clears. 3D-only. */
  setSites?(
    sites: Array<{
      id: string;
      x: number;
      y: number;
      w: number;
      h: number;
      /** ⑦ build stage: 0 marked ground, 1 floor, 2 posts + wall courses. */
      stage?: 0 | 1 | 2;
      /** Banked-labor fraction 0..1 — the wall-course driver (phase 3). */
      progress?: number;
      /** The finished building's wall tint. */
      color?: string;
    }>,
  ): void;
  /** SPIRIT LADDER: opt this view's OWNER-mode camera writes off — an external
   *  rig owns the shared camera while the view keeps rendering. 3D-only. */
  setExternalCamera?(on: boolean): void;
  /** SPIRIT LADDER (planet law: the planet owns the player's cursor): opt this
   *  view's OWN spark off — the view still computes its cursor target (hover
   *  snap, select) and reports it via externalCursorWorld for the planet's
   *  spark to draw. 3D-only. */
  setExternalCursor?(on: boolean): void;
  /** Reveal building INTERIORS from occupancy/accessibility (cutaway walls,
   *  open roofs)? Default on. The spirit GROUND rung turns it off: its local
   *  avatar is a parked stand-in, not an occupant, so passing a house in the
   *  street must not strip its walls. 3D-only. */
  setInteriorReveal?(on: boolean): void;
  /** SPIRIT LADDER: the cursor target computed on the last render while the
   *  external-cursor opt-out is on — WORLD coords into `out`; null when there
   *  is none. 3D-only. */
  externalCursorWorld?(
    out: import("three").Vector3,
  ): { hovering: boolean; select: number } | null;
  /** SPIRIT LADDER: the render camera an external rig poses. 3D-only. */
  camera?: import("three").PerspectiveCamera;
  /** SPIRIT LADDER: the dollhouse rig pose for `frame` at azimuth `spiritAz`,
   *  WORLD coords — pose only, never writes the camera. 3D-only. */
  dollhousePose?(
    frame: { x: number; y: number; w: number; h: number } | null,
    spiritAz: number,
    out: { pos: import("three").Vector3; look: import("three").Vector3; up: import("three").Vector3; fov: number },
  ): void;
  /** HOST-EMBED: force an avatar body (in)visible regardless of sim state — the
   *  coordinator hides the town's local walker while it's airborne. 3D-only. */
  setAvatarHidden?(id: string, hidden: boolean): void;
  /** POSSESSION: drop an avatar's cached body model so the next frame rebuilds
   *  it through the modelFactory (re-skin without a world rebuild). 3D-only. */
  resetAvatarModel?(id: string): void;
  /** HOST-EMBED chart rebase: the anchor this view hangs under moved to a new
   *  surface chart (world poses preserved; WorldHost.rebase carried the sim) —
   *  re-express the view's eased LOCAL-frame caches (follow centre, heading,
   *  spark) through `delta` = newAnchorWorld⁻¹ · oldAnchorWorld. 3D-only. */
  rebaseLocal?(delta: import("three").Matrix4): void;
  /** DIAGNOSTICS: one-line snapshot of the last cutaway/visibility pass
   *  (spirit toggle, frame, visible/blackout counts, local avatar). 3D-only. */
  debugCutaway?(): string;
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
