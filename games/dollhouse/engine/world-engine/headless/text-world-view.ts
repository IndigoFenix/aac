// shared/world-engine/headless/text-world-view.ts
//
// THE TEXT MODE VIEW — a real `WorldView` handed to the quest host, with no GL,
// no DOM and no canvas (text-mode.md law ①: "the view is the fidelity line").
// It draws nothing. What it DOES is everything a renderer owes the simulation:
//
//   • it answers `screenToWorld`, so the pointer/gaze pipeline works;
//   • it answers `pickScreen`, so hover/dwell resolve as they do in GL;
//   • it answers `revealedBuildings()`, which is NOT chrome — the town streamer
//     keys interior EMBODIMENT on it, so a view that computed it differently
//     would populate a DIFFERENT WORLD (render3d.ts ~:270);
//   • it records the `WorldState` + `RenderIntent` it was handed, which is the
//     ONLY channel the text projection may narrate from (law ①).
//
// ── THE CAMERA IS THE IDENTITY MAP (for now) ────────────────────────────────
// `screenToWorld(px, py) === { x: px, y: py }` — a "pixel" IS a world point.
// This is the pattern world-host-carry.test.ts drives the host with, and it
// makes `go X` trivially `worldToScreen(X)` → `setPointer(X)`. The GL-affine
// virtual follow camera (a real screen space with a finite viewport, so screen
// picking and off-screen culling mean something) arrives with MOVEMENT, step ⑨
// of text-mode.md — at which point only this file changes: everything above
// already routes through screenToWorld/worldToScreen.
//
// ── NO REACT, NO DOM, NO GAMES-BRIDGE ───────────────────────────────────────
// world-view.ts is DOM-TYPED and deliberately not re-exported from index.js, so
// it is imported TYPE-ONLY here (the same discipline board-chrome.ts follows).
// The one value import is `revealedInteriors` from render3d.ts, which is pure
// and DOM-free at module scope — importing it headless is already proven safe
// (server/tests/world-engine/world-render3d.test.ts).

import type { WorldState } from "../engine.js";
import { pickEntity } from "../interact.js";
import type { RenderIntent, ScreenPick, WorldView } from "../world-view.js";
import { revealedInteriors } from "../render3d.js";
import type { Vec2 } from "../types.js";
import type { BuildOverlayView } from "../interaction/quest/build-overlay-3d.js";

/** A rectangle in world coords — the dollhouse focus footprint. */
export interface TextFocusFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TextWorldViewOpts {
  /** Whose eyes this view renders from — what the reveal rule keys on. */
  localId: string;
  /** SPIRIT session: interiors reveal by ACCESSIBILITY, not by the room the
   *  body stands in (render3d's `revealedInteriors`). */
  spirit: boolean;
  /** Initial dollhouse focus rect, or null for the whole world. Mutable
   *  afterwards through `setSpiritFocus`. */
  spiritFrame?: TextFocusFrame | null;
  /** Initial interior-reveal flag. Default ON — the same default the 3D view
   *  ships (world-view.ts `setInteriorReveal`); the spirit GROUND rung is the
   *  one that turns it off. */
  interiorReveal?: boolean;
  /** Fired at the END of every `render()`, after the reveal cache is fresh —
   *  the text projection's frame hook. It receives exactly what a GL frame
   *  received and nothing more. */
  onRender?(state: WorldState, dt: number, intent: RenderIntent | undefined): void;
}

/** What the last rendered frame handed this view — the projection's window
 *  onto the world, and the ONLY one law ① allows. */
export interface TextViewProbe {
  /** The state of the last `render()` — null before the first frame. */
  state: WorldState | null;
  /** The intent that came with it (aim, cursor/hover, conversation). */
  intent: RenderIntent | null;
  /** That frame's dt, seconds. */
  dt: number;
  /** ⑦ THE BUILD OVERLAY the host handed this view — the lit ground, the live
   *  sites, the builder's ghosts. Null = the host is showing none. This is a
   *  RENDER input like any other (GL draws the identical payload), so
   *  narrating it is law ①, not a peek. */
  build: BuildOverlayView | null;
  /** The inverse of `screenToWorld` — identity today (see the camera note). */
  worldToScreen(p: Vec2): { x: number; y: number };
}

/** A `WorldView` that renders to nothing and remembers everything. */
export interface TextWorldView extends WorldView {
  /** ⑦ — the host's per-frame build overlay push (`QuestViewSeam.buildOverlay`).
   *  Stored for the probe; nothing is drawn. */
  setBuildOverlay(v: BuildOverlayView | null): void;
  /** Buildings whose interior is on show, as of the LAST render (see the
   *  one-frame-lag note in `render`). Required here — the streamer needs it. */
  revealedBuildings(): Set<string>;
  setInteriorReveal(on: boolean): void;
  setSpiritFocus(frame: TextFocusFrame | null): void;
  /** The last frame, for the projection. */
  probe(): TextViewProbe;
}

/** The identity screen↔world map, named so the two directions can never drift
 *  apart while the affine camera is still ahead of us (step ⑨). */
const worldToScreenIdentity = (p: Vec2): { x: number; y: number } => ({ x: p.x, y: p.y });

export function createTextWorldView(opts: TextWorldViewOpts): TextWorldView {
  const { localId, spirit } = opts;
  let interiorReveal = opts.interiorReveal ?? true;
  let spiritFrame: TextFocusFrame | null = opts.spiritFrame ?? null;

  let lastState: WorldState | null = null;
  let lastIntent: RenderIntent | null = null;
  let lastDt = 0;
  /** ⑦ — the last build overlay the host pushed (see `setBuildOverlay`). */
  let build: BuildOverlayView | null = null;
  // THE ONE-FRAME LAG, ON PURPOSE (text-mode.md law ⑥ / sim parity). The world
  // host runs its sim — including the town streamer, which asks the view what
  // is revealed — BEFORE it calls `view.render`. So in GL, `revealedBuildings()`
  // always answers with LAST frame's reveal, and on frame 0 it answers with the
  // empty set (nothing has rendered yet). Computing it eagerly here would make
  // the headless world stream residents one frame EARLIER than a GL run, i.e. a
  // different world from the same seed. So: computed in render(), cached, and
  // handed out unchanged until the next render.
  //
  // ONE DOCUMENTED DIVERGENCE: GL reports a building while its roof is still
  // EASING back to opaque, so a room you just left stays "revealed" for the
  // length of the fade. Headless has no fade — it SEALS INSTANTLY. That makes
  // the headless set a subset of GL's (conservative: a resident abstracts a
  // few frames sooner, never later), which is the safe direction for a
  // streaming gate. The GL A/B expects equality modulo exactly this tail.
  let revealed: Set<string> = new Set();

  // Injected viewport (CSS px) — a headless view has no element to measure, so
  // the host tells it (quest-host uses QuestViewSeam.size() ?? 1280x720). Kept
  // because the virtual follow camera (step ⑨) will need it; the identity map
  // does not, so nothing reads it yet.
  const viewport = { w: 1, h: 1, dpr: 1 };

  return {
    // A pixel IS a world point. Never null: there is no horizon to fall off.
    screenToWorld(px, py): Vec2 {
      return { x: px, y: py };
    },

    /** What the gaze rests on. GL raycasts its meshes; with the identity map
     *  the equivalent question is "what entity is AT that world point", which
     *  is exactly `pickEntity` — the same function the host itself falls back
     *  to for a view with no screen pick, so hover/dwell behave as in GL.
     *  `includeLocal` drops the exclusion of the local body (pickEntity skips
     *  the id it is given, so an id that matches nothing includes everyone).
     *  Never returns `kind:"bubble"`: text mode draws no bubbles to look at —
     *  speech is read by diffing `state.bubbles` (law ②), not by picking one. */
    pickScreen(px: number, py: number, o?: { includeLocal?: boolean }): ScreenPick | null {
      if (!lastState) return null;
      const hit = pickEntity({ x: px, y: py }, lastState, o?.includeLocal ? "" : localId);
      return hit ? { kind: hit.kind, id: hit.id } : null;
    },

    revealedBuildings(): Set<string> {
      return revealed;
    },

    render(state: WorldState, dt: number, intent?: RenderIntent): void {
      lastState = state;
      lastIntent = intent ?? null;
      lastDt = dt;
      // ONE OWNER of the interior-reveal rule (render3d.ts) — sim parity by
      // construction, not by a comment saying the two agree.
      revealed = revealedInteriors(state, localId, { interiorReveal, spirit, spiritFrame });
      opts.onRender?.(state, dt, intent);
    },

    resize(width: number, height: number, dpr: number): void {
      viewport.w = Math.max(1, width);
      viewport.h = Math.max(1, height);
      viewport.dpr = dpr || 1;
    },

    /** Reveal interiors at all? Off = ordinary sealed buildings (the spirit
     *  GROUND rung). Takes effect on the NEXT render, like every camera write. */
    setInteriorReveal(on: boolean): void {
      interiorReveal = on;
    },

    /** The dollhouse focus footprint (spirit only): accessible rooms OUTSIDE it
     *  stay sealed. Null = the whole-world stationary spirit. Next render. */
    setSpiritFocus(frame: TextFocusFrame | null): void {
      spiritFrame = frame;
    },

    setBuildOverlay(v: BuildOverlayView | null): void {
      build = v;
    },

    probe(): TextViewProbe {
      return {
        state: lastState,
        intent: lastIntent,
        dt: lastDt,
        build,
        worldToScreen: worldToScreenIdentity,
      };
    },

    dispose(): void {
      lastState = null;
      lastIntent = null;
      build = null;
      revealed = new Set();
    },
  };
}
