/**
 * 🔭 HOVERING CALLS ATTENTION TO LOOSE GOODS (task #51 item 1e).
 *
 * USER RULING (2026-09-04, verbatim): *"Hovering over loose objects (such as
 * the wood piles after a tree is cut) should also call attention to them, to
 * collect them, similar to how the house mode works."*
 *
 * The laws this file pins:
 *
 *  ① IT IS A WEIGHT, NEVER A COMMAND — the attention spark's whole model
 *    ("hovering draws a creature's attention toward the motive that object
 *    affords, firing a need early through the self-assigned path; never a
 *    command"). What is shown reaches THE ONE ENGAGED CREATURE and nobody
 *    else — the no-ambient-response law — and it multiplies the value of the
 *    links that touch that thing rather than issuing anything.
 *
 *  ② WITH A BILL OPEN, THE SALIENCE IS THE WHOLE ANSWER: the engaged body
 *    re-decides and takes the link that draws from what it is being shown,
 *    instead of the one it would otherwise have picked. No second mechanism.
 *
 *  ③ WITH NO BILL, THE AFFORDANCE IS COLLECT: a haul of that good to where
 *    such things belong (the shelf a felled lot's timber lands on), self-issued
 *    as an ordinary contribute slice — so the announce, the abandon sweep and
 *    the delivered toast all work unchanged, and it is one-shot by
 *    construction.
 *
 *  ④ NEVER A CO-LOCATED WALK. A thing lying beside the crate is put away by
 *    the books, not by sending somebody to lift it 1.3 m (the director's own
 *    `CO_LOCATED_PILE_M`, read from the puller's side).
 *
 *  ⑤ FALSIFICATION — off the `pullLabor` capability nothing is taken, which is
 *    what keeps the dollhouse (whose hover still means TIDY / PROVISION)
 *    byte-identical.
 *
 * DB-free / GL-free — `npm run test:engine -- collect`.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bootTextQuest, type TextQuestRun } from "@shared/world-engine/headless/text-quest.js";
import {
  decideCollect,
  decideContribution,
  hoverSalience,
  visibleBills,
  type BillLink,
  type ContributeDeps,
} from "@shared/world-engine/interaction/quest/contribute.js";
import {
  SPARK_SALIENCE,
  collectSiteId,
  isContributePursuit,
} from "@shared/world-engine/kernel/town/pull-labor.js";
import type { QuestSession } from "@shared/world-engine/interaction/quest/quest-host.js";
import { createReservationLedger } from "@shared/world-engine/kernel/town/reservations.js";
import { createTransferLedger } from "@shared/world-engine/kernel/town/transfer.js";
import type { ConstructionOrder } from "@shared/world-engine/kernel/town/construction.js";
import { DOLLHOUSE_SCALE } from "@shared/world-engine/scale.js";
import type { BodyCarry } from "@shared/world-engine/kernel/town/scope-shape.js";

// ═══ THE FIXTURE ══════════════════════════════════════════════════════════
// A felled trunk out in the wild, a crate near the site, and the yard the
// settlement puts loose things in.

const SITE_AT = { x: 100, y: 0 };
const CRATE_AT = { x: 90, y: 0 };
const TRUNK_AT = { x: 40, y: 0 };
const YARD_AT = { x: 95, y: 4 };
const CRATE = "furn_0_crate";
const TRUNK = "flora:oak:wild:oak_3";
const YARD = "town:yard";

interface Fixture {
  session: QuestSession;
  deps: ContributeDeps;
  at: Map<string, { x: number; y: number }>;
  carry: Map<string, BodyCarry>;
  orders: ConstructionOrder[];
  crateStock: Record<string, number>;
  trunkStock: Record<string, number>;
  hauled: string[];
  announced: string[];
  /** What the local spark is showing, and to whom (the host's own closure). */
  hover: { cid: string; objId: string } | null;
  /** Move the yard (④'s co-located case). */
  yardAt: { x: number; y: number };
}

const bare = (): BodyCarry => ({ inHand: null, worn: null });
const withBasket = (capacity: number): BodyCarry => ({
  inHand: { objId: "basket_1", glyph: "basket", bag: { objId: "basket_1", glyph: "basket", stock: {}, capacity } },
  worn: null,
});

function makeFixture(opts?: { pullOn?: boolean; wantsWood?: boolean }): Fixture {
  // The site's bill wants BLOCK by default — so nothing in the world is asking
  // for the trunk's wood, which is case ③'s premise. `wantsWood` opens a bill
  // that wants BOTH heads: the block the near crate holds, and the wood only
  // the far trunk has — the two links case ② weighs against each other.
  const orders: ConstructionOrder[] = [
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
      costs: opts?.wantsWood ? { block: 120, wood: 20 } : { block: 120 },
      pile: { block: 100 },
    } as ConstructionOrder,
  ];
  const crateStock: Record<string, number> = { block: 20 };
  const trunkStock: Record<string, number> = { wood: 8 };
  const at = new Map<string, { x: number; y: number }>();
  const carry = new Map<string, BodyCarry>();
  const hauled: string[] = [];
  const announced: string[] = [];
  const f = {
    at,
    carry,
    orders,
    crateStock,
    trunkStock,
    hauled,
    announced,
    hover: null as { cid: string; objId: string } | null,
    yardAt: { ...YARD_AT },
  } as Fixture;

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
    scopeOfPoint: () => null,
    orderPileIds: (o) => ({ pileId: `orderpile:${o.ord}` }),
    endpointAt: (_s, id) =>
      id === "orderpile:1"
        ? SITE_AT
        : id === CRATE
          ? CRATE_AT
          : id === TRUNK
            ? TRUNK_AT
            : id === YARD
              ? f.yardAt
              : null,
    pileWordOf: () => "house",
    bodyAt: (_s, cid) => at.get(cid) ?? null,
    carryOf: (_s, cid) => carry.get(cid) ?? bare(),
    bagCeilingOf: () => 0,
    orderSiteId: (ord) => `o:${ord}`,
    buildworkSiteAt: () => null,
    siteMaterialSources: () => [
      { id: CRATE, stack: crateStock, d: 10 },
      { id: TRUNK, stack: trunkStock, d: 60 },
    ],
    freeHeadStockWithinReach: (_s, _a, head) =>
      (head === "block" ? crateStock.block ?? 0 : (crateStock.wood ?? 0) + (trunkStock.wood ?? 0)),
    agrHolder: (id) => `agr:${id}`,
    billIssuer: () => "player",
    drawSourceShelf: () => {},
    issueTransferHaul: (_s, cid, agreementId) => void hauled.push(`${cid}|${agreementId}`),
    standAndWork: () => {},
    chopAt: () => {},
    announce: (_s, cid) => void announced.push(cid),
    motiveWeight: () => 1,
    forgoneS: () => 0,
    // THE TWO HOVER HOOKS, wired exactly as the host wires them.
    salience: (_s, cid, link) => hoverSalience(f.hover, cid, link),
    collectDestOf: () => ({ id: YARD, at: f.yardAt, word: "yard" }),
    looseGoodOf: (s, _cid, objId) =>
      objId === TRUNK && (trunkStock.wood ?? 0) > 0
        ? { head: "wood", units: trunkStock.wood!, at: TRUNK_AT }
        : null,
  };

  f.session = session;
  f.deps = deps;
  return f;
}

const link = (from: string): BillLink => ({
  siteId: "o:1",
  ord: 1,
  link: "haul",
  head: "wood",
  units: 4,
  from,
  to: "orderpile:1",
  at: TRUNK_AT,
  destWord: "house",
  unitValueS: 10,
  urgency: 1,
  spoken: false,
  issuer: "player",
  seats: Number.POSITIVE_INFINITY,
});

// ═══ ① THE WEIGHT ═════════════════════════════════════════════════════════

describe("① the hover is a WEIGHT on what the engaged creature is shown", () => {
  it("nothing hovered ⇒ every link weighs 1 (the shipped behaviour)", () => {
    expect(hoverSalience(null, "mara", link(TRUNK))).toBe(1);
  });

  it("the ENGAGED creature's links off that thing weigh SPARK_SALIENCE", () => {
    expect(hoverSalience({ cid: "mara", objId: TRUNK }, "mara", link(TRUNK))).toBe(SPARK_SALIENCE);
  });

  it("🚨 AND NOBODY ELSE'S DO — the no-ambient-response law", () => {
    // Pointing at a thing is not an announcement to the town: a creature the
    // player never engaged is not nudged and never pulled into somebody else's
    // business.
    expect(hoverSalience({ cid: "mara", objId: TRUNK }, "orrin", link(TRUNK))).toBe(1);
  });

  it("a link that does not touch the hovered thing weighs 1", () => {
    expect(hoverSalience({ cid: "mara", objId: TRUNK }, "mara", link(CRATE))).toBe(1);
  });

  it("…and it reaches a FELL link by the thing it acts ON, not only by `from`", () => {
    const chop: BillLink = { ...link(CRATE), link: "fell", objId: TRUNK, from: undefined, units: undefined };
    expect(hoverSalience({ cid: "mara", objId: TRUNK }, "mara", chop)).toBe(SPARK_SALIENCE);
  });
});

// ═══ ② WITH A BILL OPEN ═══════════════════════════════════════════════════

describe("② with a bill open, the salience RE-ORDERS the links", () => {
  it("PREMISE — unhovered, the near crate's link wins", () => {
    const f = makeFixture({ wantsWood: true });
    f.at.set("mara", SITE_AT);
    // Two links serve this bill: block from the crate ten metres away, and wood
    // from the trunk sixty metres out. Nothing is being shown to anybody.
    expect(new Set(visibleBills(f.session, "mara", f.deps).map((l) => l.from))).toEqual(
      new Set([CRATE, TRUNK]),
    );
    expect(decideContribution(f.session, "mara", f.deps, { beatS: -Infinity })).toBe(true);
    expect(f.session.transfers.active()[0]!.from).toBe(CRATE);
  });

  it("🔭 …and hovering the TRUNK makes the same body take the far one instead", () => {
    const f = makeFixture({ wantsWood: true });
    f.at.set("mara", SITE_AT);
    f.hover = { cid: "mara", objId: TRUNK };
    expect(decideContribution(f.session, "mara", f.deps, { beatS: -Infinity })).toBe(true);
    expect(f.session.transfers.active()[0]!.from).toBe(TRUNK);
    // ⚖️ …AND ONLY FOR THE BODY BEING SHOWN. The same world, another body, and
    // the near crate wins again — the hover moved one creature's mind, not the
    // bill's own worth.
    f.at.set("orrin", SITE_AT);
    expect(decideContribution(f.session, "orrin", f.deps, { beatS: -Infinity })).toBe(true);
    expect(f.session.transfers.active().find((a) => a.executor === "orrin")!.from).toBe(CRATE);
  });

  it("🚨 AND COLLECT REFUSES WHILE A BILL IS DRAWING FROM IT — never two arms on one stack", () => {
    const f = makeFixture({ wantsWood: true });
    f.at.set("mara", SITE_AT);
    f.hover = { cid: "mara", objId: TRUNK };
    // The bill's own wood link names this very trunk, so the salience above is
    // the whole answer and a collect would promise the same units twice.
    expect(visibleBills(f.session, "mara", f.deps).some((l) => l.from === TRUNK)).toBe(true);
    expect(decideCollect(f.session, "mara", TRUNK, f.deps)).toBe(false);
    expect(f.session.transfers.all()).toEqual([]);
  });
});

// ═══ ③ WITH NO BILL ═══════════════════════════════════════════════════════

describe("③ with no bill wanting it, the affordance is COLLECT", () => {
  it("the engaged body hauls it to where such things belong", () => {
    const f = makeFixture();
    f.at.set("mara", TRUNK_AT);
    f.carry.set("mara", withBasket(8));
    expect(decideCollect(f.session, "mara", TRUNK, f.deps)).toBe(true);
    const a = f.session.transfers.active()[0]!;
    expect(a.from).toBe(TRUNK);
    expect(a.to).toBe(YARD);
    expect(a.goods).toEqual({ wood: 8 });
    expect(a.executor).toBe("mara");
    expect(f.hauled).toEqual([`mara|${a.id}`]);
    expect(f.announced).toEqual(["mara"]); // ⚖️ never a silent claim
    const p = f.session.pursuits.get("mara");
    expect(isContributePursuit(p)).toBe(true);
    expect(p!.bill!.siteId).toBe(collectSiteId(YARD));
    expect(p!.bill!.spoken).toBe(false); // pointing is not an order
    expect(f.session.reservations.reservedUnits(TRUNK, "wood")).toBe(8);
  });

  it("the slice is the body's OWN carry — bagless is one whole thing", () => {
    const f = makeFixture();
    f.at.set("mara", TRUNK_AT);
    expect(decideCollect(f.session, "mara", TRUNK, f.deps)).toBe(true);
    expect(f.session.transfers.active()[0]!.goods).toEqual({ wood: 1 });
  });

  it("NO DOUBLE-RESERVE — the second body takes what the first left", () => {
    const f = makeFixture();
    f.at.set("mara", TRUNK_AT);
    f.at.set("orrin", TRUNK_AT);
    f.carry.set("mara", withBasket(5));
    f.carry.set("orrin", withBasket(5));
    expect(decideCollect(f.session, "mara", TRUNK, f.deps)).toBe(true);
    expect(decideCollect(f.session, "orrin", TRUNK, f.deps)).toBe(true);
    // Σ promised ≤ the stack, always.
    const promised = f.session.transfers.active().reduce((s, a) => s + (a.goods.wood ?? 0), 0);
    expect(promised).toBe(8);
    expect(f.session.reservations.reservedUnits(TRUNK, "wood")).toBe(8);
    // …and a third finds nothing free to promise.
    f.at.set("hadar", TRUNK_AT);
    f.carry.set("hadar", withBasket(5));
    expect(decideCollect(f.session, "hadar", TRUNK, f.deps)).toBe(false);
  });

  it("a thing that is not a loose good affords nothing", () => {
    const f = makeFixture();
    f.at.set("mara", TRUNK_AT);
    expect(decideCollect(f.session, "mara", CRATE, f.deps)).toBe(false);
    expect(f.session.transfers.all()).toEqual([]);
  });

  it("an EMPTIED heap affords nothing", () => {
    const f = makeFixture();
    f.trunkStock.wood = 0;
    f.at.set("mara", TRUNK_AT);
    expect(decideCollect(f.session, "mara", TRUNK, f.deps)).toBe(false);
  });
});

// ═══ ④ THE CO-LOCATED LAW ═════════════════════════════════════════════════

describe("④ never a co-located walk", () => {
  it("a thing lying beside its own crate is NOT collected by walking", () => {
    const f = makeFixture();
    f.yardAt = { x: TRUNK_AT.x + 1.3, y: TRUNK_AT.y }; // the 1.3 m box-to-box shuffle
    f.at.set("mara", TRUNK_AT);
    expect(decideCollect(f.session, "mara", TRUNK, f.deps)).toBe(false);
    expect(f.session.transfers.all()).toEqual([]);
  });
});

// ═══ ⑤ FALSIFICATION ══════════════════════════════════════════════════════

describe("⑤ off the capability, the hover takes nothing", () => {
  it("`pullLaborOn` false ⇒ no collect, no agreement, no pursuit", () => {
    const f = makeFixture({ pullOn: false });
    f.at.set("mara", TRUNK_AT);
    expect(decideCollect(f.session, "mara", TRUNK, f.deps)).toBe(false);
    expect(f.session.transfers.all()).toEqual([]);
    expect(f.session.pursuits.size).toBe(0);
  });
});

// ═══ ⑥ THE HOST — the whole chain, on a real world ════════════════════════
//
// The wiring the stub deps above cannot see: the GAZE writes the hovered good,
// the ENGAGED creature is the only one it reaches, and the two items meet — a
// tree MARKED and felled by 1d leaves the heap that 1e then collects. One boot,
// driven through the same `run.look` gaze shape GL produces.

describe("⑥ the host: a marked tree falls, and its heap is collected by the engaged body", () => {
  let run: TextQuestRun;
  const doc = JSON.parse(readFileSync(join(process.cwd(), "scripts", "worlds", "frontier.spec.json"), "utf8"));

  beforeAll(() => {
    run = bootTextQuest({ world: doc, seed: 11, dt: 0.5 });
    run.advance(20); // let the streamer stand the residents up
  }, 600_000);

  afterAll(() => run?.dispose());

  const busy = (cid: string): boolean =>
    run.session.pursuits.has(cid) ||
    run.session.walk.has(cid) ||
    run.session.needStep.has(cid) ||
    run.session.liveNeedBodies.has(cid) ||
    (run.session.npcTasks.get(cid)?.length ?? 0) > 0;

  it("🪓🔭 the mark is felled, then the hovered heap is hauled to the yard", () => {
    const c = run.session.town!.stage.center;
    const oak = { id: "probe:oak", species: "oak", x: c.x + 40, y: c.y - 30, stock: { wood: 6 } };
    if (!run.host.addWildFeature(oak)) throw new Error("the probe oak would not spawn — fixture broken, not a finding");
    const ep = "flora:oak:probe:oak"; // an embodied plant keeps its `flora:` key through the fall
    const book = run.session.town!.deltas;

    // ① 1d — A MARK, AND A BODY THAT TAKES IT. (Posted directly: the press and
    //    the sentence are pinned in wild-body-press / feature-removal; what is
    //    under test here is that the MARK ITSELF is work anybody may pull.)
    book.designateFell({
      featureId: "probe:oak",
      at: { x: oak.x, y: oak.y },
      word: "plants",
      issuer: "player",
      spoken: true,
      postedDay: 0,
    });
    const standing = () => run.session.wilderness!.features.find((f) => f.id === "probe:oak");
    for (let i = 0; i < 40 && !standing()?.downed; i++) run.advanceS(10);
    expect(standing()?.downed).toBe(true);
    // …and its timber never moved (the felling's own conservation form).
    expect(run.session.containerRecords.get(ep)?.stock?.["wood"]).toBe(6);
    expect(book.fellOrders().some((r) => r.featureId === "probe:oak")).toBe(false); // the mark retired

    // ② 1e — NOW SHOW IT TO SOMEBODY. Engagement is the gate: only the body the
    //    player has drawn in responds.
    const who = ["resident_24_0", "resident_24_1"].find((cid) => !busy(cid));
    if (!who) throw new Error("no idle resident to engage — fixture broken, not a finding");
    const other = ["resident_24_0", "resident_24_1"].find((cid) => cid !== who)!;
    run.session.sparkAttention.set("player", { cid: who, strength: 1 });
    run.session.sparkEngageHold.set("player", run.session.townClock + 60);
    run.clearLook();
    run.advance(1);
    const objId = Object.keys(run.state.objects).find((k) => k.includes("probe:oak"));
    expect(objId).toBe(ep); // the heap IS the container — one key through the fall
    run.look(oak.x, oak.y);
    let landed = "";
    for (let i = 0; i < 40 && landed !== ep; i++) {
      run.stepFrame();
      landed = run.view.probe().intent?.cursor?.hoverId ?? "";
    }
    expect(landed).toBe(ep); // the gaze really is on the heap
    for (let i = 0; i < 20; i++) run.stepFrame(); // the hold (ramp → the chore threshold)

    // ③ THE ENGAGED BODY TOOK IT — to where loose things belong, as an ordinary
    //    contribute slice.
    const p = run.session.pursuits.get(who);
    expect(isContributePursuit(p)).toBe(true);
    expect(p!.bill!.link).toBe("haul");
    expect(p!.bill!.head).toBe("wood");
    expect(p!.bill!.siteId.startsWith("collect:")).toBe(true);
    const a = run.session.transfers.all().find((r) => r.from === ep);
    expect(a).toBeDefined();
    expect(a!.executor).toBe(who);
    expect(a!.to).not.toBe(ep);
    // ④ 🚨 AND NOBODY ELSE WAS PULLED IN — the no-ambient-response law, live.
    const q = run.session.pursuits.get(other);
    expect(q?.bill?.siteId?.startsWith("collect:") ?? false).toBe(false);
  }, 600_000);
});
