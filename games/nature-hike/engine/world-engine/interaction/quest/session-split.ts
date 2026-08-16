// shared/world-engine/interaction/quest/session-split.ts
//
// SESSION SPLIT/MERGE — generic engine machinery: proximity-based splitting
// of ONE shared multiplayer world into per-cluster simulation sessions,
// applied whenever multiple players share a world (per the user ruling
// recorded in the round doc). It is not specific to any one game. Players
// who spread apart split the shared sim into per-cluster sessions (each
// cluster gets its own quest host instance); players who come back together
// merge their sessions again. This module decides WHO is in WHICH session
// and WHO hosts it — nothing about spawning/tearing down an actual quest
// host lives here.
//
// HYSTERESIS LAW (the whole point of this module): a pair of players only
// MERGES once they come within `mergeM` of each other, but two players
// already sharing a session only SPLIT once they drift past `splitM`
// (`splitM > mergeM`). The band between the two thresholds is sticky in
// both directions — strangers/joiners must close all the way to `mergeM`
// to be pulled in, while co-members coast through that same band without
// being pushed apart. Without this gap, players hovering near a single
// threshold would flap sessions (and hand authority back and forth) every
// tick. See `clusterMembers` for the exact edge rule.
//
// ELECTION: `sessionAuthority` picks the lowest-id member (or an explicit
// `platformOwner`, if present) to run a session. This mirrors the precedent
// in shared/social-world/npc-conversation-logic.ts (`resolveWorldOwner`:
// platform host preferred, else smallest id) — reimplemented here rather
// than imported, because shared/world-engine may not import across the
// vendored-engine boundary into shared/social-world.
//
// DEPENDENCY-LIGHT BY DESIGN: zero imports, zero I/O, zero Date.now/
// Math.random. Every function is a pure computation over its arguments, so
// callers on either side of the boundary (game client, headless host, tests)
// get byte-identical answers for byte-identical inputs. In particular this
// module does NOT know the wild chunk's side length — `WILD_SIDE` is a
// per-game constant that lives in games/world-lab (a `games/` project),
// which shared/world-engine cannot import — callers pass it into
// `sessionThresholds`.
//
// DOC'd DEVIATIONS / OPEN CHOICES (spec left these open):
//  - `greatCircleDistanceM` is exported (the spec's public API block didn't
//    list it) so tests can assert exact distances directly instead of
//    reverse-engineering them from clustering behavior.
//  - Session-id continuity is a GREEDY MAXIMUM MATCHING between prev session
//    ids and next components: every (prevId, component) pair with overlap>0
//    is a candidate, sorted by (overlap desc, prevId asc, component's lowest
//    member asc), and pairs are claimed greedily in that order (first-come,
//    each side claimed at most once). This satisfies the spec's per-id rule
//    ("the component it shares the most members with") while resolving the
//    cases the spec leaves implicit — e.g. two prev ids competing for the
//    same merged component — deterministically in favor of the higher-
//    overlap pairing.
//  - NO-CHURN (law 6): "unchanged" is defined as identical id/members/
//    authority sets between prev and the freshly computed sessions (anchor
//    drift is NOT part of the comparison — anchors are always recomputed
//    fresh). This is the simplification the spec explicitly allows; the
//    load-bearing property it preserves is that a static world never bumps
//    epoch forever.
//  - Degenerate anchor: if member directions sum to the zero vector (e.g. an
//    exactly-antipodal pair), the anchor direction is `[0,0,0]` (not
//    renormalized to a unit vector) rather than thrown — a rare v1 edge case
//    a caller can special-case if it ever matters.

/** Wild-chunk fraction beyond which two CURRENT session-mates are considered
 *  to have drifted apart (an edge is dropped unless they're already this
 *  close together AND were already sharing a session). */
export const SESSION_SPLIT_FRAC = 0.45;
/** Wild-chunk fraction within which ANY two members merge, session history
 *  or not. */
export const SESSION_MERGE_FRAC = 0.2;

/** Absolute split/merge distances for a wild chunk of the given side length. */
export function sessionThresholds(wildSideM: number): { splitM: number; mergeM: number } {
  return { splitM: wildSideM * SESSION_SPLIT_FRAC, mergeM: wildSideM * SESSION_MERGE_FRAC };
}

/** A member's position on the planet sphere. `d` is a body-local UNIT
 *  direction (not necessarily normalized by the caller — this module treats
 *  it as-is; pass a genuine unit vector). `e` is elevation in metres,
 *  currently ignored for distance purposes (v1: flat-sphere hiking only). */
export interface MemberLoc {
  id: string;
  d: [number, number, number];
  e: number;
}

export interface SplitSession {
  id: string;
  /** Sorted ascending. */
  members: string[];
  /** Always one of `members`. */
  authority: string;
  /** Normalized centroid of member directions; mean elevation. */
  anchor: { d: [number, number, number]; e: number };
}

export interface SessionAssignment {
  epoch: number;
  /** Sorted by id. */
  sessions: SplitSession[];
}

function clampUnit(x: number): number {
  return x < -1 ? -1 : x > 1 ? 1 : x;
}

function dot3(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Great-circle distance in metres between two unit directions on a sphere
 *  of the given radius. Elevation is ignored (v1). */
export function greatCircleDistanceM(
  radiusM: number,
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  return radiusM * Math.acos(clampUnit(dot3(a, b)));
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Elect the member who runs a session: `platformOwner` if it is one of the
 *  members, else the lexicographically smallest member id. Throws on an
 *  empty member list (there is no session with zero members to elect for). */
export function sessionAuthority(memberIds: string[], opts?: { platformOwner?: string }): string {
  if (memberIds.length === 0) throw new Error("sessionAuthority: empty member list");
  const owner = opts?.platformOwner;
  if (owner !== undefined && memberIds.includes(owner)) return owner;
  let min = memberIds[0];
  for (const id of memberIds) if (id < min) min = id;
  return min;
}

// ---- clusterMembers -------------------------------------------------------

class UnionFind {
  private readonly parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    // Deterministic root choice (lower index wins) — doesn't affect output,
    // since components are re-canonicalized (sorted member ids) afterward.
    if (ra < rb) this.parent[rb] = ra;
    else this.parent[ra] = rb;
  }
}

function anchorFor(
  members: string[],
  locById: Map<string, MemberLoc>,
): { d: [number, number, number]; e: number } {
  let sx = 0;
  let sy = 0;
  let sz = 0;
  let se = 0;
  for (const m of members) {
    const loc = locById.get(m);
    if (!loc) continue;
    sx += loc.d[0];
    sy += loc.d[1];
    sz += loc.d[2];
    se += loc.e;
  }
  const len = Math.hypot(sx, sy, sz);
  const d: [number, number, number] = len > 0 ? [sx / len, sy / len, sz / len] : [0, 0, 0];
  return { d, e: members.length > 0 ? se / members.length : 0 };
}

/**
 * Recompute the session topology for the current tick.
 *
 * 1. Distance between two members is great-circle (elevation ignored).
 * 2. Edge rule (the hysteresis law): a pair is connected iff
 *    `dist <= mergeM`, OR (`dist <= splitM` AND both were in the SAME prev
 *    session). Connected components of that graph are the new sessions.
 * 3. Output is fully canonicalized (everything sorted by id) so the same
 *    input SET, in any array order, produces a JSON-identical result.
 * 4. Session-id continuity and no-churn epoch handling: see the module doc
 *    comment above for the exact (spec-permitted) choices made here.
 */
export function clusterMembers(
  locs: MemberLoc[],
  prev: SessionAssignment | null,
  opts: { radiusM: number; splitM: number; mergeM: number; platformOwner?: string },
): SessionAssignment {
  const { radiusM, splitM, mergeM, platformOwner } = opts;

  // Canonicalize input order first — everything downstream is order-independent.
  const sorted = [...locs].sort((a, b) => cmp(a.id, b.id));
  const locById = new Map(sorted.map((l) => [l.id, l] as const));

  const prevSessionOfMember = new Map<string, string>();
  const prevSessions = prev?.sessions ?? [];
  for (const s of prevSessions) {
    for (const m of s.members) prevSessionOfMember.set(m, s.id);
  }

  const uf = new UnionFind(sorted.length);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const dist = greatCircleDistanceM(radiusM, sorted[i].d, sorted[j].d);
      if (dist <= mergeM) {
        uf.union(i, j);
        continue;
      }
      if (dist <= splitM) {
        const sa = prevSessionOfMember.get(sorted[i].id);
        const sb = prevSessionOfMember.get(sorted[j].id);
        if (sa !== undefined && sa === sb) uf.union(i, j);
      }
    }
  }

  const byRoot = new Map<number, string[]>();
  for (let i = 0; i < sorted.length; i++) {
    const r = uf.find(i);
    let bucket = byRoot.get(r);
    if (!bucket) {
      bucket = [];
      byRoot.set(r, bucket);
    }
    bucket.push(sorted[i].id);
  }
  const components = [...byRoot.values()].map((members) => members.slice().sort(cmp));
  components.sort((a, b) => cmp(a[0], b[0]));

  // Greedy maximum matching between prev session ids and next components —
  // see the module doc comment ("DOC'd DEVIATIONS") for the exact rule.
  type Pair = { prevId: string; compIdx: number; overlap: number };
  const pairs: Pair[] = [];
  for (const s of prevSessions) {
    const prevSet = new Set(s.members);
    for (let ci = 0; ci < components.length; ci++) {
      let overlap = 0;
      for (const m of components[ci]) if (prevSet.has(m)) overlap++;
      if (overlap > 0) pairs.push({ prevId: s.id, compIdx: ci, overlap });
    }
  }
  pairs.sort((a, b) => {
    if (a.overlap !== b.overlap) return b.overlap - a.overlap;
    if (a.prevId !== b.prevId) return cmp(a.prevId, b.prevId);
    return cmp(components[a.compIdx][0], components[b.compIdx][0]);
  });

  const claimedPrev = new Set<string>();
  const claimedComp = new Set<number>();
  const inheritedId = new Map<number, string>();
  for (const p of pairs) {
    if (claimedPrev.has(p.prevId) || claimedComp.has(p.compIdx)) continue;
    claimedPrev.add(p.prevId);
    claimedComp.add(p.compIdx);
    inheritedId.set(p.compIdx, p.prevId);
  }

  const tentativeEpoch = (prev?.epoch ?? -1) + 1;
  const nextSessions: SplitSession[] = components.map((members, ci) => {
    const id = inheritedId.get(ci) ?? `ss:${members[0]}@${tentativeEpoch}`;
    return {
      id,
      members,
      authority: sessionAuthority(members, { platformOwner }),
      anchor: anchorFor(members, locById),
    };
  });
  nextSessions.sort((a, b) => cmp(a.id, b.id));

  const unchanged =
    prev !== null &&
    prev.sessions.length === nextSessions.length &&
    prev.sessions.every((p, i) => {
      const n = nextSessions[i];
      return (
        p.id === n.id &&
        p.authority === n.authority &&
        p.members.length === n.members.length &&
        p.members.every((m, mi) => m === n.members[mi])
      );
    });

  return { epoch: unchanged ? prev!.epoch : tentativeEpoch, sessions: nextSessions };
}

// ---- diffAssignments -------------------------------------------------------

export type SessionDecision =
  | { type: "boot"; session: SplitSession }
  | { type: "tear"; sessionId: string }
  | { type: "authority-change"; sessionId: string; from: string; to: string }
  | { type: "handover"; from: string; to: string; members: string[]; reason: "split" | "merge" }
  | { type: "anchor"; sessionId: string; anchor: { d: [number, number, number]; e: number } };

function decisionKey(d: SessionDecision): string {
  switch (d.type) {
    case "boot":
      return `0:${d.session.id}`;
    case "tear":
      return `1:${d.sessionId}`;
    case "authority-change":
      return `2:${d.sessionId}`;
    case "handover":
      return `3:${d.from}>${d.to}`;
    case "anchor":
      return `4:${d.sessionId}`;
  }
}

/**
 * Diff two assignments into the plain-data decisions a caller must act on
 * (boot a new host, tear one down, hand authority/members over, or push an
 * anchor update). Deterministic, sorted by `decisionKey` above: type rank
 * first (boot, tear, authority-change, handover, anchor), then the relevant
 * id (session id, or `from>to` for handovers).
 *
 * Handover grouping: every member whose session id changed between prev and
 * next is grouped by (fromSessionId, toSessionId); one handover is emitted
 * per group, `from` = the prev session's authority (even if that peer has
 * since departed entirely — loss-tolerant v1, the consumer handles absence),
 * `to` = the destination session's (next) authority, `members` sorted
 * ascending. `reason` is "split" if the destination id is new in `next`
 * (paired with a `boot`), "merge" if the destination id already existed in
 * `prev`. A member who is new in `next` (no prev session) or who has
 * departed entirely (no next session) is not part of any handover.
 */
export function diffAssignments(prev: SessionAssignment | null, next: SessionAssignment): SessionDecision[] {
  const decisions: SessionDecision[] = [];
  const prevSessions = prev?.sessions ?? [];
  const prevById = new Map(prevSessions.map((s) => [s.id, s] as const));
  const nextById = new Map(next.sessions.map((s) => [s.id, s] as const));

  for (const s of next.sessions) {
    if (!prevById.has(s.id)) decisions.push({ type: "boot", session: s });
  }
  for (const s of prevSessions) {
    if (!nextById.has(s.id)) decisions.push({ type: "tear", sessionId: s.id });
  }
  for (const s of next.sessions) {
    const p = prevById.get(s.id);
    if (p && p.authority !== s.authority) {
      decisions.push({ type: "authority-change", sessionId: s.id, from: p.authority, to: s.authority });
    }
  }

  const prevSessionOfMember = new Map<string, string>();
  for (const s of prevSessions) for (const m of s.members) prevSessionOfMember.set(m, s.id);
  const nextSessionOfMember = new Map<string, string>();
  for (const s of next.sessions) for (const m of s.members) nextSessionOfMember.set(m, s.id);

  const allMembers = new Set<string>([...prevSessionOfMember.keys(), ...nextSessionOfMember.keys()]);
  const groups = new Map<string, { from: string; to: string; members: string[] }>();
  for (const m of allMembers) {
    const from = prevSessionOfMember.get(m);
    const to = nextSessionOfMember.get(m);
    if (from === undefined || to === undefined || from === to) continue;
    // Composite move-group key: JSON-encoding the pair is unambiguous for
    // ANY id contents (and keeps this source free of exotic separator bytes).
    const key = JSON.stringify([from, to]);
    let g = groups.get(key);
    if (!g) {
      g = { from, to, members: [] };
      groups.set(key, g);
    }
    g.members.push(m);
  }
  for (const { from, to, members } of groups.values()) {
    const fromSession = prevById.get(from);
    const toSession = nextById.get(to)!;
    const reason: "split" | "merge" = prevById.has(to) ? "merge" : "split";
    decisions.push({
      type: "handover",
      from: fromSession ? fromSession.authority : from,
      to: toSession.authority,
      members: members.slice().sort(cmp),
      reason,
    });
  }

  for (const s of next.sessions) {
    const p = prevById.get(s.id);
    if (!p) continue; // boots carry their anchor inside `session` already
    const dx = s.anchor.d[0] - p.anchor.d[0];
    const dy = s.anchor.d[1] - p.anchor.d[1];
    const dz = s.anchor.d[2] - p.anchor.d[2];
    if (Math.hypot(dx, dy, dz) > 1e-6) decisions.push({ type: "anchor", sessionId: s.id, anchor: s.anchor });
  }

  decisions.sort((a, b) => cmp(decisionKey(a), decisionKey(b)));
  return decisions;
}
