// shared/social-world/world-host.ts
//
// The framework-free heart of the social-world client: the per-frame loop that
// drives input → aim → sim → networking → render. Extracted from
// SocialWorldCanvas so the SAME loop runs in two places:
//   • on the main thread (the React component wires DOM events + the call net), and
//   • inside a Web Worker on an OffscreenCanvas (the bridge posts inputs in and
//     outbound net messages out).
//
// It owns NO DOM and NO transport: a `WorldView` (injected) does the drawing +
// screen→world mapping, a `scheduleFrame`/`now` clock drives it, and inbound peer
// state is fed in via methods while outbound rides the injected `net` callbacks.
// That keeps this module pure enough to live on either side of the worker boundary.

import {
  addLocalAvatar,
  applyInbound,
  applyRemoteAvatar,
  collectOutbound,
  createWorldState,
  removeAvatar,
  smoothRemoteAvatars,
  steerAvatar,
  tickWorld,
  type Vec2,
  type WorldNetMessage,
  type WorldSpec,
  type WorldState,
} from "../world-engine/index.js";
import type { WorldView } from "../world-engine/world-view.js";
import {
  createNpcController,
  DEFAULT_CONVERSATION_RADIUS,
  type NpcController,
  type NpcEngagement,
  type NpcProximity,
} from "./npc-controller.js";
import type { WorldPresence } from "./world-presence.js";

const SEND_INTERVAL_MS = 1000 / 15; // ~15 Hz mesh world-state (toys/possession + avatar)
const PRESENCE_INTERVAL_MS = 1000 / 8; // ~8 Hz relay position (cheap, position-only)

/** Outbound transport — supplied by the host's environment (the call mesh on the
 *  main thread, or a postMessage bridge in the worker). Absent ⇒ single-player. */
export interface WorldHostNet {
  send: (msgs: WorldNetMessage[]) => void;
  publishPresence?: (p: WorldPresence) => void;
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
}

/** A running world loop. Feed it peer state + input; it renders and emits outbound. */
export interface WorldHost {
  /** Inbound mesh messages (toys/possession + avatars when no relay). */
  applyNetInbound(msgs: WorldNetMessage[]): void;
  /** Inbound relayed presence (a remote avatar position). */
  applyPresence(p: WorldPresence): void;
  /** A peer left / was pruned. */
  applyPresenceLeave(personId: string): void;
  /** Pointer moved to a canvas-relative CSS pixel. */
  setPointer(px: number, py: number): void;
  /** Pointer left the surface (avatar coasts to a stop). */
  clearPointer(): void;
  /** Logical size (CSS px) + DPR changed. */
  resize(width: number, height: number, dpr: number): void;
  /** Bias a hosted NPC's body from its live conversation (mind → body). No-op for
   *  an unknown id or a peer that doesn't host that NPC. */
  setNpcEngagement(npcId: string, engagement: NpcEngagement | null): void;
  start(): void;
  /** Stop the loop and dispose the view. */
  stop(): void;
  /** The live world state (read-only use — e.g. diagnostics). */
  readonly state: WorldState;
}

export function runWorldHost(deps: WorldHostDeps): WorldHost {
  const { view, spec, localId, net } = deps;

  const state: WorldState = createWorldState(spec, localId, deps.spawnIndex, deps.spawnAt);

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
      steerAvatar(state, ctrl.npcId, aim, dt);
    }
  };

  let pointer: { x: number; y: number } | null = null;
  let running = false;
  let cancel: (() => void) | null = null;
  let last = 0;
  let lastSend = 0;
  let lastPresence = 0;
  let pendingEvents: ReturnType<typeof tickWorld>["events"] = [];

  const frame = (dt: number, now: number): void => {
    // Aim is derived EACH frame from the stored pointer against the (moving) camera,
    // so the avatar tracks the screen point even as the follow camera scrolls.
    const aim: Vec2 | null = pointer ? view.screenToWorld(pointer.x, pointer.y) : null;
    const { events } = tickWorld(state, { aim }, dt);
    // Advance hosted NPC bodies (no-op when this peer hosts none). Runs after the
    // local tick so controllers see this frame's player position.
    advanceNpcs(dt);
    emitProximityIfChanged();
    // Glide remote avatars between the ~8–15 Hz packets (dead-reckon + ease).
    smoothRemoteAvatars(state, dt);

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

    view.render(state, dt);
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
      applyRemoteAvatar(state, { id: p.personId, x: p.x, y: p.y, fx: p.fx, fy: p.fy, vx: p.vx, vy: p.vy });
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
    resize(width, height, dpr) {
      view.resize(width, height, dpr);
    },
    setNpcEngagement(npcId, engagement) {
      npcById.get(npcId)?.setEngagement(engagement);
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
