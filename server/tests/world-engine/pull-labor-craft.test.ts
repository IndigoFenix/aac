/**
 * ⚖️ A SPOKEN `make` IS A BILL (task #51, Stage 2d).
 *
 * THE DEFECT THIS CLOSES, measured: a craft's gathering was a HOUSEHOLD PUSH
 * LANE — one named body (`resident_<hi>_0`) carrying one draw per sweep, and
 * only while its house was watched. So the player's own `make cart` on a
 * founded frontier was served DEAD LAST behind every town-wide pull slice (2c:
 * the craft haul landed at t≈440, after all 16 of the site's), and on a quiet
 * frontier not at all (2b: 0 deliveries in 900 s; re-measured before this
 * change: 0 in 408 s). A cart nobody can practically obtain is not the cart the
 * user asked for.
 *
 * The laws this file pins:
 *
 *  ① THE MATERIALS ARE A BILL. A standing spoken `CraftJob` enumerates as an
 *    ordinary `BillRow`: a HAUL link per short head, aimed at the job's own
 *    craft spot, priced and sliced exactly as a site pile's is.
 *
 *  ② THE LABOUR IS A SEAT — and deliberately the REFINE link, not a fifth
 *    `ContributeLink`. "Stand at the seat and dwell while the books bank" IS
 *    the refine act; the SITE ID (`craft:<hi>` vs `o:<ord>`) is the
 *    discriminator, which is what keeps `LINK_RANK`, `contributeCrewAt`, the
 *    dwell retirement test and `reseat` untouched.
 *
 *  ③ THE PLAYER'S ORDER WEIGHS WHAT A SPOKEN BUILD WEIGHS — `spoken: true`
 *    reaches `motiveWeight`, so "you asked" is the same number here as there.
 *
 *  ④ THE BILL NETS WHAT IS ALREADY WALKING and DISAPPEARS when the job is done
 *    or cancelled — a 4-block bill that one body has taken must not be offered
 *    to a second, and a finished job must not keep asking.
 *
 *  ⑤ A PILE IS NEVER ITS OWN SOURCE. A craft spot is a real cupboard, so it is
 *    IN `siteMaterialSources`; without the not-me rule a body could be sent to
 *    carry blocks from the bench to the bench.
 *
 *  ⑥ FALSIFICATION — off the `pullLabor` capability nothing here is reachable,
 *    which is what leaves the household craft lane and the dollhouse bench
 *    byte-identical.
 *
 * SHAPE: PURE. The reader/decider are driven over a synthetic session and stub
 * deps — `craftRowsOf` is the CONTRACT the construction director's
 * `craftBillsOf` must satisfy, pinned the way `fellRowsOf` already is (no
 * quest-host value import; the play-level arc lives in text mode).
 *
 * DB-free / GL-free — `npm run test:engine -- craft`.
 */
import { describe, it, expect } from "@jest/globals";
import type { ConstructionOrder } from "@shared/world-engine/kernel/town/construction.js";
import {
  decideContribution,
  visibleBills,
  type ContributeDeps,
} from "@shared/world-engine/interaction/quest/contribute.js";
import {
  craftSiteId,
  hiOfCraftSiteId,
  isContributePursuit,
  seatKey,
  seatTaken,
  type CraftBillRow,
  type WorkSeat,
} from "@shared/world-engine/kernel/town/pull-labor.js";
import type { QuestSession } from "@shared/world-engine/interaction/quest/quest-host.js";
import { createReservationLedger } from "@shared/world-engine/kernel/town/reservations.js";
import { createTransferLedger } from "@shared/world-engine/kernel/town/transfer.js";
import { DOLLHOUSE_SCALE } from "@shared/world-engine/scale.js";
import type { BodyCarry } from "@shared/world-engine/kernel/town/scope-shape.js";

// ═══ ⓪ THE SEAM — the site id ═════════════════════════════════════════════

describe("⓪ `craft:<hi>` is the craft job's own bill id", () => {
  it("round-trips a house index, the community slot included", () => {
    expect(craftSiteId(24)).toBe("craft:24");
    expect(hiOfCraftSiteId("craft:24")).toBe(24);
    // ⚖️ #44's community slot is a NEGATIVE index and spells itself `craft:-1`.
    // A legal key, and a distinct one, which is the whole requirement.
    expect(craftSiteId(-1)).toBe("craft:-1");
    expect(hiOfCraftSiteId("craft:-1")).toBe(-1);
  });

  it("🚨 IS NOT A CONSTRUCTION ORDINAL — `contributeCrewAt` keys on this exact string", () => {
    // The felling designation's law, applied to the bench: a craft borrowing
    // `o:<ord>` would make a body at a workbench count as a body standing on
    // the build site of the same number.
    expect(hiOfCraftSiteId("o:24")).toBeNull();
    expect(hiOfCraftSiteId("fell:wild:oak_3")).toBeNull();
    expect(hiOfCraftSiteId("craft:")).toBeNull();
    expect(hiOfCraftSiteId("craft:abc")).toBeNull();
  });

  it("a craft's seat is that site's seat 0 — one bench, one place to stand", () => {
    expect(seatKey(craftSiteId(24), 0)).toBe("craft:24#seat0");
  });
});

// ═══ THE FIXTURE ══════════════════════════════════════════════════════════

const SPOT = "furn_24_cupboard"; // the bench's own container — a REAL cupboard
const SPOT_AT = { x: 10, y: 0 };
const BENCH_AT = { x: 11, y: 1 }; // the standable ground beside the work
const YARD = "town:yard";
const YARD_AT = { x: 16, y: 0 };
const SITE_AT = { x: -40, y: 0 };
const HI = 24;
const CRAFT_SITE = craftSiteId(HI);

interface Fixture {
  session: QuestSession;
  deps: ContributeDeps;
  at: Map<string, { x: number; y: number }>;
  craftRows: CraftBillRow[];
  orders: ConstructionOrder[];
  yardStock: Record<string, number>;
  spotStock: Record<string, number>;
  hauled: string[];
  stood: Array<{ cid: string; at: { x: number; y: number } }>;
  weights: Array<{ cid: string; spoken: boolean }>;
}

const bare = (): BodyCarry => ({ inHand: null, worn: null });

/** The row the director's `craftBillsOf` promises: a spoken `make cart` whose
 *  bill is 4 blocks and whose spot holds none of them yet. */
function cartRow(over?: Partial<CraftBillRow>): CraftBillRow {
  return {
    siteId: CRAFT_SITE,
    hi: HI,
    spotId: SPOT,
    at: SPOT_AT,
    missing: { block: 4 },
    required: { block: 4 },
    work: null, // not staged — the MATERIAL link is what this bill offers
    destWord: "house",
    spoken: true,
    ...over,
  };
}

/** …and the same row once the blocks have landed: the dwell is on offer. */
function stagedCartRow(over?: Partial<CraftBillRow>): CraftBillRow {
  return cartRow({
    missing: {},
    work: { at: BENCH_AT, leftS: 84, urgency: 1 },
    ...over,
  });
}

function makeFixture(opts?: { pullOn?: boolean; withSiteBill?: boolean }): Fixture {
  const orders: ConstructionOrder[] = opts?.withSiteBill
    ? [
        {
          kind: "found",
          ord: 0,
          type: "house",
          slot: 0,
          dx: -40,
          dy: 0,
          w: 8,
          h: 6,
          door: "south",
          startedDay: 0,
          buildDays: 4,
          costs: { block: 120 },
          pile: {},
        } as ConstructionOrder,
      ]
    : [];
  const yardStock: Record<string, number> = { block: 40 };
  const spotStock: Record<string, number> = {};
  const at = new Map<string, { x: number; y: number }>();
  const craftRows: CraftBillRow[] = [];
  const hauled: string[] = [];
  const stood: Fixture["stood"] = [];
  const weights: Fixture["weights"] = [];

  const session = {
    town: {} as unknown,
    wilderness: (opts?.pullOn ?? true) ? ({} as unknown) : null,
    foundedSite: null,
    scale: DOLLHOUSE_SCALE,
    townClock: 500,
    taskClock: 100,
    transfers: createTransferLedger(),
    reservations: createReservationLedger(),
    pursuits: new Map(),
    walk: new Map(),
    liveNeedBodies: new Set<string>(),
    npcTasks: new Map(),
    lastDrive: new Map(),
  } as unknown as QuestSession;

  const craftSeats = (): WorkSeat[] => [
    { siteId: CRAFT_SITE, link: "refine", key: seatKey(CRAFT_SITE, 0), at: BENCH_AT, index: 0 },
  ];

  const deps: ContributeDeps = {
    deltasOf: () => ({ orders: () => orders }),
    scopeCtxOf: () => ({ townId: () => "town" }),
    // The craft spot sits INSIDE house 24; the bodies stand on open ground.
    // A bill hung off the cupboard's own containment would be invisible to
    // every one of them — which is why a spoken craft hangs off the town.
    scopeOfPoint: () => null,
    orderPileIds: (o) => ({ pileId: `orderpile:${o.ord}` }),
    endpointAt: (_s, id) =>
      id === SPOT ? SPOT_AT : id === YARD ? YARD_AT : id === "orderpile:0" ? SITE_AT : null,
    pileWordOf: () => "house",
    bodyAt: (_s, cid) => at.get(cid) ?? null,
    carryOf: () => bare(),
    bagCeilingOf: () => 8,
    orderSiteId: (ord) => `o:${ord}`,
    buildworkSiteAt: () => null,
    // The director answers the craft site's ONE seat and nothing else here.
    seatsOf: (_s, siteId) => (siteId === CRAFT_SITE ? craftSeats() : []),
    // 🚨 THE CRAFT SPOT IS IN THIS LIST — it is a registered cupboard, unlike a
    // construction pile. Law ⑤ is what stops a body carrying to it FROM it.
    siteMaterialSources: () => [
      { id: SPOT, stack: spotStock, d: 0 },
      { id: YARD, stack: yardStock, d: 6 },
    ],
    freeHeadStockWithinReach: (_s, _at, head) =>
      head === "block" ? (yardStock.block ?? 0) + (spotStock.block ?? 0) : 0,
    agrHolder: (id) => `agr:${id}`,
    billIssuer: () => "player",
    drawSourceShelf: () => {},
    issueTransferHaul: (_s, cid, agreementId) => void hauled.push(`${cid}|${agreementId}`),
    standAndWork: (_s, cid, spot) => void stood.push({ cid, at: spot }),
    chopAt: () => {},
    craftRowsOf: () => craftRows,
    announce: () => {},
    motiveWeight: (_s, cid, link) => {
      weights.push({ cid, spoken: link.spoken });
      return link.spoken ? 2 : 1; // "you asked" — 1 + compliance, stubbed
    },
    forgoneS: () => 0,
  };

  return { session, deps, at, craftRows, orders, yardStock, spotStock, hauled, stood, weights };
}

// ═══ ① THE MATERIALS ARE A BILL ═══════════════════════════════════════════

describe("① a spoken `make` enumerates as a material bill", () => {
  it("offers ONE haul link per short head, aimed at the craft spot", () => {
    const f = makeFixture();
    f.craftRows.push(cartRow());
    f.at.set("resident_1_0", { x: 14, y: 0 });
    const links = visibleBills(f.session, "resident_1_0", f.deps);
    expect(links).toHaveLength(1);
    const l = links[0]!;
    expect(l.link).toBe("haul");
    expect(l.siteId).toBe(CRAFT_SITE);
    expect(l.head).toBe("block");
    expect(l.units).toBe(4); // the whole bill — the SLICE is sized at the take
    expect(l.to).toBe(SPOT);
    expect(l.from).toBe(YARD);
    expect(l.destWord).toBe("house");
    // A HAUL HAS NO SEAT (S1, unchanged): its bound is its reservation.
    expect(l.seats).toBeUndefined();
  });

  it("presses on what has LANDED — urgency is missing ÷ required", () => {
    const f = makeFixture();
    f.craftRows.push(cartRow({ missing: { block: 1 }, required: { block: 4 } }));
    f.at.set("resident_1_0", { x: 14, y: 0 });
    expect(visibleBills(f.session, "resident_1_0", f.deps)[0]!.urgency).toBeCloseTo(0.25);
  });

  it("🚨 IS VISIBLE FROM OUTSIDE THE BENCH'S HOUSE — the player asked the settlement", () => {
    // `scopeOfPoint` answers null for every body here (open ground). If the
    // bill hung off the cupboard's own containment (`h_24`) nobody standing in
    // the settlement could see it, and "nobody serves the cart" would come
    // back wearing a scope walk.
    const f = makeFixture();
    f.craftRows.push(cartRow());
    f.at.set("resident_1_0", { x: 14, y: 0 });
    f.at.set("resident_9_9", { x: -30, y: 12 });
    expect(visibleBills(f.session, "resident_1_0", f.deps)).toHaveLength(1);
    expect(visibleBills(f.session, "resident_9_9", f.deps)).toHaveLength(1);
  });

  it("a body sizes its slice from its own carry and reserves it atomically", () => {
    const f = makeFixture();
    f.craftRows.push(cartRow());
    f.at.set("resident_1_0", { x: 14, y: 0 });
    expect(decideContribution(f.session, "resident_1_0", f.deps, { beatS: -Infinity })).toBe(true);
    const p = f.session.pursuits.get("resident_1_0");
    expect(isContributePursuit(p)).toBe(true);
    expect(p!.bill!.siteId).toBe(CRAFT_SITE);
    expect(p!.bill!.link).toBe("haul");
    expect(p!.bill!.units).toBe(4);
    // The units are spoken for AT THE SOURCE under the agreement's own holder.
    const agrId = p!.bill!.agreementId!;
    expect(f.session.reservations.reservedUnits(YARD, "block")).toBe(4);
    expect(f.hauled).toEqual([`resident_1_0|${agrId}`]);
  });
});

// ═══ ② THE LABOUR IS A SEAT (the REFINE link) ═════════════════════════════

describe("② the labour is one seat at the bench", () => {
  it("a staged job offers a REFINE link with exactly one free seat", () => {
    const f = makeFixture();
    f.craftRows.push(stagedCartRow());
    f.at.set("resident_1_0", { x: 12, y: 0 });
    const links = visibleBills(f.session, "resident_1_0", f.deps);
    expect(links).toHaveLength(1);
    const l = links[0]!;
    // ⚖️ NOT A FIFTH LINK KIND — the site id is the discriminator.
    expect(l.link).toBe("refine");
    expect(l.siteId).toBe(CRAFT_SITE);
    expect(l.units).toBeUndefined();
    expect(l.seats).toEqual([
      { siteId: CRAFT_SITE, link: "refine", key: "craft:24#seat0", at: BENCH_AT, index: 0 },
    ]);
    expect(l.unitValueS).toBe(84); // the labour still owed, in seconds
  });

  it("taking it CLAIMS the seat and stands the body at the bench", () => {
    const f = makeFixture();
    f.craftRows.push(stagedCartRow());
    f.at.set("resident_1_0", { x: 12, y: 0 });
    expect(decideContribution(f.session, "resident_1_0", f.deps, { beatS: -Infinity })).toBe(true);
    const bill = f.session.pursuits.get("resident_1_0")!.bill!;
    expect(bill.link).toBe("refine");
    expect(bill.seatKey).toBe("craft:24#seat0");
    expect(seatTaken(f.session.reservations, "craft:24#seat0")).toBe(true);
    expect(f.stood).toEqual([{ cid: "resident_1_0", at: BENCH_AT }]);
  });

  it("🚨 ONE BENCH, ONE MAKER — a second body is not offered the taken seat", () => {
    const f = makeFixture();
    f.craftRows.push(stagedCartRow());
    f.at.set("resident_1_0", { x: 12, y: 0 });
    f.at.set("resident_2_0", { x: 12, y: 1 });
    expect(decideContribution(f.session, "resident_1_0", f.deps, { beatS: -Infinity })).toBe(true);
    // The reader no longer offers it…
    expect(visibleBills(f.session, "resident_2_0", f.deps)[0]!.seats).toEqual([]);
    // …and the decider skips a link whose every place is spoken for.
    expect(decideContribution(f.session, "resident_2_0", f.deps, { beatS: -Infinity })).toBe(false);
    expect(f.stood).toHaveLength(1);
  });

  it("a hungrier body does not take the bench — contribute is one motive in the argmax", () => {
    const f = makeFixture();
    f.craftRows.push(stagedCartRow());
    f.at.set("resident_1_0", { x: 12, y: 0 });
    expect(decideContribution(f.session, "resident_1_0", f.deps, { beatS: 1e9 })).toBe(false);
    expect(seatTaken(f.session.reservations, "craft:24#seat0")).toBe(false);
  });
});

// ═══ ③ THE PLAYER'S ORDER WEIGHS WHAT A SPOKEN BUILD WEIGHS ═══════════════

describe("③ spoken weight", () => {
  it("the link carries `spoken` and it reaches `motiveWeight`", () => {
    const f = makeFixture();
    f.craftRows.push(cartRow());
    f.at.set("resident_1_0", { x: 14, y: 0 });
    const l = visibleBills(f.session, "resident_1_0", f.deps)[0]!;
    expect(l.spoken).toBe(true);
    expect(l.issuer).toBe("player");
    decideContribution(f.session, "resident_1_0", f.deps, { beatS: -Infinity });
    expect(f.weights).toContainEqual({ cid: "resident_1_0", spoken: true });
  });

  it("…and a civic row alongside it is weighed as civic", () => {
    const f = makeFixture({ withSiteBill: true });
    f.craftRows.push(cartRow());
    f.at.set("resident_1_0", { x: 14, y: 0 });
    decideContribution(f.session, "resident_1_0", f.deps, { beatS: -Infinity });
    expect(f.weights.some((w) => w.spoken === false)).toBe(true);
    expect(f.weights.some((w) => w.spoken === true)).toBe(true);
  });
});

// ═══ ④ THE BILL NETS, AND IT DIES WITH THE JOB ════════════════════════════

describe("④ the bill nets what is walking, and disappears when the job does", () => {
  it("🚨 A BILL ONE BODY HAS TAKEN IS NOT OFFERED TO A SECOND", () => {
    // The craft's whole bill is FOUR blocks, so one body takes all of it. Two
    // bodies both hauling four is the double-order `pileShortfall` exists for.
    const f = makeFixture();
    f.craftRows.push(cartRow());
    f.at.set("resident_1_0", { x: 14, y: 0 });
    f.at.set("resident_2_0", { x: 14, y: 1 });
    expect(decideContribution(f.session, "resident_1_0", f.deps, { beatS: -Infinity })).toBe(true);
    expect(visibleBills(f.session, "resident_2_0", f.deps)).toEqual([]);
    expect(decideContribution(f.session, "resident_2_0", f.deps, { beatS: -Infinity })).toBe(false);
  });

  it("…and it REOPENS when that haul dies, with its units back on the shelf", () => {
    // The liveness rule's whole point: a carrier that stops walking must not
    // hold a 4-block bill forever (measured on the quiet frontier — one body
    // halted 55 m out with its errand still "active" and the cart ended there).
    const f = makeFixture();
    f.craftRows.push(cartRow());
    f.at.set("resident_1_0", { x: 14, y: 0 });
    f.at.set("resident_2_0", { x: 14, y: 1 });
    decideContribution(f.session, "resident_1_0", f.deps, { beatS: -Infinity });
    const agrId = f.session.pursuits.get("resident_1_0")!.bill!.agreementId!;
    f.session.transfers.fail(agrId, "no-executor");
    f.session.reservations.release(`agr:${agrId}`);
    expect(f.session.reservations.reservedUnits(YARD, "block")).toBe(0);
    expect(visibleBills(f.session, "resident_2_0", f.deps)).toHaveLength(1);
  });

  it("a job that has gone (minted, or cancelled) offers NOTHING", () => {
    const f = makeFixture();
    f.craftRows.push(cartRow());
    f.at.set("resident_1_0", { x: 14, y: 0 });
    expect(visibleBills(f.session, "resident_1_0", f.deps)).toHaveLength(1);
    f.craftRows.length = 0; // `craftJobsOf.delete(hi)` — the mint, or a cancel
    expect(visibleBills(f.session, "resident_1_0", f.deps)).toEqual([]);
    expect(decideContribution(f.session, "resident_1_0", f.deps, { beatS: -Infinity })).toBe(false);
  });

  it("a covered, unstaffed job offers ONLY the dwell — nothing left to fetch", () => {
    const f = makeFixture();
    f.craftRows.push(stagedCartRow());
    f.at.set("resident_1_0", { x: 12, y: 0 });
    expect(visibleBills(f.session, "resident_1_0", f.deps).map((l) => l.link)).toEqual(["refine"]);
  });
});

// ═══ ⑤ A PILE IS NEVER ITS OWN SOURCE ═════════════════════════════════════

describe("⑤ the craft spot is not its own source", () => {
  it("🚨 never carries blocks from the bench to the bench", () => {
    // A craft spot is a REAL cupboard, so `siteMaterialSources` lists it — the
    // one thing a construction pile never was. Only the yard may serve it.
    const f = makeFixture();
    f.spotStock.block = 9; // …and it is the NEAREST source in the list (d = 0)
    f.craftRows.push(cartRow());
    f.at.set("resident_1_0", { x: 14, y: 0 });
    const links = visibleBills(f.session, "resident_1_0", f.deps);
    expect(links).toHaveLength(1);
    expect(links[0]!.from).toBe(YARD);
  });

  it("…and with NO other source it offers no haul at all", () => {
    const f = makeFixture();
    f.spotStock.block = 9;
    f.yardStock.block = 0;
    f.craftRows.push(cartRow());
    f.at.set("resident_1_0", { x: 14, y: 0 });
    expect(visibleBills(f.session, "resident_1_0", f.deps)).toEqual([]);
  });
});

// ═══ ⑥ FALSIFICATION — off the capability, none of it exists ══════════════

describe("⑥ off the `pullLabor` capability nothing here is reachable", () => {
  it("the decider refuses before it reads a single row", () => {
    const f = makeFixture({ pullOn: false });
    f.craftRows.push(cartRow());
    f.at.set("resident_1_0", { x: 14, y: 0 });
    expect(decideContribution(f.session, "resident_1_0", f.deps, { beatS: -Infinity })).toBe(false);
    expect(f.session.pursuits.size).toBe(0);
    expect(f.hauled).toEqual([]);
  });

  it("a session whose bookkeeper offers no craft rows behaves exactly as before", () => {
    // `craftRowsOf` is OPTIONAL for the same reason `fellRowsOf` is: a fixture
    // (or a world) that mints no craft rows must not have to say so.
    const f = makeFixture({ withSiteBill: true });
    const deps = { ...f.deps };
    delete (deps as { craftRowsOf?: unknown }).craftRowsOf;
    f.at.set("resident_1_0", { x: -36, y: 0 });
    const links = visibleBills(f.session, "resident_1_0", deps);
    expect(links.every((l) => l.siteId === "o:0")).toBe(true);
  });
});
