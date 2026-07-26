// INTERIOR SUBDIVISION (construction pipeline ⑤b), at the pure layer — an
// empty SHELL building grows its first rooms by guillotine cuts of its own
// open floor (the annexOptions law turned inward), and a demolished base
// room rises AGAIN in its exact old place (the union host re-splits along
// the old partition). Candidates that reach the caller are buildable by
// construction: every existing doorway survives (on the remainder, or
// transferred whole to the new room), the street door stays with the root,
// and the remainder keeps a real floor. No DOM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  createTownDeltas,
  demolishCheck,
  demolishRoom,
  demolishedRects,
  interiorOptions,
  isInteriorCandidate,
  pendingRoomKindOf,
  requestInterior,
  stagingMissing,
  workDeltaKey,
} from "@shared/world-engine/kernel/town/construction.js";
import { buildingRoomPlan, houseRoomPlan } from "@shared/world-engine/kernel/town/rooms.js";
import { putStock } from "@shared/world-engine/kernel/town/transfer.js";

const CENTER = { x: 0, y: 0 };
/** The empty shell: a 10×9 doored box, street door south (an open plan —
 *  program {} is the shell's interior). */
const SHELL = { dx: 0, dy: 0, w: 10, h: 9, door: "south" as const, bare: true };
const SHELL_INDEX = 7;
const SHELL_KEY = "f_0"; // a founded work keys its delta by founding ordinal
const shellShape = { ...SHELL, index: 100000 + SHELL_INDEX };
const shellPlan = (deltas?: ReturnType<typeof createTownDeltas>) =>
  buildingRoomPlan(CENTER, SHELL_INDEX, SHELL, {}, deltas?.get(SHELL_KEY));

describe("subdividing an empty shell (⑤b)", () => {
  it("the open root offers guillotine cuts — far band first, street door kept", () => {
    const plan = shellPlan();
    expect(plan.rooms).toHaveLength(1); // born an empty box
    const cands = interiorOptions(CENTER, shellShape, plan, undefined, "bedroom", {
      keepRoot: false,
    });
    expect(cands.length).toBeGreaterThan(0);
    // Best-first: the far band (deepest from the street door).
    const far = cands[0]!;
    expect(far.hostId).toBe(`w_${SHELL_INDEX}`);
    expect(far.u0).toBeCloseTo(0);
    expect(far.u1).toBeCloseTo(10);
    expect(far.v1).toBeCloseTo(9);
    expect(far.v1 - far.v0).toBeGreaterThanOrEqual(3.1 - 1e-9); // sleep minD
    // NO near-band cut exists: a full-frontage band at the street side
    // would strand the street door on the new room.
    expect(
      cands.some(
        (c) =>
          Math.abs(c.u0) < 1e-6 && Math.abs(c.u1 - 10) < 1e-6 &&
          Math.abs(c.v0) < 1e-6 && c.v1 < 9 - 1e-6,
      ),
    ).toBe(false);
  });

  it("a committed cut materializes: root shrinks, the new room doors into it", () => {
    const deltas = createTownDeltas();
    const cand = interiorOptions(CENTER, shellShape, shellPlan(), undefined, "bedroom", {
      keepRoot: false,
    })[0]!;
    expect(requestInterior(deltas, SHELL_KEY, cand).ok).toBe(true);
    const plan = shellPlan(deltas);
    expect(plan.rooms).toHaveLength(2);
    // The root keeps its id AND its street door (the relaxed invariant).
    const root = plan.rooms[0]!;
    expect(root.id).toBe(`w_${SHELL_INDEX}`);
    expect(root.doorways.some((d) => d.edge === "south")).toBe(true);
    expect(root.rect.h).toBeCloseTo(9 - (cand.v1 - cand.v0));
    const room = plan.rooms.find((r) => r.id === `w_${SHELL_INDEX}_i0`)!;
    expect(room.kind).toBe("bedroom");
    expect(plan.bedrooms).toContain(room.id);
    // One shared door joins them — the new room sits one hop deep.
    expect(room.doorways).toHaveLength(1);
    expect(room.depth).toBe(1);
  });

  it("the shrunk root subdivides AGAIN; every room stays reachable", () => {
    const deltas = createTownDeltas();
    const first = interiorOptions(CENTER, shellShape, shellPlan(), undefined, "bedroom", {
      keepRoot: false,
    })[0]!;
    requestInterior(deltas, SHELL_KEY, first);
    const second = interiorOptions(
      CENTER, shellShape, shellPlan(deltas), deltas.get(SHELL_KEY), "store",
      { keepRoot: false },
    )[0]!;
    expect(requestInterior(deltas, SHELL_KEY, second).ok).toBe(true);
    const plan = shellPlan(deltas);
    expect(plan.rooms).toHaveLength(3);
    expect(plan.rooms[0]!.doorways.some((d) => d.edge === "south")).toBe(true);
    for (const r of plan.rooms) {
      expect(Number.isFinite(r.depth)).toBe(true);
      if (r !== plan.rooms[0]) expect(r.depth).toBeGreaterThan(0);
    }
  });

  it("interior rooms ride the serialization round-trip byte-identically", () => {
    const deltas = createTownDeltas();
    const cand = interiorOptions(CENTER, shellShape, shellPlan(), undefined, "kitchen", {
      keepRoot: false,
    })[0]!;
    requestInterior(deltas, SHELL_KEY, cand);
    const before = shellPlan(deltas);
    const back = createTownDeltas(deltas.toJSON());
    const after = buildingRoomPlan(CENTER, SHELL_INDEX, SHELL, {}, back.get(SHELL_KEY));
    expect(JSON.stringify(after.rooms)).toBe(JSON.stringify(before.rooms));
  });

  it("interior demolition is ORDER-GUARDED: only the newest cut of a host may go", () => {
    const deltas = createTownDeltas();
    const first = interiorOptions(CENTER, shellShape, shellPlan(), undefined, "bedroom", {
      keepRoot: false,
    })[0]!;
    requestInterior(deltas, SHELL_KEY, first);
    const second = interiorOptions(
      CENTER, shellShape, shellPlan(deltas), deltas.get(SHELL_KEY), "store",
      { keepRoot: false },
    )[0]!;
    requestInterior(deltas, SHELL_KEY, second);
    const plan = shellPlan(deltas);
    // i0 shares the root host with the LATER i1 — its removal would move
    // the ground i1 replays against; refused.
    expect(demolishCheck(deltas, SHELL_KEY, plan, `w_${SHELL_INDEX}_i0`).ok).toBe(false);
    // i1 is the newest — the partition comes down, the floor re-absorbs.
    const res = demolishRoom(deltas, SHELL_KEY, plan, `w_${SHELL_INDEX}_i1`);
    expect(res.ok).toBe(true);
    expect(shellPlan(deltas).rooms).toHaveLength(2);
  });

  it("a host a pending cut targets is excluded; caps and floors refuse honestly", () => {
    const plan = shellPlan();
    expect(
      interiorOptions(CENTER, shellShape, plan, undefined, "bedroom", {
        keepRoot: false,
        excludeHosts: new Set([`w_${SHELL_INDEX}`]),
      }),
    ).toHaveLength(0);
    // keepRoot (the house law) locks a one-room plan entirely.
    expect(
      interiorOptions(CENTER, shellShape, plan, undefined, "bedroom", { keepRoot: true }),
    ).toHaveLength(0);
  });
});

describe("re-creation in place (⑤b — demolished rooms rise where they stood)", () => {
  const HOUSE = { index: 0, dx: -5, dy: -4, w: 10, h: 8, door: "south" as const };
  const KEY = "h_0";

  it("the demolished bath's exact rect leads the candidates and re-materializes", () => {
    const deltas = createTownDeltas();
    const basePlan = houseRoomPlan(CENTER, HOUSE);
    const bath = basePlan.rooms.find((r) => r.id === "h_0_rb")!;
    expect(demolishRoom(deltas, KEY, basePlan, "h_0_rb").ok).toBe(true);
    const merged = houseRoomPlan(CENTER, HOUSE, deltas.get(KEY));
    expect(merged.bathId).toBeNull();
    const preferred = demolishedRects(CENTER, HOUSE, basePlan, deltas.get(KEY), "bath");
    expect(preferred).toHaveLength(1);
    const cand = interiorOptions(CENTER, HOUSE, merged, deltas.get(KEY), "bath", {
      keepRoot: true,
      preferred,
    })[0]!;
    expect(cand).toBeDefined();
    expect(cand.hostId).toBe("h_0_r1"); // the union host re-splits
    expect(requestInterior(deltas, KEY, cand).ok).toBe(true);
    const plan = houseRoomPlan(CENTER, HOUSE, deltas.get(KEY));
    const reborn = plan.rooms.find((r) => r.id === "h_0_i0")!;
    expect(reborn.kind).toBe("bath");
    // The room stands EXACTLY where the old one stood.
    expect(reborn.rect.x).toBeCloseTo(bath.rect.x);
    expect(reborn.rect.y).toBeCloseTo(bath.rect.y);
    expect(reborn.rect.w).toBeCloseTo(bath.rect.w);
    expect(reborn.rect.h).toBeCloseTo(bath.rect.h);
    expect(plan.bathId).toBe("h_0_i0");
    // The LIVING-ROOM INVARIANT held throughout (houseRoomPlan asserts) —
    // and every room still reaches the street.
    for (const r of plan.rooms) expect(Number.isFinite(r.depth)).toBe(true);
  });
});

describe("pending interior designations (the ⑤ staging shape, inward)", () => {
  it("posts, gathers into its pile, and commits via requestInterior", () => {
    const deltas = createTownDeltas();
    const cand = interiorOptions(CENTER, shellShape, shellPlan(), undefined, "bedroom", {
      keepRoot: false,
    })[0]!;
    const p = deltas.postAnnexSite({
      buildingKey: SHELL_KEY,
      candidate: cand,
      costs: { wood: 2 },
      pile: {},
      startedDay: 0,
      buildDays: 0.125,
    });
    expect(isInteriorCandidate(p.candidate)).toBe(true);
    expect(pendingRoomKindOf(p)).toBe("bedroom");
    expect(stagingMissing(p)).toEqual({ wood: 2 });
    putStock({ stack: p.pile }, { "wood.wet": 2 }); // facted pays its head
    expect(stagingMissing(p)).toEqual({});
    deltas.stageAnnexSite(p.ord, 1);
    expect(p.laborStartDay).toBe(1);
    expect(requestInterior(deltas, p.buildingKey, cand).ok).toBe(true);
    deltas.removeAnnexSite(p.ord);
    expect(deltas.annexSites()).toHaveLength(0);
    expect(deltas.get(SHELL_KEY)!.interior).toHaveLength(1);
  });

  it("workDeltaKey: founded rows key by immortal ordinal, base rows by index", () => {
    expect(workDeltaKey({ foundedOrd: 4 }, 12)).toBe("f_4");
    expect(workDeltaKey({}, 12)).toBe("w_12");
  });
});
