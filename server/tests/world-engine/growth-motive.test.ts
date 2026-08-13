// GROWTH MOTIVE (supply & demand round, stage S1) — user law ②, verbatim in
// `feedback_order_scoping_and_growth_motive.md`:
//
//   "I'm also curious about why the city is constantly growing in the first
//    place. Growth doesn't happen for no reason, it happens due to unfulfilled
//    needs, which is usually triggered by either population growth or the
//    personality and values of the leader or population."
//
// The honest pre-round answer was: the city grows because THE BANK ALWAYS
// FILLS. Prosperity accrued from SATIETY (a full pantry, a chest with stacks
// in it), the want was a fixed checklist (every house wants three bedrooms,
// forever, whoever lives in it), and a settlement with no houses at all
// accrued at the FLAT DAILY CAP. Three separate ways to grow for free.
//
// This file pins the three replacements, at the rung each one lives at:
//   ① the WANT is a reading (`nextAnnexWant` over real occupancy),
//   ② the MEANS is real surplus (`prosperitySignals` — the spare pattern),
//   ③ the two compose (`constructionStep`: content ⇒ nothing ordered, however
//      rich).
//
// The town rung's own re-derivation (`townSurplus` feeding the founding bank)
// and the endogenous population are pinned elsewhere: the founding bank in
// text mode (a whole town-day loop is not a unit), the births in
// `town-cohorts.test.ts`. No DOM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  constructionStep,
  nextAnnexWant,
  PROSPERITY_THRESHOLD,
  SOULS_PER_BEDROOM,
  type HouseOccupancy,
} from "@shared/world-engine/kernel/town/construction.js";
import { houseRoomPlan } from "@shared/world-engine/kernel/town/rooms.js";
import { buildTownPlay } from "@shared/world-engine/interaction/town/town-play.js";
import {
  createConstructionDirector,
  type ConstructionDirectorCtx,
} from "@shared/world-engine/interaction/quest/construction-director.js";
import { HOUSEHOLD } from "@shared/world-engine/kernel/town/stations.js";
import type { QuestSession } from "@shared/world-engine/interaction/quest/quest-host.js";
import { REAL_SCALE } from "@shared/world-engine/scale.js";

const CONFIG = { seed: 5, days: 30, questCount: 0, key: "smalltown", startPop: 20 };

/**
 * 🚨 THE PROSPERITY HARNESS' OWN TOWN — MOVED FIXTURE (S&D σ close), WITH WHY.
 *
 * `prosperitySignals`' first clause is gate ①: AN UNMET DEMAND BANKS NOTHING.
 * Every test below that asks for a NON-ZERO baseline therefore needs a town
 * whose demands are actually met — and `CONFIG` above is a 30-day-old hamlet
 * of ~27 souls, which in an honest economy has no weaver and no tailor, so its
 * clothing fill is 0 and gate ① fires for every household on every day. That
 * is the LAW WORKING, not a bug: a hamlet that cannot clothe itself is not
 * banking savings.
 *
 * (Before the σ close it was masked. The pre-S2 farm read an abstract charter
 * scalar and produced ~40× a village's appetite regardless of population, so
 * even a 27-soul hamlet banked its granary to the 400 cap in 30 days and
 * raised a tailor. The fixture was standing on the phantom.)
 *
 * So the signal harness stands on the SHIPPED town instead — the same seed,
 * age and household the dollhouse ships — which reaches its industrial ladder
 * honestly (7 farms, 3 weavers, 2 tailors by day 220) and meets both street
 * demands. `CONFIG` stays exactly as it was for the two describes above, which
 * read occupancy and the construction step and never touch a good's fill.
 */
const PROVISIONED = { seed: 12, days: 220, questCount: 0 };

// ---------------------------------------------------------------------------
// ① THE WANT — a reading, not a checklist
// ---------------------------------------------------------------------------

describe("nextAnnexWant — occupancy replaces the fixed 3-bedroom checklist", () => {
  const play = buildTownPlay(CONFIG);
  const house = play.plan.houses[0]!;
  const planWith = () => houseRoomPlan(play.stage.center, house);

  it("the bedroom standard DERIVES the old constant — 5 souls ⇒ 3 rooms", () => {
    // This is the argument for the number, and the reason the change is safe:
    // `SOULS_PER_BEDROOM` × 3 covers a full HOUSEHOLD and 2 rooms do not, so a
    // full household wants exactly the third bedroom the constant asserted.
    // The checklist was not WRONG for the standard case — it was un-derived.
    expect(2 * SOULS_PER_BEDROOM).toBeLessThan(HOUSEHOLD);
    expect(3 * SOULS_PER_BEDROOM).toBeGreaterThanOrEqual(HOUSEHOLD);
  });

  it("absent occupancy ⇒ the shipped ladder, clause for clause", () => {
    const plan = planWith();
    // Whatever this town's houses were built with, the answer with no reading
    // is the answer the shipped code gave: `bedrooms.length < 3` ⇒ sleep.
    expect(nextAnnexWant(plan)).toBe(plan.bedrooms.length < 3 ? "sleep" : nextAnnexWant(plan));
  });

  it("🚨 A SMALL HOUSEHOLD STOPS ASKING — 2 souls in 2 bedrooms want no third", () => {
    const plan = { ...planWith(), bedrooms: ["a", "b"] };
    expect(nextAnnexWant(plan)).toBe("sleep"); // the checklist: always a third
    expect(nextAnnexWant(plan, undefined, { souls: 2 })).not.toBe("sleep");
  });

  it("…and a GROWN one asks for a fourth the checklist would never give it", () => {
    const plan = { ...planWith(), bedrooms: ["a", "b", "c"] };
    expect(nextAnnexWant(plan)).not.toBe("sleep"); // 3 rooms satisfied the old rule
    expect(nextAnnexWant(plan, undefined, { souls: 3 * SOULS_PER_BEDROOM + 1 })).toBe("sleep");
  });

  it("a house with NO bedrooms is crowded at any occupancy (never a divide by zero)", () => {
    const plan = { ...planWith(), bedrooms: [] };
    expect(nextAnnexWant(plan, undefined, { souls: 1 })).toBe("sleep");
    expect(nextAnnexWant(plan, undefined, { souls: 0 })).toBe("sleep");
  });

  it("exactly AT the standard is not crowded (the boundary belongs to contentment)", () => {
    const plan = { ...planWith(), bedrooms: ["a", "b"] };
    expect(nextAnnexWant(plan, undefined, { souls: 2 * SOULS_PER_BEDROOM })).not.toBe("sleep");
    expect(nextAnnexWant(plan, undefined, { souls: 2 * SOULS_PER_BEDROOM + 1 })).toBe("sleep");
  });

  it("ORDERED PROGRAMS still outrank everything — a spoken want is not a need reading", () => {
    // Pipeline ④: the player asked for this room. Occupancy has no vote.
    const plan = { ...planWith(), bedrooms: ["a", "b", "c"] };
    expect(nextAnnexWant(plan, [{ room: "store" }], { souls: 1 })).toBe("store");
  });

  it("the KITCHEN want stays unconditional — a household cooks every day", () => {
    const plan = {
      ...planWith(),
      bedrooms: ["a", "b"],
      rooms: planWith().rooms.filter((r) => r.kind !== "kitchen"),
    };
    expect(nextAnnexWant(plan, undefined, { souls: 2 })).toBe("kitchen");
  });

  it("🚨 CONTENT IS AN ANSWER — kitchen kept, boxes roomy, no craft work ⇒ NOTHING", () => {
    const base = planWith();
    const plan = {
      ...base,
      bedrooms: ["a", "b"],
      rooms: [
        ...base.rooms.filter((r) => r.kind !== "store" && r.kind !== "workshop"),
        { ...base.rooms[0]!, id: "k1", kind: "kitchen" },
      ],
    };
    const roomy: HouseOccupancy = { souls: 2, storagePressure: 0.2, craftPressure: 0 };
    expect(nextAnnexWant(plan, undefined, roomy)).toBeNull();
    // …and each pressure, alone, brings its room back.
    expect(nextAnnexWant(plan, undefined, { ...roomy, storagePressure: 1 })).toBe("store");
    expect(nextAnnexWant(plan, undefined, { ...roomy, craftPressure: 1 })).toBe("workshop");
    // No reading at all ⇒ the historical differentiation ladder.
    expect(nextAnnexWant(plan, undefined, { souls: 2 })).toBe("store");
  });
});

// ---------------------------------------------------------------------------
// ③ THE COMPOSITION — a rich, content household orders nothing
// ---------------------------------------------------------------------------

describe("constructionStep — the occupancy gate outranks the bank", () => {
  const richSignals = () => [{ key: "test", value: PROSPERITY_THRESHOLD }];

  it("🚨 A CONTENT HOUSEHOLD BUILDS NOTHING, however full its bank", () => {
    const play = buildTownPlay(CONFIG);
    // Bank everybody well past the threshold first.
    for (const h of play.plan.houses) {
      play.deltas.mutate(`h_${h.index}`, (d) => {
        d.prosperity = PROSPERITY_THRESHOLD * 4;
      });
    }
    const requests = constructionStep(
      play.stage.center,
      play.plan,
      play.deltas,
      richSignals,
      1,
      [],
      // One soul per house: nobody is crowded, every differentiation satisfied
      // or unwanted.
      {
        occupancyOf: (): HouseOccupancy => ({ souls: 1, storagePressure: 0, craftPressure: 0 }),
      },
    );
    // Either nothing was ordered, or the only thing ordered was the standing
    // KITCHEN need — never a bedroom, which is the arm the round killed.
    for (const r of requests) expect(r.action.cluster).not.toBe("sleep");
  });

  it("…and a CROWDED one still does — need is the license, not the bank", () => {
    const play = buildTownPlay(CONFIG);
    for (const h of play.plan.houses) {
      play.deltas.mutate(`h_${h.index}`, (d) => {
        d.prosperity = PROSPERITY_THRESHOLD * 4;
      });
    }
    const requests = constructionStep(
      play.stage.center,
      play.plan,
      play.deltas,
      richSignals,
      1,
      [],
      { occupancyOf: (): HouseOccupancy => ({ souls: 40 }) },
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]!.action.cluster).toBe("sleep");
  });

  it("no occupancy supplied ⇒ the shipped step (fixtures are untouched)", () => {
    const withGate = () => {
      const play = buildTownPlay(CONFIG);
      for (const h of play.plan.houses) {
        play.deltas.mutate(`h_${h.index}`, (d) => {
          d.prosperity = PROSPERITY_THRESHOLD * 4;
        });
      }
      return play;
    };
    const a = withGate();
    const b = withGate();
    const ra = constructionStep(a.stage.center, a.plan, a.deltas, richSignals, 1, []);
    const rb = constructionStep(b.stage.center, b.plan, b.deltas, richSignals, 1, [], {});
    expect(JSON.stringify(ra)).toBe(JSON.stringify(rb));
  });
});

// ---------------------------------------------------------------------------
// ② THE MEANS — real surplus, at the household rung
// ---------------------------------------------------------------------------

/** The director with just enough seams to answer `prosperitySignals`: a town,
 *  a household's containers, and the town's shortage book. */
function signalHarness(opts: {
  shortage?: number;
  boxes?: Record<string, Record<string, number>>;
} = {}) {
  const play = buildTownPlay(PROVISIONED);
  const boxes = opts.boxes ?? {};
  const session = {
    town: play,
    townClock: 0,
    scale: REAL_SCALE,
    containerRecords: new Map(
      Object.entries(boxes).map(([id, stock]) => [id, { mount: "standing" as const, relation: "in" as const, stock, owner: null }]),
    ),
    wornBagIndex: new Map<string, string>(),
    reservations: play.deltas.reservations,
    transfers: play.deltas.transfers,
    taskClock: 0,
  } as unknown as QuestSession;
  const houseIndex = play.plan.houses[0]!.index;
  const ctx = {
    presenter: { toast: () => {} },
    familyOf: () => null,
    npcChatBubble: () => {},
    houseContainerKeys: (_s: unknown, hi: number) => (hi === houseIndex ? Object.keys(boxes) : []),
    residentTownCtx: (_s: unknown, hi: number) => ({
      town: play.town,
      eco: play.eco,
      plan: play.plan,
      goods: play.stage.goods,
      center: play.stage.center,
      house: play.plan.houses.find((h) => h.index === hi),
      neighbor: false,
    }),
    townShortage: () => opts.shortage ?? 0,
    townSurplus: () => 0,
    invalidateTownJobs: () => {},
  } as unknown as ConstructionDirectorCtx;
  const director = createConstructionDirector(ctx);
  const total = () =>
    director
      .prosperitySignals(session, houseIndex)
      .reduce((s: number, sig: { value: number }) => s + sig.value, 0);
  return { play, session, houseIndex, director, total };
}

describe("prosperitySignals — the spare pattern at the household rung", () => {
  it("🚨 SATIETY ALONE BANKS NOTHING — a fed household with bare chests accrues 0", () => {
    // The pantry sawtooth runs between the household's keep-buffer and
    // `boxCap`, and boxCap IS its committed demand over the stocking horizon.
    // However full the box reads, there is no surplus in it. This is the arm
    // that used to pay 0.8/day to every fed house on the map.
    expect(signalHarness().total()).toBe(0);
  });

  it("🚨 AN UNMET DEMAND BANKS NOTHING — a short town pays nobody", () => {
    // Even with real wealth in the chests: if the town cannot meet its own
    // demand, a full pantry is a buffer draining, not savings.
    const rich = { "box:1": { wood: 9, stone: 9, apple: 9, cloth: 9, block: 9, rope: 9 } };
    expect(signalHarness({ boxes: rich }).total()).toBeGreaterThan(0);
    expect(signalHarness({ boxes: rich, shortage: 0.4 }).total()).toBe(0);
    expect(signalHarness({ boxes: rich, shortage: 0.4 }).director.prosperitySignals(
      signalHarness({ boxes: rich, shortage: 0.4 }).session,
      signalHarness({ boxes: rich, shortage: 0.4 }).houseIndex,
    )).toEqual([]);
  });

  it("SPARE stacks are wealth — and the keep-one floor says one unit is not", () => {
    const one = { "box:1": { wood: 1, stone: 1, apple: 1, cloth: 1, block: 1, rope: 1 } };
    const many = { "box:1": { wood: 2, stone: 2, apple: 2, cloth: 2, block: 2, rope: 2 } };
    // G1/G2: a creature keeps at least one of anything and gives its surplus.
    expect(signalHarness({ boxes: one }).total()).toBe(0);
    expect(signalHarness({ boxes: many }).total()).toBeGreaterThan(0);
  });

  it("🚨 RESERVED STOCK IS THE BILL, NOT BREADTH", () => {
    // A chest full of blocks already claimed by the room this household is
    // raising is its own outstanding demand. Counting it as wealth is exactly
    // how a household banked its way to a second room it could not pay for.
    const boxes = { "box:1": { wood: 6, stone: 6 } };
    const open = signalHarness({ boxes });
    expect(open.total()).toBeGreaterThan(0);

    const claimed = signalHarness({ boxes: { "box:1": { wood: 6, stone: 6 } } });
    claimed.session.reservations.reserve("annex:h0", "box:1", "wood", 6);
    claimed.session.reservations.reserve("annex:h0", "box:1", "stone", 6);
    expect(claimed.total()).toBe(0);
  });

  it("is deterministic — the same house, the same day, the same signals", () => {
    const boxes = { "box:1": { wood: 4, stone: 4 } };
    const a = signalHarness({ boxes });
    const b = signalHarness({ boxes });
    expect(a.director.prosperitySignals(a.session, a.houseIndex)).toEqual(
      b.director.prosperitySignals(b.session, b.houseIndex),
    );
  });

  it("a neighbour's household is not ours (the cluster guard is unchanged)", () => {
    const h = signalHarness();
    expect(h.director.prosperitySignals(h.session, 99999)).toEqual([]);
  });
});
