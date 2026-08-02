// BUILD EXECUTOR LIFECYCLE (city-expansion ①b), at the pure layer — the
// exact pieces quest-host wires: a spoken "build house" compiles to the
// build GoalSpec → an UNTARGETED order posts to the ①a task pool → build
// CAPABILITY is catalog + costs + lot (never compileGoal, which returns
// null for build by design) → a deterministic claim → the intent
// announcement names the structure → the commit spends stock and writes the
// founded delta → progress runs on the construction clock (not the errand
// queue) → completion staffs the workplace through the roster with the
// spec's OWN jobs count. Plus the refusal shapes: unknown structure, and
// missing materials NAMED. No DOM / GL.

import { describe, it, expect } from "@jest/globals";
import { parseSentence } from "@shared/world-engine/interaction/intent/parse-intent.js";
import { compileIntent, defaultBinder } from "@shared/world-engine/interaction/intent/intent-compile.js";
import { compileGoal, type WorldResolver } from "@shared/world-engine/interaction/behavior/goal-selection.js";
import {
  chooseClaimant,
  createTaskPool,
  type TaskCandidate,
} from "@shared/world-engine/interaction/behavior/task-pool.js";
import { goalIntentLine, type IntentLineSyms } from "@shared/world-engine/interaction/dialogue/intent-lines.js";
import {
  createTownDeltas,
  foundedBuildingDone,
  foundingOptions,
} from "@shared/world-engine/kernel/town/construction.js";
import {
  costsMet,
  missingCosts,
  resolveStructure,
  spendCosts,
  structureCosts,
} from "@shared/world-engine/kernel/town/structures.js";
import { BLOCK_GLYPH } from "@shared/world-engine/products.js";
import { TOWN_PLAY_STRUCTURES } from "@shared/world-engine/interaction/town/town-play.js";
import { assignTownJobs } from "@shared/world-engine/kernel/town/roster.js";
import type { GoalSpec } from "@shared/world-engine/interaction/behavior/rules.js";

const SEED = 21;
const KEY = "millbrook";

const syms: IntentLineSyms = {
  item: (ref) => ("id" in ref ? ref.id : ref.match.kind ?? "thing"),
  place: () => "there",
  creature: (id) => id,
};

const nullResolver: WorldResolver = {
  positionOf: () => null,
  homeOf: () => null,
  place: () => null,
  resolveItem: () => null,
  itemPosition: () => null,
  stationFor: () => null,
};

describe("order → goal: the sentence compiles to the build GoalSpec", () => {
  it('"build house" compiles to { kind: "build", structure: "house" }', () => {
    const frame = parseSentence("build + house");
    const compiled = compileIntent(frame, defaultBinder({ player: "__player__" }), { id: "t1" });
    expect(compiled.kind).toBe("goal");
    if (compiled.kind !== "goal") return;
    expect(compiled.goal).toMatchObject({ kind: "build", structure: "house" });
  });
});

describe("the full pooled lifecycle: order → task → claim → announce → progress → complete → staffed", () => {
  it("runs end to end off REAL construction state", () => {
    const goal: GoalSpec = { kind: "build", structure: "house", cap: 1 };
    const deltas = createTownDeltas();
    // Phase 3: bills are BLOCKS. Phase 6: the bill is DERIVED from the
    // footprint, so the yard is stocked FROM the bill rather than from a
    // literal that quietly stops covering a house when the knobs move.
    const houseSpec = resolveStructure(TOWN_PLAY_STRUCTURES, goal.structure)!;
    deltas.stock["block.material_wood"] = structureCosts(houseSpec)[BLOCK_GLYPH]! + 2;

    // ── ORDER → TASK (untargeted → the ①a pool).
    const pool = createTaskPool();
    const task = pool.post({
      goal, issuer: "__player__",
      focus: { x: 0, y: 0, radius: 26 }, now: 0, sourceGlyph: "build + house",
    });

    // ── CAPABILITY is build-specific: compileGoal stays null BY DESIGN
    // (the ①a handoff — the check lives in the claimant loop, not there).
    expect(compileGoal(goal, "resident_0_1", nullResolver)).toBeNull();
    const spec = resolveStructure(TOWN_PLAY_STRUCTURES, goal.structure)!;
    expect(costsMet(spec, deltas.stock)).toBe(true);
    const candidates = foundingOptions({
      seed: SEED, key: KEY, footprint: spec.footprint, type: spec.type,
      occupied: [], claimedSlots: new Set(),
    });
    expect(candidates.length).toBeGreaterThan(0);

    // ── CLAIM: deterministic (nearest, ties by id) — a resident volunteers
    // for its town's construction (civic willingness).
    const claimants: TaskCandidate[] = [
      { id: "resident_0_1", pos: { x: 2, y: 0 }, capable: true, willing: true },
      { id: "resident_0_2", pos: { x: 8, y: 0 }, capable: true, willing: true },
    ];
    const winner = chooseClaimant(task, claimants)!;
    expect(winner).toBe("resident_0_1");
    expect(pool.claim(task.id, winner)).toBe(true);

    // ── ANNOUNCE: the intent line NAMES the structure ("I'll build the house").
    const line = goalIntentLine(goal, syms)!;
    expect(line.c).toContain("build");
    expect(line.c).toContain("house");

    // ── COMMIT: spend the stock, write the founded delta (a faceted block
    // pays the head bill — the phase-3 material convention).
    expect(spendCosts(spec, deltas.stock)).toBe(true);
    expect(deltas.stock["block.material_wood"]).toBe(2);
    const b = deltas.foundBuilding(candidates[0]!, 0, spec.buildDays);

    // ── PROGRESS off construction state — NOT the errand queue: the walk
    // ends long before the walls do, and the task stays claimed.
    expect(foundedBuildingDone(b, spec.buildDays / 2)).toBe(false);
    expect(pool.claimedBy(winner)?.id).toBe(task.id);

    // ── COMPLETE: the clock passes; the fact is written; the task retires.
    expect(foundedBuildingDone(b, spec.buildDays + 0.01)).toBe(true);
    deltas.completeFounding(b.ord);
    pool.complete(task.id);
    expect(pool.get(task.id)?.status).toBe("done");
    expect(pool.claimed()).toHaveLength(0);

    // ── STAFFED: the roster deals the completed workplace its OWN jobs
    // count (a farm's spec.jobs, not the flat STAFF_PER_WORK) — and a
    // scaffold (staff 0) hires nobody.
    const farm = resolveStructure(TOWN_PLAY_STRUCTURES, "farm")!;
    const houses = [
      { index: 0, door: { x: 0, y: 0 } },
      { index: 1, door: { x: 10, y: 0 } },
      { index: 2, door: { x: 20, y: 0 } },
    ];
    const jobs = assignTownJobs(
      houses,
      [{ door: { x: 5, y: 5 }, staff: farm.jobs }, { door: { x: 15, y: 5 }, staff: 0 }],
      1,
      SEED,
    );
    const flat = [...jobs.values()].flat();
    expect(flat.filter((j) => j.work === 0)).toHaveLength(farm.jobs);
    expect(flat.filter((j) => j.work === 1)).toHaveLength(0);
  });
});

describe("refusals — named, never generic", () => {
  it("an unknown structure resolves to null (the host names it in the can't)", () => {
    expect(resolveStructure(TOWN_PLAY_STRUCTURES, "palace")).toBeNull();
  });

  it("missing materials are NAMED with their shortfall ('we need more block')", () => {
    const spec = resolveStructure(TOWN_PLAY_STRUCTURES, "workshop")!;
    // A faceted block pays toward the head; the shortfall names the head.
    const missing = missingCosts(spec, { "block.material_wood": 1 });
    expect(missing.block).toBe(structureCosts(spec)[BLOCK_GLYPH]! - 1);
    // The refusal string the host builds from this names each glyph.
    const names = Object.entries(missing).map(([g, n]) => `${n} ${g}`).join(", ");
    expect(names).toMatch(/block/);
  });

  it("an infeasible site (no ground) refuses with an EMPTY enumeration, never a bad lot", () => {
    const spec = resolveStructure(TOWN_PLAY_STRUCTURES, "market")!;
    expect(
      foundingOptions({
        seed: SEED, key: KEY, footprint: spec.footprint, type: spec.type,
        occupied: [], claimedSlots: new Set(), bound: 5,
      }),
    ).toEqual([]);
  });
});

describe("point-steered ordering ('build + house + here') — near ranks the slot lattice", () => {
  const spec = resolveStructure(TOWN_PLAY_STRUCTURES, "house")!;
  const base = {
    seed: SEED, key: KEY, footprint: spec.footprint, type: spec.type,
    occupied: [], claimedSlots: new Set<number>(), max: 8,
  };
  const centerOf = (c: { dx: number; dy: number; w: number; h: number }) =>
    ({ x: c.dx + c.w / 2, y: c.dy + c.h / 2 });

  it("a near point at a far candidate's lot makes THAT lot rank first — point-steered, not point-exact", () => {
    const legacy = foundingOptions(base);
    expect(legacy.length).toBeGreaterThan(1);
    const target = legacy[legacy.length - 1]!;
    const steered = foundingOptions({ ...base, near: centerOf(target) });
    expect(steered[0]).toEqual(target);
    // Same feasible SET — steering permutes, never invents or drops lots.
    const key = (c: { slot: number }) => c.slot;
    expect([...steered].map(key).sort((a, b) => a - b)).toEqual(
      [...legacy].map(key).sort((a, b) => a - b),
    );
  });

  it("is deterministic — the same near point ranks the same list", () => {
    const target = foundingOptions(base)[1]!;
    const a = foundingOptions({ ...base, near: centerOf(target) });
    const b = foundingOptions({ ...base, near: centerOf(target) });
    expect(a).toEqual(b);
  });

  it("zoning still outranks distance: matching-zone ground beats nearer open ground", () => {
    const legacy = foundingOptions(base);
    const far = legacy[legacy.length - 1]!;
    const close = legacy[0]!;
    const fc = centerOf(far);
    const steered = foundingOptions({
      ...base,
      near: centerOf(close), // aim at the close open lot…
      zoning: (x, y) => (Math.hypot(x - fc.x, y - fc.y) < 2 ? "match" : "open"),
    });
    expect(steered[0]).toEqual(far); // …the zoned lot still wins the ranking
  });
});
