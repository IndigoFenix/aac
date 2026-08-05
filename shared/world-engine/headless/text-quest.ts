// shared/world-engine/headless/text-quest.ts
//
// THE HEADLESS BOOT — `bootTextQuest` stands up the SAME dollhouse session the
// shipped game boots (games/dollhouse/src/quest-boot.ts `bootLivingTown`), with
// the rendering surface swapped for the text view and the frame pump swapped
// for a hand-cranked clock. text-mode.md law ⑥: BYPASS THE PIXELS, NEVER THE
// SIM. Every sim-relevant step of that boot is replicated here, in order:
//
//   ① loadWorldManifest(structuredClone(raw), [ECONOMY_MODULE])
//   ② buildTownScope(loaded.game)  →  { spec, play, focus }
//   ③ spirit flag (avatarKind), session scale, culture, dollhouse focus index
//   ④ createQuestHost3D({ view, presenter, voice: null, scheduleFrame, now, npcRng })
//   ⑤ host.start(bundle.game, play, { spirit, dollhouse, scale, culture })
//   ⑥ the TEXT CAMERA — the three SIM effects of the spirit ladder's structure
//      rung, and nothing else (see `applyCamera` below).
//
// ── DELIBERATELY NOT REPLICATED (render/chrome only) ────────────────────────
// Everything the browser boot does that a frame of simulation cannot see:
//   • `resolveImage` / glyph rasters — artwork for buttons that do not exist;
//   • the board-island claim, the toast/objective/satchel DOM, the win card;
//   • `ResizeObserver` (the seam declares a fixed viewport instead);
//   • the AIM ARBITRATION between a native pointer and the forwarded gaze
//     stream — there is exactly one input here, `look()`;
//   • `__questLab` / `__questLab_pose` / `__spiritLadder` window globals;
//   • the spirit LADDER object itself (its camera poses, blends, orbit dwell,
//     rung ascent/descent) — a text camera is STATIC, which is also what makes
//     resident streaming deterministic;
//   • crowd-budget / creature-tier LOD levers (render fidelity, per camera);
//   • multiplayer (`QuestHostDeps.multiplayer`) — one local player here;
//   • `groundAt` / `waterAt` samplers — the dollhouse town is flat.
//
// No React, no DOM, no games-bridge. The view is type-only where it can be.

import { hashSeed, mulberry32 } from "@shared/prng.js";
import type { WorldState } from "../engine.js";
import { avatarKind, loadWorldManifest } from "../kernel/manifest.js";
import { ECONOMY_MODULE } from "../kernel/modules/economy/index.js";
import {
  createQuestHost3D,
  type QuestBoardView,
  type QuestHost3D,
  type QuestPresenter,
  type QuestSession,
  type QuestViewSeam,
} from "../interaction/quest/quest-host.js";
import { buildTownScope } from "../interaction/town/town-play-game.js";
import { DOLLHOUSE_SCALE, resolveWorldScale, type WorldScale } from "../scale.js";
import { PLAYER_ID } from "../solver/space3d.js";
import { createTextWorldView, type TextFocusFrame, type TextWorldView } from "./text-world-view.js";

/**
 * WHERE THE TEXT SESSION WATCHES FROM. A text camera is STATIC by design: it
 * never orbits, never blends and never changes rung, so the reveal set (and
 * therefore which residents the town streamer embodies) is a pure function of
 * the sim — which is what makes two same-seed runs identical.
 *
 *   • `dollhouse` — the shipped game's opening: the spirit parked at the focus
 *     house, its interior on show, the rest of the town sealed.
 *   • `town` — the whole-world stationary spirit: every ACCESSIBLE room on
 *     show, no focus frame.
 *   • `follow` — ride one creature. Minimal on purpose (step ⑨ owns movement):
 *     interiors reveal only while that creature is actually possessed, which is
 *     the ladder's own rule (`possessedNow || level === "structure"`).
 */
export type TextCamera =
  | { kind: "dollhouse" }
  | { kind: "town" }
  | { kind: "follow"; creatureId: string };

export interface TextQuestOpts {
  /** The PARSED world document (the object `game.spec.json` holds). Cloned
   *  before loading, exactly as the game's `loadSpec` does — `loadWorldManifest`
   *  mutates/normalizes what it is handed. */
  world: unknown;
  /** Seed for the injected NPC RNG. Default: the town document's own
   *  `config.seed`, so a run is reproducible from the document alone. */
  seed?: number;
  /** Fixed frame step, seconds. Default 1/60 (text-mode.md D4). */
  dt?: number;
  /** Default `{ kind: "dollhouse" }` — the shipped game's opening camera. */
  camera?: TextCamera;
  /** Clock origin in ms. Default 0. */
  startMs?: number;
  /** Per-frame hook, forwarded to the view's `onRender` (the projection's
   *  frame seam). Fires after the reveal cache is fresh. */
  onRender?: TextWorldViewOnRender;
}

type TextWorldViewOnRender = NonNullable<Parameters<typeof createTextWorldView>[0]["onRender"]>;

/** What the boot's own fan-out presenter has SEEN. Not part of the projection
 *  contract (a projection registers a TAP instead) — a test/debug convenience. */
export interface TextPresenterLog {
  /** The last board page the host pushed, exactly as it pushed it. */
  board: QuestBoardView | null;
  boards: number;
  clears: number;
  toasts: number;
  lastToast: string | null;
  objectives: number;
  sessions: number;
  wins: number;
}

export interface TextQuestRun {
  readonly host: QuestHost3D;
  readonly view: TextWorldView;
  /** The live world state. Throws once the run is disposed. */
  readonly state: WorldState;
  readonly session: QuestSession;
  /** Advance EXACTLY one frame of `frameDt` seconds. */
  stepFrame(): void;
  advance(frames: number): void;
  advanceS(seconds: number): void;
  /** Register a listener on the presenter FAN-OUT. Every host push reaches
   *  every tap; the boot's own record is unaffected. Returns a remove fn. */
  addPresenterTap(p: Partial<QuestPresenter>): () => void;
  /** See `TextPresenterLog`. */
  presenterLog(): TextPresenterLog;
  /** Speak a composed AAC sentence (the real `performPlayerAction` path). */
  speak(sentence: string, opts?: { spokenExternally?: boolean; targetId?: string }): void;
  /** Press a board option. */
  select(id: string): void;
  /** LOOK at a world point — the pointer/gaze pipeline, through the view's
   *  identity screen map (so a world point IS the client pixel). */
  look(worldX: number, worldY: number): void;
  clearLook(): void;
  readonly frameDt: number;
  readonly seed: number;
  dispose(): void;
}

export function bootTextQuest(opts: TextQuestOpts): TextQuestRun {
  // ① THE DOCUMENT. structuredClone first: the loader normalizes in place, and
  //    a caller's parsed JSON must survive a second boot unchanged (the
  //    determinism test boots the same object twice).
  const loaded = loadWorldManifest(structuredClone(opts.world), [ECONOMY_MODULE]);
  if (!loaded.game) throw new Error("bootTextQuest: the document has no `game` settings");
  const game = loaded.game;
  if (game.scope !== "town") {
    throw new Error(`bootTextQuest: only the town scope boots headless (got "${game.scope}")`);
  }

  // ② THE TOWN. Same call, same certification, same deterministic build.
  const built = buildTownScope(game);
  const play = built.play;

  // ③ THE SESSION SHAPE the game hands `host.start` — verbatim from bootLivingTown.
  const spirit = avatarKind(game) === "spirit";
  //    The document's declared scale, else the street-clock DOLLHOUSE profile
  //    (the town machinery is paced to that 240 s day).
  const scale: WorldScale = game.scale ? resolveWorldScale(game.scale) : DOLLHOUSE_SCALE;
  const culture = game.culture;
  const dollhouse = built.focus ? built.focus.house : undefined;
  //    The focus LOT in world coords — the ladder's `focusFrame`. (The host
  //    computes the same rect internally as `spiritFrame` and hands it to the
  //    view seam; this one drives the camera's own writes.)
  const focusLot = built.focus
    ? play.plan.houses.find((h) => h.index === built.focus!.house) ?? null
    : null;
  const focusFrame: TextFocusFrame | null = focusLot
    ? {
        x: focusLot.dx + play.stage.center.x,
        y: focusLot.dy + play.stage.center.y,
        w: focusLot.w,
        h: focusLot.h,
      }
    : null;

  const camera: TextCamera = opts.camera ?? { kind: "dollhouse" };
  const frameDt = opts.dt ?? 1 / 60;
  const seed = opts.seed ?? play.config.seed;

  // ── THE PRESENTER FAN-OUT ─────────────────────────────────────────────────
  // The boot owns the presenter (the host needs one before anything else
  // exists), so a projection cannot REPLACE it — it TAPS it. Every method
  // records into the boot's log and forwards to every tap, so two consumers
  // (a text session and a test) never fight over the one slot.
  const taps: Partial<QuestPresenter>[] = [];
  const log: TextPresenterLog = {
    board: null, boards: 0, clears: 0, toasts: 0, lastToast: null,
    objectives: 0, sessions: 0, wins: 0,
  };
  /** Forward one push to every tap, in registration order. */
  const fan = (call: (t: Partial<QuestPresenter>) => void): void => {
    for (const t of taps) call(t);
  };
  const presenter: QuestPresenter = {
    // Required half.
    sessionStarted(session) { log.sessions++; log.board = null; fan((t) => t.sessionStarted?.(session)); },
    board(v) { log.boards++; log.board = v; fan((t) => t.board?.(v)); },
    clearBoard() { log.clears++; log.board = null; fan((t) => t.clearBoard?.()); },
    toast(text, kind) { log.toasts++; log.lastToast = text; fan((t) => t.toast?.(text, kind)); },
    objectives(list) { log.objectives++; fan((t) => t.objectives?.(list)); },
    collect(nodeId, have, need) { fan((t) => t.collect?.(nodeId, have, need)); },
    satchel(inventory) { fan((t) => t.satchel?.(inventory)); },
    won() { log.wins++; fan((t) => t.won?.()); },
    // Optional half — present because the host CALLS them (a missing method is
    // a silently dropped push, and text mode's whole job is to drop nothing).
    pocket(items) { fan((t) => t.pocket?.(items)); },
    score(value) { fan((t) => t.score?.(value)); },
    action(action, meta) { fan((t) => t.action?.(action, meta)); },
    nouns(list) { fan((t) => t.nouns?.(list)); },
    addressees(list) { fan((t) => t.addressees?.(list)); },
    family(members) { fan((t) => t.family?.(members)); },
    city(chips) { fan((t) => t.city?.(chips)); },
  };

  // ── THE MANUAL PUMP ───────────────────────────────────────────────────────
  // world-host-carry.test.ts's pattern, one level up: the frame callback is
  // captured instead of scheduled, and `now` reads the same hand-advanced
  // clock the host's dt is computed from. The host's loop re-schedules itself
  // at the end of every frame, so the captured callback stays fresh.
  let tMs = opts.startMs ?? 0;
  let frameCb: ((now: number) => void) | null = null;
  const scheduleFrame = (cb: (now: number) => void): (() => void) => {
    frameCb = cb;
    return () => {
      if (frameCb === cb) frameCb = null;
    };
  };

  let view: TextWorldView | null = null;
  const seam: QuestViewSeam = {
    create(ctx) {
      view = createTextWorldView({
        localId: ctx.localId,
        spirit: ctx.spirit,
        // The host resolved the dollhouse rect already; seed from it so frame 1
        // is right even before the camera asserts itself.
        spiritFrame: ctx.spiritFrame,
        interiorReveal: camera.kind !== "follow",
        ...(opts.onRender ? { onRender: opts.onRender } : {}),
      });
      return view;
    },
    // A fixed viewport. Nothing measures a headless view, and with the identity
    // screen map the numbers only bound the host's screen-space picking.
    size: () => ({ w: 1280, h: 720, dpr: 1 }),
  };

  // ④ THE HOST. `voice: null` is LOAD-BEARING — omitting it constructs the
  //    default speechSynthesis voice, which does not exist in Node.
  const host = createQuestHost3D({
    view: seam,
    presenter,
    voice: null,
    scheduleFrame,
    now: () => tMs,
    // Determinism (text-mode.md D4): the world-host's default is `Math.random`,
    // so a headless boot MUST inject. Same fold every other subsystem uses.
    npcRng: mulberry32(hashSeed(seed, "npc")),
  });

  // ⑤ START. Exactly the argument list bootLivingTown passes.
  host.start(play.bundle.game, play, {
    spirit,
    ...(dollhouse !== undefined ? { dollhouse } : {}),
    scale,
    ...(culture ? { culture } : {}),
  });
  if (!view) throw new Error("bootTextQuest: the host never built a view");
  const textView: TextWorldView = view;

  // ⑥ THE TEXT CAMERA — the ladder's THREE SIM EFFECTS, and nothing else.
  //
  // The spirit ladder (spirit/ladder.ts `stepStructure`) does a great deal that
  // is pure rendering: it eases an orbit, blends two poses, rebases the render
  // origin, drives a spark. Exactly three of its writes reach the SIMULATION,
  // and those are what a text camera owes the world:
  //
  //   1. PARK THE GAZE AVATAR at the focus house centre (`placeGazeAvatar`,
  //      fired once on engaging the rung). A spirit's PLAYER_ID body is a
  //      parked stand-in, but it is still the body `visibleBuildings` and the
  //      streamer's occupancy check read, so WHERE it stands is sim state.
  //   2. TELL THE HOST WHERE THE SPIRIT HOVERS (`setSpiritPosition`, fed every
  //      frame from `ladder.focusWorld`) — distance rules must see the SPIRIT,
  //      not the parked body.
  //   3. SET THE REVEAL (`setInteriorReveal` + `setSpiritFocus`), which decides
  //      `revealedBuildings()` and therefore which interiors get EMBODIED.
  //      Re-asserted every frame in the ladder because the view can be rebuilt
  //      under a streaming session; re-asserted here for the same reason.
  //
  // (In GL, 3 goes host → questView. Headless `questView` is null by
  //  construction, so the camera writes to the text view directly.)
  const cameraPoint = (): { x: number; y: number } | null => {
    if (camera.kind === "dollhouse") {
      return focusFrame
        ? { x: focusFrame.x + focusFrame.w / 2, y: focusFrame.y + focusFrame.h / 2 }
        : { x: play.stage.center.x, y: play.stage.center.y };
    }
    if (camera.kind === "town") return { x: play.stage.center.x, y: play.stage.center.y };
    const body = host.world?.state.avatars[camera.creatureId];
    return body ? { x: body.x, y: body.y } : null;
  };

  /** Effect 1 — once, on boot, exactly as the ladder's `s.engaged` latch. */
  const parkGazeAvatar = (): void => {
    if (camera.kind === "follow") return; // a followed body parks itself
    const at = cameraPoint();
    const p = host.world?.state.avatars[PLAYER_ID];
    if (!at || !p) return;
    p.x = at.x;
    p.y = at.y;
    p.vx = 0;
    p.vy = 0;
  };

  /** Effects 2 + 3 — idempotent, re-asserted before every frame. */
  const applyCamera = (): void => {
    const at = cameraPoint();
    if (at) host.setSpiritPosition(at.x, at.y);
    switch (camera.kind) {
      case "dollhouse":
        textView.setSpiritFocus(focusFrame);
        textView.setInteriorReveal(true);
        break;
      case "town":
        textView.setSpiritFocus(null); // frameless spirit = the full reveal
        textView.setInteriorReveal(true);
        break;
      case "follow":
        textView.setSpiritFocus(null);
        // The ladder's own rule: a formless spirit in the street is not an
        // occupant — CLAIM a body and the interior opens as for a walker.
        textView.setInteriorReveal(host.possessed !== null);
        break;
    }
  };

  parkGazeAvatar();
  applyCamera();

  const stepFrame = (): void => {
    // Camera writes land BEFORE the frame, so this frame's render() sees them —
    // and `revealedBuildings()` keeps its honest one-frame lag (the sim inside
    // this frame still reads what the PREVIOUS render computed).
    applyCamera();
    tMs += frameDt * 1000;
    frameCb?.(tMs);
  };

  return {
    host,
    view: textView,
    get state(): WorldState {
      const w = host.world;
      if (!w) throw new Error("bootTextQuest: the world host has stopped");
      return w.state;
    },
    get session(): QuestSession {
      return host.session;
    },
    stepFrame,
    advance(frames: number): void {
      for (let i = 0; i < frames; i++) stepFrame();
    },
    advanceS(seconds: number): void {
      const n = Math.max(0, Math.round(seconds / frameDt));
      for (let i = 0; i < n; i++) stepFrame();
    },
    addPresenterTap(p: Partial<QuestPresenter>): () => void {
      taps.push(p);
      return () => {
        const i = taps.indexOf(p);
        if (i >= 0) taps.splice(i, 1);
      };
    },
    presenterLog(): TextPresenterLog {
      return { ...log };
    },
    speak(sentence, o): void {
      host.speak(sentence, o);
    },
    select(id: string): void {
      host.select(id);
    },
    look(worldX: number, worldY: number): void {
      // The view's screen map is the identity, and a headless host's client
      // origin is (0,0) — so a world point IS the client pixel to feed.
      host.setPointer(worldX, worldY);
    },
    clearLook(): void {
      host.clearPointer();
    },
    frameDt,
    seed,
    dispose(): void {
      host.stop();
    },
  };
}
