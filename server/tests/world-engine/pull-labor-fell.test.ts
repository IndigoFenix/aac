/**
 * ⚖️ THE CUT IS A DESIGNATION, NOT A DEED (task #51 item 1d).
 *
 * USER RULING (2026-09-04, verbatim): *"the 'cut command' for trees isn't
 * supposed to destroy the tree when the button is pressed. It should issue a
 * COMMAND to cut that tree. Or, alternatively, DESIGNATE the tree to be cut
 * when available as a task."*
 *
 * The laws this file pins:
 *
 *  ① THE MARK IS A BOOK ROW, not a session opinion. It lives in the deltas
 *    beside the annex and demolition designations, it is IDEMPOTENT on the
 *    thing (marking twice is marking once), and it SURVIVES A SAVE — a promise
 *    the world made to a child cannot evaporate on reload. A world that never
 *    marked anything serializes byte-identically (the emit-when-non-empty law
 *    every young field in that store follows).
 *
 *  ② A MARK IS A BILL, and it enumerates as one: a FELL link with no
 *    destination (`BillLink.to` was left optional for exactly this), one seat
 *    (one tree, one chopper), pressing flat out (a thing is up or it is down —
 *    there is no partly-felled), and visible to whoever's scope walk reaches
 *    the ground it stands on.
 *
 *  ③ THE LOT-CLEARING BILL IS THE SAME ROW WITH A CARRY HALF — 1a's REQUEST 2.
 *    Under the capability the bookkeeper posts a tree→shelf agreement with NO
 *    executor and cuts nothing; standing, the row offers the CHOP; down, it
 *    offers the HAUL that carries the timber off, RIDING the agreement that is
 *    already holding those units rather than posting a second one over them.
 *
 *  ④ THE EXECUTOR IS A WALK, A DWELL AND THE ONE KILL DRAW. The decider
 *    installs a `clearFeature` pursuit — the goal the child's own SENTENCE
 *    compiles to, so the announce line and the activity verb already know how
 *    to speak about it — and hands the body to `chopAt`. Nothing is felled by
 *    deciding.
 *
 *  ⑤ FALSIFICATION — off the `pullLabor` capability none of it is reachable,
 *    which is what keeps the dollhouse bench byte-identical.
 *
 * SHAPE: ① is the kernel store, pure. ②–⑤ ride the decider's own synthetic
 * session and stub deps (no quest-host value import — that transform tax is
 * why the arc lives in text mode).
 *
 * DB-free / GL-free — `npm run test:engine -- fell`.
 */
import { describe, it, expect } from "@jest/globals";
import {
  createTownDeltas,
  type ConstructionOrder,
} from "@shared/world-engine/kernel/town/construction.js";
import {
  decideContribution,
  visibleBills,
  type ContributeDeps,
} from "@shared/world-engine/interaction/quest/contribute.js";
import {
  fellSiteId,
  clearSiteId,
  isContributePursuit,
  type FellRow,
} from "@shared/world-engine/kernel/town/pull-labor.js";
import type { QuestSession } from "@shared/world-engine/interaction/quest/quest-host.js";
import { createReservationLedger } from "@shared/world-engine/kernel/town/reservations.js";
import { createTransferLedger } from "@shared/world-engine/kernel/town/transfer.js";
import { DOLLHOUSE_SCALE } from "@shared/world-engine/scale.js";
import type { BodyCarry } from "@shared/world-engine/kernel/town/scope-shape.js";

// ═══ ① THE ROW — the kernel store, pure ═══════════════════════════════════

const MARK = {
  featureId: "wild:oak_3",
  at: { x: 12, y: -4 },
  word: "plants",
  issuer: "player",
  spoken: true,
  postedDay: 2,
};

describe("① the felling designation is a BOOK ROW", () => {
  it("marks a thing, assigns an ordinal, and bumps the version", () => {
    const d = createTownDeltas();
    const v = d.version;
    const row = d.designateFell(MARK);
    expect(row.ord).toBe(0);
    expect(row.featureId).toBe("wild:oak_3");
    expect(d.fellOrders()).toHaveLength(1);
    expect(d.version).toBeGreaterThan(v);
  });

  it("🚨 IS IDEMPOTENT ON THE THING — marking twice is marking once", () => {
    // The lot-clearing sweep re-derives its blockers EVERY SECOND, and a child
    // may press the same button twice. Either would mint a second bill for one
    // tree without this (`ensureRefineOrders`' own law, applied to the mark).
    const d = createTownDeltas();
    const a = d.designateFell(MARK);
    const v = d.version;
    const b = d.designateFell({ ...MARK, issuer: "someone_else" });
    expect(b).toBe(a); // the standing row IS the answer
    expect(d.fellOrders()).toHaveLength(1);
    expect(d.fellOrders()[0]!.issuer).toBe("player"); // …and it is not rewritten
    expect(d.version).toBe(v); // nothing changed, so nothing is dirty
  });

  it("a second THING gets its own ordinal", () => {
    const d = createTownDeltas();
    d.designateFell(MARK);
    const b = d.designateFell({ ...MARK, featureId: "wild:oak_9" });
    expect(b.ord).toBe(1);
    expect(d.fellOrders().map((r) => r.featureId)).toEqual(["wild:oak_3", "wild:oak_9"]);
  });

  it("cancels by the thing's own id, and says whether there was one", () => {
    const d = createTownDeltas();
    d.designateFell(MARK);
    expect(d.cancelFell("wild:oak_9")).toBe(false);
    expect(d.cancelFell("wild:oak_3")).toBe(true);
    expect(d.fellOrders()).toEqual([]);
    expect(d.cancelFell("wild:oak_3")).toBe(false); // …and again is honest about it
  });

  it("🚨 SURVIVES A SAVE — a designation is not a session opinion", () => {
    const d = createTownDeltas();
    d.designateFell(MARK);
    d.designateFell({ ...MARK, featureId: "wild:bush_1", word: "plants", spoken: false });
    const back = createTownDeltas(JSON.parse(JSON.stringify(d.toJSON())));
    expect(back.fellOrders()).toEqual(d.fellOrders());
    // …and the store owns its rows: mutating the restored one cannot reach back.
    back.cancelFell("wild:oak_3");
    expect(d.fellOrders()).toHaveLength(2);
  });

  it("a world that marked NOTHING serializes exactly the object it always did", () => {
    // The emit-when-non-empty law (`herd`, `areaRecords`): the dollhouse bench
    // and every pre-1d save must round-trip byte-identically.
    const d = createTownDeltas();
    expect("fellOrders" in d.toJSON()).toBe(false);
    d.designateFell(MARK);
    expect(d.toJSON().fellOrders).toHaveLength(1);
    d.cancelFell(MARK.featureId);
    expect("fellOrders" in d.toJSON()).toBe(false);
  });
});

// ═══ ②–⑤ THE BILL — the decider's synthetic world ═════════════════════════
//
// The same hand-built shape the decider suite uses (every input visible in the
// test), with the two row sources this item adds.

const SITE_AT = { x: 100, y: 0 };
const CRATE_AT = { x: 90, y: 0 };
const OAK_AT = { x: 60, y: 20 };
const YARD_AT = { x: 95, y: 5 };
const CRATE = "furn_0_crate";
const OAK = "flora:oak:wild:oak_3";
const YARD = "town:yard";

interface Fixture {
  session: QuestSession;
  deps: ContributeDeps;
  at: Map<string, { x: number; y: number }>;
  fellRows: FellRow[];
  orders: ConstructionOrder[];
  crateStock: Record<string, number>;
  chopped: Array<{ cid: string; objId: string; at: { x: number; y: number } }>;
  hauled: string[];
  announced: string[];
  posted: number;
}

const bare = (): BodyCarry => ({ inHand: null, worn: null });

function makeFixture(opts?: { pullOn?: boolean; withSiteBill?: boolean }): Fixture {
  // A site bill exists only when a case asks for one — most of these cases are
  // about a bill with NO construction row behind it at all.
  const orders: ConstructionOrder[] = opts?.withSiteBill
    ? [
        {
          kind: "found",
          ord: 1,
          type: "house",
          slot: 0,
          dx: 100,
          dy: 0,
          w: 8,
          h: 6,
          door: "south",
          startedDay: 0,
          buildDays: 4,
          costs: { block: 120 },
          pile: { block: 100 },
        } as ConstructionOrder,
      ]
    : [];
  const crateStock: Record<string, number> = { block: 20 };
  const at = new Map<string, { x: number; y: number }>();
  const fellRows: FellRow[] = [];
  const chopped: Fixture["chopped"] = [];
  const hauled: string[] = [];
  const announced: string[] = [];
  const f: Partial<Fixture> = {};

  const session = {
    town: {} as unknown,
    wilderness: (opts?.pullOn ?? true) ? ({} as unknown) : null,
    foundedSite: null,
    scale: DOLLHOUSE_SCALE,
    taskClock: 100,
    transfers: createTransferLedger(),
    reservations: createReservationLedger(),
    pursuits: new Map(),
    walk: new Map(),
    liveNeedBodies: new Set<string>(),
    npcTasks: new Map(),
    lastDrive: new Map(),
  } as unknown as QuestSession;

  const deps: ContributeDeps = {
    deltasOf: () => ({ orders: () => orders }),
    scopeCtxOf: () => ({ townId: () => "town" }),
    // The oak stands on open ground (null — "counts for nobody"), which the
    // walk tolerates; a body inside `h_5` is somewhere else entirely.
    scopeOfPoint: (_s, x) => (x <= -300 ? "h_5" : null),
    orderPileIds: (o) => ({ pileId: `orderpile:${o.ord}` }),
    endpointAt: (_s, id) =>
      id === "orderpile:1" ? SITE_AT : id === CRATE ? CRATE_AT : id === OAK ? OAK_AT : id === YARD ? YARD_AT : null,
    pileWordOf: () => "house",
    bodyAt: (_s, cid) => at.get(cid) ?? null,
    carryOf: () => bare(),
    bagCeilingOf: () => 0,
    orderSiteId: (ord) => `o:${ord}`,
    buildworkSiteAt: () => null,
    // 🔁 MOVED (Stage 2): the seat seam is a required dep now. A MARK's seat is
    // not a construction row's — it is minted from the mark's own site id — so
    // this fixture offers no ORDER seats and the fell pins below still stand.
    seatsOf: () => [],
    siteMaterialSources: () => [
      { id: CRATE, stack: crateStock, d: 10 },
      { id: OAK, stack: { wood: 8 }, d: 40 },
    ],
    freeHeadStockWithinReach: (_s, _at, head) => (head === "block" ? crateStock.block ?? 0 : 8),
    agrHolder: (id) => `agr:${id}`,
    billIssuer: () => "player",
    drawSourceShelf: () => {},
    issueTransferHaul: (_s, cid, agreementId) => void hauled.push(`${cid}|${agreementId}`),
    standAndWork: () => {},
    chopAt: (_s, cid, objId, spot) => void chopped.push({ cid, objId, at: spot }),
    fellRowsOf: () => fellRows,
    announce: (_s, cid) => void announced.push(cid),
    motiveWeight: () => 1,
    forgoneS: () => 0,
  };

  Object.assign(f, {
    session,
    deps,
    at,
    fellRows,
    orders,
    crateStock,
    chopped,
    hauled,
    announced,
    posted: 0,
  });
  return f as Fixture;
}

/** A mark: the tree stands, nothing to carry, nobody is executing anything. */
const standingMark = (): FellRow => ({
  siteId: fellSiteId("wild:oak_3"),
  objId: OAK,
  at: OAK_AT,
  word: "plants",
  standing: true,
  spoken: true,
  issuer: "player",
});

/** The builders' bill: the same tree, plus the carry half the bookkeeper
 *  posted against it. */
const clearingBill = (session: QuestSession, standing: boolean): FellRow => {
  const a = session.transfers.post({
    from: OAK,
    to: YARD,
    goods: { wood: 8 },
    issuer: "player",
    mode: "haul",
    now: 1,
    sourceGlyph: "clear the ground for the house",
  });
  session.reservations.reserve(`agr:${a.id}`, OAK, "wood", 8);
  return {
    siteId: clearSiteId("wild:oak_3"),
    objId: OAK,
    at: OAK_AT,
    word: "plants",
    standing,
    spoken: false,
    issuer: "player",
    haul: { agreementId: a.id, to: YARD, destWord: "yard", head: "wood", units: 8 },
  };
};

describe("② a MARK is a bill", () => {
  it("enumerates as a FELL link with no destination and ONE seat", () => {
    const f = makeFixture();
    f.fellRows.push(standingMark());
    f.at.set("resident_0_0", { x: 62, y: 20 });
    const links = visibleBills(f.session, "resident_0_0", f.deps);
    expect(links).toHaveLength(1);
    const l = links[0]!;
    expect(l.link).toBe("fell");
    expect(l.objId).toBe(OAK);
    expect(l.to).toBeUndefined(); // the trunk lies where it falls
    expect(l.units).toBeUndefined(); // a chop moves nothing
    // 🔁 MOVED PIN (Stage 2, S2): "one tree, one chopper" is now a real SEAT on
    // the mark's own site id rather than the integer 1 — same law, claimed on
    // the ledger instead of counted over `session.pursuits`.
    expect(l.seats).toEqual([
      { siteId: "fell:wild:oak_3", link: "fell", key: "fell:wild:oak_3#seat0", at: OAK_AT, index: 0 },
    ]);
    expect(l.urgency).toBe(1); // a thing is up, or it is down
    expect(l.word).toBe("plants");
    expect(l.siteId).toBe("fell:wild:oak_3");
  });

  it("is visible through the SCOPE WALK, not a radius", () => {
    const f = makeFixture();
    f.fellRows.push(standingMark());
    // ⚖️ A MARK ON OPEN GROUND HANGS OFF THE SETTLEMENT'S OWN ROOT, and the
    // root is always walked — so distance decides nothing at all: a body four
    // hundred metres away sees it exactly as one standing beside it does, and
    // the WALK (not a radius) is what admits them both. That is the same rung
    // the site's own pile hangs off.
    f.at.set("far", { x: 400, y: 400 });
    expect(visibleBills(f.session, "far", f.deps)).toHaveLength(1);
    // …and a mark on ground INSIDE somebody's building is another matter: the
    // walk from `h_5` never reaches `h_9`, so that body sees nothing.
    const inside: ContributeDeps = { ...f.deps, scopeOfPoint: (_s, x) => (x <= -300 ? "h_5" : "h_9") };
    f.at.set("indoors", { x: -400, y: 0 });
    expect(visibleBills(f.session, "indoors", inside)).toEqual([]);
    f.at.set("sameRoom", { x: 62, y: 20 });
    expect(visibleBills(f.session, "sameRoom", inside)).toHaveLength(1);
  });

  it("⚖️ FELL IS THE LEAST DOWNSTREAM LINK — a stocked crate is served first", () => {
    const f = makeFixture({ withSiteBill: true });
    f.fellRows.push(standingMark());
    f.at.set("resident_0_0", SITE_AT);
    expect(visibleBills(f.session, "resident_0_0", f.deps).map((l) => l.link)).toEqual([
      "haul",
      "fell",
    ]);
  });

  it("two marks come back in a TOTAL order — every peer enumerates the same list", () => {
    const f = makeFixture();
    const a = { ...standingMark(), siteId: fellSiteId("wild:oak_9"), objId: "flora:oak:wild:oak_9" };
    f.fellRows.push(a, standingMark());
    f.at.set("resident_0_0", OAK_AT);
    const ids = visibleBills(f.session, "resident_0_0", f.deps).map((l) => l.siteId);
    expect(ids).toEqual(["fell:wild:oak_3", "fell:wild:oak_9"]);
  });
});

describe("③ the LOT-CLEARING bill — 1a's executor-less row, closed", () => {
  it("STANDING, it is a CHOP (and the agreement rides along)", () => {
    const f = makeFixture();
    f.fellRows.push(clearingBill(f.session, true));
    f.at.set("resident_0_0", OAK_AT);
    const links = visibleBills(f.session, "resident_0_0", f.deps);
    expect(links).toHaveLength(1);
    expect(links[0]!.link).toBe("fell");
    expect(links[0]!.objId).toBe(OAK);
    expect(links[0]!.agreementId).toBeDefined();
  });

  it("DOWN, the SAME row is the haul that carries it off", () => {
    const f = makeFixture();
    f.fellRows.push(clearingBill(f.session, false));
    f.at.set("resident_0_0", OAK_AT);
    const links = visibleBills(f.session, "resident_0_0", f.deps);
    expect(links).toHaveLength(1);
    expect(links[0]!.link).toBe("haul");
    expect(links[0]!.head).toBe("wood");
    expect(links[0]!.from).toBe(OAK);
    expect(links[0]!.to).toBe(YARD);
  });

  it("🚨 THE PULLER ADOPTS THAT AGREEMENT — it never posts a second one", () => {
    // The bookkeeper's row is already holding those eight units under its own
    // holder. A second agreement over the same stock is a double promise, and
    // the pile would read as covered twice.
    const f = makeFixture();
    f.fellRows.push(clearingBill(f.session, false));
    f.at.set("resident_0_0", OAK_AT);
    const id = f.session.transfers.all()[0]!.id;
    expect(decideContribution(f.session, "resident_0_0", f.deps, { beatS: -Infinity })).toBe(true);
    expect(f.session.transfers.all()).toHaveLength(1); // no second row
    expect(f.session.transfers.get(id)!.executor).toBe("resident_0_0");
    expect(f.session.transfers.get(id)!.status).toBe("moving");
    expect(f.hauled).toEqual([`resident_0_0|${id}`]);
    expect(f.session.reservations.reservedUnits(OAK, "wood")).toBe(8); // unchanged
    const p = f.session.pursuits.get("resident_0_0");
    expect(isContributePursuit(p)).toBe(true);
    expect(p!.bill!.agreementId).toBe(id);
  });

  it("…and the SECOND body to reach it is refused — first to hands wins", () => {
    const f = makeFixture();
    f.fellRows.push(clearingBill(f.session, false));
    f.at.set("a", OAK_AT);
    f.at.set("b", OAK_AT);
    expect(decideContribution(f.session, "a", f.deps, { beatS: -Infinity })).toBe(true);
    expect(decideContribution(f.session, "b", f.deps, { beatS: -Infinity })).toBe(false);
    expect(f.session.transfers.all()).toHaveLength(1);
  });
});

describe("④ the EXECUTOR — a walk, a dwell, and the one kill draw", () => {
  it("deciding installs a `clearFeature` pursuit and hands the body to the chop", () => {
    const f = makeFixture();
    f.fellRows.push(standingMark());
    f.at.set("resident_0_0", { x: 62, y: 20 });
    expect(decideContribution(f.session, "resident_0_0", f.deps, { beatS: -Infinity })).toBe(true);
    const p = f.session.pursuits.get("resident_0_0")!;
    expect(isContributePursuit(p)).toBe(true);
    expect(p.goal).toEqual({ kind: "clearFeature", feature: "plants" });
    expect(p.bill!.link).toBe("fell");
    expect(p.bill!.objId).toBe(OAK);
    expect(p.bill!.units).toBeUndefined();
    expect(p.source).toBe("need"); // self-issued — nobody ordered it
    expect(f.session.liveNeedBodies.has("resident_0_0")).toBe(true);
    expect(f.announced).toEqual(["resident_0_0"]); // ⚖️ never a silent claim
    expect(f.chopped).toEqual([{ cid: "resident_0_0", objId: OAK, at: OAK_AT }]);
  });

  it("🚨 DECIDING FELLS NOTHING — no agreement, no reservation, no unit moved", () => {
    const f = makeFixture();
    f.fellRows.push(standingMark());
    f.at.set("resident_0_0", OAK_AT);
    decideContribution(f.session, "resident_0_0", f.deps, { beatS: -Infinity });
    expect(f.session.transfers.all()).toEqual([]);
    expect(f.session.reservations.reservedUnits(OAK, "wood")).toBe(0);
  });

  it("ONE TREE, ONE CHOPPER — the seat is taken", () => {
    const f = makeFixture();
    f.fellRows.push(standingMark());
    f.at.set("a", OAK_AT);
    f.at.set("b", OAK_AT);
    expect(decideContribution(f.session, "a", f.deps, { beatS: -Infinity })).toBe(true);
    expect(decideContribution(f.session, "b", f.deps, { beatS: -Infinity })).toBe(false);
    expect(f.chopped).toHaveLength(1);
  });

  it("A BODY WITH FULL HANDS may still chop — a felling needs no carry", () => {
    const f = makeFixture();
    f.fellRows.push(standingMark());
    f.at.set("resident_0_0", OAK_AT);
    f.deps.carryOf = () => ({ inHand: { objId: "rock_1", glyph: "stone" }, worn: null });
    expect(decideContribution(f.session, "resident_0_0", f.deps, { beatS: -Infinity })).toBe(true);
    expect(f.chopped).toHaveLength(1);
  });

  it("a HUNGRY body still eats first — the mark is a chore, not an emergency", () => {
    // F2's ladder, read on this link: a mark presses at `CONTRIBUTE_PRIORITY ×
    // NEED_PRESSURE_S` (a chore), and a need worth more than that wins.
    const f = makeFixture();
    f.fellRows.push({ ...standingMark(), spoken: false });
    f.at.set("resident_0_0", OAK_AT);
    expect(decideContribution(f.session, "resident_0_0", f.deps, { beatS: 500 })).toBe(false);
    expect(f.chopped).toEqual([]);
  });
});

describe("⑤ FALSIFICATION — off the capability there is no bill at all", () => {
  it("`pullLaborOn` false ⇒ the mark is invisible and nothing is decided", () => {
    const f = makeFixture({ pullOn: false });
    f.fellRows.push(standingMark());
    f.at.set("resident_0_0", OAK_AT);
    expect(decideContribution(f.session, "resident_0_0", f.deps, { beatS: -Infinity })).toBe(false);
    expect(f.chopped).toEqual([]);
    expect(f.session.pursuits.size).toBe(0);
  });
});
