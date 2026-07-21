/**
 * laws.ts — SCOPED PROHIBITIONS (nations arc P2 — the Law substrate,
 * nations-and-empires.md §3/§6).
 *
 * A LAW here is a standing PROHIBITION: "<verb> is not done <in area>".
 * Three tiers:
 *   - "custom"   — a community habit; competes through the compliance
 *                  argmax like any society rule (rules.ts).
 *   - "law"      — issued by an authority (the player, a hall, a crown);
 *                  commands that violate it are REFUSED with the law
 *                  named.
 *   - "absolute" — a cultural taboo: NOT weighed at all — the violating
 *                  candidate is PRUNED from every argmax (the
 *                  cannotLeavePost pattern) and a member is physically
 *                  unable to select it. The world spec's `game.culture`
 *                  absolutes (parental controls) enter here with
 *                  issuer "world".
 *
 * POSITIVE standing rules ("when night go home") keep living in rules.ts —
 * a prohibition is not a goal to pursue but a gate on goals, so it gets
 * its own row shape; unifying the two under one Law envelope is the P4
 * dispute-machine work.
 *
 * AREAS: a law binds where its area contains the actor. The session owns
 * geometry (containment oracles); law rows stay pure data — which is why
 * this module lives in the KERNEL: `SerializedTownDeltas` persists
 * authored rows beside the construction they govern, and the interaction
 * layer (behavior/laws.ts) re-exports this core plus the GoalSpec bridge.
 * The world spec's absolute ring is NEVER persisted here — it re-derives
 * from `game.culture` every boot (unrepealable by construction).
 */

// ── Areas ───────────────────────────────────────────────────────────────────

export type AreaRef =
  | { kind: "everywhere" }
  /** The whole settlement scope the session runs in ("in town"). */
  | { kind: "town" }
  /** A building/room by object id (household scale — "my room"). */
  | { kind: "structure"; id: string }
  /** A town district by zone-charter ord (③ zoning's areas). */
  | { kind: "district"; ord: number }
  /** Legacy disc (town-local metres) — the zoning brush's shape. */
  | { kind: "disc"; x: number; y: number; r: number };

/** Specificity rank for innermost-wins resolution (higher = more local). */
const AREA_RANK: Record<AreaRef["kind"], number> = {
  everywhere: 0, town: 1, district: 2, disc: 2, structure: 3,
};

/** The caller's containment oracle: is the ACTOR inside this area right
 *  now? The session owns geometry; laws stay pure data. `everywhere`
 *  never consults it. */
export type AreaTest = (area: AreaRef) => boolean;

// ── Laws ────────────────────────────────────────────────────────────────────

export type LawTier = "custom" | "law" | "absolute";

const TIER_RANK: Record<LawTier, number> = { custom: 0, law: 1, absolute: 2 };

export interface Law {
  /** Ordinal — law k of this session/world, forever (append-only). */
  ord: number;
  tier: LawTier;
  /** The forbidden verb (lexicon verb word — "fight"). */
  forbid: string;
  area: AreaRef;
  /** Who issued it — a creature id, or "world" for the spec's universal
   *  absolute ring (unrepealable, parental controls). */
  issuer: string;
}

/** Found the universal absolute ring from the world spec's culture. */
export function absoluteLaws(absolutes: Iterable<string>): Law[] {
  const out: Law[] = [];
  for (const verb of absolutes) {
    out.push({ ord: out.length, tier: "absolute", forbid: verb, area: { kind: "everywhere" }, issuer: "world" });
  }
  return out;
}

/** Append a law (assigns the next ordinal — the addZone pattern). */
export function addLaw(laws: Law[], law: Omit<Law, "ord">): Law {
  const ord = laws.reduce((m, l) => Math.max(m, l.ord + 1), 0);
  const row: Law = { ord, ...law };
  laws.push(row);
  return row;
}

/**
 * The law governing `verb` for an actor standing where `within` says —
 * or null when nothing forbids it. Resolution: highest TIER wins
 * (absolute > law > custom), then the most SPECIFIC area
 * (innermost-wins, §3a), then the LATEST ordinal (the zoning
 * later-wins law). Deterministic; no RNG.
 */
export function governingLaw(
  laws: readonly Law[],
  verb: string,
  within: AreaTest,
): Law | null {
  let best: Law | null = null;
  for (const l of laws) {
    if (l.forbid !== verb) continue;
    if (l.area.kind !== "everywhere" && !within(l.area)) continue;
    if (
      best === null ||
      TIER_RANK[l.tier] > TIER_RANK[best.tier] ||
      (TIER_RANK[l.tier] === TIER_RANK[best.tier] &&
        (AREA_RANK[l.area.kind] > AREA_RANK[best.area.kind] ||
          (AREA_RANK[l.area.kind] === AREA_RANK[best.area.kind] && l.ord > best.ord)))
    ) {
      best = l;
    }
  }
  return best;
}

/** True when an ABSOLUTE law forbids the verb here — the candidate-pruning
 *  predicate (selectGoal veto): an absolute is never weighed, argued with,
 *  or outranked. */
export function absolutelyForbidden(
  laws: readonly Law[],
  verb: string,
  within: AreaTest,
): boolean {
  return governingLaw(laws, verb, within)?.tier === "absolute";
}
