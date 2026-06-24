// shared/social-world/circle-solver.ts
//
// The CIRCLE SOLVER — the pure, deterministic, TRANSPORT-AGNOSTIC core of
// "variable conversation circles in large worlds". Given where everyone is (plus
// arbitrary attributes) and a list of composable RULES, it computes, for each
// person, the set of people they can hear/see — their AUDIBLE SET.
//
// Proximity ("hear within radius R") is the first rule; teams, assigned pairs and
// facilitator overrides are future rules behind the SAME signature. The media
// layer (Phase 2: dynamic mesh / later SFU) consumes ONLY this output, so
// swapping rules never touches transport — that is the seam this whole feature
// exists to validate.
//
// See planning-docs/large-world-conversation-circles.md.

/**
 * A participant as the solver sees them: an id, a world position, and an open bag
 * of attributes for non-proximity rules. WorldPresence (the relay payload in
 * world-presence.ts) is structurally a superset, so live presences feed straight
 * in without an adapter.
 */
export interface WorldParticipant {
  personId: string;
  x: number;
  y: number;
  /** Arbitrary attributes for non-proximity rules (team, role, pairing…). */
  attrs?: Record<string, string | number | boolean>;
}

/**
 * One directed "self perceives the other" edge. `recv`/`send` are kept separate
 * so a rule can express ASYMMETRY (a facilitator who hears a circle without being
 * heard = recv:true, send:false). Proximity edges are symmetric.
 */
export interface AudibleEdge {
  /** The OTHER party (never self). */
  personId: string;
  /** Volume/clarity 0..1 — 1 is full. Falloff rules attenuate; gates are 1. */
  weight: number;
  /** Self can HEAR/SEE them. */
  recv: boolean;
  /** They can hear/see self. */
  send: boolean;
}

/**
 * A rule maps (self, others) → the edges it ASSERTS. Returning no edge for a pair
 * means "no opinion", not "deny" — the solver UNIONs every rule's edges, so any
 * rule can add an edge but none silently removes another's. (A future "block"
 * primitive, if needed, would be a separate post-pass, kept out of v1.)
 */
export type ConversationRule = (
  self: WorldParticipant,
  others: readonly WorldParticipant[],
) => AudibleEdge[];

// ---------------------------------------------------------------------------
// Proximity rule — the first, simplest example
// ---------------------------------------------------------------------------

export interface ProximityRuleOptions {
  /** Hard cutoff in world units: beyond this you cannot hear them at all. */
  radius: number;
  /**
   * Distance at which volume STARTS dropping (≤ radius). Between `falloffStart`
   * and `radius` weight ramps linearly 1→0; inside `falloffStart` it's a flat 1.
   * Default = radius (a hard on/off gate, no falloff).
   */
  falloffStart?: number;
}

/**
 * Sensible default for the 40×30 social field: an ~8-unit circle (about a fifth
 * of the field) with volume starting to fade at 5 units. Tuned for "walk over to
 * join a conversation" rather than realistic acoustics.
 */
export const DEFAULT_PROXIMITY: ProximityRuleOptions = { radius: 8, falloffStart: 5 };

/** Build a proximity rule: you hear anyone within `radius`, fading past
 *  `falloffStart`. Symmetric — equal distance gives equal weight both ways. */
export function proximityRule(opts: ProximityRuleOptions = DEFAULT_PROXIMITY): ConversationRule {
  const radius = Math.max(0, opts.radius);
  const start = Math.min(radius, Math.max(0, opts.falloffStart ?? radius));
  return (self, others) => {
    const edges: AudibleEdge[] = [];
    for (const o of others) {
      if (o.personId === self.personId) continue;
      const d = Math.hypot(o.x - self.x, o.y - self.y);
      if (d > radius) continue;
      const weight =
        d <= start || radius === start ? 1 : Math.max(0, 1 - (d - start) / (radius - start));
      if (weight <= 0) continue; // exactly on the cutoff → silent, drop it
      edges.push({ personId: o.personId, weight, recv: true, send: true });
    }
    return edges;
  };
}

// ---------------------------------------------------------------------------
// Solver
// ---------------------------------------------------------------------------

/**
 * Solve the audible edges for ONE participant under a set of rules. Edges to the
 * same person from different rules merge: weight = max, recv/send = OR. The
 * result is deduped by personId and never contains self.
 */
export function solveAudibleFor(
  self: WorldParticipant,
  others: readonly WorldParticipant[],
  rules: readonly ConversationRule[],
): AudibleEdge[] {
  const merged = new Map<string, AudibleEdge>();
  for (const rule of rules) {
    for (const e of rule(self, others)) {
      if (e.personId === self.personId) continue;
      const prev = merged.get(e.personId);
      if (!prev) {
        merged.set(e.personId, { ...e });
      } else {
        prev.weight = Math.max(prev.weight, e.weight);
        prev.recv = prev.recv || e.recv;
        prev.send = prev.send || e.send;
      }
    }
  }
  return Array.from(merged.values());
}

/** Solve every participant's audible edges at once (the whole-world view). */
export function solveCircles(
  participants: readonly WorldParticipant[],
  rules: readonly ConversationRule[],
): Map<string, AudibleEdge[]> {
  const out = new Map<string, AudibleEdge[]>();
  for (const self of participants) {
    const others = participants.filter((p) => p.personId !== self.personId);
    out.set(self.personId, solveAudibleFor(self, others, rules));
  }
  return out;
}

/**
 * The set of people `self` can HEAR (recv && weight>0) — the media layer's
 * "open/keep a connection to these" list. Drops send-only (listen-in target)
 * edges that self can't itself hear.
 */
export function audibleRecvIds(edges: readonly AudibleEdge[]): Set<string> {
  const s = new Set<string>();
  for (const e of edges) if (e.recv && e.weight > 0) s.add(e.personId);
  return s;
}
