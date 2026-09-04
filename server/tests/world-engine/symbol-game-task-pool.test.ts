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
import type { VerbCost } from "@shared/world-engine/kernel/town/scope-shape.js";

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

// ─────────────────────────────────────────────────────────────────────────
// THE PRICED CLAIM (economy arc batch 2, L1) — argmax(value − cost), with the
// shipped geometry as the tie rule. Pinned BOTH WAYS, the
// `need-costs-and-claims` discipline: every case is stated unpriced (what the
// shipped rule answers) and priced (what the arithmetic answers), so the
// reduction is a measurement rather than a claim.
// ─────────────────────────────────────────────────────────────────────────

const price = (over: Partial<VerbCost>): VerbCost => ({
  journeyS: 0,
  handsS: 0,
  spoilageS: 0,
  forgoneS: 0,
  ...over,
});

describe("chooseClaimant — the priced claim", () => {
  const task = (valueS?: number): PooledTask => ({
    id: "task_0",
    goal: FETCH_WOOD,
    issuer: "__player__",
    focus: FOCUS,
    createdAt: 0,
    expiresAt: 45,
    status: "open",
    ...(valueS !== undefined ? { valueS } : {}),
  });

  it("UNPRICED is byte-identical to the shipped rule — every net ties, geometry decides", () => {
    const t = task();
    // The same three assertions the distance pin above makes, restated here
    // as the kill-switch arm: with no cost on any candidate and no value on
    // the task, the argmax cannot separate anybody.
    expect(chooseClaimant(t, [cand("far", 8, 0), cand("near", 2, 0)])).toBe("near");
    expect(chooseClaimant(t, [cand("zeta", 3, 0), cand("alpha", 3, 0)])).toBe("alpha");
    // A task WITH a value and candidates without costs is still geometry: the
    // value is the same for every row of one task, so it cancels out.
    expect(chooseClaimant(task(500), [cand("far", 8, 0), cand("near", 2, 0)])).toBe("near");
  });

  it("🚨 THE POINT OF THE BATCH: an idle hand beats a nearer body that is mid-shift", () => {
    const t = task(400);
    const onShift = cand("a_farmhand", 1, 0, { cost: price({ journeyS: 2, forgoneS: 180 }) });
    const idle = cand("z_idler", 6, 0, { cost: price({ journeyS: 12 }) });
    expect(chooseClaimant(t, [onShift, idle])).toBe("z_idler");
    // …and the SAME pair unpriced elects the farmhand, by being nearer. That
    // difference IS the change; nothing else about the function moved.
    expect(chooseClaimant(task(), [cand("a_farmhand", 1, 0), cand("z_idler", 6, 0)])).toBe("a_farmhand");
  });

  it("a shift worker IS pulled when the claim's value clears the output it destroys", () => {
    // Same two bodies, same forgone — but the idle hand is now a long walk
    // away, and the walk costs more than the shift does.
    const t = task(400);
    const onShift = cand("a_farmhand", 1, 0, { cost: price({ journeyS: 2, forgoneS: 60 }) });
    const idle = cand("z_idler", 9, 0, { cost: price({ journeyS: 90 }) });
    expect(chooseClaimant(t, [onShift, idle])).toBe("a_farmhand");
  });

  it("EQUAL forgone ⇒ nearest still wins — journeyS is monotone in distance", () => {
    // The locality law survives the price: among candidates the world values
    // the same, the cheapest leg IS the shortest one.
    const t = task(100);
    const near = cand("near", 2, 0, { cost: price({ journeyS: 2, forgoneS: 40 }) });
    const far = cand("far", 8, 0, { cost: price({ journeyS: 8, forgoneS: 40 }) });
    expect(chooseClaimant(t, [far, near])).toBe("near");
  });

  it("NET ties fall through to distance, then to the lexicographic id", () => {
    const t = task(50);
    // Same net (−10), different distance ⇒ nearer wins.
    expect(
      chooseClaimant(t, [
        cand("far", 8, 0, { cost: price({ journeyS: 10 }) }),
        cand("near", 2, 0, { cost: price({ forgoneS: 10 }) }),
      ]),
    ).toBe("near");
    // Same net AND same distance ⇒ the shipped id rule.
    expect(
      chooseClaimant(t, [
        cand("zeta", 3, 0, { cost: price({ journeyS: 4 }) }),
        cand("alpha", 3, 0, { cost: price({ handsS: 4 }) }),
      ]),
    ).toBe("alpha");
  });

  it("NO SIGN GATE — a claim worth less than it costs is still claimed", () => {
    // Deliberate: `netValueS`'s sign is the WORTHWHILE question and this is
    // the WHO question. A gate here would silently stop every posted task the
    // moment anyone attached a price to it.
    const t = task(1);
    expect(chooseClaimant(t, [cand("only", 2, 0, { cost: price({ forgoneS: 9999 }) })])).toBe("only");
  });

  it("stays pure and eligibility still gates first — an out-of-area bargain never claims", () => {
    const t = task(100);
    const cs = [
      cand("outside", 30, 0, { cost: price({}) }),
      cand("inside", 5, 0, { cost: price({ forgoneS: 90 }) }),
    ];
    const first = chooseClaimant(t, cs);
    expect(first).toBe("inside");
    for (let i = 0; i < 20; i++) expect(chooseClaimant(t, cs)).toBe(first);
  });

  it("valueS rides the pool row and survives the round trip, absent stays absent", () => {
    const pool = createTaskPool();
    const priced = pool.post({ goal: FETCH_WOOD, issuer: "__player__", focus: FOCUS, now: 0, valueS: 42 });
    const bare = pool.post({ goal: FETCH_WOOD, issuer: "__player__", focus: FOCUS, now: 0 });
    expect(priced.valueS).toBe(42);
    expect("valueS" in bare).toBe(false);
    expect(createTaskPool(pool.toJSON()).toJSON()).toEqual(pool.toJSON());
  });
});

// ── #50 ④ — THE RULED PRIORITY ─────────────────────────────────────────────
//
// User ruling 2026-09-03: *"Player orders should take high priority and
// creatures should only idle if either their need for rest is high or there
// is nothing to do."* The claim sweep walks `open()` and fills each row from
// the bodies that are free, one task per body — so this list's ORDER is the
// order hands are handed out, and creation order alone put a spoken errand
// behind whatever ambient stocking row the town happened to post first.
describe("#50 ④ open() — spoken rows first, age within each group", () => {
  const post = (pool: ReturnType<typeof createTaskPool>, now: number, spoken?: boolean) =>
    pool.post({ goal: FETCH_WOOD, issuer: "__player__", focus: FOCUS, now, ...(spoken ? { spoken: true } : {}) });

  it("a SPOKEN task claims ahead of an OLDER ambient row", () => {
    const pool = createTaskPool();
    const ambient = post(pool, 0);
    const spoken = post(pool, 10, true);
    // The ambient row is older and was posted first; the ruling still puts the
    // one somebody asked for in front of it.
    expect(pool.open().map((t) => t.id)).toEqual([spoken.id, ambient.id]);
  });

  it("AGE still decides inside each group — the partition is stable", () => {
    const pool = createTaskPool();
    const a1 = post(pool, 0);
    const s1 = post(pool, 1, true);
    const a2 = post(pool, 2);
    const s2 = post(pool, 3, true);
    expect(pool.open().map((t) => t.id)).toEqual([s1.id, s2.id, a1.id, a2.id]);
  });

  it("BYTE-IDENTICAL when nothing is spoken — and when everything is", () => {
    // The two homogeneous cases are the shipped creation order verbatim, which
    // is what keeps every determinism/replay pin written before #50 true for an
    // ambient town (and for a session where the player drives everything).
    const ambientOnly = createTaskPool();
    const ids = [post(ambientOnly, 0).id, post(ambientOnly, 1).id, post(ambientOnly, 2).id];
    expect(ambientOnly.open().map((t) => t.id)).toEqual(ids);

    const spokenOnly = createTaskPool();
    const sids = [post(spokenOnly, 0, true).id, post(spokenOnly, 1, true).id];
    expect(spokenOnly.open().map((t) => t.id)).toEqual(sids);
  });

  it("priority is about HANDS, not status: a spoken row claims and expires like any other", () => {
    const pool = createTaskPool();
    const spoken = post(pool, 0, true);
    const ambient = post(pool, 0);
    expect(pool.claim(spoken.id, "wolf_1")).toBe(true);
    expect(pool.open().map((t) => t.id)).toEqual([ambient.id]); // claimed rows leave
    expect(pool.expire(DEFAULT_TASK_TTL_S).map((t) => t.id)).toEqual([ambient.id]);
  });

  it("`spoken` rides the row and the round trip; ABSENT stays absent", () => {
    const pool = createTaskPool();
    const s = post(pool, 0, true);
    const a = post(pool, 0);
    expect(s.spoken).toBe(true);
    expect("spoken" in a).toBe(false); // an ambient row serializes as it always did
    const revived = createTaskPool(pool.toJSON());
    expect(revived.get(s.id)?.spoken).toBe(true);
    expect("spoken" in (revived.get(a.id) as object)).toBe(false);
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
