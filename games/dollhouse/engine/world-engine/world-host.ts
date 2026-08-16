// shared/world-engine/world-host.ts
//
// The framework-free heart of the world engine: the per-frame loop that drives
// input → aim → sim → (optional) networking → render. Lives in the engine so any
// surface — the single-player goal-tree player, a future game, or the social
// world — gets the full feel (physics, camera, gaze, dialogue bubbles, NPC
// bodies) by injecting a WorldView + clock, with transport optional. It runs in
// two places:
//   • on the main thread (a React component wires DOM events + a call net), and
//   • inside a Web Worker on an OffscreenCanvas (a bridge posts inputs in and
//     outbound net messages out).
//
// It owns NO DOM and NO transport: a `WorldView` (injected) does the drawing +
// screen→world mapping, a `scheduleFrame`/`now` clock drives it, and inbound peer
// state is fed in via methods while outbound rides the injected `net` callbacks.
// Multiplayer specifics (presence relay, NPC conversation brains, the call mesh)
// stay in shared/social-world; this only knows the generic transport seam below.

import {
  __probeStats,
  addLocalAvatar,
  applyRemoteAvatar,
  carryObject,
  CARRY_HOLD,
  createWorldState,
  objectAllows,
  placeCarriedObject,
  removeAvatar,
  routeThroughDoors,
  setAvatarSpeech,
  setDrivenBody,
  addWorldObject,
  removeWorldObject,
  setWorldBuildings,
  setWorldStructures,
  smoothRemoteAvatars,
  steerAvatar,
  fixturesWalkable,
  structuresWalkable,
  terrainWalkable,
  tickWorld,
  WORLD_ENGINE_DEFAULTS,
  type GroundSampler,
  type WaterSampler,
  type MoveConstraint,
  type WorldEngineConfig,
  type WorldEvent,
  type WorldState,
} from "./engine.js";
import { createDwellTracker } from "./dwell.js";
import { probesOn } from "./perf-probes.js";
import { speciesBodyRadius } from "./creatures/species.js";
import { applyInbound, collectOutbound, sayMessage, type WorldNetMessage } from "./net.js";
import { WORLD_MAX_NPCS, WORLD_MAX_ROOTED_NPCS, isRootedNpc, type BuildingSpec, type NpcSpec, type ObjectSpec, type StructureSpec, type TransitPoint, type Vec2, type WorldSpec } from "./types.js";
import type { WorldView } from "./world-view.js";
import { createGazeInterpreter } from "./gaze-intent.js";
import { approachAim, pickEntity } from "./interact.js";
import { DEFAULT_WORLD_TUNABLES, type WorldTunables } from "./world-tunables.js";
import { clockDodgeAim, separateBodies } from "./interaction/quest/stand-points.js";
import { tickFurnitureAnchor, isFurnitureAnchored } from "./interaction/quest/furniture-anchor.js";
import {
  __npcStats,
  createDetourMemory,
  createNpcController,
  detourAim,
  sideOfBend,
  DEFAULT_CONVERSATION_RADIUS,
  type NpcController,
  type NpcEngagement,
  type NpcErrand,
  type NpcErrandPath,
  type NpcProximity,
} from "./npc-controller.js";

/**
 * A relayed avatar position — the generic packet the host publishes/applies for a
 * networked peer. Multiplayer code (shared/social-world/world-presence) carries a
 * richer `WorldPresence` (it also feeds the conversation-circle solver); that type
 * is structurally a superset, so it flows through these methods unchanged.
 */
export interface PresencePacket {
  personId: string;
  x: number;
  y: number;
  /** Facing unit vector. */
  fx: number;
  fy: number;
  /** Velocity (world units/sec) for smoothing/extrapolation. */
  vx: number;
  vy: number;
  /** Storey level (0 = ground). Optional on the wire; defaults to 0. */
  floor?: number;
}

const SEND_INTERVAL_MS = 1000 / 15; // ~15 Hz mesh world-state (toys/possession + avatar)
const PRESENCE_INTERVAL_MS = 1000 / 8; // ~8 Hz relay position (cheap, position-only)

/** Outbound transport — supplied by the host's environment (the call mesh on the
 *  main thread, or a postMessage bridge in the worker). Absent ⇒ single-player. */
export interface WorldHostNet {
  send: (msgs: WorldNetMessage[]) => void;
  publishPresence?: (p: PresencePacket) => void;
}

/** THE FRAME-LENGTH CEILING with no wide tick configured — today's value, and
 *  the reason a caller's wider `dt` has always been a silent no-op: the loop
 *  re-derives dt from the clock and clamps it here (wide-tick-round.md). */
const FRAME_DT_CAP_S = 0.05;
/** Default inner MOTION cap for a wide tick — BLESSED at 0.1 by the W4a
 *  calibration (wide-tick-round.md): the A/B comparator's gating channels
 *  (toast/depart/ledger) read identical to today's 0.05 at every tested
 *  value, and `arrive`'s one `mara` divergence is present ALREADY at 0.05 —
 *  it is a dt=0.5 decision-latency artifact (W2's recorded class e3), not
 *  something raising innerStepS introduces. 0.1 is also the mathematically
 *  PROVABLE ceiling: `step = dt / ceil(dt/innerStepS) ≤ innerStepS` for any
 *  dt, so `innerStepS ≤ maxStep` (`WORLD_ENGINE_DEFAULTS.maxStep`, 0.1)
 *  guarantees the engine's own internal clamp (engine.ts `Math.min(dt,
 *  config.maxStep)`, :694/:838) never binds — there is only ever ONE clock.
 *  0.15 was tested and REJECTED: at dt ∈ {0.25, 0.5} it produces a 0.125 s
 *  substep, which the engine's own clamp silently truncates to 0.1 s —
 *  bodies under-integrate by 20% while the outer loop's accounting believes
 *  the full step happened, reintroducing the exact desync this seam exists
 *  to close. (Its beat diff read CLEANER than 0.1's, which is the tell: that
 *  is under-integration nudging timing to coincidentally dodge this arc's
 *  truncated-window artifact, not genuine improved fidelity — the comparator
 *  measures discrete beats, not walked distance, so it cannot see this on
 *  its own.) W-② — a tuning parameter of the seam, not a user dial. */
export const WIDE_TICK_INNER_STEP_S = 0.1;
/** The widest frame a wide-tick host will admit — text-mode's `--dt` ceiling. */
export const WIDE_TICK_MAX_FRAME_S = 0.5;

/**
 * ⏩ THE WIDE TICK (planning-docs/games/world-engine/wide-tick-round.md).
 *
 * OPT-IN, at host construction only. Present, it does exactly two things:
 *   • lifts the host's own frame-length clamp from 0.05 s to `maxFrameS`, so a
 *     headless pump that hands over a wide dt actually gets one; and
 *   • splits the two MOTION arms of the frame (`tickWorld` + `advanceNpcs`)
 *     into equal substeps of ≤ `innerStepS`, while the DECISION pass
 *     (`deps.onFrame` — the whole quest layer) runs ONCE with the full dt.
 *
 * ⚖️ W-① one dt enters the frame; bodies cover all of it.
 * ⚖️ W-③ ABSENT, the frame body and the clamps behave byte-identically to
 *    today — GL never constructs this, so play mode is untouched.
 */
export interface WideTickConfig {
  /** Max seconds of MOTION integrated per inner step. Default 0.05. */
  innerStepS?: number;
  /** Max frame dt this host will admit. Default 0.5. */
  maxFrameS?: number;
}

export interface WorldHostDeps {
  view: WorldView;
  spec: WorldSpec;
  localId: string;
  /** Stable spawn assignment (wraps spec.spawns); see SocialWorldCanvas. */
  spawnIndex: number;
  /** Resolved spawn point (centroid-of-peers + offset already applied), or omit. */
  spawnAt?: Vec2;
  /** IRREGULAR-GROUND seam: height sampler for the site (see GroundSampler —
   *  pure, meters). Stored on the world state; the 3D view reads it there to
   *  stand bodies/buildings/roads on the terrain, and the sim reads its
   *  GRADIENT for slope movement costs (slow/wall). Omit ⇒ flat 0. */
  groundAt?: GroundSampler;
  /** WATER seam, beside `groundAt`: true where (x, y) is water — impassable to
   *  the local walker and NPC bodies (see WaterSampler). Mechanics only; the
   *  host's ground mesh renders it. Omit ⇒ dry everywhere. */
  waterAt?: WaterSampler;
  net?: WorldHostNet;
  /** Host this spec's NPCs on THIS peer: spawn them, advance their bodies each
   *  frame, and broadcast them like owned avatars. Exactly one peer in a room
   *  should set this. The solo surface always does; Phase 2 elects one owner in a
   *  multiplayer call. Default false. */
  hostNpcs?: boolean;
  /** REPLICA NPCs (owner-authoritative multiplayer, the follower's half of
   *  `hostNpcs`): spawn this spec's NPCs — and accept runtime `addNpc()` — as
   *  bodies WITHOUT controllers, so they are never advanced locally and never
   *  broadcast (`ownedAvatarIds` stays the local spark alone). The owning
   *  peer's ordinary avatar packets then drive them (applyRemoteAvatar +
   *  smoothRemoteAvatars), while the local streamer keeps deciding WHICH
   *  bodies exist and which model each wears. Mutually exclusive with
   *  hostNpcs (hostNpcs wins). Default false. */
  replicaNpcs?: boolean;
  /** RNG for NPC wander (deterministic in tests). Defaults to Math.random. */
  npcRng?: () => number;
  /** Concurrent cap for runtime-streamed NPCs (addNpc). Defaults to
   *  WORLD_MAX_NPCS — the right bound when every NPC is a live social
   *  session and/or broadcast to peers. A single-player STREAMED world
   *  whose cast is pure bodies (wander/errand controllers, no AI mind —
   *  e.g. grand-dream's villagers) may raise it: a body costs one
   *  steering tick per frame. Spec-authored NPCs stay schema-capped
   *  regardless. Counts MOVERS only — rooted bodies have their own
   *  ledger (maxRootedNpcs), so a forest never crowds out the cast. */
  maxNpcs?: number;
  /** Concurrent cap for ROOTED runtime bodies (isRootedNpc — zero declared
   *  pace: trees). Defaults to WORLD_MAX_ROOTED_NPCS, which is far larger
   *  than maxNpcs because these bodies skip steering entirely: they cost an
   *  avatar record, not a tick. Raise it for a world that stands a dense
   *  forest as touchable entities. */
  maxRootedNpcs?: number;
  /** Fires (on CHANGE of the in-range set) with the hosted NPCs the LOCAL player is
   *  within conversation range of, nearest first. The React conversation layer uses
   *  it to decide which NPC the player can talk to. Only meaningful when hostNpcs. */
  onNpcProximity?: (nearby: NpcProximity[]) => void;
  /** Schedule the next frame; returns a cancel fn. Main: requestAnimationFrame.
   *  Worker: self.requestAnimationFrame, else a setTimeout shim. */
  scheduleFrame: (cb: (nowMs: number) => void) => () => void;
  /** Monotonic clock in ms (performance.now on both threads). */
  now: () => number;
  /** Initial gaze/camera/comfort tunables (debug menu). Defaults applied if omitted. */
  tunables?: WorldTunables;
  /** Constrain avatar movement — the LOCAL player and any hosted NPC bodies slide
   *  along its solids (e.g. a goal-tree quest's walls). Its `walkable` closure is
   *  read every step, so it can reflect changing world state (a door that opened).
   *  Omit for open-field worlds (the social field). */
  constraint?: MoveConstraint;
  /** Called each frame AFTER the local + NPC ticks and remote smoothing, BEFORE
   *  render — the seam where a single-player game layer reads avatar positions and
   *  injects its own logic (e.g. quest proximity detection → runtime inputs). */
  onFrame?: (state: WorldState, dt: number) => void;
  /** Enable the CARRY interaction: dwell on a nearby carryable object to pick it
   *  up; while carrying, steering is suspended and dwelling on a spot moves the
   *  OBJECT there and puts it down (onto a container's slot under that spot, or on
   *  the ground). Omit to disable carry.
   *  `canPick` vetoes a completed pick-dwell (item OWNERSHIP: the vendor's stock
   *  is visible but not takeable); `onPickDenied` fires instead of the pick so the
   *  game layer can show the refusal (❌ + the owner's "mine!" bubble). */
  carry?: {
    reach?: number;
    dwellMs?: number;
    canPick?: (objectId: string) => boolean;
    onPickDenied?: (objectId: string) => void;
    /** PRE-GATE: false = the object offers NO pick affordance at all (no dwell
     *  ring, no denied event) — unlike `canPick`, whose veto fires after a
     *  completed dwell so the game can explain WHY. A formless spirit that
     *  simply cannot grab the world uses this; ownership vetoes keep canPick. */
    pickable?: (objectId: string) => boolean;
  };
  /** Extra dwell-to-select progress (0..1) to fold into the gaze-cursor spark's
   *  bloom — for a game-layer dwell the host doesn't own (e.g. the conversation
   *  start/cancel dwell). Read each frame just before render. */
  cursorProgress?: () => number;
  /** SPIRIT / stationary mode (AvatarKind "spirit"): the local avatar NEVER moves
   *  (aim is forced null) and CARRY goes DISTANCE-FREE — the gaze-hovered
   *  carryable is picked, and the held item is placed at the gaze fixation,
   *  regardless of reach. The simplified puzzle avatar: the player chooses only
   *  WHAT to do, never where to stand. (Talk-at-a-distance is the game layer's
   *  job — see the quest host's spirit dispatcher.) */
  stationary?: boolean;
  /** MULTIPLAYER + SPIRIT: where this peer actually IS, when that is NOT its
   *  local avatar's position. A stationary spirit's avatar never moves (`aim`
   *  is forced null below), so the streamed packet would pin every peer's light
   *  to the spawn point for the whole session — they'd see each other exist and
   *  never see each other move. Returning the spirit's hover point makes the
   *  broadcast follow the player. Applied to the OUTBOUND packet only: the sim
   *  is untouched, so nothing here can shove a body or change a distance rule.
   *  Return null to stream the avatar's own position (the default). */
  netLocalPos?: () => Vec2 | null;
  /** ⏩ WIDE TICK — see `WideTickConfig`. Omit for today's behaviour. */
  wideTick?: WideTickConfig;
}

/** A running world loop. Feed it peer state + input; it renders and emits outbound. */
export interface WorldHost {
  /** Inbound mesh messages (toys/possession + avatars when no relay). */
  applyNetInbound(msgs: WorldNetMessage[]): void;
  /** Inbound relayed presence (a remote avatar position). */
  applyPresence(p: PresencePacket): void;
  /** A peer left / was pruned. */
  applyPresenceLeave(personId: string): void;
  /** Pointer moved to a canvas-relative CSS pixel. */
  setPointer(px: number, py: number): void;
  /** Pointer left the surface (avatar coasts to a stop). */
  clearPointer(): void;
  /** Freeze the sim (advance dt=0) while still rendering + updating the pointer
   *  pick, so a debug tool can inspect a still frame. Pass false to resume. */
  setPaused(paused: boolean): void;
  /** Enter/leave an NPC conversation: while a target is set the local avatar
   *  FOLLOWS it — steering toward the point to stay at talking distance and facing
   *  it (so a partner that walks off is followed, not left behind) — and the camera
   *  slews to FACE it. Pass the partner's LIVE position each frame. Pass null to
   *  leave. Driven by the game layer (e.g. dwell-to-talk). */
  setConversation(target: Vec2 | null): void;
  /** WHO IS TALKING — the conversation a camera should FRAME, passed straight
   *  through to the renderer as `RenderIntent.conversation` (the dollhouse
   *  camera's conversation dolly reads it). Null clears.
   *
   *  `id` is the conversation's own identity and is the camera's LATCH KEY: the
   *  dolly holds the frame while the id stands, so members joining and leaving
   *  never restart the move. `members` are avatar ids (any may have no body —
   *  the camera frames whichever it can see). `speaker` is reserved for a later
   *  framing bias and is ignored by the v1 camera.
   *
   *  DELIBERATELY SEPARATE from `setConversation`: that one is the LOCAL
   *  player's steering/facing target and is a POINT (it also carries a container
   *  board's standpoint, which is not a conversation at all). This is the set of
   *  bodies a camera must FRAME, so it must be identities the renderer can
   *  re-read each frame, and it covers the NPC↔NPC exchanges the local player
   *  isn't even part of. Pass it every frame the conversation stands; the
   *  renderer adds its own hysteresis so a one-frame gap never drops the frame. */
  setConversationFocus(
    conv: { id: string; members: string[]; speaker?: string } | null,
  ): void;
  /** @deprecated The dyadic form — use `setConversationFocus`. Kept as a thin
   *  wrapper (a pair is the n = 2 case) so existing callers behave identically:
   *  the synthesized latch key `pair:a|b` changes exactly when the pair does,
   *  which is the old `{a,b}`-equality latch. */
  setConversationPair(pair: { a: string; b: string } | null): void;
  /** POINT: transiently override the camera to swivel and FACE a world point
   *  (over-the-shoulder, at max yaw speed), overriding any conversation target
   *  for `holdMs` (default 2200), then revert. Used when an NPC gives the player
   *  directions ("it's far, to the north" — the camera turns that way). */
  pointAt(target: Vec2, holdMs?: number): void;
  /** This frame's settled gaze — the EFFECTIVE fixation point (`committedWorld`:
   *  the looked-at entity's position when the gaze rests on one on screen, else
   *  the fixated ground point; null mid-saccade), what it rests on (`hover`, from
   *  the screen-space pick), how settled it is (`unsettled`: 0 settled … 1
   *  flicking), and the current CARRY dwell progress (`dwellProgress`: 0 idle …
   *  1 about to fire). The game layer hit-tests committedWorld to detect dwell on
   *  a figure / empty ground and reads dwellProgress for the dwell indicator.
   *  `picks` says whether this view resolves a screen pick AT ALL (the 2D view
   *  omits pickScreen): with it, a null `hover` MEANS "the gaze is on nothing",
   *  and a game layer can trust the hover as the aim instead of guessing from
   *  fixation proximity. Without it, `hover` is always null and proximity is
   *  the only pick available. */
  getGaze(): {
    committedWorld: Vec2 | null;
    hover: { kind: "avatar" | "object"; id: string } | null;
    picks: boolean;
    unsettled: number;
    dwellProgress: number;
  };
  /** ONE-SHOT screen pick at a canvas-relative CSS pixel — the entity under the
   *  point, resolved IMMEDIATELY (no dwell/settle), so a debug tool can click to
   *  inspect even while PAUSED (the settled-gaze `hover` can't advance at dt=0).
   *  A bubble resolves to its speaker avatar; null = empty ground. */
  pickAt(px: number, py: number): { kind: "avatar" | "object"; id: string } | null;
  /** Logical size (CSS px) + DPR changed. */
  resize(width: number, height: number, dpr: number): void;
  /** The local user spoke: show a speech bubble over the local avatar and broadcast
   *  it once so peers render it too. `glyph` is the optional composed AAC glyph. */
  say(text: string, glyph?: string): void;
  /** Spawn a hosted NPC at runtime — the STREAMING seam: a large world can keep
   *  its concurrent cast under WORLD_MAX_NPCS by spawning inhabitants as the
   *  player approaches their region and despawning them on leave (the spec then
   *  carries only ever-present NPCs). Only meaningful on the NPC-hosting peer;
   *  enforces the same concurrent cap as the spec. False = rejected (not
   *  hosting / duplicate id / cap). */
  addNpc(npc: NpcSpec): boolean;
  /** Despawn a runtime-hosted NPC (body, controller, proximity). False = unknown. */
  removeNpc(npcId: string): boolean;
  /** Runtime locomotion override for a hosted NPC body — e.g. party-follow
   *  (quest-host.ts joinParty) walking a recruited creature at the player's
   *  run speed instead of its spawn pace. `mps` sets steerMaxSpeed; `null`
   *  restores the spawn snapshot exactly (the config as it stood before the
   *  first override — see npcConfig/npcConfigs above). Non-party NPC
   *  errand/need speeds are never touched by this. False = unknown npcId. */
  setNpcMaxSpeed(npcId: string, mps: number | null): boolean;
  /** THE body's collision radius — what locomotion actually enforces for this
   *  NPC (its species-sized per-NPC config, else the engine default). Route
   *  planners MUST probe at exactly this girth: fatter reads a legal lane as
   *  a wall, thinner plans through furniture. */
  npcRadiusOf(npcId: string): number;
  /** THE body's SPAWN walk pace (its species/behavior steerMaxSpeed, or the
   *  engine default) — reads through any active setNpcMaxSpeed override to
   *  the snapshot underneath, so callers (party-follow) can multiply off the
   *  true spawn speed regardless of when they ask. 0 for an unknown npcId. */
  npcMaxSpeedOf(npcId: string): number;
  /** Replace the streamed structure set (walls/doors around the player — see
   *  engine.setWorldStructures). Collision, door swing, and rendering follow
   *  immediately; door states persist across swaps for surviving ids. */
  setStructures(structures: StructureSpec[]): void;
  /** Replace the streamed BUILDINGS (engine.setWorldBuildings): registers
   *  the volumes - roofs, floor slabs, see-inside fade, indoor-avatar
   *  cull - AND lowers them into their structures in one move. Streaming
   *  hosts use this instead of setStructures; flattened walls alone are
   *  a roofless, cull-less house. */
  setBuildings(buildings: BuildingSpec[]): void;
  /** Replace the DRAG ZONES (construction v1): rects of heavy going —
   *  storage-room clutter slows bodies without ever blocking them. The
   *  zones compile into the engine's DragSampler (stride scale; slope
   *  composes on top). Empty array clears — free ground everywhere. */
  setDragZones(zones: Array<{ x: number; y: number; w: number; h: number; scale: number }>): void;
  /** Replace the RESERVED GROUND (city-founding construction sites): flat
   *  lot rects bodies cross freely but dropped items never land on
   *  (engine dropObject nudges out). Empty array clears. */
  setReservedGround(rects: Array<{ x: number; y: number; w: number; h: number }>): void;
  /** Add a STREAMED world object (furniture arriving with its house —
   *  engine.addWorldObject). False if the id already exists. */
  addObject(spec: ObjectSpec): boolean;
  /** Remove a streamed object; whatever it contained is set free where
   *  it stands. False for an unknown id. */
  removeObject(objectId: string): boolean;
  /** Bias a hosted NPC's body from its live conversation (mind → body). No-op for
   *  an unknown id or a peer that doesn't host that NPC. */
  setNpcEngagement(npcId: string, engagement: NpcEngagement | null): void;
  /** Send a hosted NPC on a scripted waypoint errand (vendor fetch-and-deliver);
   *  null cancels. No-op for an unknown id or a peer that doesn't host it. */
  setNpcErrand(npcId: string, errand: NpcErrand | null): void;
  /** Confine a hosted NPC's idle WANDER to a clear rect (an IDLE PAD — see
   *  NpcController.setWanderRect): pacing stays inside furniture-free ground,
   *  and a body outside the pad stands instead of blind-roaming (the host
   *  paths it there). Null clears. No-op for an unknown id. */
  setNpcWanderRect(npcId: string, rect: { x: number; y: number; w: number; h: number } | null): void;
  /** Is that NPC's scripted errand still running (the plan is not finished)? True
   *  through a waypoint's DWELL as well — the errand still owns the body, which is
   *  what a "is this body busy?" caller wants. False for unknown/errand-less NPCs. */
  npcErrandActive(npcId: string): boolean;
  /** That NPC's live errand plan, or null when none runs — the body's own truth
   *  about where it is headed and whether it is walking at all (`dwelling` = it
   *  is standing out a waypoint, so it is NOT going anywhere). The pure schedule
   *  can say "home" while a body is still finishing its walk, and can say
   *  "traveling" while it naps at the bed; this settles both. */
  npcErrandPath(npcId: string): NpcErrandPath | null;
  /** DEBUG PATHS: start/stop capturing each hosted NPC's steering decision each
   *  frame (see npcPaths). Off by default — the capture allocates per NPC per
   *  frame and a town hosts hundreds, so this is opt-in. */
  setPathDebug(on: boolean): void;
  /** DEBUG PATHS: this frame's steering snapshot per hosted NPC — the errand
   *  plan, the aimed-at waypoint, and the detour-bent aim actually steered to.
   *  Empty unless setPathDebug(true). Live objects; read, don't keep. */
  npcPaths(): NpcPathSnapshot[];
  /** Live-update the gaze interpreter + camera/comfort tunables (debug menu). */
  setTunables(t: WorldTunables): void;
  /** Building ids whose roof is currently NOT fully opaque (the see-inside fade is
   *  active). A streaming host keys interior population on this — keep a room's
   *  residents/furniture while its roof is open, abstract once it seals. Empty for
   *  a view that doesn't model roofs (the 2D top-down). */
  revealedBuildings(): Set<string>;
  /** Toggle SPIRIT/stationary mode live (see WorldHostDeps.stationary) — the
   *  POSSESSION seam: a spirit entering a creature's body becomes an ordinary
   *  walker (aim drives it, carry goes reach-gated); dismissing flips back. */
  setStationary(on: boolean): void;
  /** CLAIM a creature's body for this spark (`null` = release, back to the
   *  spark's own body). The claimed creature is NOT removed, moved or re-skinned
   *  — it already wears its own model, and its controller is merely suspended
   *  while claimed, so its drives resume the moment the spark leaves. Returns
   *  false if that body isn't in the world. */
  claimBody(bodyId: string | null): boolean;
  /** CHART REBASE (planet-mounted ground): the tangent chart this sim runs in
   *  was re-anchored under the walker (floating origin on the sphere) — the
   *  caller moved the render anchor so WORLD poses are unchanged, and this
   *  re-expresses every sim-frame coordinate in the NEW chart: avatar/NPC
   *  positions, velocities, facings (+ remote-interp targets), object
   *  positions/velocities, and each NPC controller's remembered points
   *  (home / wander waypoint / errand polyline). `mapPoint` maps a sim POINT
   *  old→new; `mapVec` maps a sim-frame VECTOR (linear part only — it must
   *  preserve magnitudes). Streamed structures/buildings/drag zones are NOT
   *  remapped — planet ground chunks don't carry them; a caller that does
   *  must re-stream them after the rebase. */
  rebase(mapPoint: (p: Vec2) => Vec2, mapVec: (v: Vec2) => Vec2): void;
  /** The body this spark currently drives (its own id when nothing is claimed). */
  drivenBody(): string;
  start(): void;
  /** EXTERNAL CLOCK (host-embed): advance + render exactly ONE frame, driven by
   *  another loop (the space-flight composer) instead of this host's own
   *  scheduleFrame. Lets the town run inside the flight scene under a single rAF —
   *  the coordinator calls this each frame instead of start(). `dt` is clamped and
   *  gated by setPaused() just like the internal loop. Don't mix with start(). */
  step(dt: number, now: number): void;
  /** Stop the loop and dispose the view. */
  stop(): void;
  /** The live world state (read-only use — e.g. diagnostics). */
  readonly state: WorldState;
}

/** DEBUG PATHS: one hosted NPC's steering decision for one frame — everything a
 *  path overlay needs to show WHY a body is going where it's going.
 *
 *  The three layers, outermost first:
 *    errand — the PLAN: door-routed waypoints + which leg is live.
 *    aim    — the point the controller chose this frame (the live waypoint, or a
 *             wander target when no errand runs).
 *    bent   — what locomotion actually steers at, after detourAim bends the aim
 *             around whatever is in the way. `detoured` when it differs.
 *
 *  A null aim means braking (dwelling, or the errand just finished). */
export interface NpcPathSnapshot {
  npcId: string;
  at: { x: number; y: number };
  floor: number;
  errand: NpcErrandPath | null;
  aim: { x: number; y: number } | null;
  bent: { x: number; y: number } | null;
  detoured: boolean;
}

/** Below this `unsettled` an INTERACT pick may engage — so a target is only chosen
 *  from a genuinely settled gaze, never mid-flick. */
const INTERACT_SETTLE_MAX = 0.4;

export function runWorldHost(deps: WorldHostDeps): WorldHost {
  const { view, spec, localId, net } = deps;
  // Mutable so setTunables() can swap interact knobs live (gaze + camera/comfort are
  // pushed into the interpreter + view; the interact config is read here in frame()).
  let tunables: WorldTunables = deps.tunables ?? DEFAULT_WORLD_TUNABLES;
  // SPIRIT/stationary mode, mutable live (setStationary) — possession flips a
  // formless spirit into an ordinary walker and back.
  let stationary = !!deps.stationary;

  // ── ⏩ THE WIDE TICK, resolved once (see `WideTickConfig`) ────────────────
  /** Seconds of MOTION per inner step. `Infinity` with no wide tick configured,
   *  so `dt > innerStepS` is false for every frame this host will ever see and
   *  the substep branch is dead code in a GL build (W-③). */
  const innerStepS = deps.wideTick
    ? Math.max(1e-3, deps.wideTick.innerStepS ?? WIDE_TICK_INNER_STEP_S)
    : Infinity;
  /** The host's own frame-length clamp — 0.05 s unless a wide tick lifts it.
   *  THIS is the ceiling a caller's wide `dt` used to die against. */
  const frameCapS = deps.wideTick
    ? Math.max(FRAME_DT_CAP_S, deps.wideTick.maxFrameS ?? WIDE_TICK_MAX_FRAME_S)
    : FRAME_DT_CAP_S;
  /** How many equal motion substeps this frame's dt needs. Always 1 without a
   *  wide tick, and 1 for any frame already inside the inner cap. */
  const wideSubsteps = (dt: number): number =>
    dt > innerStepS ? Math.ceil(dt / innerStepS) : 1;

  const state: WorldState = createWorldState(spec, localId, deps.spawnIndex, deps.spawnAt, deps.groundAt, deps.waterAt);

  // The gaze→aim interpreter (fixation gate + weakening + auto-sit). Sits between
  // the raw pointer and the engine's single `aim`, so the engine is untouched. Its
  // output also feeds the camera director (the view's render call) so the camera
  // commits to where the player is steering.
  const gaze = createGazeInterpreter(tunables.gaze);

  // NPCs we host: spawn each as a locally-owned avatar + build its steering
  // controller. Their ids ride the outbound avatar stream so peers render them as
  // ordinary remotes. Empty unless deps.hostNpcs (one peer per room).
  // REPLICA mode (deps.replicaNpcs — a multiplayer follower) spawns the same
  // bodies but builds NO controller: the body stands until the owning peer's
  // avatar packets move it (applyRemoteAvatar/smoothRemoteAvatars — a
  // controller-less body is not locally driven, so the network may).
  const npcHosting = !!deps.hostNpcs;
  const npcBodies = npcHosting || !!deps.replicaNpcs;
  const npcControllers: NpcController[] = [];
  const npcIds = new Set<string>();
  /** ROOTED bodies (isRootedNpc — zero declared pace: trees). A subset of
   *  `npcIds`: still avatars in every way that shows (drawn, hoverable,
   *  proximity, containers), but they never steer and they spend their OWN
   *  budget, so a forest can stand without crowding out the creature cast. */
  const rootedIds = new Set<string>();
  if (npcBodies && spec.npcs?.length) {
    for (const npc of spec.npcs) {
      addLocalAvatar(state, npc.id, npc.x, npc.y, npc.facing ?? 0);
      if (npcHosting) npcControllers.push(createNpcController(npc));
      npcIds.add(npc.id);
      if (isRootedNpc(npc)) rootedIds.add(npc.id);
    }
  }
  const npcRng = deps.npcRng ?? Math.random;
  // The spark's own body + every NPC body we host. A CLAIMED creature is
  // already an NPC here, so claiming needs no change to what we stream out.
  // REPLICA bodies are deliberately NOT ours to stream — the owner streams
  // them; a follower broadcasts its own spark alone.
  const ownedAvatarIds = npcHosting ? [localId, ...npcIds] : [localId];
  /** THE BODY THIS SPARK DRIVES — `localId` until a creature is claimed, then
   *  that creature's body (see WorldState.drivenId / setDrivenBody). Read it
   *  FRESH every use: a claim can re-point it on any frame. `localId` remains
   *  the spark's NETWORK identity and must not be substituted for this. */
  const driven = (): string => state.drivenId;
  const npcById = new Map(npcControllers.map((c) => [c.npcId, c]));

  // Proximity is computed from the SPEC's NPCs + their positions in `state.avatars`,
  // so it works on EVERY peer — not just the owner that hosts the bodies. A
  // non-owner receives NPC positions over the relay/mesh and can still tell which
  // NPC its player is standing next to. Emit only when the in-range SET changes.
  const npcRadii = new Map<string, number>();
  // Per-NPC locomotion override: a spec `speed` walks that body slower (or
  // faster) than the player's steerMaxSpeed default, and a spec `species`
  // sizes its collision/planning radius (speciesBodyRadius — a big creature
  // collides AND plans at its own girth).
  const npcConfigs = new Map<string, WorldEngineConfig>();
  // Runtime speed override (setNpcMaxSpeed, driven by party-follow): the
  // steerMaxSpeed npcConfigs held BEFORE the first override, so `null`
  // restores exactly rather than drifting toward whatever the last write
  // left behind. Absent = no override active for that npc.
  const npcSpeedOverrideBase = new Map<string, number>();
  const npcConfig = (n: NpcSpec): void => {
    const radius = speciesBodyRadius(n.species);
    if (n.behavior?.speed || radius !== WORLD_ENGINE_DEFAULTS.avatarRadius) {
      npcConfigs.set(n.id, {
        ...WORLD_ENGINE_DEFAULTS,
        avatarRadius: radius,
        ...(n.behavior?.speed ? { steerMaxSpeed: n.behavior.speed } : {}),
      });
    }
  };
  // WALL-GLIDE is a STEER-TIME grant, applied only at the host's own
  // steerAvatar call: a host-driven NPC pressed against a fixture walks
  // PARALLEL to the face instead of grinding down it (engine.ts wallGlide).
  // npcConfigs entries stay pure — every other consumer (npcRadiusOf, the
  // furniture anchor, and above all `drivenConfig`, the spark-CLAIMED body
  // whose aim is the user's own gaze) reads them glide-free, so the player's
  // aim stays authoritative even into a wall.
  //
  // ⚠️ AND IT IS VETOED ON A TIGHT ROUTED LEG, exactly like `detourAim` below.
  // The glide does not bend the aim, it REPLACES it: while a contact is live the
  // whole desired speed runs along the pressed face, and the contact outlives its
  // last collision frame (engine CONTACT_HOLD_S) so the body keeps walking a face
  // it has already cleared — metres of it at steerMaxSpeed. Outdoors that is the
  // point (slide past the unmodelled rock). On a routed indoor point it is the
  // corner-cutting the route was built to prevent: the body abandons a corridor
  // measured in centimetres and grinds around the very fixture it was routed
  // around. Observed: a body on a tight leg past a table left its planned line by
  // 0.5 m with the glide on and 0.11 m with it off. ONE law, one veto — a routed
  // indoor point is walked EXACTLY, and no steer-time shortcut may override it.
  const NPC_STEER_DEFAULTS: WorldEngineConfig = { ...WORLD_ENGINE_DEFAULTS, wallGlide: true };
  const glideConfigs = new WeakMap<WorldEngineConfig, WorldEngineConfig>();
  const steerConfigOf = (id: string, glide: boolean): WorldEngineConfig => {
    const base = npcConfigs.get(id);
    if (!glide) return base ?? WORLD_ENGINE_DEFAULTS;
    if (!base) return NPC_STEER_DEFAULTS;
    let g = glideConfigs.get(base);
    if (!g) {
      g = { ...base, wallGlide: true };
      glideConfigs.set(base, g);
    }
    return g;
  };
  for (const n of spec.npcs ?? []) {
    npcRadii.set(n.id, n.behavior?.conversationRadius ?? DEFAULT_CONVERSATION_RADIUS);
    npcConfig(n);
  }
  let lastProximityKey = "";
  const emitProximityIfChanged = (): void => {
    if (!deps.onNpcProximity || npcRadii.size === 0) return;
    const player = state.avatars[driven()];
    if (!player) return;
    const nearby: NpcProximity[] = [];
    for (const [npcId, radius] of npcRadii) {
      const npc = state.avatars[npcId];
      if (!npc) continue;
      const d = Math.hypot(npc.x - player.x, npc.y - player.y);
      if (d <= radius) nearby.push({ npcId, distance: d });
    }
    nearby.sort((a, b) => a.distance - b.distance);
    const key = nearby.map((n) => n.npcId).join(",");
    if (key !== lastProximityKey) {
      lastProximityKey = key;
      deps.onNpcProximity(nearby);
    }
  };

  /** Detour shoulder memory for every mover this host steers — the NPCs by id,
   *  and the local player under PLAYER_DETOUR_KEY. See createDetourMemory: the
   *  commitment expires on a timer rather than clearing on a straight frame,
   *  which is what stops a body dithering between shoulders (the table spin). */
  const detourSides = createDetourMemory();
  const PLAYER_DETOUR_KEY = "__player__"; // can't collide with an NPC id

  /** DEBUG PATHS (off by default — the capture allocates per NPC per frame, and
   *  a town hosts hundreds). Filled by advanceNpcs while on; read by npcPaths(). */
  let pathDebug = false;
  const pathSnaps = new Map<string, NpcPathSnapshot>();

  /** Step every hosted NPC body for this frame (controller → aim → locomotion). */
  /** TEMP: advanceNpcs sub-phase accumulators, reported by the frame-phase log. */
  const _npcPhase = { aim: 0, detour: 0, steer: 0, bodies: 0, aimProbes: 0 };
  const advanceNpcs = (dt: number): void => {
    _npcPhase.aim = _npcPhase.detour = _npcPhase.steer = _npcPhase.bodies = 0; // TEMP
    _npcPhase.aimProbes = 0; // TEMP
    const _pn = (): number => (typeof performance !== "undefined" ? performance.now() : 0);
    if (!npcControllers.length) return;
    // "Humans" = bodies an NPC should react to: anything not autonomous, PLUS a
    // CLAIMED creature — a body with a spark in it is a person to its
    // neighbours, even though its id is still an NPC's.
    const humans = Object.values(state.avatars).filter(
      (a) => !npcIds.has(a.id) || a.id === driven(),
    );
    // One live snapshot of ALL bodies for the crowding oracle (references —
    // positions stay live as bodies step). Hoisted so occupancy probing never
    // re-walks the avatar map per waypoint draw (aim-phase cost).
    const allBodies = Object.values(state.avatars);
    for (const ctrl of npcControllers) {
      // A CLAIMED body is steered by the spark's gaze in tickWorld this frame.
      // SUSPEND its controller — never delete it: the creature keeps its
      // personality, needs and job, and simply resumes them on release. (When
      // the spark becomes a decision-GUIDE rather than a driver, this is where
      // the controller starts consuming the gaze as a goal instead of yielding.)
      if (ctrl.npcId === driven()) continue;
      // ROOTED (a tree — isRootedNpc): zero pace, so aim → detour → steer
      // could only ever return it to the spot it is already standing on.
      // The whole pipeline is waste, and skipping it is exactly what makes
      // a forest of standing bodies affordable (what the separate rooted
      // budget is priced on). It keeps everything that SHOWS: drawn,
      // hoverable, in proximity, holding its container.
      if (rootedIds.has(ctrl.npcId)) continue;
      const self = state.avatars[ctrl.npcId];
      if (!self) continue;
      // THIS body's collision radius — planner probes must match locomotion
      // exactly (a fatter probe reads a body-wide furniture lane as a wall),
      // and per-NPC configs make it creature-specific (a big pet plans at
      // its own girth).
      const bodyR = (npcConfigs.get(ctrl.npcId) ?? WORLD_ENGINE_DEFAULTS).avatarRadius;
      // FURNITURE-USE ANCHOR (furniture-anchor.ts) — a body USING a fixture it
      // claimed (asleep on its bed, sat on its chair/toilet) is driven by the
      // anchor, not the errand steering: it eases ONTO the use point (bypassing
      // that one fixture's collision), pins there, and eases back off to a
      // validated dismount when done. When the anchor owns the frame, skip the
      // ordinary aim/detour/steer entirely — no tug-of-war between the two.
      if (
        tickFurnitureAnchor(state, ctrl.npcId, dt, npcConfigs.get(ctrl.npcId), {
          bodyR,
          radiusOf: (id) => (npcConfigs.get(id) ?? WORLD_ENGINE_DEFAULTS).avatarRadius,
        })
      ) {
        continue;
      }
      // Terrain (water / wall-steep slope) joins the oracle so wander waypoints
      // and detours refuse blocked ground — an NPC stalls at a lake edge instead
      // of spinning against the movement gate.
      const walk = (p: { x: number; y: number }, radius: number) =>
        structuresWalkable(state, p, radius, self.floor) &&
        // Solid FIXTURES too — locomotion collides with them, so a planner
        // blind to them aims THROUGH tables and the body slides along the
        // face instead of detouring around it.
        fixturesWalkable(state, p, radius, self.floor) &&
        terrainWalkable(state, p) &&
        (deps.constraint?.walkable(p, radius) ?? true);
      // THE CROWDING ORACLE — is `p` within combined radii of ANOTHER body?
      // Idle wander waypoints prefer un-occupied ground so milling townsfolk
      // spread out instead of stacking. Separation scales with body size
      // (this body + the other body's own radius), never a magic constant. On
      // the same floor only (a body upstairs isn't in the way).
      const occupied = (p: { x: number; y: number }, radius: number): boolean => {
        for (const o of allBodies) {
          if (o.id === ctrl.npcId) continue;
          if (o.floor !== self.floor) continue;
          const oR = (npcConfigs.get(o.id) ?? WORLD_ENGINE_DEFAULTS).avatarRadius;
          if (Math.hypot(o.x - p.x, o.y - p.y) < radius + oR) return true;
        }
        return false;
      };
      _npcPhase.bodies++; // TEMP
      const _tAim = _pn(); // TEMP
      const _pAim = __probeStats.struct; // TEMP
      const aim = ctrl.computeAim({
        self,
        humans,
        now: state.time,
        width: spec.manifold.width,
        height: spec.manifold.height,
        // Unbounded (planet-mounted) worlds: the extent is content, not
        // walls — the controller must not clamp waypoints to it, or an NPC
        // could never AIM past the town edge (the follow-into-the-wild bug).
        bounded: spec.manifold.bounded !== false,
        rng: npcRng,
        // The same ground truth locomotion collides against — lets the
        // controller refuse to aim at blocked ground (wander waypoints).
        walkable: walk,
        radius: bodyR,
        // The clock anchor's pace derives from the body's own walk speed.
        maxSpeed: (npcConfigs.get(ctrl.npcId) ?? WORLD_ENGINE_DEFAULTS).steerMaxSpeed,
        // Spread milling bodies out — don't roam onto a spot a neighbour holds.
        occupied,
      });
      // Walk AROUND what's in the way, not into it — the local detour bends the aim
      // past a building face instead of grinding along it (npc-controller detourAim).
      // NEVER on a routed pass-through leg (errandLegTight — door transits, indoor
      // dogleg corners): the plan already avoids the furniture, and a local bend
      // drags the body off its verified corridor into exactly the traps the route
      // was built to skirt.
      const _tDet = _pn(); _npcPhase.aim += _tDet - _tAim; // TEMP
      _npcPhase.aimProbes += __probeStats.struct - _pAim; // TEMP
      let bent = aim;
      // ONE reading of the veto per frame — it gates BOTH steer-time shortcuts
      // (the aim bend here, the wall glide at steerAvatar below).
      const legTight = ctrl.errandLegTight();
      if (aim && !legTight) {
        bent = detourAim(self, aim, walk, bodyR, detourSides.prefer(ctrl.npcId, state.time));
        // RENEW on every bent frame; NEVER clear on a straight one — the hold is
        // what carries one bypass through to the end (createDetourMemory).
        if (bent !== aim) detourSides.record(ctrl.npcId, sideOfBend(self, aim, bent), state.time);
      }
      // CLOCKED-WALKER DODGE (clock-path-dodging.md): a body riding a clock
      // anchor walks AROUND bodies in its line — an aim bend scaled by the
      // bubble's shrink rule (fading to pass-through at the edge), never a
      // position push. Off tight legs only, walkability-gated like every aim.
      const clock = ctrl.clockState();
      if (bent && clock && !legTight) {
        bent = clockDodgeAim(self, bent, allBodies, {
          selfId: ctrl.npcId,
          radiusOf: (id) => (npcConfigs.get(id) ?? WORLD_ENGINE_DEFAULTS).avatarRadius,
          scale: clock.scale,
          canStand: (p, r) => walk(p, r),
        });
      }
      const _tSteer = _pn(); _npcPhase.detour += _tSteer - _tDet; // TEMP
      // DEBUG: snapshot the whole decision — the errand PLAN, the waypoint the
      // controller picked (`aim`), and what the detour actually steers at
      // (`bent`). aim ≠ bent is a live bypass; a body whose bent aim thrashes
      // while the plan stands still is the pathfinding failure worth seeing.
      if (pathDebug) {
        pathSnaps.set(ctrl.npcId, {
          npcId: ctrl.npcId,
          at: { x: self.x, y: self.y },
          floor: self.floor,
          errand: ctrl.errandPath(),
          aim: aim ? { x: aim.x, y: aim.y } : null,
          bent: bent ? { x: bent.x, y: bent.y } : null,
          detoured: !!aim && !!bent && (aim.x !== bent.x || aim.y !== bent.y),
        });
      }
      // DECLARE THE DOOR THIS BODY IS WALKING THROUGH. Doors open because a body
      // is crossing them, not because one is nearby (engine tickDoors), so the
      // live waypoint's doorway tag has to reach the avatar every frame —
      // including the null, or a door would stay held open by a body that has
      // long since finished its transit.
      self.crossingDoorId = ctrl.crossingDoorId();
      steerAvatar(state, ctrl.npcId, bent, dt, steerConfigOf(ctrl.npcId, !legTight), deps.constraint);
      _npcPhase.steer += _pn() - _tSteer; // TEMP
    }
    // EMERGENT BODY SEPARATION (stand-points separateBodies) — locomotion collides
    // bodies with walls but NEVER with each other, and the crowding oracle only
    // biases where a body AIMS (wander waypoints, stand points). Neither unmerges
    // bodies that actually OVERLAP: two residents whose stand points / homecoming
    // spots land on the same patch arrive fused and stand there forever (observed:
    // an idle family pile), and two on parallel errands walk in lockstep reading as
    // one body. So each frame push any overlapping pair gently apart, gated on the
    // ground each body can actually stand on. The spark-driven body is an immovable
    // OBSTACLE its neighbours part around; rooted `flora:` (trees a resident stands
    // at to harvest) are excluded entirely — they neither shove nor are shoved.
    const drivenNow = driven();
    // CLOCKED walkers leave separation entirely (clock-path-dodging.md,
    // pinned decision 5): they are never shoved — idle neighbours part
    // around them (the immovable-obstacle treatment the spark body gets),
    // and clocked-vs-clocked pairs resolve through the dodge aim above.
    const clockedIds = new Set<string>();
    for (const c of npcControllers) if (c.clockState()) clockedIds.add(c.npcId);
    separateBodies(
      // A body held by the furniture anchor (asleep on its bed, sat on its
      // chair) is excluded ENTIRELY: it must not be pushed off the fixture, and
      // it blocks the room no more than the fixture it sits on already does — so
      // it neither shoves nor is shoved. ROOTED bodies are excluded the same
      // way — by FUNCTION (isRootedNpc: a thing that cannot walk cannot be
      // shoved aside) with the older `flora:` id rule kept as a floor.
      allBodies.filter(
        (b) => !b.id.startsWith("flora:") && !rootedIds.has(b.id) && !isFurnitureAnchored(b),
      ),
      dt,
      {
        radiusOf: (id) => (npcConfigs.get(id) ?? WORLD_ENGINE_DEFAULTS).avatarRadius,
        movable: (id) => id !== drivenNow && !clockedIds.has(id),
        canStand: (p, r) =>
          structuresWalkable(state, p, r, p.floor) &&
          fixturesWalkable(state, p, r, p.floor) &&
          terrainWalkable(state, p) &&
          (deps.constraint?.walkable(p, r) ?? true),
      },
    );
    // Bodies that stopped being hosted shouldn't linger as ghost lines.
    if (pathDebug && pathSnaps.size > npcControllers.length) {
      for (const id of pathSnaps.keys()) if (!npcIds.has(id)) pathSnaps.delete(id);
    }
  };

  let pointer: { x: number; y: number } | null = null;
  let running = false;
  let paused = false;
  let cancel: (() => void) | null = null;
  let last = 0;
  let lastSend = 0;
  let lastPresence = 0;
  let pendingEvents: ReturnType<typeof tickWorld>["events"] = [];

  // Carry interaction (dwell to pick up / put down). One LENIENT dwell tracker
  // serves both: its must-exit latch is what stops a stare from picking-up and
  // putting-down the same object every frame.
  const carryReach = deps.carry?.reach ?? 1.6;
  const carryDwellMs = deps.carry?.dwellMs ?? 650;
  const carryDwell = createDwellTracker({ dwellMs: carryDwellMs, tolerance: 1.6, graceMs: 450 });
  let carryDwellProgress = 0;
  // Carry guards (kill the pick↔drop cycling + accidental drops): a just-DROPPED
  // item can't be re-picked until the gaze LEAVES it; a just-PICKED item can't be
  // dropped within CARRY_LOOKAWAY_DIST of the pick spot until the gaze moves that
  // far away (or off, a saccade). Combined with the no-drop-while-talking guard.
  const CARRY_LOOKAWAY_DIST = 2.0;
  let noRepickId: string | null = null;
  let recentPickSpot: Vec2 | null = null;

  // PLAYER DOOR-NAV: when a walk target is in another room, steer through the
  // connecting doorways (the same routeThroughDoors NPC errands use) instead of
  // grinding on a wall. Waypoints are followed + consumed; the route is recomputed
  // only when the goal moves (stable while you fixate).
  let navGoal: Vec2 | null = null;
  let navWaypoints: TransitPoint[] = [];
  /** The doorway the player's LIVE nav waypoint straddles, or null. The player
   *  opens doors the same way everyone else does — by walking the leg through one
   *  — and its nav waypoints ARE the transit points, so the live one's tag is the
   *  declaration. Read (and cleared) at the steering site below. */
  let navCrossingDoorId: string | null = null;
  const NAV_ARRIVE = 1.0;
  const navThroughDoors = (from: Vec2, dest: Vec2): Vec2 => {
    navCrossingDoorId = null;
    if (!state.spec.buildings?.length) return dest;
    if (!navGoal || Math.hypot(navGoal.x - dest.x, navGoal.y - dest.y) > 1.5) {
      const route = routeThroughDoors(state, from, dest);
      navWaypoints = route.length > 1 ? route.slice(0, -1) : []; // transit points only
      navGoal = { x: dest.x, y: dest.y };
    }
    while (navWaypoints.length && Math.hypot(from.x - navWaypoints[0]!.x, from.y - navWaypoints[0]!.y) < NAV_ARRIVE) {
      navWaypoints.shift();
    }
    const next = navWaypoints[0];
    navCrossingDoorId = next?.doorId ?? null;
    return next ?? dest;
  };
  // The gaze resting ON a door means "go through it": push the walk target to the
  // door's FAR side (away from the player), which routeThroughDoors then routes to.
  const DOOR_LINGER_R = 1.4;
  const doorThrough = (from: Vec2, p: Vec2): Vec2 => {
    let best: StructureSpec | null = null;
    let bestD = DOOR_LINGER_R;
    for (const s of state.spec.structures ?? []) {
      if (s.kind !== "door") continue;
      const d = Math.hypot((s.a.x + s.b.x) / 2 - p.x, (s.a.y + s.b.y) / 2 - p.y);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    if (!best || best.kind !== "door") return p;
    const mx = (best.a.x + best.b.x) / 2;
    const my = (best.a.y + best.b.y) / 2;
    let nx = -(best.b.y - best.a.y);
    let ny = best.b.x - best.a.x;
    const l = Math.hypot(nx, ny) || 1;
    nx /= l;
    ny /= l;
    const side = nx * (from.x - mx) + ny * (from.y - my) >= 0 ? -1 : 1; // away from the player
    return { x: mx + nx * 1.6 * side, y: my + ny * 1.6 * side };
  };
  // Conversation: when set, the avatar follows this point (to talking distance,
  // facing it) and the camera faces it. Updated to the partner's live position.
  let conversationTarget: Vec2 | null = null;
  // WHO IS TALKING (dollhouse conversation dolly): the conversation the game
  // layer says is running — its latch id plus the body ids in it — republished
  // verbatim on the render intent. Ids survive a REBASE untouched — unlike
  // `conversationTarget` above, which is a point and has to be re-mapped — which
  // is half the reason the seam is identities rather than positions (see the
  // `rebase` implementation: nothing to do here, deliberately).
  let conversationFocus: { id: string; members: string[]; speaker?: string } | null = null;
  // ONE writer for both the n-ary setter and the deprecated pair wrapper, as a
  // free function rather than a method-calls-method delegation: the host is a
  // plain object literal, so a `this.setConversationFocus(…)` hop would break
  // for any caller that pulled the method off the host first.
  const applyConversationFocus = (
    conv: { id: string; members: string[]; speaker?: string } | null,
  ): void => {
    // Copy the roster: the game layer keeps mutating its own member array (a
    // conversation record does exactly that as people join and leave) and the
    // intent is read a frame later.
    conversationFocus = conv
      ? {
          id: conv.id,
          members: [...conv.members],
          ...(conv.speaker ? { speaker: conv.speaker } : {}),
        }
      : null;
  };
  // POINT override (NPC directions): while the hold counts down, the camera
  // faces this point instead of the conversation target, over-the-shoulder, at
  // max yaw. Counted down by dt each frame (no wall-clock dependency).
  let pointTarget: Vec2 | null = null;
  let pointHold = 0;
  // This frame's settled gaze, exposed to the game layer via getGaze().
  let lastCommitted: Vec2 | null = null;
  let lastHover: { kind: "avatar" | "object"; id: string } | null = null;
  let lastUnsettled = 1;
  let lastDwellProgress = 0;
  /** The object this peer is currently carrying, or undefined. */
  const carriedId = (): string | undefined =>
    Object.values(state.objects).find((o) => o.carriedBy === driven())?.id;

  const frame = (dt: number, now: number): void => {
    // TEMP frame-phase probe (view-distance-lod-tiers.md): split a slow frame
    // into engine tick / npc advance / quest sim (needs+pursuit+stream) / render
    // so a "minutes per frame" stall names its phase. Logs only over-threshold
    // frames. Remove with the descent/bake probes. `__framePhase` in the console.
    const _pnow = (): number => (typeof performance !== "undefined" ? performance.now() : 0);
    const _pf = { tick: 0, npc: 0, sim: 0, render: 0 };
    // Interpret the raw pointer into an aim EACH frame against the (moving) camera:
    // the fixation gate drops flicks, weakening eases off during saccades, and the
    // idle timer latches WATCH/sitting. The mapped aim tracks the screen point even
    // as the follow camera scrolls. The full intent also drives the camera below.
    const me = state.avatars[driven()];
    const intent = gaze.update({
      pointer,
      screenToWorld: (px, py) => view.screenToWorld(px, py),
      avatar: me ? { x: me.x, y: me.y } : null,
      dt,
      nowMs: now,
    });
    // SCREEN SNAP: the ACTUAL gaze (raw pixel) resting on a rendered entity —
    // a speech bubble, an avatar's body/sprite, an object's mesh — decouples the
    // EFFECTIVE gaze from the ground point under the pixel: it becomes that
    // entity's position. A bubble resolves to its SPEAKER (so looking at what's
    // being said means looking at who says it, and the camera drops to the
    // shoulder view framing both). Gated on a settled gaze like INTERACT, so a
    // saccade sweeping across entities never snaps.
    let snap: { kind: "avatar" | "object"; id: string; x: number; y: number } | null = null;
    let snapFromBubble = false;
    /** The gaze is resting on the LOCAL player itself. You can't engage yourself
     *  (that's the WATCH/sit path), but the spark cursor should still mark you. */
    let hoverSelf = false;
    if (pointer && view.pickScreen && me && intent.unsettled < INTERACT_SETTLE_MAX) {
      const hit = view.pickScreen(pointer.x, pointer.y, { includeLocal: true });
      if (hit) {
        if (hit.kind === "bubble") {
          const anchor = state.bubbles[hit.id]?.anchor;
          if (anchor?.kind === "avatar" && anchor.id !== driven() && state.avatars[anchor.id]) {
            const av = state.avatars[anchor.id]!;
            snap = { kind: "avatar", id: anchor.id, x: av.x, y: av.y };
            snapFromBubble = true;
          } else if (anchor && anchor.kind === "point") {
            // A point-anchored caption (over an object/spot): gaze goes there.
            const under = pickEntity({ x: anchor.x, y: anchor.y }, state, driven(), tunables.interact);
            snap = under
              ? { kind: under.kind, id: under.id, x: under.x, y: under.y }
              : null;
            snapFromBubble = !!snap;
          }
        } else if (hit.kind === "avatar" && hit.id === driven()) {
          hoverSelf = true;
        } else if (hit.kind === "object" && hit.id === carriedId()) {
          // The item you're carrying is NOT a target — ignore it, so it never
          // becomes the fixation (which fed a place-loop / facing jitter).
        } else {
          const pos = hit.kind === "avatar" ? state.avatars[hit.id] : state.objects[hit.id];
          if (pos) snap = { kind: hit.kind, id: hit.id, x: pos.x, y: pos.y };
        }
      }
    }
    /** The settled gaze the world logic works from — snapped to the looked-at
     *  entity when there is one, else the fixated ground point. */
    const effFix: Vec2 | null = snap ? { x: snap.x, y: snap.y } : intent.committedWorld;

    // INTERACT (P3): a SETTLED gaze resting on an entity re-targets the aim to
    // engage it (toy → walk in; person → approach to talking distance + face). The
    // engine is unchanged — it just receives the engaging aim instead of the raw
    // ground point. interactId is forwarded so the renderer can highlight the target.
    // A screen snap IS the pick (exact in every rig pose); the ground-point
    // proximity pick stays as the fallback for the overhead view.
    let aim: Vec2 | null = intent.aim;
    let interactId: string | undefined;
    if (me && !intent.sitting && effFix && intent.unsettled < INTERACT_SETTLE_MAX && !stationary) {
      const hit = snap ?? pickEntity(effFix, state, driven(), tunables.interact);
      if (hit) {
        aim = approachAim({ x: me.x, y: me.y }, { x: hit.x, y: hit.y }, hit.kind, tunables.interact);
        interactId = hit.id;
      }
    }

    // CARRY: dwell on a nearby carryable to pick it up; while carrying, you steer
    // it WITH you (stopping ~CARRY_HOLD short of the drop point so the held object
    // leads onto the spot), then a lenient dwell on the spot sets it down. The
    // shared dwell tracker's must-exit latch prevents an instant pick→drop loop.
    carryDwellProgress = 0;
    if (deps.carry && me) {
      const carrying = carriedId();
      const fix = effFix; // the effective fixation point (null mid-saccade)
      // What the gaze rests on (pickEntity excludes the carried item). A CREATURE
      // under the gaze is a TALK target, never a drop spot; a free carryable is a
      // pick / swap target.
      const groundPick = fix ? pickEntity(fix, state, driven(), tunables.interact) : null;
      const overCreature = snap?.kind === "avatar" || groundPick?.kind === "avatar";
      const hoveredObj =
        groundPick?.kind === "object" &&
        objectAllows(state.spec, groundPick.id, "carry") &&
        deps.carry.pickable?.(groundPick.id) !== false // pre-gate: no affordance at all
          ? state.objects[groundPick.id]
          : undefined;
      const inReach = (o: { x: number; y: number }) =>
        stationary || Math.hypot(o.x - me.x, o.y - me.y) <= carryReach;
      const tryPick = (id: string) => {
        // Ownership veto: a completed pick-dwell on someone else's item is DENIED
        // (the attempt still "happened" — the game layer shows why).
        if (deps.carry?.canPick?.(id) === false) {
          deps.carry.onPickDenied?.(id);
          return false;
        }
        carryObject(state, id, driven());
        return true;
      };
      // LOOK-AWAY clears the cooldowns: the re-pick lock lifts once the gaze is no
      // longer on that item; the nearby-drop lock lifts once the gaze leaves the
      // pick spot (moved CARRY_LOOKAWAY_DIST away, or a saccade with no fixation).
      if (noRepickId && groundPick?.id !== noRepickId) noRepickId = null;
      if (
        recentPickSpot &&
        (!fix || Math.hypot(fix.x - recentPickSpot.x, fix.y - recentPickSpot.y) > CARRY_LOOKAWAY_DIST)
      ) {
        recentPickSpot = null;
      }

      if (carrying) {
        interactId = carrying;
        // SWAP: dwelling on a DIFFERENT free carryable sets the held item down
        // there and takes the new one. (Not the just-dropped item on cooldown.)
        const swapObj =
          hoveredObj && hoveredObj.id !== noRepickId && inReach(hoveredObj) ? hoveredObj : undefined;
        const talking = !!conversationTarget;
        const nearPick =
          !!recentPickSpot &&
          !!fix &&
          Math.hypot(fix.x - recentPickSpot.x, fix.y - recentPickSpot.y) < CARRY_LOOKAWAY_DIST;
        let placeSpot: Vec2 | null = null;
        if (fix && !swapObj) {
          const dx = fix.x - me.x;
          const dy = fix.y - me.y;
          const d = Math.hypot(dx, dy) || 1;
          // Walking: stop ~CARRY_HOLD short so the held item leads onto the spot.
          aim = stationary ? null : d > CARRY_HOLD ? { x: me.x + (dx / d) * (d - CARRY_HOLD), y: me.y + (dy / d) * (d - CARRY_HOLD) } : null;
          // Never place while TALKING, over a CREATURE, or too NEARBY the pick spot
          // (until the gaze has looked away). Placement is arm's reach (walking).
          const reachOk = stationary || d <= carryReach + CARRY_HOLD + 0.4;
          if (!talking && !overCreature && !nearPick && reachOk) placeSpot = { x: fix.x, y: fix.y };
        } else if (swapObj && !stationary) {
          const dx = swapObj.x - me.x;
          const dy = swapObj.y - me.y;
          const d = Math.hypot(dx, dy) || 1;
          aim = d > CARRY_HOLD ? { x: me.x + (dx / d) * (d - CARRY_HOLD), y: me.y + (dy / d) * (d - CARRY_HOLD) } : null;
        }
        const dwellTarget = swapObj ? { x: swapObj.x, y: swapObj.y } : placeSpot;
        const res = carryDwell.step(dwellTarget, dt * 1000);
        carryDwellProgress = res.progress;
        if (res.fired) {
          if (swapObj) {
            placeCarriedObject(state, carrying, { x: swapObj.x, y: swapObj.y });
            noRepickId = carrying; // don't instantly re-grab what we just set down
            if (tryPick(swapObj.id)) recentPickSpot = { x: swapObj.x, y: swapObj.y };
          } else if (placeSpot) {
            const a = carryDwell.anchor();
            if (a) {
              placeCarriedObject(state, carrying, a);
              noRepickId = carrying;
              recentPickSpot = null;
            }
          }
        }
      } else {
        // PICK: dwell on a free carryable in reach — never the just-dropped one
        // until the gaze has left it (noRepickId).
        const pickObj = hoveredObj && hoveredObj.id !== noRepickId && inReach(hoveredObj) ? hoveredObj : undefined;
        if (pickObj) interactId = pickObj.id;
        const res = carryDwell.step(pickObj ? { x: pickObj.x, y: pickObj.y } : null, dt * 1000);
        carryDwellProgress = res.progress;
        if (res.fired && pickObj && tryPick(pickObj.id)) {
          recentPickSpot = { x: pickObj.x, y: pickObj.y };
          noRepickId = null;
        }
      }
    }

    // Expose the settled EFFECTIVE gaze + what it rests on + carry-dwell progress
    // for the game layer (onFrame).
    lastCommitted = effFix;
    lastHover = snap ? { kind: snap.kind, id: snap.id } : null;
    lastUnsettled = intent.unsettled;
    lastDwellProgress = carryDwellProgress;
    // CONVERSATION: FOLLOW the partner while talking. The walk aim becomes the
    // partner (LIVE position, fed each frame by the game layer) rather than the
    // gaze — approachAim walks to talking distance and faces them, so if the NPC
    // moves off (an errand) the player follows instead of standing frozen; once
    // at talking distance it holds + faces (no drift). Routed through doors below
    // like any walk aim. Mirrors the carry steering-suspension, but steered toward
    // the speaker instead of nulled.
    if (conversationTarget && me && !stationary) {
      aim = approachAim({ x: me.x, y: me.y }, conversationTarget, "avatar", tunables.interact);
    }
    // PLAYER DOOR-NAV: route the walk aim through doorways when the target is in
    // another room (walk out of a building, into the next room), instead of the
    // straight aim grinding on a wall. Skipped while stationary.
    if (!stationary && aim && me) {
      const from = { x: me.x, y: me.y };
      aim = navThroughDoors(from, doorThrough(from, aim));
      // …and AROUND building exteriors on the way — the same local detour the
      // NPCs steer with (a door-bound aim passes through the walkable gap, so
      // door approaches are never deflected). Probe at the body's REAL radius
      // and keep the last-committed shoulder, exactly like the NPC path.
      const preBend = aim;
      aim = detourAim(
        from,
        preBend,
        (p, radius) =>
          structuresWalkable(state, p, radius, me.floor) &&
          terrainWalkable(state, p) &&
          (deps.constraint?.walkable(p, radius) ?? true),
        WORLD_ENGINE_DEFAULTS.avatarRadius,
        detourSides.prefer(PLAYER_DETOUR_KEY, state.time),
      );
      // Same rule as the NPCs: renew while bent, expire when genuinely free.
      if (aim !== preBend) {
        detourSides.record(PLAYER_DETOUR_KEY, sideOfBend(from, preBend, aim), state.time);
      }
      me.crossingDoorId = navCrossingDoorId;
    } else if (me) {
      // Not walking anywhere (standing, carrying, spirit) — so not crossing
      // anything. Doors this body was holding open let go, exactly as they would
      // for an NPC whose errand ended.
      me.crossingDoorId = null;
    }
    if (stationary) aim = null; // SPIRIT: the avatar never moves
    // POINT override expiry: a directions swivel holds briefly, then reverts to
    // the conversation target.
    if (pointTarget) {
      pointHold -= dt;
      if (pointHold <= 0) pointTarget = null;
    }
    const faceTarget = pointTarget ?? conversationTarget;
    // Gaze resting on a speech bubble — or on the speaker while conversing —
    // asks the camera for the over-the-shoulder framing (player + speaker both
    // visible; the overhead pose puts the camera between them). A point override
    // forces the shoulder view too (an over-the-shoulder "look where I point").
    const wantShoulder =
      !!pointTarget || snapFromBubble || (!!conversationTarget && snap?.kind === "avatar");

    // The DRIVEN body moves at ITS OWN girth: when a spark claims a creature,
    // `state.drivenId` is that NPC's id, so tickWorld must steer, wall-collide
    // and manifold-clamp it at the claimed body's radius — not the spark's
    // default. Unclaimed, drivenId === localId (never in npcConfigs) → undefined
    // → WORLD_ENGINE_DEFAULTS, exactly as before.
    const drivenConfig = npcConfigs.get(driven());
    // SPIRIT: a carried object rides the GAZE. A formless stationary avatar can't
    // walk it into place, and the engine parks a carried item a fixed step in
    // FRONT of the carrier — so in spirit mode it would just sit by the invisible
    // avatar, and pick-up/put-down would read as nothing. Snap the held object to
    // the fixation each frame so it lifts to the spark on pick-up and glides with
    // it until the place-dwell drops it (placeCarriedObject already uses the same
    // point). Skip mid-saccade (effFix null) so it doesn't jump to the origin.
    const snapSpiritCarried = (): void => {
      if (!stationary || !effFix) return;
      const heldId = carriedId();
      const held = heldId ? state.objects[heldId] : undefined;
      if (held) {
        held.x = effFix.x;
        held.y = effFix.y;
      }
    };
    // ⏩ THE MOTION ARMS (W-①). `tickWorld` integrates the local body + toys;
    // `advanceNpcs` integrates the hosted cast — and NOTHING else in this frame
    // is motion. Handed a dt wider than the inner cap (only possible with the
    // opt-in `wideTick` config), they run in ceil(dt/innerStepS) equal substeps
    // off the SAME player aim, so the bodies cover every second the decision
    // pass below is about to be told elapsed. `substeps` is 1 in every other
    // build of this host, and the one-substep branch below is byte-for-byte the
    // order this frame has always run in (W-③).
    const substeps = wideSubsteps(dt);
    const events: WorldEvent[] = [];
    /** One motion substep of `step` seconds: local tick, then the hosted cast
     *  (after it, so controllers see this substep's player position). */
    const stepMotion = (step: number): void => {
      const _tA = _pnow();
      const r = tickWorld(state, { aim }, step, drivenConfig, deps.constraint);
      _pf.tick += _pnow() - _tA;
      if (r.events.length) events.push(...r.events);
      const _tB = _pnow();
      advanceNpcs(step);
      _pf.npc += _pnow() - _tB;
    };
    if (substeps === 1) {
      // Today's frame, unchanged — including the carried-object snap's position
      // BETWEEN the two arms.
      const _tA = _pnow();
      const r = tickWorld(state, { aim }, dt, drivenConfig, deps.constraint);
      _pf.tick += _pnow() - _tA;
      if (r.events.length) events.push(...r.events);
      snapSpiritCarried();
      const _tB = _pnow();
      advanceNpcs(dt);
      _pf.npc += _pnow() - _tB;
    } else {
      const step = dt / substeps;
      for (let i = 0; i < substeps; i++) stepMotion(step);
      // ONCE per frame: the snap is idempotent and its point (`effFix`) is fixed
      // for the whole frame, so the end-of-frame state is what it always was.
      snapSpiritCarried();
    }
    emitProximityIfChanged();
    // Glide remote avatars between the ~8–15 Hz packets (dead-reckon + ease).
    smoothRemoteAvatars(state, dt);
    // Game layer hook (single-player quest logic): runs on the final frame state.
    const _tC = _pnow();
    deps.onFrame?.(state, dt);
    _pf.sim = _pnow() - _tC;

    if (net) {
      if (events.length) pendingEvents.push(...events);

      // Position → relay (Phase 1), lower rate, position-only.
      // DELIBERATELY the spark's OWN body, not `driven()`: presence is keyed by
      // participant id, and a claimed creature already streams to peers as an
      // ordinary NPC body over the mesh channel (it lives in ownedAvatarIds).
      // Publishing the claimed body here too would double-render it. Rendering a
      // remote spark as a light beside the body it claimed is future work — it
      // needs a rare spark→body claim message, never per-frame gaze.
      if (net.publishPresence && now - lastPresence >= PRESENCE_INTERVAL_MS) {
        const local = state.avatars[localId];
        if (local) {
          net.publishPresence({
            personId: localId,
            x: local.x, y: local.y,
            fx: local.fx, fy: local.fy,
            vx: local.vx, vy: local.vy,
            floor: local.floor,
          });
        }
        lastPresence = now;
      }

      // Avatar + toys/possession → mesh. Everyone streams their avatar so all
      // render regardless of A/V proximity (only audio/video is range-gated).
      if (now - lastSend >= SEND_INTERVAL_MS) {
        const msgs = collectOutbound(state, pendingEvents, ownedAvatarIds);
        // SPIRIT: broadcast where the player IS, not where their formless
        // avatar is parked (see netLocalPos). Velocity stays 0 — the receiver
        // eases onto each fresh point rather than dead-reckoning past it.
        const here = deps.netLocalPos?.();
        if (here) {
          for (const m of msgs) {
            if (m.t === "avatar" && m.id === localId) { m.x = here.x; m.y = here.y; }
          }
        }
        net.send(msgs);
        pendingEvents = [];
        lastSend = now;
      }
    }

    const _tD = _pnow();
    view.render(state, dt, {
      aim,
      sitting: intent.sitting,
      interactId,
      faceTarget,
      shoulder: wantShoulder,
      conversation: conversationFocus,
      // The spark cursor tracks the genuine gaze fixation (`effFix`) + what it
      // rests on (`snap`), NOT `interactId`/`aim` — so it never sticks to the
      // carried item or the conversation partner. Its bloom is the dwell-select
      // progress (carry pick/place + any game-layer dwell).
      cursor: {
        point: effFix ?? intent.aim,
        ...(snap
          ? { hoverId: snap.id, hoverKind: snap.kind }
          : hoverSelf
            ? { hoverId: driven(), hoverKind: "avatar" as const }
            : {}),
        selectProgress: Math.max(carryDwellProgress, deps.cursorProgress?.() ?? 0),
      },
    });
    _pf.render = _pnow() - _tD;
    const _total = _pf.tick + _pf.npc + _pf.sim + _pf.render;
    // PUBLISH EVERY FRAME while the probes are on (wide-tick-round.md W0): the
    // console line stays a SLOW-frame reporter, but a headless sampler needs the
    // split of an ORDINARY frame too — it reads `__framePhase` after each
    // stepFrame and accumulates. Probes off (the default) = untouched.
    if (probesOn()) (globalThis as unknown as Record<string, unknown>).__framePhase = _pf;
    if (_total > 150 && probesOn() && typeof console !== "undefined") {
      console.log(
        `[frame-phase] ${_total.toFixed(0)}ms — tick:${_pf.tick.toFixed(0)} npc:${_pf.npc.toFixed(0)}` +
          `(aim:${_npcPhase.aim.toFixed(0)}/${_npcPhase.aimProbes}p det:${_npcPhase.detour.toFixed(0)} steer:${_npcPhase.steer.toFixed(0)} n:${_npcPhase.bodies})` +
          ` sim:${_pf.sim.toFixed(0)} render:${_pf.render.toFixed(0)}` +
          ` probes:S${__probeStats.struct}/F${__probeStats.fix}` +
          ` picks:${__npcStats.picks}(fail:${__npcStats.pickFails})`,
      );
    }
    __probeStats.struct = 0; // TEMP: per-frame probe counts
    __probeStats.fix = 0;
    __npcStats.picks = 0; // TEMP
    __npcStats.pickFails = 0;
  };

  const loop = (now: number): void => {
    if (!running) return;
    // ⏩ `frameCapS` is 0.05 unless a wide tick was configured — the host
    // RE-DERIVES dt from the clock, so this clamp (not the engine's) is what a
    // caller's wide frameDt has always died against.
    const dt = Math.min(frameCapS, (now - last) / 1000);
    last = now;
    // Paused: still render (and update the pointer pick, so click-to-inspect works)
    // but advance the sim by ZERO — nothing moves, no clock/errand/chatter tick.
    frame(paused ? 0 : dt, now);
    cancel = deps.scheduleFrame(loop);
  };

  return {
    state,
    applyNetInbound(msgs) {
      for (const m of msgs) applyInbound(state, m);
    },
    applyPresence(p) {
      if (p.personId === localId) return; // never let the relay move our own avatar
      applyRemoteAvatar(state, { id: p.personId, x: p.x, y: p.y, fx: p.fx, fy: p.fy, vx: p.vx, vy: p.vy, floor: p.floor ?? 0 });
    },
    applyPresenceLeave(personId) {
      removeAvatar(state, personId);
    },
    setPointer(px, py) {
      pointer = { x: px, y: py };
    },
    clearPointer() {
      pointer = null;
    },
    setPaused(p) {
      paused = p;
    },
    setConversation(target) {
      conversationTarget = target;
    },
    setConversationFocus(conv) {
      applyConversationFocus(conv);
    },
    setConversationPair(pair) {
      // n = 2 through the one path. The synthesized key changes exactly when the
      // pair does, so the renderer's id latch reproduces the old
      // `{a,b}`-equality latch exactly — including that swapping a and b is a
      // DIFFERENT conversation, as it always was.
      applyConversationFocus(
        pair ? { id: `pair:${pair.a}|${pair.b}`, members: [pair.a, pair.b] } : null,
      );
    },
    pointAt(target, holdMs = 2200) {
      pointTarget = { x: target.x, y: target.y };
      pointHold = Math.max(0, holdMs) / 1000;
    },
    getGaze() {
      return {
        committedWorld: lastCommitted,
        hover: lastHover,
        picks: !!view.pickScreen,
        unsettled: lastUnsettled,
        dwellProgress: lastDwellProgress,
      };
    },
    pickAt(px, py) {
      if (!view.pickScreen) return null;
      const hit = view.pickScreen(px, py, { includeLocal: false });
      if (!hit) return null;
      if (hit.kind === "bubble") {
        const anchor = state.bubbles[hit.id]?.anchor;
        return anchor?.kind === "avatar" && state.avatars[anchor.id]
          ? { kind: "avatar", id: anchor.id }
          : null;
      }
      return { kind: hit.kind, id: hit.id };
    },
    resize(width, height, dpr) {
      view.resize(width, height, dpr);
    },
    revealedBuildings() {
      return view.revealedBuildings?.() ?? new Set<string>();
    },
    setStationary(on) {
      stationary = on;
    },
    claimBody(bodyId) {
      if (!setDrivenBody(state, bodyId)) return false;
      // The claimed body is driven from the gaze this frame on — re-emit
      // proximity, since who counts as a "human" to the other NPCs just moved.
      lastProximityKey = "\0";
      return true;
    },
    drivenBody() {
      return state.drivenId;
    },
    say(text, glyph) {
      const line = (text ?? "").trim();
      if (!line) return;
      // THE SPARK SPEAKS — deliberately `localId`, NOT `driven()`.
      //
      // The player and their avatar are SEPARATE UNITS. A claimed creature can
      // speak for itself (its own dialogue, from its own needs); the player only
      // TELLS it what to do. So words the player puts through the board/chat are
      // the PLAYER's words, never the ridden body's — the quest path agrees
      // (its speaker is the AUTHOR's own cid — `LOCAL_PLAYER_CID` for this
      // device, `player:<personId>` for a peer — and a ridden body is something
      // you talk TO, not as).
      //
      // Anchoring to the spark's own body is exact today because nothing claims
      // in the social world. Once claiming reaches it, the spark's body must
      // track the body it claimed, so this bubble reads as the light floating
      // beside the avatar rather than back at a parked, formless body.
      // setAvatarSpeech stamps it with state.time so it fades on the local clock.
      setAvatarSpeech(state, localId, { text: line, glyph });
      net?.send([sayMessage(localId, line, glyph)]);
    },
    addNpc(npc) {
      if (!npcBodies) return false; // neither hosting nor replicating
      if (npcIds.has(npc.id) || state.avatars[npc.id]) return false;
      // TWO LEDGERS, because the two cost wildly different things: a mover
      // spends a steering tick every frame, a rooted body spends none. A
      // forest must never eat the creature budget (a capped tree used to
      // fail SILENTLY, and the streamer had already hidden its scenery).
      const rooted = isRootedNpc(npc);
      const cap = rooted
        ? (deps.maxRootedNpcs ?? WORLD_MAX_ROOTED_NPCS)
        : (deps.maxNpcs ?? WORLD_MAX_NPCS);
      if ((rooted ? rootedIds.size : npcIds.size - rootedIds.size) >= cap) return false;
      addLocalAvatar(state, npc.id, npc.x, npc.y, npc.facing ?? 0);
      if (npcHosting) {
        // Ours to drive AND to stream (replicas get neither — the owner's
        // packets animate them; see deps.replicaNpcs).
        const ctrl = createNpcController(npc);
        npcControllers.push(ctrl);
        npcById.set(npc.id, ctrl);
        ownedAvatarIds.push(npc.id); // rides the outbound avatar stream like spec NPCs
      }
      npcIds.add(npc.id);
      if (rooted) rootedIds.add(npc.id);
      npcRadii.set(npc.id, npc.behavior?.conversationRadius ?? DEFAULT_CONVERSATION_RADIUS);
      npcConfig(npc);
      lastProximityKey = "\0"; // cast changed — re-emit proximity next frame
      return true;
    },
    npcRadiusOf(npcId) {
      return (npcConfigs.get(npcId) ?? WORLD_ENGINE_DEFAULTS).avatarRadius;
    },
    npcMaxSpeedOf(npcId) {
      if (!npcIds.has(npcId)) return 0;
      return (
        npcSpeedOverrideBase.get(npcId) ??
        (npcConfigs.get(npcId) ?? WORLD_ENGINE_DEFAULTS).steerMaxSpeed
      );
    },
    removeNpc(npcId) {
      if (!npcIds.has(npcId)) return false;
      npcIds.delete(npcId);
      rootedIds.delete(npcId); // frees a slot in whichever ledger it spent
      npcById.delete(npcId);
      const ci = npcControllers.findIndex((c) => c.npcId === npcId);
      if (ci >= 0) npcControllers.splice(ci, 1);
      const oi = ownedAvatarIds.indexOf(npcId);
      if (oi >= 0) ownedAvatarIds.splice(oi, 1);
      npcRadii.delete(npcId);
      npcConfigs.delete(npcId);
      npcSpeedOverrideBase.delete(npcId); // no dangling override for a reused id
      detourSides.forget(npcId);
      pathSnaps.delete(npcId);
      removeAvatar(state, npcId);
      lastProximityKey = "\0";
      return true;
    },
    setNpcMaxSpeed(npcId, mps) {
      if (!npcIds.has(npcId)) return false;
      if (mps === null) {
        const original = npcSpeedOverrideBase.get(npcId);
        if (original === undefined) return true; // no override active — no-op
        npcSpeedOverrideBase.delete(npcId);
        const cfg = npcConfigs.get(npcId);
        if (cfg) npcConfigs.set(npcId, { ...cfg, steerMaxSpeed: original });
        return true;
      }
      if (!npcSpeedOverrideBase.has(npcId)) {
        npcSpeedOverrideBase.set(
          npcId,
          (npcConfigs.get(npcId) ?? WORLD_ENGINE_DEFAULTS).steerMaxSpeed,
        );
      }
      const base = npcConfigs.get(npcId) ?? WORLD_ENGINE_DEFAULTS;
      npcConfigs.set(npcId, { ...base, steerMaxSpeed: mps });
      return true;
    },
    rebase(mapPoint, mapVec) {
      const remapPose = (a: {
        x: number; y: number; vx: number; vy: number; fx: number; fy: number;
        tx?: number; ty?: number; tvx?: number; tvy?: number; tfx?: number; tfy?: number;
      }): void => {
        const p = mapPoint({ x: a.x, y: a.y });
        a.x = p.x;
        a.y = p.y;
        const v = mapVec({ x: a.vx, y: a.vy });
        a.vx = v.x;
        a.vy = v.y;
        const f = mapVec({ x: a.fx, y: a.fy });
        const fl = Math.hypot(f.x, f.y);
        if (fl > 1e-9) {
          a.fx = f.x / fl;
          a.fy = f.y / fl;
        }
        // Remote-interpolation targets ride along (a peer's body mid-lerp must
        // not slide back toward its pre-rebase coordinates).
        if (a.tx !== undefined && a.ty !== undefined) {
          const t = mapPoint({ x: a.tx, y: a.ty });
          a.tx = t.x;
          a.ty = t.y;
        }
        if (a.tvx !== undefined && a.tvy !== undefined) {
          const tv = mapVec({ x: a.tvx, y: a.tvy });
          a.tvx = tv.x;
          a.tvy = tv.y;
        }
        if (a.tfx !== undefined && a.tfy !== undefined) {
          const tf = mapVec({ x: a.tfx, y: a.tfy });
          const tl = Math.hypot(tf.x, tf.y);
          if (tl > 1e-9) {
            a.tfx = tf.x / tl;
            a.tfy = tf.y / tl;
          }
        }
      };
      for (const a of Object.values(state.avatars)) remapPose(a);
      for (const o of Object.values(state.objects)) {
        const p = mapPoint({ x: o.x, y: o.y });
        o.x = p.x;
        o.y = p.y;
        const v = mapVec({ x: o.vx, y: o.vy });
        o.vx = v.x;
        o.vy = v.y;
      }
      for (const ctrl of npcControllers) ctrl.rebase(mapPoint);
      if (conversationTarget) conversationTarget = mapPoint(conversationTarget);
      if (pointTarget) pointTarget = mapPoint(pointTarget);
    },
    setStructures(structures) {
      setWorldStructures(state, structures);
    },
    setBuildings(buildings) {
      setWorldBuildings(state, buildings);
    },
    setDragZones(zones) {
      if (!zones.length) {
        delete state.drag;
        return;
      }
      const zs = zones.map((z) => ({ ...z }));
      state.drag = (x, y) => {
        let scale = 1;
        for (const z of zs) {
          if (x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h) {
            scale = Math.min(scale, z.scale);
          }
        }
        return scale;
      };
    },
    setReservedGround(rects) {
      if (!rects.length) {
        delete state.reservedGround;
        return;
      }
      state.reservedGround = rects.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h }));
    },
    addObject(spec) {
      return addWorldObject(state, spec);
    },
    removeObject(objectId) {
      return removeWorldObject(state, objectId);
    },
    setNpcEngagement(npcId, engagement) {
      npcById.get(npcId)?.setEngagement(engagement);
    },
    setNpcErrand(npcId, errand) {
      npcById.get(npcId)?.setErrand(errand);
    },
    setNpcWanderRect(npcId, rect) {
      npcById.get(npcId)?.setWanderRect(rect);
    },
    npcErrandActive(npcId) {
      return npcById.get(npcId)?.hasErrand() ?? false;
    },
    npcErrandPath(npcId) {
      return npcById.get(npcId)?.errandPath() ?? null;
    },
    setPathDebug(on) {
      pathDebug = on;
      if (!on) pathSnaps.clear(); // stale lines must not outlive the toggle
    },
    npcPaths() {
      return [...pathSnaps.values()];
    },
    setTunables(t) {
      tunables = t;
      gaze.setTunables(t.gaze);
      view.setTunables?.(t);
    },
    start() {
      if (running) return;
      running = true;
      last = deps.now();
      cancel = deps.scheduleFrame(loop);
    },
    step(dt, now) {
      // The external-clock twin of the loop's clamp — same ceiling, same lift.
      frame(paused ? 0 : Math.min(frameCapS, Math.max(0, dt)), now);
    },
    stop() {
      running = false;
      if (cancel) { cancel(); cancel = null; }
      view.dispose();
    },
  };
}
