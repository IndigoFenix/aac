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
  smoothRemoteAvatars,
  steerAvatar,
  tickWorld,
  type MoveConstraint,
  type WorldState,
} from "./engine.js";
import { createDwellTracker } from "./dwell.js";
import { applyInbound, collectOutbound, sayMessage, type WorldNetMessage } from "./net.js";
import type { Vec2, WorldSpec } from "./types.js";
import type { WorldView } from "./world-view.js";
import { createGazeInterpreter } from "./gaze-intent.js";
import { approachAim, pickEntity } from "./interact.js";
import { DEFAULT_WORLD_TUNABLES, type WorldTunables } from "./world-tunables.js";
import {
  createNpcController,
  DEFAULT_CONVERSATION_RADIUS,
  type NpcController,
  type NpcEngagement,
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
   *  the ground). Omit to disable carry. */
  carry?: { reach?: number; dwellMs?: number };
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
  /** This frame's settled gaze — the fixated ground point (`committedWorld`, null
   *  mid-saccade), how settled it is (`unsettled`: 0 settled … 1 flicking), and the
   *  current CARRY dwell progress (`dwellProgress`: 0 idle … 1 about to fire). The
   *  game layer hit-tests committedWorld to detect dwell on a figure / empty ground
   *  and reads dwellProgress to draw a dwell-timer indicator. */
  getGaze(): { committedWorld: Vec2 | null; unsettled: number; dwellProgress: number };
  /** Logical size (CSS px) + DPR changed. */
  resize(width: number, height: number, dpr: number): void;
  /** The local user spoke: show a speech bubble over the local avatar and broadcast
   *  it once so peers render it too. `glyph` is the optional composed AAC glyph. */
  say(text: string, glyph?: string): void;
  /** Bias a hosted NPC's body from its live conversation (mind → body). No-op for
   *  an unknown id or a peer that doesn't host that NPC. */
  setNpcEngagement(npcId: string, engagement: NpcEngagement | null): void;
  /** Live-update the gaze interpreter + camera/comfort tunables (debug menu). */
  setTunables(t: WorldTunables): void;
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
  for (const n of spec.npcs ?? []) {
    npcRadii.set(n.id, n.behavior?.conversationRadius ?? DEFAULT_CONVERSATION_RADIUS);
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
      });
      steerAvatar(state, ctrl.npcId, aim, dt, undefined, deps.constraint);
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
  // This frame's settled gaze, exposed to the game layer via getGaze().
  let lastCommitted: Vec2 | null = null;
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
    // INTERACT (P3): a SETTLED gaze resting on an entity re-targets the aim to
    // engage it (toy → walk in; person → approach to talking distance + face). The
    // engine is unchanged — it just receives the engaging aim instead of the raw
    // ground point. interactId is forwarded so the renderer can highlight the target.
    let aim: Vec2 | null = intent.aim;
    let interactId: string | undefined;
    if (me && !intent.sitting && intent.committedWorld && intent.unsettled < INTERACT_SETTLE_MAX) {
      const hit = pickEntity(intent.committedWorld, state, localId, tunables.interact);
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
      const fix = intent.committedWorld; // the fixation point (null mid-saccade)
      if (carrying) {
        interactId = carrying;
        if (fix) {
          const dx = fix.x - me.x;
          const dy = fix.y - me.y;
          const d = Math.hypot(dx, dy);
          aim = d > CARRY_HOLD ? { x: me.x + (dx / d) * (d - CARRY_HOLD), y: me.y + (dy / d) * (d - CARRY_HOLD) } : null;
        }
        const res = carryDwell.step(fix ? { x: fix.x, y: fix.y } : null, dt * 1000);
        carryDwellProgress = res.progress;
        if (res.fired) {
          const a = carryDwell.anchor();
          if (a) placeCarriedObject(state, carrying, a);
        }
      } else {
        const target = fix ? pickEntity(fix, state, localId, tunables.interact) : null;
        const obj = target?.kind === "object" ? state.objects[target.id] : undefined;
        const near = !!obj && Math.hypot(obj.x - me.x, obj.y - me.y) <= carryReach && objectAllows(state.spec, obj.id, "carry");
        if (near && obj) interactId = obj.id;
        const res = carryDwell.step(near && obj ? { x: obj.x, y: obj.y } : null, dt * 1000);
        carryDwellProgress = res.progress;
        if (res.fired && near && obj) carryObject(state, obj.id, localId);
      }
    }

    // Expose the settled gaze + carry-dwell progress for the game layer (onFrame).
    lastCommitted = intent.committedWorld;
    lastUnsettled = intent.unsettled;
    lastDwellProgress = carryDwellProgress;
    // CONVERSATION: freeze the avatar while talking (the camera faces the speaker,
    // applied via the render intent below). Mirrors the carry steering-suspension.
    if (conversationTarget) aim = null;

    const { events } = tickWorld(state, { aim }, dt, undefined, deps.constraint);
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

    view.render(state, dt, { aim, sitting: intent.sitting, interactId, faceTarget: conversationTarget });
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
    getGaze() {
      return { committedWorld: lastCommitted, unsettled: lastUnsettled, dwellProgress: lastDwellProgress };
    },
    resize(width, height, dpr) {
      view.resize(width, height, dpr);
    },
    say(text, glyph) {
      const line = (text ?? "").trim();
      if (!line) return;
      // Show it locally (over our own avatar) and broadcast it once. setAvatarSpeech
      // stamps it with state.time so it fades on the local clock.
      setAvatarSpeech(state, localId, { text: line, glyph });
      net?.send([sayMessage(localId, line, glyph)]);
    },
    setNpcEngagement(npcId, engagement) {
      npcById.get(npcId)?.setEngagement(engagement);
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
