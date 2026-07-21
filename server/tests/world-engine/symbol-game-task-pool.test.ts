// UNTARGETED ORDERS → TASK POOL (city-expansion phase ①a §2): the pure,
// serializable pool (behavior/task-pool.ts). Pins: create → open → claim
// (FILLED, exactly one) → done, release-on-failure, expiry surfacing back
// exactly once, deterministic claim choice (no RNG — nearest wins, ties by
// id), issuer-agnosticism (a creature issuer rides the same rows), and the
// TownDeltas-style toJSON round-trip. Pure logic — safe in `npm test`.

import { describe, it, expect } from "@jest/globals";
import {
  chooseClaimant,
  createTaskPool,
  DEFAULT_TASK_TTL_S,
  eligibleForTask,
  type PooledTask,
  type TaskCandidate,
} from "@shared/world-engine/interaction/behavior/task-pool.js";
import type { GoalSpec } from "@shared/world-engine/interaction/behavior/rules.js";

const FETCH_WOOD: GoalSpec = { kind: "fetch", item: { match: { kind: "wood" } } };
const FOCUS = { x: 0, y: 0, radius: 10 };

function cand(id: string, x: number, y: number, over?: Partial<TaskCandidate>): TaskCandidate {
  return { id, pos: { x, y }, capable: true, willing: true, ...over };
}

describe("task lifecycle — create → open → claim (filled) → done / expire", () => {
  it("posts an open task carrying goal + issuer + focus + the spoken sentence", () => {
    const pool = createTaskPool();
    const t = pool.post({
      goal: FETCH_WOOD,
      issuer: "__player__",
      focus: FOCUS,
      now: 5,
      sourceGlyph: "get + wood",
    });
    expect(t.status).toBe("open");
    expect(t.issuer).toBe("__player__");
    expect(t.expiresAt).toBe(5 + DEFAULT_TASK_TTL_S);
    expect(pool.open().map((x) => x.id)).toEqual([t.id]);
  });

  it("a claim FILLS the task — the second claimant is refused (exactly one executes)", () => {
    const pool = createTaskPool();
    const t = pool.post({ goal: FETCH_WOOD, issuer: "__player__", focus: FOCUS, now: 0 });
    expect(pool.claim(t.id, "wolf_1")).toBe(true);
    expect(pool.claim(t.id, "wolf_2")).toBe(false);
    expect(pool.get(t.id)).toMatchObject({ status: "claimed", claimedBy: "wolf_1" });
    expect(pool.open()).toHaveLength(0);
    expect(pool.claimedBy("wolf_1")?.id).toBe(t.id);
  });

  it("release (a plan that failed to issue) reopens the task for someone else", () => {
    const pool = createTaskPool();
    const t = pool.post({ goal: FETCH_WOOD, issuer: "__player__", focus: FOCUS, now: 0 });
    pool.claim(t.id, "wolf_1");
    pool.release(t.id);
    expect(pool.get(t.id)?.status).toBe("open");
    expect(pool.get(t.id)?.claimedBy).toBeUndefined();
    expect(pool.claim(t.id, "wolf_2")).toBe(true);
  });

  it("complete retires a claimed task", () => {
    const pool = createTaskPool();
    const t = pool.post({ goal: FETCH_WOOD, issuer: "__player__", focus: FOCUS, now: 0 });
    pool.claim(t.id, "wolf_1");
    pool.complete(t.id);
    expect(pool.get(t.id)?.status).toBe("done");
    expect(pool.claimedBy("wolf_1")).toBeUndefined();
  });

  it("expiry surfaces an unclaimed task back EXACTLY once; claimed tasks never expire", () => {
    const pool = createTaskPool();
    const stale = pool.post({ goal: FETCH_WOOD, issuer: "__player__", focus: FOCUS, now: 0, ttlS: 10 });
    const held = pool.post({ goal: FETCH_WOOD, issuer: "__player__", focus: FOCUS, now: 0, ttlS: 10 });
    pool.claim(held.id, "wolf_1");
    expect(pool.expire(9)).toHaveLength(0);
    const expired = pool.expire(10);
    expect(expired.map((t) => t.id)).toEqual([stale.id]); // the claimed one is safe
    expect(pool.expire(999)).toHaveLength(0); // reported once, never again
    expect(pool.get(stale.id)?.status).toBe("expired");
  });
});

describe("claim choice — deterministic, no RNG", () => {
  const task = (): PooledTask => ({
    id: "task_0",
    goal: FETCH_WOOD,
    issuer: "__player__",
    focus: FOCUS,
    createdAt: 0,
    expiresAt: 45,
    status: "open",
  });

  it("only capable + willing candidates INSIDE the focus area are eligible", () => {
    const t = task();
    expect(eligibleForTask(t, cand("a", 3, 4))).toBe(true); // dist 5 ≤ 10
    expect(eligibleForTask(t, cand("b", 30, 0))).toBe(false); // outside the area
    expect(eligibleForTask(t, cand("c", 0, 0, { capable: false }))).toBe(false); // "cannot" never claims
    expect(eligibleForTask(t, cand("d", 0, 0, { willing: false }))).toBe(false); // "wont" doesn't volunteer
  });

  it("the NEAREST eligible candidate wins; distance ties break to the lower id", () => {
    const t = task();
    expect(chooseClaimant(t, [cand("far", 8, 0), cand("near", 2, 0)])).toBe("near");
    expect(chooseClaimant(t, [cand("zeta", 3, 0), cand("alpha", 3, 0)])).toBe("alpha");
    expect(chooseClaimant(t, [cand("only", 30, 0)])).toBeNull(); // nobody in the area
  });

  it("is a pure function — the same inputs always pick the same claimant", () => {
    const t = task();
    const cs = [cand("b", 1, 1), cand("a", 1, 1), cand("c", 0, 5)];
    const first = chooseClaimant(t, cs);
    for (let i = 0; i < 50; i++) expect(chooseClaimant(t, cs)).toBe(first);
  });
});

describe("issuer-agnosticism + the mutation-layer contract", () => {
  it("a CREATURE issuer rides the same rows — nothing special-cases the player", () => {
    const pool = createTaskPool();
    const t = pool.post({ goal: FETCH_WOOD, issuer: "npc_bear", focus: FOCUS, now: 0 });
    expect(t.issuer).toBe("npc_bear");
    expect(pool.claim(t.id, "wolf_1")).toBe(true); // claimable exactly like a player task
  });

  it("toJSON round-trips the whole pool (TownDeltas pattern: serializable state)", () => {
    const pool = createTaskPool();
    const a = pool.post({ goal: FETCH_WOOD, issuer: "__player__", focus: FOCUS, now: 0, sourceGlyph: "get + wood" });
    pool.claim(a.id, "wolf_1");
    pool.post({ goal: FETCH_WOOD, issuer: "npc_bear", focus: FOCUS, now: 3 });
    const revived = createTaskPool(pool.toJSON());
    expect(revived.toJSON()).toEqual(pool.toJSON());
    expect(revived.claimedBy("wolf_1")?.id).toBe(a.id);
    // Serials continue — a revived pool never reuses ids.
    expect(revived.post({ goal: FETCH_WOOD, issuer: "x", focus: FOCUS, now: 4 }).id).toBe("task_2");
    // The snapshot is a copy, not a live alias.
    const snap = pool.toJSON();
    pool.complete(a.id);
    expect(snap.tasks.find((t) => t.id === a.id)?.status).toBe("claimed");
  });
});
