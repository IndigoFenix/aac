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
  addLocalAvatar,
  applyRemoteAvatar,
  carryObject,
  CARRY_HOLD,
  createWorldState,
  objectAllows,
  placeCarriedObject,
  removeAvatar,
  setAvatarSpeech,
  addWorldObject,
  removeWorldObject,
  setWorldBuildings,
  setWorldStructures,
  smoothRemoteAvatars,
  steerAvatar,
  structuresWalkable,
  tickWorld,
  WORLD_ENGINE_DEFAULTS,
  type MoveConstraint,
  type WorldEngineConfig,
  type WorldState,
} from "./engine.js";
import { createDwellTracker } from "./dwell.js";
import { applyInbound, collectOutbound, sayMessage, type WorldNetMessage } from "./net.js";
import { WORLD_MAX_NPCS, type BuildingSpec, type NpcSpec, type ObjectSpec, type StructureSpec, type Vec2, type WorldSpec } from "./types.js";
import type { WorldView } from "./world-view.js";
import { createGazeInterpreter } from "./gaze-intent.js";
import { approachAim, pickEntity } from "./interact.js";
import { DEFAULT_WORLD_TUNABLES, type WorldTunables } from "./world-tunables.js";
import {
  createNpcController,
  DEFAULT_CONVERSATION_RADIUS,
  type NpcController,
  type NpcEngagement,
  type NpcErrand,
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

export interface WorldHostDeps {
  view: WorldView;
  spec: WorldSpec;
  localId: string;
  /** Stable spawn assignment (wraps spec.spawns); see SocialWorldCanvas. */
  spawnIndex: number;
  /** Resolved spawn point (centroid-of-peers + offset already applied), or omit. */
  spawnAt?: Vec2;
  net?: WorldHostNet;
  /** Host this spec's NPCs on THIS peer: spawn them, advance their bodies each
   *  frame, and broadcast them like owned avatars. Exactly one peer in a room
   *  should set this. The solo surface always does; Phase 2 elects one owner in a
   *  multiplayer call. Default false. */
  hostNpcs?: boolean;
  /** RNG for NPC wander (deterministic in tests). Defaults to Math.random. */
  npcRng?: () => number;
  /** Concurrent cap for runtime-streamed NPCs (addNpc). Defaults to
   *  WORLD_MAX_NPCS — the right bound when every NPC is a live social
   *  session and/or broadcast to peers. A single-player STREAMED world
   *  whose cast is pure bodies (wander/errand controllers, no AI mind —
   *  e.g. grand-dream's villagers) may raise it: a body costs one
   *  steering tick per frame. Spec-authored NPCs stay schema-capped
   *  regardless. */
  maxNpcs?: number;
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
  /** Enter/leave an NPC conversation: while a target is set the local avatar is
   *  FROZEN (steering suspended) and the camera slews to FACE the target world
   *  point. Pass null to leave. Driven by the game layer (e.g. dwell-to-talk). */
  setConversation(target: Vec2 | null): void;
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
   *  a figure / empty ground and reads dwellProgress for the dwell indicator. */
  getGaze(): {
    committedWorld: Vec2 | null;
    hover: { kind: "avatar" | "object"; id: string } | null;
    unsettled: number;
    dwellProgress: number;
  };
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
  /** Live-update the gaze interpreter + camera/comfort tunables (debug menu). */
  setTunables(t: WorldTunables): void;
  /** Building ids whose roof is currently NOT fully opaque (the see-inside fade is
   *  active). A streaming host keys interior population on this — keep a room's
   *  residents/furniture while its roof is open, abstract once it seals. Empty for
   *  a view that doesn't model roofs (the 2D top-down). */
  revealedBuildings(): Set<string>;
  start(): void;
  /** Stop the loop and dispose the view. */
  stop(): void;
  /** The live world state (read-only use — e.g. diagnostics). */
  readonly state: WorldState;
}

/** Below this `unsettled` an INTERACT pick may engage — so a target is only chosen
 *  from a genuinely settled gaze, never mid-flick. */
const INTERACT_SETTLE_MAX = 0.4;

export function runWorldHost(deps: WorldHostDeps): WorldHost {
  const { view, spec, localId, net } = deps;
  // Mutable so setTunables() can swap interact knobs live (gaze + camera/comfort are
  // pushed into the interpreter + view; the interact config is read here in frame()).
  let tunables: WorldTunables = deps.tunables ?? DEFAULT_WORLD_TUNABLES;

  const state: WorldState = createWorldState(spec, localId, deps.spawnIndex, deps.spawnAt);

  // The gaze→aim interpreter (fixation gate + weakening + auto-sit). Sits between
  // the raw pointer and the engine's single `aim`, so the engine is untouched. Its
  // output also feeds the camera director (the view's render call) so the camera
  // commits to where the player is steering.
  const gaze = createGazeInterpreter(tunables.gaze);

  // NPCs we host: spawn each as a locally-owned avatar + build its steering
  // controller. Their ids ride the outbound avatar stream so peers render them as
  // ordinary remotes. Empty unless deps.hostNpcs (one peer per room).
  const npcControllers: NpcController[] = [];
  const npcIds = new Set<string>();
  if (deps.hostNpcs && spec.npcs?.length) {
    for (const npc of spec.npcs) {
      addLocalAvatar(state, npc.id, npc.x, npc.y, npc.facing ?? 0);
      npcControllers.push(createNpcController(npc));
      npcIds.add(npc.id);
    }
  }
  const npcRng = deps.npcRng ?? Math.random;
  const ownedAvatarIds = [localId, ...npcIds];
  const npcById = new Map(npcControllers.map((c) => [c.npcId, c]));

  // Proximity is computed from the SPEC's NPCs + their positions in `state.avatars`,
  // so it works on EVERY peer — not just the owner that hosts the bodies. A
  // non-owner receives NPC positions over the relay/mesh and can still tell which
  // NPC its player is standing next to. Emit only when the in-range SET changes.
  const npcRadii = new Map<string, number>();
  // Per-NPC locomotion override: a spec `speed` walks that body slower (or
  // faster) than the player's steerMaxSpeed default.
  const npcConfigs = new Map<string, WorldEngineConfig>();
  const npcConfig = (n: NpcSpec): void => {
    if (n.behavior?.speed) {
      npcConfigs.set(n.id, { ...WORLD_ENGINE_DEFAULTS, steerMaxSpeed: n.behavior.speed });
    }
  };
  for (const n of spec.npcs ?? []) {
    npcRadii.set(n.id, n.behavior?.conversationRadius ?? DEFAULT_CONVERSATION_RADIUS);
    npcConfig(n);
  }
  let lastProximityKey = "";
  const emitProximityIfChanged = (): void => {
    if (!deps.onNpcProximity || npcRadii.size === 0) return;
    const player = state.avatars[localId];
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

  /** Step every hosted NPC body for this frame (controller → aim → locomotion). */
  const advanceNpcs = (dt: number): void => {
    if (!npcControllers.length) return;
    const humans = Object.values(state.avatars).filter((a) => !npcIds.has(a.id));
    for (const ctrl of npcControllers) {
      const self = state.avatars[ctrl.npcId];
      if (!self) continue;
      const aim = ctrl.computeAim({
        self,
        humans,
        now: state.time,
        width: spec.manifold.width,
        height: spec.manifold.height,
        rng: npcRng,
        // The same ground truth locomotion collides against — lets the
        // controller refuse to aim at blocked ground (wander waypoints).
        walkable: (p, radius) =>
          structuresWalkable(state, p, radius, self.floor) &&
          (deps.constraint?.walkable(p, radius) ?? true),
      });
      steerAvatar(state, ctrl.npcId, aim, dt, npcConfigs.get(ctrl.npcId), deps.constraint);
    }
  };

  let pointer: { x: number; y: number } | null = null;
  let running = false;
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
  // Conversation: when set, the avatar is frozen and the camera faces this point.
  let conversationTarget: Vec2 | null = null;
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
    Object.values(state.objects).find((o) => o.carriedBy === localId)?.id;

  const frame = (dt: number, now: number): void => {
    // Interpret the raw pointer into an aim EACH frame against the (moving) camera:
    // the fixation gate drops flicks, weakening eases off during saccades, and the
    // idle timer latches WATCH/sitting. The mapped aim tracks the screen point even
    // as the follow camera scrolls. The full intent also drives the camera below.
    const me = state.avatars[localId];
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
          if (anchor?.kind === "avatar" && anchor.id !== localId && state.avatars[anchor.id]) {
            const av = state.avatars[anchor.id]!;
            snap = { kind: "avatar", id: anchor.id, x: av.x, y: av.y };
            snapFromBubble = true;
          } else if (anchor && anchor.kind === "point") {
            // A point-anchored caption (over an object/spot): gaze goes there.
            const under = pickEntity({ x: anchor.x, y: anchor.y }, state, localId, tunables.interact);
            snap = under
              ? { kind: under.kind, id: under.id, x: under.x, y: under.y }
              : null;
            snapFromBubble = !!snap;
          }
        } else if (hit.kind === "avatar" && hit.id === localId) {
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
    if (me && !intent.sitting && effFix && intent.unsettled < INTERACT_SETTLE_MAX && !deps.stationary) {
      const hit = snap ?? pickEntity(effFix, state, localId, tunables.interact);
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
      if (carrying) {
        interactId = carrying;
        let withinPlaceReach = false;
        if (fix) {
          const dx = fix.x - me.x;
          const dy = fix.y - me.y;
          const d = Math.hypot(dx, dy);
          aim = deps.stationary ? null : d > CARRY_HOLD ? { x: me.x + (dx / d) * (d - CARRY_HOLD), y: me.y + (dy / d) * (d - CARRY_HOLD) } : null;
          // Placement is an ARM'S-REACH act: the put-down dwell only accumulates
          // once the avatar has walked close enough to set the object there —
          // dwelling on a distant spot steers toward it, never teleports the
          // object to it. NEVER place while the gaze rests on a CREATURE — that's
          // what dumped items onto creatures' tiles; giving an item is a dialogue
          // act, not a drop. (The avatar still approaches; only the drop is blocked.)
          // Check the creature via pickEntity too, not just snap: the held item can
          // SHADOW the creature in the screen pick (item-priority), so snap may miss
          // it — pickEntity excludes the carried item and finds the creature under it.
          const overCreature =
            snap?.kind === "avatar" || pickEntity(fix, state, localId, tunables.interact)?.kind === "avatar";
          // SPIRIT: place at the fixation regardless of reach (still never onto a creature).
          withinPlaceReach = !overCreature && (deps.stationary || d <= carryReach + CARRY_HOLD + 0.4);
        }
        const res = carryDwell.step(withinPlaceReach && fix ? { x: fix.x, y: fix.y } : null, dt * 1000);
        carryDwellProgress = res.progress;
        if (res.fired) {
          const a = carryDwell.anchor();
          if (a) placeCarriedObject(state, carrying, a);
        }
      } else {
        const target = fix ? pickEntity(fix, state, localId, tunables.interact) : null;
        const obj = target?.kind === "object" ? state.objects[target.id] : undefined;
        // SPIRIT: a hovered carryable is pickable at any distance (no walking).
        const near = !!obj && (deps.stationary || Math.hypot(obj.x - me.x, obj.y - me.y) <= carryReach) && objectAllows(state.spec, obj.id, "carry");
        if (near && obj) interactId = obj.id;
        const res = carryDwell.step(near && obj ? { x: obj.x, y: obj.y } : null, dt * 1000);
        carryDwellProgress = res.progress;
        if (res.fired && near && obj) {
          // Ownership veto: a completed pick-dwell on someone else's item is
          // DENIED (the attempt still "happened" — the game layer shows why).
          if (deps.carry.canPick?.(obj.id) === false) deps.carry.onPickDenied?.(obj.id);
          else carryObject(state, obj.id, localId);
        }
      }
    }

    // Expose the settled EFFECTIVE gaze + what it rests on + carry-dwell progress
    // for the game layer (onFrame).
    lastCommitted = effFix;
    lastHover = snap ? { kind: snap.kind, id: snap.id } : null;
    lastUnsettled = intent.unsettled;
    lastDwellProgress = carryDwellProgress;
    // CONVERSATION: freeze the avatar while talking (the camera faces the speaker,
    // applied via the render intent below). Mirrors the carry steering-suspension.
    if (conversationTarget) aim = null;
    if (deps.stationary) aim = null; // SPIRIT: the avatar never moves
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

    const { events } = tickWorld(state, { aim }, dt, undefined, deps.constraint);
    // SPIRIT: a carried object rides the GAZE. A formless stationary avatar can't
    // walk it into place, and the engine parks a carried item a fixed step in
    // FRONT of the carrier — so in spirit mode it would just sit by the invisible
    // avatar, and pick-up/put-down would read as nothing. Snap the held object to
    // the fixation each frame so it lifts to the spark on pick-up and glides with
    // it until the place-dwell drops it (placeCarriedObject already uses the same
    // point). Skip mid-saccade (effFix null) so it doesn't jump to the origin.
    if (deps.stationary && effFix) {
      const heldId = carriedId();
      const held = heldId ? state.objects[heldId] : undefined;
      if (held) {
        held.x = effFix.x;
        held.y = effFix.y;
      }
    }
    // Advance hosted NPC bodies (no-op when this peer hosts none). Runs after the
    // local tick so controllers see this frame's player position.
    advanceNpcs(dt);
    emitProximityIfChanged();
    // Glide remote avatars between the ~8–15 Hz packets (dead-reckon + ease).
    smoothRemoteAvatars(state, dt);
    // Game layer hook (single-player quest logic): runs on the final frame state.
    deps.onFrame?.(state, dt);

    if (net) {
      if (events.length) pendingEvents.push(...events);

      // Position → relay (Phase 1), lower rate, position-only.
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
        net.send(collectOutbound(state, pendingEvents, ownedAvatarIds));
        pendingEvents = [];
        lastSend = now;
      }
    }

    view.render(state, dt, {
      aim,
      sitting: intent.sitting,
      interactId,
      faceTarget,
      shoulder: wantShoulder,
      // The spark cursor tracks the genuine gaze fixation (`effFix`) + what it
      // rests on (`snap`), NOT `interactId`/`aim` — so it never sticks to the
      // carried item or the conversation partner. Its bloom is the dwell-select
      // progress (carry pick/place + any game-layer dwell).
      cursor: {
        point: effFix ?? intent.aim,
        ...(snap
          ? { hoverId: snap.id, hoverKind: snap.kind }
          : hoverSelf
            ? { hoverId: localId, hoverKind: "avatar" as const }
            : {}),
        selectProgress: Math.max(carryDwellProgress, deps.cursorProgress?.() ?? 0),
      },
    });
  };

  const loop = (now: number): void => {
    if (!running) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    frame(dt, now);
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
    setConversation(target) {
      conversationTarget = target;
    },
    pointAt(target, holdMs = 2200) {
      pointTarget = { x: target.x, y: target.y };
      pointHold = Math.max(0, holdMs) / 1000;
    },
    getGaze() {
      return {
        committedWorld: lastCommitted,
        hover: lastHover,
        unsettled: lastUnsettled,
        dwellProgress: lastDwellProgress,
      };
    },
    resize(width, height, dpr) {
      view.resize(width, height, dpr);
    },
    revealedBuildings() {
      return view.revealedBuildings?.() ?? new Set<string>();
    },
    say(text, glyph) {
      const line = (text ?? "").trim();
      if (!line) return;
      // Show it locally (over our own avatar) and broadcast it once. setAvatarSpeech
      // stamps it with state.time so it fades on the local clock.
      setAvatarSpeech(state, localId, { text: line, glyph });
      net?.send([sayMessage(localId, line, glyph)]);
    },
    addNpc(npc) {
      if (!deps.hostNpcs) return false;
      if (npcIds.has(npc.id) || state.avatars[npc.id]) return false;
      if (npcIds.size >= (deps.maxNpcs ?? WORLD_MAX_NPCS)) return false; // spec cap unless the host raised it
      addLocalAvatar(state, npc.id, npc.x, npc.y, npc.facing ?? 0);
      const ctrl = createNpcController(npc);
      npcControllers.push(ctrl);
      npcIds.add(npc.id);
      npcById.set(npc.id, ctrl);
      ownedAvatarIds.push(npc.id); // rides the outbound avatar stream like spec NPCs
      npcRadii.set(npc.id, npc.behavior?.conversationRadius ?? DEFAULT_CONVERSATION_RADIUS);
      npcConfig(npc);
      lastProximityKey = "\0"; // cast changed — re-emit proximity next frame
      return true;
    },
    removeNpc(npcId) {
      if (!npcIds.has(npcId)) return false;
      npcIds.delete(npcId);
      npcById.delete(npcId);
      const ci = npcControllers.findIndex((c) => c.npcId === npcId);
      if (ci >= 0) npcControllers.splice(ci, 1);
      const oi = ownedAvatarIds.indexOf(npcId);
      if (oi >= 0) ownedAvatarIds.splice(oi, 1);
      npcRadii.delete(npcId);
      npcConfigs.delete(npcId);
      removeAvatar(state, npcId);
      lastProximityKey = "\0";
      return true;
    },
    setStructures(structures) {
      setWorldStructures(state, structures);
    },
    setBuildings(buildings) {
      setWorldBuildings(state, buildings);
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
    stop() {
      running = false;
      if (cancel) { cancel(); cancel = null; }
      view.dispose();
    },
  };
}
