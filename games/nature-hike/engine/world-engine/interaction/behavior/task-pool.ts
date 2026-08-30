// shared/world-engine/interaction/behavior/task-pool.ts
//
// UNTARGETED ORDERS → a TASK POOL (city-expansion phase ①a §2). An order
// spoken with NO target creature becomes a TASK: the compiled goal + WHO
// issued it + the issuer's FOCUS AREA at issue time. Any APPROPRIATE creature
// inside the focus area may pick it up — appropriateness is the existing
// willingness/capability machinery (a creature that CANNOT never claims; a
// WONT creature doesn't volunteer) — and a claimed task is FILLED: exactly one
// creature executes it, everyone else skips it. Tasks that nobody could take
// EXPIRE and surface back to the issuer ("no one can do that"), never rotting
// silently.
//
// MULTIPLAYER LAW (seed + clock + mutations): tasks and claims are an OWNED
// MUTATION LAYER, following the TownDeltas pattern (kernel/town/construction.ts)
// — plain serializable state (`toJSON`/`createTaskPool(json)`), consumed by
// pure functions. NO RNG anywhere: `chooseClaimant` is a pure function of
// (task, candidate set), so replaying the same clock over the same task set
// yields identical claims on every peer.
//
// ISSUER-AGNOSTIC by design (§4): `issuer` is a creature id exactly like a
// Rule's `author` — the player is one creature among many. Nothing in the
// pool special-cases a player-issued task; creature-issued orders route
// through the same rows later.

import type { CreatureId } from "@shared/world-engine/interaction/behavior/creatures.js";
import type { GoalSpec } from "@shared/world-engine/interaction/behavior/rules.js";
import { costTotalS, type VerbCost } from "@shared/world-engine/kernel/town/scope-shape.js";
import type { FoldCommitment, FoldScope } from "@shared/world-engine/kernel/town/fold.js";

/** The issuer's attention area at issue time — claims are scoped to it. */
export interface TaskFocus {
  x: number;
  y: number;
  radius: number;
}

export type PooledTaskStatus = "open" | "claimed" | "done" | "expired";

export interface PooledTask {
  id: string;
  goal: GoalSpec;
  /** WHO issued the order — a creature id (the player is one, never special). */
  issuer: CreatureId;
  focus: TaskFocus;
  /** Pool-clock seconds (the host's monotonic task clock). */
  createdAt: number;
  expiresAt: number;
  status: PooledTaskStatus;
  claimedBy?: CreatureId;
  /** The spoken sentence that posted it — for the "no one can do that" report. */
  sourceGlyph?: string;
  /** ⚖️ #45 — WHY THE TOWN WANTS THIS, when nobody spoke it: the stack HEAD
   *  a civic sweep posted this task to cover (par stock, an order pile's
   *  bill, a starved-pile release). The why-chain renders it as "because the
   *  town needs <head>" and SUPPRESSES the authority link — the issuer field
   *  still names a creature (reach + volunteer compliance read it), but an
   *  automatic stockpile must never answer "because you asked" (user report:
   *  the dollhouse opened with an errand blamed on a player who said
   *  nothing). Absent = a real order; authority answers as ever. */
  need?: string;
  /**
   * ⚖️ WHAT DOING THIS IS WORTH, in hand-seconds (economy arc batch 2, L1).
   *
   * The POSTER answers it, because it is a world question — how short the
   * storehouse is, how much of the bill is left — exactly as `forgoneOf`'s
   * division of labour has the caller resolve "what does this serve where it
   * lies" and carry the answer on the candidate (needs.ts). Absent = the
   * poster had no number in hand, and the claim falls back to geometry.
   */
  valueS?: number;
}

export interface SerializedTaskPool {
  serial: number;
  tasks: PooledTask[];
}

/** How long an unclaimed task stays open before it expires back to the issuer. */
export const DEFAULT_TASK_TTL_S = 45;

/** Compliance toward the ISSUER a creature needs to VOLUNTEER for a pooled
 *  task. Below it the creature "won't" — feasible, but it doesn't put its
 *  hand up. A household member under its guiding spirit (~0.68) volunteers;
 *  a neutral stranger (~0.06) doesn't — the same social law as rules
 *  ("suggestions, not law", relations.ts). */
export const VOLUNTEER_COMPLIANCE = 0.3;

export interface TaskPool {
  post(input: {
    goal: GoalSpec;
    issuer: CreatureId;
    focus: TaskFocus;
    now: number;
    ttlS?: number;
    sourceGlyph?: string;
    /** See {@link PooledTask.valueS} — omitted stays omitted. */
    valueS?: number;
    /** See {@link PooledTask.need} — omitted stays omitted. */
    need?: string;
  }): PooledTask;
  get(id: string): PooledTask | undefined;
  /** Open tasks in CREATION ORDER (the deterministic processing order). */
  open(): PooledTask[];
  /** Claimed (filled, still executing) tasks in creation order. */
  claimed(): PooledTask[];
  /** The task `cid` currently holds, if any (one task per body). */
  claimedBy(cid: CreatureId): PooledTask | undefined;
  /** open → claimed. False when the task is already filled/gone — the
   *  exactly-one guarantee for racing claimants. */
  claim(id: string, by: CreatureId): boolean;
  /** claimed → open again (the plan failed to issue) — someone else may take it. */
  release(id: string): void;
  /** claimed → done (the claimant's errand ran out). */
  complete(id: string): void;
  /** Expire OPEN tasks past their deadline; returns the newly expired ones
   *  (each surfaces back to the issuer exactly once). */
  expire(now: number): PooledTask[];
  /** The serializable mutation record (TownDeltas pattern). */
  toJSON(): SerializedTaskPool;
}

export function createTaskPool(json?: SerializedTaskPool): TaskPool {
  let serial = json?.serial ?? 0;
  const tasks: PooledTask[] = (json?.tasks ?? []).map(
    (t) => JSON.parse(JSON.stringify(t)) as PooledTask,
  );
  const byId = new Map<string, PooledTask>(tasks.map((t) => [t.id, t]));

  return {
    post(input) {
      const task: PooledTask = {
        id: `task_${serial++}`,
        goal: input.goal,
        issuer: input.issuer,
        focus: { ...input.focus },
        createdAt: input.now,
        expiresAt: input.now + (input.ttlS ?? DEFAULT_TASK_TTL_S),
        status: "open",
        ...(input.sourceGlyph !== undefined ? { sourceGlyph: input.sourceGlyph } : {}),
        ...(input.valueS !== undefined ? { valueS: input.valueS } : {}),
        ...(input.need !== undefined ? { need: input.need } : {}),
      };
      tasks.push(task);
      byId.set(task.id, task);
      return task;
    },
    get: (id) => byId.get(id),
    open: () => tasks.filter((t) => t.status === "open"),
    claimed: () => tasks.filter((t) => t.status === "claimed"),
    claimedBy: (cid) => tasks.find((t) => t.status === "claimed" && t.claimedBy === cid),
    claim(id, by) {
      const t = byId.get(id);
      if (!t || t.status !== "open") return false; // FILLED (or gone) — others skip it
      t.status = "claimed";
      t.claimedBy = by;
      return true;
    },
    release(id) {
      const t = byId.get(id);
      if (t?.status !== "claimed") return;
      t.status = "open";
      delete t.claimedBy;
    },
    complete(id) {
      const t = byId.get(id);
      if (t?.status === "claimed") t.status = "done";
    },
    expire(now) {
      const expired: PooledTask[] = [];
      for (const t of tasks) {
        if (t.status === "open" && now >= t.expiresAt) {
          t.status = "expired";
          expired.push(t);
        }
      }
      return expired;
    },
    toJSON: () => ({
      serial,
      tasks: tasks.map((t) => JSON.parse(JSON.stringify(t)) as PooledTask),
    }),
  };
}

// ── ⚖️ F-④ — THE HANDS BOOK AT THE FOLD (fold-round.md stage F4) ───────────

/**
 * ⚖️ F-④ GATHER — every IN-FLIGHT pooled task touching `scope`, as
 * `FoldCommitment`s. READ-ONLY (the pool is not touched); the fold turns
 * these into a REFUSAL, because a task books HANDS and hands are embodied
 * (scope-unification.md §BREAKS: *"a body's concurrency is anatomical"*) — a
 * claimed task is a body mid-errand, and no closed-form record can stand in
 * for it the way one stands in for a reserved number. v1 declines the fold
 * and names the tasks rather than pretend either way.
 *
 * IN FLIGHT = `open` or `claimed`: a claimed task is being executed right
 * now, and an OPEN one is a promise still owed to its issuer — it has not
 * expired, so folding the scope out from under it would drop it silently,
 * which is the same violation. `done`/`expired` rows are history and block
 * nothing. Order is open rows then claimed rows, each in creation order: the
 * pool exposes the two lists and no combined one, and grouping them puts the
 * unclaimed promises first in a capped blocker list, which is the more useful
 * half to read.
 *
 * TOUCHING = the scope IS the issuer (the order was spoken by it) or the
 * claimant (it is the body on the hook). `holder` is the claimant where one
 * exists, else the issuer — nobody has taken it, so the issuer still carries
 * it; `against` is always the issuer, who is owed the work.
 */
export function gatherTaskCommitments(pool: TaskPool, scope: FoldScope): FoldCommitment[] {
  const ids = new Set<string>([scope.id, ...scope.endpoints]);
  const out: FoldCommitment[] = [];
  for (const t of [...pool.open(), ...pool.claimed()]) {
    if (!ids.has(t.issuer) && !(t.claimedBy !== undefined && ids.has(t.claimedBy))) continue;
    out.push({
      book: "task",
      id: t.id,
      holder: t.claimedBy ?? t.issuer,
      against: t.issuer,
      payload: {
        status: t.status,
        ...(t.sourceGlyph !== undefined ? { sourceGlyph: t.sourceGlyph } : {}),
      },
    });
  }
  return out;
}

/** One creature's standing toward a task, as the WORLD evaluated it:
 *  `capable` = the goal compiled to an executable plan for this body
 *  (compileGoal — "cannot" never claims); `willing` = its compliance toward
 *  the ISSUER clears the volunteer bar ("wont" doesn't volunteer). */
export interface TaskCandidate {
  id: CreatureId;
  pos: { x: number; y: number };
  capable: boolean;
  willing: boolean;
  /**
   * ⚖️ WHAT THIS CLAIM WOULD COST THIS BODY (economy arc batch 2, L1) — the
   * plan's own legs and hands (`compileGoal(…).cost`, which the pool loop
   * used to compute and throw away) plus `forgoneS`: what the claim
   * DESTROYS. A body mid-shift is producing; a body mid-pursuit is serving a
   * drive; an idle body is doing neither and costs nothing.
   *
   * Absent = unpriced, exactly like an unpriced `NeedCtx`: the claim falls
   * back to geometry and the choice is byte-identical to the shipped rule.
   */
  cost?: VerbCost;
}

/** Is this candidate allowed to claim the task at all? */
export function eligibleForTask(task: PooledTask, c: TaskCandidate): boolean {
  if (!c.capable || !c.willing) return false;
  return Math.hypot(c.pos.x - task.focus.x, c.pos.y - task.focus.y) <= task.focus.radius;
}

/**
 * PURE, DETERMINISTIC claim resolution: among the eligible candidates, the
 * one whose claim is worth the most — `argmax(task.valueS − costTotalS(cost))`
 * — wins; NET ties fall back to the shipped rule, NEAREST the focus centre,
 * then the LEXICOGRAPHIC lower id. No RNG — the same (task, candidates)
 * always picks the same claimant, so multiplayer replay holds. Null when
 * nobody may take it.
 *
 * ⚖️ BYTE-IDENTICAL WHEN NOTHING IS PRICED (economy arc batch 2, L1). With no
 * `cost` on any candidate and no `valueS` on the task every net is 0, every
 * row ties, and the function reduces EXACTLY to "nearest, ties by id" — which
 * is why every distance and purity pin written before the price still holds
 * verbatim. Among candidates with EQUAL forgone the ordering is preserved too:
 * `journeyS` is monotone in distance, so cheapest is nearest.
 *
 * ⚠️ NO SIGN GATE. `netValueS`'s sign is the WORTHWHILE question and this is
 * the WHO question; a negative net still claims, because refusing here would
 * silently stop a posted task from ever being taken the moment anyone attached
 * a price to it. The gate belongs to the poster, with a pin of its own.
 *
 * ⚠️ `valueS` is the SAME for every candidate of one task, so it cancels out
 * of this argmax by construction. It rides the comparison anyway because the
 * decision grammar is `value − cost` at every rung, and the seat that will
 * rank COMPETING TASKS for one body needs the term already carried, not
 * retro-fitted.
 */
export function chooseClaimant(
  task: PooledTask,
  candidates: readonly TaskCandidate[],
): CreatureId | null {
  let best: TaskCandidate | null = null;
  let bestNet = -Infinity;
  let bestD = Infinity;
  for (const c of candidates) {
    if (!eligibleForTask(task, c)) continue;
    const d = Math.hypot(c.pos.x - task.focus.x, c.pos.y - task.focus.y);
    const net = (task.valueS ?? 0) - (c.cost ? costTotalS(c.cost) : 0);
    const better =
      net > bestNet ||
      (net === bestNet && (d < bestD || (d === bestD && best !== null && c.id < best.id)));
    if (better) {
      bestNet = net;
      bestD = d;
      best = c;
    }
  }
  return best?.id ?? null;
}
