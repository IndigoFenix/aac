// shared/social-world/media-gate.ts
//
// Phase 2 of "variable conversation circles": turn the circle solver's audible
// set into MEDIA decisions — which peer connections to open, which to close, and
// at what volume. PURE so it's unit-testable; the caller (CallContext) applies
// the side effects against the PeerMesh + the audio elements.
//
// Model: "subtractive gating on a full mesh". The baseline call still connects
// peers on join; this planner PRUNES peers who wander out of range and RE-ADDS
// them when they walk back in. Hysteresis is two radii — connect at
// `connectRadius`, only drop past the wider `dropRadius` — so a peer loitering on
// the boundary doesn't thrash the ~1s WebRTC handshake.
//
// Only the proximityRule is wired here, but the audible set comes from the solver
// (solveAudibleFor), so a future non-proximity rule changes the rule, not this
// shape. See planning-docs/large-world-conversation-circles.md.

import {
  proximityRule,
  solveAudibleFor,
  audibleRecvIds,
  type WorldParticipant,
} from "./circle-solver.js";

export interface MediaGateConfig {
  /** Open a connection to peers within this radius (world units). */
  connectRadius: number;
  /** Keep an OPEN connection until the peer passes this radius (> connectRadius).
   *  The gap is the hysteresis band that stops boundary thrash. */
  dropRadius: number;
  /** Full volume within this radius; linear fade to 0 at dropRadius. */
  falloffStart: number;
}

/** Tuned for the 40×30 social field: hear within 8, fully fade out by 11. */
export const DEFAULT_MEDIA_GATE: MediaGateConfig = {
  connectRadius: 8,
  dropRadius: 11,
  falloffStart: 8,
};

export interface MediaPlan {
  /** Peers to OPEN a connection to (in range, not yet connected). */
  connect: string[];
  /** Peers to CLOSE (connected, now beyond dropRadius). */
  disconnect: string[];
  /** Target audio gain 0..1 for every peer that should stay connected. */
  gains: Map<string, number>;
}

function emptyPlan(): MediaPlan {
  return { connect: [], disconnect: [], gains: new Map() };
}

/**
 * Decide the media changes for `selfId` given everyone's positions and the peers
 * currently connected. The caller opens/closes the listed connections and sets
 * the listed gains.
 */
export function planMedia(
  selfId: string,
  participants: readonly WorldParticipant[],
  connectedIds: Iterable<string>,
  config: MediaGateConfig = DEFAULT_MEDIA_GATE,
): MediaPlan {
  const connected = new Set(connectedIds);
  const self = participants.find((p) => p.personId === selfId);

  // Without our own position we can't judge proximity — hold everything as-is
  // (full volume) rather than dropping live connections on a transient gap.
  if (!self) {
    const plan = emptyPlan();
    for (const id of connected) plan.gains.set(id, 1);
    return plan;
  }

  const others = participants.filter((p) => p.personId !== selfId);
  const inRange = audibleRecvIds(
    solveAudibleFor(self, others, [
      proximityRule({ radius: config.connectRadius, falloffStart: config.falloffStart }),
    ]),
  );
  // The wider "keep" ring also yields the fade weight for connected peers.
  const keepEdges = solveAudibleFor(self, others, [
    proximityRule({ radius: config.dropRadius, falloffStart: config.falloffStart }),
  ]);
  const keepWeight = new Map(keepEdges.map((e) => [e.personId, e.weight]));

  const plan = emptyPlan();
  for (const id of inRange) if (!connected.has(id)) plan.connect.push(id);
  for (const id of connected) if (!keepWeight.has(id)) plan.disconnect.push(id);

  const disconnecting = new Set(plan.disconnect);
  for (const id of connected) if (!disconnecting.has(id)) plan.gains.set(id, keepWeight.get(id) ?? 1);
  for (const id of plan.connect) plan.gains.set(id, keepWeight.get(id) ?? 1);
  return plan;
}

/**
 * PRESENTATION gating: per-peer audio/video gain 0..1 from a single falloff rule,
 * with NO connection hysteresis. Used when everyone stays on a full mesh (so all
 * avatars render from the world layer) and only their live A/V is constrained —
 * a peer beyond `dropRadius` is absent from the map (mute + hide their tile),
 * one inside fades with distance. Peers NOT in the returned map are out of the
 * circle. (planMedia above is the connection-level variant, reserved for the
 * later large-world / SFU phase.)
 */
export function audibleGains(
  selfId: string,
  participants: readonly WorldParticipant[],
  config: MediaGateConfig = DEFAULT_MEDIA_GATE,
): Map<string, number> {
  const gains = new Map<string, number>();
  const self = participants.find((p) => p.personId === selfId);
  if (!self) return gains;
  const others = participants.filter((p) => p.personId !== selfId);
  const edges = solveAudibleFor(self, others, [
    proximityRule({ radius: config.dropRadius, falloffStart: config.falloffStart }),
  ]);
  for (const e of edges) if (e.weight > 0) gains.set(e.personId, e.weight);
  return gains;
}
