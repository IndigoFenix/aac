/**
 * 🪚 BLOCK CADENCE — THE MILL CUTS ONE BLOCK AT A TIME.
 *
 * User, 2026-09-06: *"Are blocks cut one at a time, or in groups? One at a time
 * would make more sense, but there would have to be a system to mitigate people
 * wasting time carrying one block at a time as they become available."*
 *
 * WHAT WAS WRONG. A refine row gathered its whole raw bill, laboured the whole
 * batch, and then MINTED THE WHOLE BATCH at retirement (`commitRefineOrder`).
 * For the 144 s of bench work behind a 12-block batch the world held twelve
 * blocks' worth of wood and not one block: nobody could carry what did not
 * exist, so every porter in reach idled through the window and then contended
 * for one pile the instant it appeared. A mill that shows nothing and then
 * drops twelve blocks is a batch REACTOR, not a bench.
 *
 * WHAT IT IS NOW. The mint follows the LABOUR, one unit at a time
 * (`mintRefineUnits` / `mintDueRefineUnits`): the raw for THIS block leaves the
 * pile and the block lands in the deposit in one step, every sweep the banked
 * labour has paid for another one. `REFINE_BATCH_UNITS` survives as what it
 * always described best — the GATHER/staging cadence, the slice of raw one row
 * stages at a time — and the second half of the user's sentence is answered by
 * machinery that already existed: the pull decider's WORTHWHILE GATE prices a
 * slice against the walk, and the carrier's own bag sizes it, so a lone block
 * at a far bench is not worth a trip and a growing pile becomes worth one.
 *
 * THE LAWS PINNED HERE:
 *
 *  ① ONE AT A TIME. The deposit passes through EVERY intermediate count on its
 *    way to the batch total — 0,1,2,…,12 — never 0 then 12.
 *  ② ITEM CONSERVATION, AT EVERY INSTANT. Raw off the pile and product into
 *    the deposit are one step, and Σ over the batch is exactly the posted bill:
 *    24 wood → 12 blocks, never 23 and never 25 — including at a ratio that
 *    does not divide evenly.
 *  ③ THE BILL SHRINKS WITH THE PILE. `billRowsOf` (contribute.ts) runs
 *    `stagingMissing` over EVERY order, laboring rows included. Draining the
 *    pile alone would make a working mill advertise a growing wood shortfall
 *    and pull porters to feed a row that needs nothing, so `costs` is
 *    decremented by exactly what was paid and `stagingMissing` stays empty.
 *  ④ `count` / `buildDays` / `labor` ARE NOT TOUCHED. The dwell link's
 *    `left / buildDays` urgency, the book's `open` sum and the retirement
 *    toast all keep their pre-patch meaning.
 *  ⑤ A PARTIAL BATCH NEVER MINTS MORE THAN ITS MATERIALS, and never retires on
 *    a pile that ran thin — the batch commit's own "regather" hold.
 *  ⑥ AN ABANDONED ROW'S BANKED UNITS STAY REAL. Blocks already cut are in the
 *    deposit; the raw not yet paid is still in the pile. Nothing evaporates.
 *
 * SHAPE: PURE. A synthetic session + the REAL director, driven through
 * `stepFoundedConstruction` — the `frontier-conservation.test.ts` harness
 * pattern, no quest-host value import, no DOM/GL, no DB.
 *
 * Run it with:  npm run test:engine -- cadence
 */
import { describe, it, expect } from "@jest/globals";
import {
  createConstructionDirector,
  REFINE_BATCH_UNITS,
  type ConstructionDirectorCtx,
} from "@shared/world-engine/interaction/quest/construction-director.js";
import { createTaskPool } from "@shared/world-engine/interaction/behavior/task-pool.js";
import { buildTownPlay } from "@shared/world-engine/interaction/town/town-play.js";
import {
  stagingMissing,
  TOWN_YARD_EP,
  type RefineOrder,
} from "@shared/world-engine/kernel/town/construction.js";
import { refinedGlyphOf } from "@shared/world-engine/products.js";
import { DOLLHOUSE_SCALE } from "@shared/world-engine/scale.js";
import type { QuestSession } from "@shared/world-engine/interaction/quest/quest-host.js";
import type { ContainerRecord } from "@shared/world-engine/kernel/town/containers.js";
import type { StockEndpoint } from "@shared/world-engine/kernel/town/transfer.js";

const CONFIG = { seed: 5, days: 30, questCount: 0, key: "smalltown", startPop: 20 };
const YARD_AT = { x: 0, y: 0 };
const MILL_AT = { x: 12, y: -3 };
const BLOCK = refinedGlyphOf("wood")!; // "block.material_wood"

/** A town with a stocked yard, nobody watching, and the real director on it.
 *  Unobserved is the point: the sweep banks labour through the CLOCK ARM
 *  (`clockArm`), which is the same rate function the watched crew uses. */
function harness() {
  const play = buildTownPlay(CONFIG);
  const toasts: string[] = [];
  const containerRecords = new Map<string, ContainerRecord>([
    [TOWN_YARD_EP, { stock: {} } as ContainerRecord],
  ]);
  const session = {
    town: play,
    townClock: 0,
    taskClock: 0,
    // The PLAY clock (240 s a day), so a batch's labour banks over a countable
    // number of one-second sweeps instead of a real day's worth of them.
    scale: DOLLHOUSE_SCALE,
    containerRecords,
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
    party: new Set<string>(),
    escorting: new Set<string>(),
    creatures: null,
    addressedFamily: null,
  } as unknown as QuestSession;
  const ctx = {
    presenter: {
      toast: (m: string) => {
        toasts.push(m);
      },
    },
    familyOf: () => null,
    avatarIdOf: (cid: string) => cid,
    buildingUnits: () => 0,
    npcChatBubble: () => {},
    gazeCreature: () => null,
    spawnLooseProp: () => null,
    removeLooseProp: () => {},
    postPooledTask: () => {},
    containerAnchor: (_s: QuestSession, id: string) => (id === TOWN_YARD_EP ? YARD_AT : null),
    houseContainerKeys: () => [],
    playerWorldPos: () => null, // NOBODY IS WATCHING — the clock arm drives
    playerFocusArea: () => null,
    townShortage: () => 0,
    invalidateTownJobs: () => {},
    questViewOf: () => null,
    spiritFocusOf: () => null,
    convoNodeId: () => null,
    issueTransferHaul: () => {},
    handIsFree: () => true,
    // ONE hand in the pool: `allocateHands` gives the single refine row its
    // `REFINE_CREW_CAP = 1`, so the bench works at exactly the shipped rate.
    townHandPool: () => ({ total: 1, free: 1 }),
    bumpStockEpoch: () => {},
    bodyCarryOf: () => ({ inHand: null, worn: null }),
    takeUnitsFromBody: () => 0,
    stockEndpointOf: (_s: QuestSession, id: string): StockEndpoint | null => {
      if (id.startsWith("orderpile:") || id.startsWith("sitepile:")) {
        const ord = Number(id.slice(id.indexOf(":") + 1));
        const row = play.deltas.orders().find((o) => o.ord === ord);
        if (!row || row.kind !== "refine") return null;
        return { id, kind: "site", at: row.at, stack: row.pile, owner: null };
      }
      const stock = containerRecords.get(id)?.stock;
      return stock ? { id, kind: "yard", at: YARD_AT, stack: stock, owner: null } : null;
    },
  } as unknown as ConstructionDirectorCtx;
  const director = createConstructionDirector(ctx);
  director.setWorld({
    state: { avatars: {}, objects: {}, spec: { objects: [] } },
    npcRadiusOf: () => 0.3,
    npcErrandActive: () => false,
    removeObject: () => {},
    setDragZones: () => {},
  } as never);
  /** Units of `glyph` anywhere the deposit could be — the yard record's stock or
   *  the deltas' own map. Which one `refineDepositId` picks is its business;
   *  what this file measures is that the units LANDED. */
  const shelved = (glyph: string) =>
    (containerRecords.get(TOWN_YARD_EP)?.stock?.[glyph] ?? 0) +
    ((play.deltas.stock as Record<string, number>)[glyph] ?? 0);
  // 🚨 A TOWN COMES WITH A LARDER (`townStockSeed`) — a fresh `buildTownPlay`
  // already holds blocks and wood. Every number below is a DELTA against that
  // seed, or the fixture's own furniture would read as the mill's output.
  const seedBlocks = shelved(BLOCK);
  const seedWood = shelved("wood");
  const banked = () => shelved(BLOCK) - seedBlocks;
  const spareWood = () => shelved("wood") - seedWood;
  const sweep = () => {
    session.taskClock += 1;
    director.stepFoundedConstruction(session, 1);
  };
  return { play, session, director, toasts, containerRecords, banked, spareWood, sweep };
}

/** A STAGED refine row: its raw is already in the pile and its labour clock is
 *  running, which is the rung the mint lives on. `count × inPerOut` wood, the
 *  shipped 2:1, unless a ratio is named. */
function stagedRefine(
  h: ReturnType<typeof harness>,
  count = REFINE_BATCH_UNITS,
  woodBill = count * 2,
  extraPile = 0,
): RefineOrder {
  const r = h.play.deltas.postRefineOrder({
    produces: BLOCK,
    count,
    costs: { wood: woodBill },
    pile: { wood: woodBill + extraPile },
    at: MILL_AT,
    startedDay: 0,
    // 12 units over 0.6 street-days is the shipped shape
    // (`REFINE_UNIT_BUILD_DAYS × count`), written out so the ratio this file
    // divides by is visible rather than scale-dependent.
    buildDays: 0.05 * count,
  });
  h.play.deltas.stageOrder(r.ord, 0);
  expect(r.laborStartDay).toBe(0);
  return r;
}

/** Sweep until the row retires (or the cap trips — a hang is a finding, not a
 *  timeout). Returns the deposit's value after every sweep. */
function millOut(h: ReturnType<typeof harness>, r: RefineOrder, cap = 4000): number[] {
  const trace: number[] = [];
  for (let i = 0; i < cap; i++) {
    h.sweep();
    trace.push(h.banked());
    if (!h.play.deltas.orders().some((o) => o.ord === r.ord)) return trace;
  }
  throw new Error(`the mill never retired in ${cap} sweeps — a hang, not a slow clock`);
}

describe("① the mint follows the labour — one block at a time", () => {
  it("walks the deposit through EVERY count on the way to the batch total", () => {
    const h = harness();
    const r = stagedRefine(h);
    const trace = millOut(h, r);

    // The DISTINCT values the deposit ever held, in order. One at a time means
    // this is 0,1,2,…,12 — the batch-commit shape would be [0, 12].
    const steps: number[] = [];
    for (const n of trace) if (steps[steps.length - 1] !== n) steps.push(n);
    expect(steps[0]).toBe(0); // labour banks before the first unit is paid for
    expect(steps).toEqual([...Array(REFINE_BATCH_UNITS + 1).keys()]);
    expect(h.banked()).toBe(REFINE_BATCH_UNITS);
  });

  it("mints the FIRST block long before the batch would have committed", () => {
    const h = harness();
    const r = stagedRefine(h);
    let first = -1;
    let last = -1;
    for (let i = 0; i < 4000; i++) {
      h.sweep();
      if (first < 0 && h.banked() > 0) first = i;
      if (!h.play.deltas.orders().some((o) => o.ord === r.ord)) {
        last = i;
        break;
      }
    }
    expect(first).toBeGreaterThanOrEqual(0);
    expect(last).toBeGreaterThan(first);
    // The 1/12th point, give or take one sweep of banking granularity — the
    // whole delta this round bought: a porter can start on block 1 after a
    // twelfth of the bench window instead of after all of it.
    expect(first + 1).toBeLessThanOrEqual(Math.ceil((last + 1) / REFINE_BATCH_UNITS) + 1);
  });

  it("retires with the batch total, and says so once", () => {
    const h = harness();
    const r = stagedRefine(h);
    millOut(h, r);
    expect(h.toasts.filter((t) => t.includes("milled and stored"))).toEqual([
      `🪚 ${REFINE_BATCH_UNITS} block milled and stored`,
    ]);
    expect(r.minted).toBe(REFINE_BATCH_UNITS);
  });
});

describe("② item conservation — 24 wood in, 12 blocks out, at every instant", () => {
  it("holds the wood-equivalent constant across the whole mill", () => {
    const h = harness();
    const r = stagedRefine(h);
    const woodLeft = () => r.pile.wood ?? 0;
    for (let i = 0; i < 4000; i++) {
      h.sweep();
      // Every block that exists was paid for out of this pile, 2 wood each —
      // consume THEN mint, per unit, so the sum can never drift mid-batch.
      expect(woodLeft() + h.banked() * 2).toBe(REFINE_BATCH_UNITS * 2);
      if (!h.play.deltas.orders().some((o) => o.ord === r.ord)) break;
    }
    expect(h.banked()).toBe(REFINE_BATCH_UNITS);
    expect(woodLeft()).toBe(0);
  });

  it("conserves exactly at a ratio that does not divide evenly", () => {
    const h = harness();
    // 18 wood for 12 blocks = 1.5 each. Every instalment is still a WHOLE unit
    // (a stack map holds things, not fractions), and the last one pays the rest.
    const r = stagedRefine(h, REFINE_BATCH_UNITS, 18);
    const paid: number[] = [];
    let prev = 18;
    for (let i = 0; i < 4000; i++) {
      h.sweep();
      const now = r.pile.wood ?? 0;
      if (now !== prev) {
        paid.push(prev - now);
        prev = now;
      }
      if (!h.play.deltas.orders().some((o) => o.ord === r.ord)) break;
    }
    expect(h.banked()).toBe(REFINE_BATCH_UNITS);
    expect(r.pile.wood ?? 0).toBe(0);
    expect(paid.reduce((s, n) => s + n, 0)).toBe(18); // never 17, never 19
    expect(paid).toHaveLength(REFINE_BATCH_UNITS);
    for (const n of paid) expect(Number.isInteger(n)).toBe(true);
  });

  it("banks the pile REMAINDER beside the output when the row retires", () => {
    const h = harness();
    const r = stagedRefine(h, REFINE_BATCH_UNITS, REFINE_BATCH_UNITS * 2, 5); // 5 spare wood
    millOut(h, r);
    expect(h.spareWood()).toBe(5);
    expect(h.banked()).toBe(REFINE_BATCH_UNITS);
  });
});

describe("③ the bill shrinks with the pile — a working mill asks for nothing", () => {
  it("keeps `stagingMissing` empty for every sweep of the mill", () => {
    const h = harness();
    const r = stagedRefine(h);
    for (let i = 0; i < 4000; i++) {
      h.sweep();
      // 🚨 `billRowsOf` runs this over EVERY order. A non-empty answer here is a
      // laboring mill advertising a wood shortfall it does not have — porters
      // walking raw to a bench that needs none.
      expect(stagingMissing(r)).toEqual({});
      if (!h.play.deltas.orders().some((o) => o.ord === r.ord)) break;
    }
  });

  it("draws `costs` down by exactly what was paid", () => {
    const h = harness();
    const r = stagedRefine(h);
    for (let i = 0; i < 4000; i++) {
      h.sweep();
      expect(r.costs.wood).toBe(REFINE_BATCH_UNITS * 2 - (r.minted ?? 0) * 2);
      if (!h.play.deltas.orders().some((o) => o.ord === r.ord)) break;
    }
    expect(r.costs.wood).toBe(0);
  });
});

describe("④ the posted shape is untouched — count, buildDays, labor", () => {
  it("never moves the three numbers every other reader prices the row on", () => {
    const h = harness();
    const r = stagedRefine(h);
    const days = r.buildDays;
    let lastLabor = 0;
    for (let i = 0; i < 4000; i++) {
      h.sweep();
      expect(r.count).toBe(REFINE_BATCH_UNITS); // the book's `open` sum
      expect(r.buildDays).toBe(days); // the dwell link's `left / buildDays`
      expect(r.labor ?? 0).toBeGreaterThanOrEqual(lastLabor); // banked, never spent
      lastLabor = r.labor ?? 0;
      if (!h.play.deltas.orders().some((o) => o.ord === r.ord)) break;
    }
    expect(r.labor ?? 0).toBeGreaterThanOrEqual(days - 1e-9);
  });
});

describe("⑤ a partial batch never outruns its materials", () => {
  it("mints only what the pile can pay, and does NOT retire on a thin pile", () => {
    const h = harness();
    // Staged on a HALF pile: the row's own bill is 24 wood and 12 stand in it.
    // (`stageOrder` is called directly — the ladder would never stage this, and
    //  that is the point: the mint is the last line of defence, not the first.)
    const r = h.play.deltas.postRefineOrder({
      produces: BLOCK,
      count: REFINE_BATCH_UNITS,
      costs: { wood: REFINE_BATCH_UNITS * 2 },
      pile: { wood: REFINE_BATCH_UNITS },
      at: MILL_AT,
      startedDay: 0,
      buildDays: 0.05 * REFINE_BATCH_UNITS,
    });
    h.play.deltas.stageOrder(r.ord, 0);
    for (let i = 0; i < 600; i++) h.sweep();
    // Six blocks is what 12 wood buys, and the row is still standing — the
    // batch commit's own "pile ran thin — regather" hold, at unit grain.
    expect(h.banked()).toBe(REFINE_BATCH_UNITS / 2);
    expect(r.minted).toBe(REFINE_BATCH_UNITS / 2);
    expect(r.pile.wood ?? 0).toBe(0);
    expect(h.play.deltas.orders().some((o) => o.ord === r.ord)).toBe(true);
    expect(h.toasts.filter((t) => t.includes("milled and stored"))).toEqual([]);
    // …and it says what it is still short of, which is what re-gathers it.
    expect(stagingMissing(r)).toEqual({ wood: REFINE_BATCH_UNITS });

    // Feed it the rest and it finishes on the labour it already banked.
    r.pile.wood = REFINE_BATCH_UNITS;
    h.sweep();
    expect(h.banked()).toBe(REFINE_BATCH_UNITS);
    expect(h.play.deltas.orders().some((o) => o.ord === r.ord)).toBe(false);
  });
});

describe("⑥ an abandoned row's banked units stay real", () => {
  it("leaves the cut blocks in the deposit and the unpaid raw in the pile", () => {
    const h = harness();
    const r = stagedRefine(h);
    while (h.banked() < 4) h.sweep();
    const cut = h.banked();
    const left = r.pile.wood ?? 0;
    h.play.deltas.removeOrder(r.ord); // the row is dropped mid-mill

    for (let i = 0; i < 50; i++) h.sweep();
    expect(h.banked()).toBe(cut); // nothing evaporates…
    expect(cut * 2 + left).toBe(REFINE_BATCH_UNITS * 2); // …and nothing was minted free
  });
});

