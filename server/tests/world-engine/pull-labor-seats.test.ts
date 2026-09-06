/**
 * ⚖️ PULL-MODEL LABOR (task #51, Stage 2) — SEATS, NOT CAPS.
 *
 * USER RULING (#50/#51): caps become SEATS. `BUILDERS_CAP = 3` was a number
 * somebody wrote down; a seat is a PLACE — a bay of the shell, the bench, the
 * tree — and a body that finds it taken takes the next link instead. So "how
 * many may work here" stops being an integer and becomes a question about the
 * work itself.
 *
 * The laws this file pins (rulings S1–S6, pull-labor-round.md):
 *
 *  S1 A SEAT IS A LEDGER CLAIM ON A SYNTHETIC ENDPOINT, never on a world
 *     object. `reserve(pull:<cid>, "<siteId>#seat<i>", "@tool", 1)`. A `@tool`
 *     unit on the BENCH OBJECT would be read by every `toolClaimed`/`freeUnits`
 *     consumer there is (`bagHolder`, `resolveMaterials` on the craft rotation)
 *     — the exact cross-talk that would move the dollhouse bench. Read and
 *     reserve are ONE synchronous step, because `reserve` cannot fail.
 *
 *  S2 K = THE BAYS NOT YET RAISED, never "all staged bays". Staging is
 *     all-or-nothing, so the literal reading would make a 9×8 cottage a 30-seat
 *     item forever; a bay that is BUILT is not a place to stand. The offered
 *     set is derived from `labor / buildDays` and tapers on its own.
 *
 *  S3 THE RATE CLAMP MOVES WITH K, ON THE PULL ARM ONLY. `laborRatePerS`'s
 *     clamp sits on BOTH arms, so retiring the cap without moving the clamp
 *     would make seats decorative. Off the capability `BUILDERS_CAP` /
 *     `REFINE_CREW_CAP` stand exactly as they did (they die in Stage 3).
 *
 *  S4 RELEASE ON EVERY DOOR, BY HOLDER, UNCONDITIONALLY — and a SWEEP, because
 *     a dwell seat has no agreement and `sweepPullSlices` keys on agreement
 *     ids: the press, the command, the eviction and the bag-fetch install all
 *     overwrite `session.pursuits` without ever calling `clear()`.
 *
 * SHAPE: S1/S2 ride the real ledger and the pure bay derivation — no session.
 * S3 rides ONE synthetic director harness (the bookkeeper suite's, verbatim in
 * shape). The decider laws ride a stub `ContributeDeps`. Only the RELEASE DOORS
 * need a host, and they share ONE frontier boot at the end.
 *
 * DB-free / GL-free — `npm run test:engine -- pull-labor-seats`.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bootTextQuest, type TextQuestRun } from "@shared/world-engine/headless/text-quest.js";
import {
  CONTRIBUTE_TPL_KEY,
  SEAT_CLAIM_GLYPH,
  claimSeat,
  heldSeats,
  isContributePursuit,
  pullHolder,
  pullLaborOn,
  raisedBays,
  releaseSeats,
  seatHeldBy,
  seatKey,
  seatTaken,
  type ContributeBill,
  type WorkSeat,
} from "@shared/world-engine/kernel/town/pull-labor.js";
import {
  TOOL_CLAIM_GLYPH,
  createReservationLedger,
  freeUnits,
  toolClaimed,
} from "@shared/world-engine/kernel/town/reservations.js";
import {
  BUILDERS_CAP,
  ORDER_PILE_EP,
  REFINE_CREW_CAP,
  benchSeatOf,
  createConstructionDirector,
  seatsOfRect,
  type ConstructionDirectorCtx,
} from "@shared/world-engine/interaction/quest/construction-director.js";
import {
  decideContribution,
  visibleBills,
  type ContributeDeps,
} from "@shared/world-engine/interaction/quest/contribute.js";
import { createTaskPool } from "@shared/world-engine/interaction/behavior/task-pool.js";
import { buildTownPlay } from "@shared/world-engine/interaction/town/town-play.js";
import { CLOCK_SCHEDULE_RATE } from "@shared/world-engine/npc-controller.js";
import { DOLLHOUSE_SCALE } from "@shared/world-engine/scale.js";
import { createTransferLedger } from "@shared/world-engine/kernel/town/transfer.js";
import { createReservationLedger as mkLedger } from "@shared/world-engine/kernel/town/reservations.js";
import { TOWN_YARD_EP, type ConstructionOrder, type FoundingCandidate } from "@shared/world-engine/kernel/town/construction.js";
import type { QuestSession } from "@shared/world-engine/interaction/quest/quest-host.js";
import type { ContainerRecord } from "@shared/world-engine/kernel/town/containers.js";
import type { BodyCarry } from "@shared/world-engine/kernel/town/scope-shape.js";

// ═══════════════════════════════════════════════════════════════════════════
// ① THE SEAM — the claim itself, on the real ledger
// ═══════════════════════════════════════════════════════════════════════════

describe("① a seat is a LEDGER CLAIM on a SYNTHETIC endpoint (S1)", () => {
  it("the key is `<siteId>#seat<i>` — one spelling, for every family", () => {
    expect(seatKey("o:3", 0)).toBe("o:3#seat0");
    expect(seatKey("o:3", 17)).toBe("o:3#seat17");
    // A mark's whole identity IS the thing, so its site id already carries it
    // and its one seat is index 0 (`fell:<featureId>#seat0`, the verdict's own
    // spelling).
    expect(seatKey("fell:wild:oak_3", 0)).toBe("fell:wild:oak_3#seat0");
    expect(seatKey("clear:wild:oak_3", 0)).toBe("clear:wild:oak_3#seat0");
  });

  it("🚨 the claim glyph IS the ledger's tool glyph — the seam spells it, so pin it", () => {
    // `kernel/town/pull-labor.ts` is IMPORT-FREE by law, so it cannot import
    // `TOOL_CLAIM_GLYPH` and writes the literal instead. Two definitions of one
    // string drift in silence; this is the only thing that stops them.
    expect(SEAT_CLAIM_GLYPH).toBe(TOOL_CLAIM_GLYPH);
  });

  it("claim → taken → release, by HOLDER (S4: one holder per body)", () => {
    const led = createReservationLedger();
    const k = seatKey("o:1", 0);
    expect(seatTaken(led, k)).toBe(false);
    expect(claimSeat(led, "mara", k)).toBe(true);
    expect(seatTaken(led, k)).toBe(true);
    expect(seatHeldBy(led, "mara", k)).toBe(true);
    expect(heldSeats(led, "mara")).toEqual([k]);
    releaseSeats(led, "mara");
    expect(seatTaken(led, k)).toBe(false);
    expect(heldSeats(led, "mara")).toEqual([]);
    // …and releasing a body that holds nothing is a no-op, which is what lets
    // every door call it unconditionally.
    expect(() => releaseSeats(led, "nobody")).not.toThrow();
  });

  it("🚨 ATOMIC — the second body to ask is told NO (`reserve` cannot fail)", () => {
    const led = createReservationLedger();
    const k = seatKey("o:1", 0);
    expect(claimSeat(led, "a", k)).toBe(true);
    expect(claimSeat(led, "b", k)).toBe(false);
    expect(heldSeats(led, "b")).toEqual([]);
    // …and exactly ONE unit stands on the endpoint however many asked.
    expect(led.reservedUnits(k, SEAT_CLAIM_GLYPH)).toBe(1);
  });

  it("…and IDEMPOTENT for its own holder — a re-issued dwell keeps its bay", () => {
    const led = createReservationLedger();
    const k = seatKey("o:1", 4);
    expect(claimSeat(led, "a", k)).toBe(true);
    expect(claimSeat(led, "a", k)).toBe(true);
    // One row, one unit — never a second bay held by the same body.
    expect(heldSeats(led, "a")).toEqual([k]);
    expect(led.reservedUnits(k, SEAT_CLAIM_GLYPH)).toBe(1);
  });

  it("🚨 A SEAT IS INVISIBLE TO THE GOODS NAMESPACE — the dollhouse-bench hazard", () => {
    // WHY THIS IS THE LOAD-BEARING PIN (S1). A `@tool` unit on the BENCH OBJECT
    // would be read by `toolClaimed` (bagHolder) and by `freeUnits`
    // (`resolveMaterials`, which the craft rotation runs on the very spot a
    // refine seat sits on). A `#seat` endpoint is read by nothing else.
    const led = createReservationLedger();
    const bench = "furn_0_bench";
    const stack = { wood: 10 };
    claimSeat(led, "mara", seatKey(`o:7`, 0));
    claimSeat(led, "tal", seatKey(bench, 0)); // even a seat NAMED after an object
    expect(toolClaimed(led, bench)).toBe(false);
    expect(freeUnits(stack, led, bench, "wood")).toBe(10);
    expect(led.reservedUnits(bench, "wood")).toBe(0);
  });

  it("raisedBays is `floor(f × n)`, clamped — and an unfinished row ALWAYS leaves one", () => {
    expect(raisedBays(0, 30)).toBe(0);
    expect(raisedBays(0.5, 30)).toBe(15);
    expect(raisedBays(1, 30)).toBe(30);
    expect(raisedBays(-3, 30)).toBe(0);
    expect(raisedBays(9, 30)).toBe(30);
    expect(raisedBays(0.5, 0)).toBe(0);
    // ⚖️ THE SITE CAN NEVER STARVE ITSELF OF THE HANDS THAT FINISH IT: an
    // unfinished row has `labor < buildDays`, so `f < 1` and `floor(f × n)`
    // is at most `n - 1`. Swept across the whole range rather than asserted.
    for (const n of [1, 6, 30, 121]) {
      for (let i = 1; i < 1000; i++) {
        const f = 1 - i / 1000;
        expect(raisedBays(f, n)).toBeLessThanOrEqual(n - 1);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ② THE BAYS — pure geometry, observation-blind (S2)
// ═══════════════════════════════════════════════════════════════════════════

/** The frontier cottage's own plot (`block-bill.ts`'s worked example: a 9×8
 *  shell is 3×3 floor + 12 wall + 3×3 roof = 30 bays / 120 blocks). */
const COTTAGE = { x: 0, y: 0, w: 9, h: 8 };

describe("② K = the staged bays NOT YET RAISED (S2)", () => {
  it("a fresh 9×8 shell offers all 30 bays, in build order, keyed by index", () => {
    const seats = seatsOfRect("o:1", COTTAGE, 0);
    expect(seats).toHaveLength(30);
    expect(seats.map((s) => s.index)).toEqual([...Array(30).keys()]);
    expect(seats[0]!.key).toBe("o:1#seat0");
    expect(seats[29]!.key).toBe("o:1#seat29");
    expect(seats.every((s) => s.siteId === "o:1" && s.link === "build")).toBe(true);
    // Every seat is a real point INSIDE (or on the edge of) the site rect, so a
    // body standing on one is inside `BUILD_WORK_EDGE_R` of the rect by
    // construction — the presence sweep needs no new geometry.
    for (const s of seats) {
      expect(s.at.x).toBeGreaterThanOrEqual(COTTAGE.x);
      expect(s.at.x).toBeLessThanOrEqual(COTTAGE.x + COTTAGE.w);
      expect(s.at.y).toBeGreaterThanOrEqual(COTTAGE.y);
      expect(s.at.y).toBeLessThanOrEqual(COTTAGE.y + COTTAGE.h);
    }
  });

  it("🚨 A RAISED BAY IS NOT OFFERED — the taper, and it needs no schedule", () => {
    // Half the labour banked ⇒ half the bays are up, and the offered set starts
    // at index 15. Many hands on the first courses, one on the ridge.
    const half = seatsOfRect("o:1", COTTAGE, 0.5);
    expect(half).toHaveLength(15);
    expect(half[0]!.index).toBe(15);
    expect(half[0]!.key).toBe("o:1#seat15");
    const nearly = seatsOfRect("o:1", COTTAGE, 0.99);
    expect(nearly).toHaveLength(1);
    expect(nearly[0]!.index).toBe(29);
    // The INDEX is stable across the taper — a body that claimed 20 finds the
    // same key at 20 while it is still offered (never a re-numbered list).
    expect(seatsOfRect("o:1", COTTAGE, 0.5).find((s) => s.index === 20)!.key).toBe(
      seatsOfRect("o:1", COTTAGE, 0).find((s) => s.index === 20)!.key,
    );
  });

  it("an INTERIOR cut offers only its partition's bays — the ghost options are read, not guessed", () => {
    const whole = seatsOfRect("o:9", COTTAGE, 0);
    const partition = seatsOfRect("o:9", COTTAGE, 0, { wallsOnly: true, onlyWall: ["north"] });
    expect(partition.length).toBeLessThan(whole.length);
    expect(partition).toHaveLength(3); // three bays across a 9 m run
    // An outward annex skips the wall it shares with its host.
    expect(seatsOfRect("o:9", COTTAGE, 0, { skipWall: ["north"] })).toHaveLength(27);
  });

  it("a BENCH is ONE seat — and a second bench row is a SECOND seat", () => {
    const a = benchSeatOf("o:4", { x: 12, y: 3 });
    expect(a).toHaveLength(1);
    expect(a[0]!.key).toBe("o:4#seat0");
    expect(a[0]!.link).toBe("refine");
    expect(a[0]!.at).toEqual({ x: 12, y: 3 });
    // Two refine rows are two bills, so they are two seats — which is the whole
    // of what `REFINE_SEATS = 1` used to mean, said about the WORK.
    const b = benchSeatOf("o:5", { x: 40, y: 3 });
    expect(b[0]!.key).not.toBe(a[0]!.key);
    const led = createReservationLedger();
    expect(claimSeat(led, "mara", a[0]!.key)).toBe(true);
    expect(claimSeat(led, "tal", a[0]!.key)).toBe(false); // one bench, one miller
    expect(claimSeat(led, "tal", b[0]!.key)).toBe(true); // …the other bench is free
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ③ THE BOOKS — K reaches the rate clamp, and ONLY under the capability (S3)
//
// One synthetic director, the bookkeeper suite's harness in shape: one town,
// one plot, and a `wilderness` switch that IS the pull capability.
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = { seed: 5, days: 30, questCount: 0, key: "smalltown", startPop: 20 };
const LOT: FoundingCandidate = { type: "house", slot: 3, dx: 10, dy: -20, w: 9, h: 8, door: "south" };
/** Long enough that the row stays in its labour phase for every sweep below. */
const BUILD_DAYS = 100;

function harness(opts: { pull: boolean; observed: boolean }) {
  const play = buildTownPlay(CONFIG);
  const siteAt = {
    x: play.stage.center.x + LOT.dx + LOT.w / 2,
    y: play.stage.center.y + LOT.dy + LOT.h / 2,
  };
  const yard: Record<string, number> = { block: 40 };
  const piles = new Map<string, Record<string, number>>();
  const session = {
    town: play,
    wilderness: opts.pull ? ({ features: [] } as unknown) : null,
    foundedSite: null,
    townClock: 0,
    taskClock: 0,
    scale: DOLLHOUSE_SCALE,
    containerRecords: new Map<string, ContainerRecord>([
      [TOWN_YARD_EP, { stock: yard, relation: "in", owner: null } as unknown as ContainerRecord],
    ]),
    wornBagIndex: new Map<string, string>(),
    marketStore: new Map<string, unknown>(),
    produceBox: new Map<string, unknown>(),
    houseShown: new Set<number>(),
    transfers: play.deltas.transfers,
    reservations: play.deltas.reservations,
    taskPool: createTaskPool(),
    buildTaskOrds: new Map<string, number>(),
    npcTasks: new Map<string, unknown[]>(),
    needPoseShow: new Map<string, unknown>(),
    pursuits: new Map<string, { tplKey?: string; bill?: ContributeBill }>(),
  } as unknown as QuestSession;
  const stackOf = (id: string): Record<string, number> => {
    const row = play.deltas
      .orders()
      .find((o) => o.ord === Number(id.slice(ORDER_PILE_EP.length))) as
      | { pile?: Record<string, number> }
      | undefined;
    if (row) return (row.pile ??= {});
    let s = piles.get(id);
    if (!s) piles.set(id, (s = {}));
    return s;
  };
  const ctx = {
    presenter: { toast: () => {} },
    familyOf: () => null,
    avatarIdOf: (cid: string) => cid,
    buildingUnits: () => 0,
    npcChatBubble: () => {},
    spawnLooseProp: () => null,
    removeLooseProp: () => {},
    postPooledTask: () => {},
    stockEndpointOf: (_s: QuestSession, id: string) =>
      id === TOWN_YARD_EP
        ? { id, kind: "yard", at: { x: siteAt.x + 30, y: siteAt.y }, stack: yard, owner: null }
        : id.startsWith(ORDER_PILE_EP)
          ? { id, kind: "site", at: siteAt, stack: stackOf(id), owner: null }
          : null,
    containerAnchor: () => null,
    houseContainerKeys: () => [],
    // The OBSERVED switch: the arm that banks from bodies, or the clock arm.
    playerWorldPos: () => (opts.observed ? siteAt : { x: 1e6, y: 1e6 }),
    playerFocusArea: () => null,
    townShortage: () => 0,
    invalidateTownJobs: () => {},
    bumpStockEpoch: () => {},
    questViewOf: () => null,
    spiritFocusOf: () => null,
    convoNodeId: () => null,
    issueTransferHaul: () => {},
    handIsFree: () => true,
    // FOUR FREE HANDS — one more than the old cap, which is the whole point.
    townHandPool: () => ({ total: 4, free: 4 }),
    bodyCarryOf: () => ({ hands: null, bags: [] }),
  } as unknown as ConstructionDirectorCtx;
  const director = createConstructionDirector(ctx);
  const avatars: Record<string, { x: number; y: number; fx: number; fy: number }> = {};
  director.setWorld({
    state: { avatars, objects: {}, spec: { objects: [] } },
    npcRadiusOf: () => 0.3,
    npcErrandActive: () => false,
    removeObject: () => {},
    setDragZones: () => {},
  } as never);
  /** Stage the plot with NO material bill, so it enters its labour phase on the
   *  first sweep and every number below is about LABOUR and nothing else. */
  play.deltas.foundBuilding(LOT, 0, BUILD_DAYS, {});
  /** THE ROW'S OWN ORDINAL — a built town already keeps a book, so the plot is
   *  never `o:1` by assumption. Read it, never guess it. */
  const ord = play.deltas
    .orders()
    .filter((o) => o.kind === "found" && o.dx === LOT.dx && o.dy === LOT.dy)
    .map((o) => o.ord)
    .at(-1)!;
  const siteId = `o:${ord}`;
  const sweep = (seconds: number) => {
    for (let i = 0; i < seconds; i++) {
      session.taskClock += 1;
      session.townClock += 1;
      director.stepFoundedConstruction(session, 1);
    }
  };
  /** Put `n` bodies on the site, each holding a build contribute pursuit. */
  const staff = (n: number) => {
    for (let i = 0; i < n; i++) {
      const cid = `resident_0_${i}`;
      avatars[cid] = { x: siteAt.x, y: siteAt.y, fx: 1, fy: 0 };
      session.pursuits.set(cid, {
        source: "need",
        tplKey: CONTRIBUTE_TPL_KEY,
        goal: { kind: "buildwork", site: siteId },
        glyph: "build",
        bill: { siteId, link: "build", spoken: false, issuer: "player" },
      });
    }
  };
  const row = (): ConstructionOrder => play.deltas.orders().find((o) => o.ord === ord)!;
  return { play, session, director, siteAt, sweep, staff, row, avatars, siteId };
}

const DAY = DOLLHOUSE_SCALE.dayLengthS;

describe("③ the rate clamp moves with K — on the PULL arm only (S3)", () => {
  it("the director's own seat read answers the shell's bays for a staged row", () => {
    const h = harness({ pull: true, observed: true });
    h.sweep(1); // gather → stage → labour, one tick (the row has no bill)
    const seats = h.director.seatsOf(h.session, h.siteId);
    expect(seats).toHaveLength(30);
    expect(seats[0]!.key).toBe(`${h.siteId}#seat0`);
    // 🚨 AND IT IS NOT OBSERVATION-GATED. `computeGhosts` skips an unobserved
    // rect entirely, so a seat read through `buildGhostsNow` would answer ZERO
    // whenever the camera looks away — exactly when the clock arm has to agree
    // with the embodied count.
    const dark = harness({ pull: true, observed: false });
    dark.sweep(1);
    expect(dark.director.seatsOf(dark.session, dark.siteId)).toHaveLength(30);
    expect(dark.director.buildGhostsNow(dark.session)).toEqual([]);
  });

  it("🚨 FOUR BODIES BANK FOUR BUILDERS — the cap of three is gone", () => {
    const h = harness({ pull: true, observed: true });
    h.sweep(1);
    h.staff(4);
    const before = h.row().labor ?? 0;
    h.sweep(1);
    const banked = (h.row().labor ?? 0) - before;
    // `laborRatePerS(min(K, present))` with K = 30 and present = 4.
    expect(banked).toBeCloseTo(4 / DAY, 9);
    // …and under the shipped clamp it would have been three.
    expect(banked).toBeGreaterThan(BUILDERS_CAP / DAY);
  });

  it("…and K STILL BOUNDS IT — six bodies on a two-bay row bank two", () => {
    // The clamp did not vanish, it MOVED: `min(K, present)` with K from the
    // work. A row whose bays are nearly all raised takes one pair of hands,
    // however many stand there, which is the taper stated as arithmetic.
    const h = harness({ pull: true, observed: true });
    h.sweep(1);
    const r = h.row() as { labor?: number };
    r.labor = BUILD_DAYS * 0.95; // ⌊0.95 × 30⌋ = 28 bays up ⇒ 2 seats left
    h.play.deltas.version++; // …the bump `bankLabor` makes, which moves the seat memo
    expect(h.director.seatsOf(h.session, h.siteId)).toHaveLength(2);
    h.staff(6);
    const before = r.labor;
    h.sweep(1);
    expect((r.labor ?? 0) - before).toBeCloseTo(2 / DAY, 9);
  });

  it("🚫 FALSIFICATION — off the capability the CLOCK ARM still clamps at BUILDERS_CAP", () => {
    // The clock arm is the honest A/B: it runs on both paths with the same
    // four-hand pool, so the ONLY thing that differs is the cap the books hand
    // `allocateHands` and `laborRatePerS`.
    const on = harness({ pull: true, observed: false });
    on.sweep(1);
    const off = harness({ pull: false, observed: false });
    off.sweep(1);
    // A row with no material bill stages AND banks in the same sweep (the order
    // loop's own two-pass-in-one-tick shape), so one sweep is one bank:
    // `elapsedS × CLOCK_SCHEDULE_RATE × crew / DAY`.
    expect(off.row().labor).toBeCloseTo((CLOCK_SCHEDULE_RATE * BUILDERS_CAP) / DAY, 9);
    expect(on.row().labor).toBeCloseTo((CLOCK_SCHEDULE_RATE * 4) / DAY, 9);
    // The pool is FOUR and the seats are thirty, so the pull arm spends every
    // hand the town has; the push arm still refuses the fourth.
    expect(on.row().labor! / off.row().labor!).toBeCloseTo(4 / 3, 9);
  });

  it("🚫 …and REFINE_CREW_CAP is untouched off the capability", () => {
    // Both constants are Stage 3's to retire. This suite only pins that they
    // are still the answer when the capability is off — which is what holds
    // `town-labor-pool`, `scope-shape` and `civic-labor-locality` still.
    expect(BUILDERS_CAP).toBe(3);
    expect(REFINE_CREW_CAP).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ④ THE DECIDER — a body claims the lowest free index, atomically
// ═══════════════════════════════════════════════════════════════════════════

const SITE_AT = { x: 100, y: 0 };
const SITE_RECT = { x: 96, y: -4, w: 9, h: 8 };
const CRATE = "furn_0_crate";
const CRATE_AT = { x: 90, y: 0 };

interface Fixture {
  session: QuestSession;
  deps: ContributeDeps;
  at: Map<string, { x: number; y: number }>;
  orders: ConstructionOrder[];
  /** The rect the fixture's seats derive from — shrink it to bound K. */
  rect: { x: number; y: number; w: number; h: number };
  laborFraction: { f: number };
  worked: Array<{ cid: string; at: { x: number; y: number } }>;
}

function makeFixture(rect = SITE_RECT): Fixture {
  const orders: ConstructionOrder[] = [
    {
      kind: "found",
      ord: 1,
      type: "house",
      slot: 0,
      dx: 100,
      dy: 0,
      w: rect.w,
      h: rect.h,
      door: "south",
      startedDay: 0,
      buildDays: 4,
      laborStartDay: 1,
      costs: { block: 130 },
      pile: { block: 120 },
    } as ConstructionOrder,
  ];
  const crateStock: Record<string, number> = { block: 40 };
  const at = new Map<string, { x: number; y: number }>();
  const worked: Fixture["worked"] = [];
  const laborFraction = { f: 0 };
  const session = {
    town: {} as unknown,
    wilderness: {} as unknown,
    foundedSite: null,
    scale: DOLLHOUSE_SCALE,
    taskClock: 100,
    transfers: createTransferLedger(),
    reservations: mkLedger(),
    pursuits: new Map(),
    walk: new Map(),
    liveNeedBodies: new Set<string>(),
    npcTasks: new Map(),
    lastDrive: new Map(),
  } as unknown as QuestSession;
  const bare = (): BodyCarry => ({ inHand: null, worn: null });
  const deps: ContributeDeps = {
    deltasOf: () => ({ orders: () => orders }),
    scopeCtxOf: () => ({ townId: () => "town" }),
    scopeOfPoint: () => null,
    orderPileIds: (o) => ({ pileId: `orderpile:${o.ord}` }),
    endpointAt: (_s, id) => (id === "orderpile:1" ? SITE_AT : id === CRATE ? CRATE_AT : null),
    pileWordOf: () => "house",
    bodyAt: (_s, cid) => at.get(cid) ?? null,
    carryOf: () => bare(),
    bagCeilingOf: () => 0,
    orderSiteId: (ord) => `o:${ord}`,
    buildworkSiteAt: (_s, siteId) => (siteId === "o:1" ? SITE_AT : null),
    // THE SEAT SOURCE — the REAL derivation, not a hand-written list, so a
    // change to the bay arithmetic moves these pins with it.
    seatsOf: (_s, siteId) => (siteId === "o:1" ? seatsOfRect(siteId, rect, laborFraction.f) : []),
    siteMaterialSources: () => [{ id: CRATE, stack: crateStock, d: 10 }],
    freeHeadStockWithinReach: (s, _a, head) => freeUnits(crateStock, s.reservations, CRATE, head),
    agrHolder: (id) => `agr:${id}`,
    billIssuer: () => "player",
    drawSourceShelf: () => {},
    issueTransferHaul: () => {},
    standAndWork: (_s, cid, spot) => void worked.push({ cid, at: spot }),
    chopAt: () => {},
    announce: () => {},
    motiveWeight: () => 1,
    forgoneS: () => 0,
  };
  return { session, deps, at, orders, rect, laborFraction, worked };
}

/** Every seat key spoken for on this fixture's ledger, by holder. */
const seatsHeld = (f: Fixture, cids: string[]): Array<[string, string[]]> =>
  cids.map((c) => [c, heldSeats(f.session.reservations, c)] as [string, string[]]);

describe("④ the decider claims the LOWEST FREE INDEX, atomically", () => {
  it("🚨 MORE THAN THREE BODIES BUILD ONE HOUSE — the measured point of the round", () => {
    const f = makeFixture();
    const cids = ["r0", "r1", "r2", "r3", "r4", "r5"];
    for (const cid of cids) f.at.set(cid, SITE_AT);
    for (const cid of cids) {
      expect(decideContribution(f.session, cid, f.deps, { beatS: -Infinity })).toBe(true);
    }
    const links = cids.map((c) => f.session.pursuits.get(c)!.bill!.link);
    expect(links).toEqual(["build", "build", "build", "build", "build", "build"]);
    // …and each of them stands on its OWN bay, lowest index first.
    expect(cids.map((c) => f.session.pursuits.get(c)!.bill!.seatKey)).toEqual([
      "o:1#seat0", "o:1#seat1", "o:1#seat2", "o:1#seat3", "o:1#seat4", "o:1#seat5",
    ]);
  });

  it("…and the body STANDS AT ITS BAY, not at the site anchor", () => {
    const f = makeFixture();
    f.at.set("r0", SITE_AT);
    f.at.set("r1", SITE_AT);
    decideContribution(f.session, "r0", f.deps, { beatS: -Infinity });
    decideContribution(f.session, "r1", f.deps, { beatS: -Infinity });
    const bays = seatsOfRect("o:1", f.rect, 0);
    expect(f.worked).toEqual([
      { cid: "r0", at: bays[0]!.at },
      { cid: "r1", at: bays[1]!.at },
    ]);
    expect(f.worked[0]!.at).not.toEqual(f.worked[1]!.at);
  });

  it("🚨 NO TWO BODIES ON ONE SEAT KEY — however many decide in one sweep", () => {
    // A 1×1 shell is 6 bays (1 floor + 4 wall + 1 roof), so the seats run out
    // and the surplus bodies must find something else to do.
    const f = makeFixture({ x: 96, y: -4, w: 1, h: 1 });
    const cids = ["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7"];
    for (const cid of cids) f.at.set(cid, SITE_AT);
    for (const cid of cids) decideContribution(f.session, cid, f.deps, { beatS: -Infinity });
    const claimed = cids
      .map((c) => f.session.pursuits.get(c)?.bill?.seatKey)
      .filter((k): k is string => k !== undefined);
    expect(claimed).toHaveLength(6);
    expect(new Set(claimed).size).toBe(6); // distinct — the whole assertion
    for (const k of claimed) expect(f.session.reservations.reservedUnits(k, SEAT_CLAIM_GLYPH)).toBe(1);
    // The seventh and eighth took the material link instead — "the seat is
    // taken, take the next link", which is what the old integer stood in for.
    expect(f.session.pursuits.get("r6")!.bill!.link).toBe("haul");
    expect(f.session.pursuits.get("r7")!.bill!.link).toBe("haul");
    expect(seatsHeld(f, ["r6", "r7"])).toEqual([["r6", []], ["r7", []]]);
  });

  it("a RAISED bay is never offered — the body claims into the live set", () => {
    const f = makeFixture();
    f.laborFraction.f = 0.5; // 15 of 30 bays up
    f.at.set("r0", SITE_AT);
    expect(decideContribution(f.session, "r0", f.deps, { beatS: -Infinity })).toBe(true);
    expect(f.session.pursuits.get("r0")!.bill!.seatKey).toBe("o:1#seat15");
  });

  it("a seat somebody ELSE holds is not offered — the reader filters on the ledger", () => {
    const f = makeFixture();
    // A peer (or this body's own past life) already stands on bay 0.
    claimSeat(f.session.reservations, "stranger", seatKey("o:1", 0));
    f.at.set("r0", SITE_AT);
    const build = visibleBills(f.session, "r0", f.deps).find((l) => l.link === "build")!;
    expect(build.seats!.map((s) => s.index)[0]).toBe(1);
    expect(build.seats!.some((s) => s.index === 0)).toBe(false);
    decideContribution(f.session, "r0", f.deps, { beatS: -Infinity });
    expect(f.session.pursuits.get("r0")!.bill!.seatKey).toBe("o:1#seat1");
  });

  it("EVERY seat taken ⇒ the dwell link is skipped, not failed", () => {
    const f = makeFixture({ x: 96, y: -4, w: 1, h: 1 });
    for (let i = 0; i < 6; i++) claimSeat(f.session.reservations, `ghost${i}`, seatKey("o:1", i));
    f.at.set("r0", SITE_AT);
    const links = visibleBills(f.session, "r0", f.deps);
    expect(links.find((l) => l.link === "build")!.seats).toEqual([]);
    expect(decideContribution(f.session, "r0", f.deps, { beatS: -Infinity })).toBe(true);
    expect(f.session.pursuits.get("r0")!.bill!.link).toBe("haul");
  });

  it("🚫 A HAUL CARRIES NO SEAT — its bound is the reservation (S1, unchanged)", () => {
    const f = makeFixture();
    f.at.set("r0", SITE_AT);
    const haul = visibleBills(f.session, "r0", f.deps).find((l) => l.link === "haul")!;
    expect(haul.seats).toBeUndefined();
    // A haul slice therefore books nothing under `pull:<cid>` — the units ride
    // the agreement's own holder, exactly as they did at Stage 1.
    f.laborFraction.f = 1; // no build seats at all ⇒ the haul is the only link
    expect(decideContribution(f.session, "r0", f.deps, { beatS: -Infinity })).toBe(true);
    expect(f.session.pursuits.get("r0")!.bill!.link).toBe("haul");
    expect(heldSeats(f.session.reservations, "r0")).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑤ THE RELEASE DOORS (S4) — ONE frontier boot, the shipped document.
//
// 🚨 WHY A SWEEP AND NOT JUST `clear()`. `sweepPullSlices` keys on AGREEMENT
// ids and a dwell seat has none, so the press, the spoken order, the eviction
// and the bag-fetch install — every one of which overwrites `session.pursuits`
// WITHOUT calling `clear()` — would strand a `pull:` ledger row forever. Stage 1
// survived those doors because `seatedOn` re-derived occupancy from the pursuit
// map; a ledger row does not re-derive.
// ═══════════════════════════════════════════════════════════════════════════

const doc = JSON.parse(
  readFileSync(join(process.cwd(), "scripts", "worlds", "frontier.spec.json"), "utf8"),
) as Record<string, unknown>;

/** A cid with no body and no history — the shape a RELOADED ledger row has. */
const ORPHAN = "resident_8_8";
/** …and one for the dead-site door (also bodiless, so the retirement test is
 *  about the SITE and not about somebody's errand). */
const STALE = "resident_9_9";
const DEAD_SITE = "o:404";

describe("⑤ every release door drops the holder (S4)", () => {
  let run: TextQuestRun;
  let orphanAfterFirstSweep: readonly unknown[] = [];

  beforeAll(() => {
    run = bootTextQuest({ world: doc, seed: 11, dt: 0.5 });
    // ⚖️ THE RELOAD SHAPE, injected BEFORE the first frame: the ledger came
    // back with a `pull:` row on it and the host's closure set came back EMPTY
    // (it is session-lived and never serialized). The first sweep must seed
    // itself from the ledger and reconcile.
    run.session.reservations.reserve(pullHolder(ORPHAN), seatKey("o:77", 0), SEAT_CLAIM_GLYPH, 1);
    run.advance(1);
    orphanAfterFirstSweep = heldSeats(run.session.reservations, ORPHAN);
    run.advance(9);
  }, 600_000);

  afterAll(() => run?.dispose());

  it("the capability is ON for this world (the premise every pin below stands on)", () => {
    expect(pullLaborOn(run.session)).toBe(true);
  }, 600_000);

  it("🔁 RELOAD — a persisted seat row nobody is standing on is reconciled on the FIRST sweep", () => {
    expect(orphanAfterFirstSweep).toEqual([]);
  }, 600_000);

  it("DOOR ① `clear()` — the work ends, the seat goes with the pursuit", () => {
    const s = run.session;
    const k = seatKey(DEAD_SITE, 0);
    s.reservations.reserve(pullHolder(STALE), k, SEAT_CLAIM_GLYPH, 1);
    s.pursuits.set(STALE, {
      source: "need",
      tplKey: CONTRIBUTE_TPL_KEY,
      goal: { kind: "buildwork", site: DEAD_SITE },
      glyph: "build",
      bill: { siteId: DEAD_SITE, link: "build", seatKey: k, spoken: false, issuer: "player" },
    } as never);
    // `contributeStillWorking` asks `buildworkSiteAt`, which answers null for a
    // row that does not exist — "the work is done, or the row is gone".
    run.advance(2);
    expect(s.pursuits.has(STALE)).toBe(false);
    expect(heldSeats(s.reservations, STALE)).toEqual([]);
    // ⚠️ THE ACT-CAP DROP (`mayAct`) IS THE SAME DOOR: it calls `clear()`
    // (quest-host, the give-up guard), so it is covered by this line and not by
    // a second fixture that would only re-test the same statement.
  }, 600_000);

  it("DOOR ⑤ a PURSUIT OVERWRITE is swept — the door that calls no `clear()`", () => {
    const s = run.session;
    run.speak("build + house");
    let cid: string | null = null;
    for (let i = 0; i < 1200 && !cid; i++) {
      run.stepFrame();
      cid = seatedBody(s);
    }
    if (!cid) {
      // Say so rather than pass vacuously — a seat that is never taken in ten
      // sim-minutes is a decider or fixture fact, not a green door.
      throw new Error("no body took a SEAT in 600 sim-s — decider or fixture, not a pass");
    }
    const key = s.pursuits.get(cid)!.bill!.seatKey!;
    expect(seatHeldBy(s.reservations, cid, key)).toBe(true);
    // ⏩ …and a seated body REFUSES A WARP while it stands there (the pursuit
    // is what refuses; the seat needs no clause of its own).
    const warp = run.warpDays(1);
    expect(warp.ok).toBe(false);
    expect(warp.blocked).toBeGreaterThan(0);
    expect(warp.note).toContain("warp refused");
    expect([...s.pursuits.keys()]).toContain(cid);

    // THE OVERWRITE: a spoken command takes the body. Nothing calls `clear()`
    // on the contribute pursuit — this is precisely the door that leaked.
    s.pursuits.set(cid, { source: "command", goal: { kind: "goTo", place: { kind: "home" } }, glyph: "go" } as never);
    run.advance(4);
    expect(heldSeats(s.reservations, cid)).toEqual([]);
    expect(s.reservations.reservedUnits(key, SEAT_CLAIM_GLYPH)).toBe(0);
  }, 600_000);

  it("🚨 NO TWO BODIES EVER HOLD ONE SEAT KEY — swept over the live ledger", () => {
    const s = run.session;
    run.advance(120);
    const seen = new Map<string, string>();
    for (const r of s.reservations.toJSON().rows) {
      if (r.glyph !== SEAT_CLAIM_GLYPH) continue;
      expect(r.qty).toBe(1);
      expect(seen.has(r.endpoint)).toBe(false);
      seen.set(r.endpoint, r.holder);
    }
    // …and every live seat belongs to a body whose pursuit names it.
    for (const [key, holder] of seen) {
      const cid = holder.slice("pull:".length);
      const p = s.pursuits.get(cid);
      expect(isContributePursuit(p) && p.bill.seatKey === key).toBe(true);
    }
  }, 600_000);
});

/** The first body standing on a seat, if any. */
function seatedBody(s: QuestSession): string | null {
  for (const [cid, p] of s.pursuits) {
    if (isContributePursuit(p) && p.bill.seatKey) return cid;
  }
  return null;
}
