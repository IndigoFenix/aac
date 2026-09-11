/**
 * ⚖️ SKILLS AT THE PULL DECIDER (skill-learning-round.md §3.2).
 *
 * The seat: `contribute.ts` ① — `valueS = link.unitValueS × slice × w × m`,
 * where `m = skillMultiplier(session, cid, skillFor(link.link, link.head))`.
 * Labour is valued AT PAR on a construction/craft row (the row's labour left,
 * in the very seconds a hand banks), so the honest way to say "this body does
 * m× the work per second" is to raise the VALUE — a full-labour `handsS` on
 * `claimCost` would zero every net by construction, which is why there has
 * never been one.
 *
 * What this file pins, on the decider's own synthetic session (no boot, no
 * quest-host value import — the `pull-labor-fell.test.ts` idiom):
 *
 *  ① 🚨 DAY ONE IS UNCHANGED — with nobody practised, every decision is the one
 *    the pre-skill tree made. (Falsification for everything below.)
 *  ② THE PRACTISED BODY'S SLICE NETS HIGHER — two bodies at EQUAL DISTANCE from
 *    one mark, sandwiched by `beatS`: the practised one takes it, the novice's
 *    own dinner outbids it. That IS "nets higher", measured through the gate
 *    the engine actually uses rather than by reading a private number.
 *  ③ ROLES EMERGE — the same body, the same world, the same two links: a novice
 *    takes the BENCH SEAT (worth 5 % more to the settlement) and a practised
 *    FELLER walks past it to the tree. Nothing else moved.
 *  ④ THE TWO SIDES AGREE ON WHICH TRADE IT IS — a craft bench is `refining` on
 *    both sides (its row carries no output head), and practice in an unrelated
 *    trade cannot move it while practice in the right one can.
 *
 * DB-free / GL-free — `npm run test:engine -- skills`.
 */
import { describe, it, expect } from "@jest/globals";
import {
  decideContribution,
  visibleBills,
  type ContributeDeps,
} from "@shared/world-engine/interaction/quest/contribute.js";
import {
  craftSiteId,
  fellSiteId,
  type CraftBillRow,
  type FellRow,
} from "@shared/world-engine/kernel/town/pull-labor.js";
import {
  DEFAULT_SKILL_CATALOGUE,
  practiceSkill,
  skillFor,
  skillMultiplier,
  type BodySkillRow,
} from "@shared/world-engine/kernel/town/skills.js";
import type { QuestSession } from "@shared/world-engine/interaction/quest/quest-host.js";
import { createReservationLedger } from "@shared/world-engine/kernel/town/reservations.js";
import { createTransferLedger } from "@shared/world-engine/kernel/town/transfer.js";
import { DOLLHOUSE_SCALE } from "@shared/world-engine/scale.js";
import type { BodyCarry } from "@shared/world-engine/kernel/town/scope-shape.js";

// Both offers stand the SAME distance from the body, so the claim's price is
// identical on both sides and only the VALUE can decide.
const BODY_AT = { x: 0, y: 0 };
const OAK_AT = { x: 20, y: 0 };
const BENCH_AT = { x: -20, y: 0 };
const OAK = "flora:oak:wild:oak_3";
const SPOT = "furn_0_spot";
const CRAFT_HI = 0;

interface Fixture {
  session: QuestSession;
  deps: ContributeDeps;
  fellRows: FellRow[];
  craftRows: CraftBillRow[];
  chopped: string[];
  worked: string[];
}

const bare = (): BodyCarry => ({ inHand: null, worn: null });

/** A standing mark: one tree, one chopper, nothing to carry. */
const mark = (): FellRow => ({
  siteId: fellSiteId("wild:oak_3"),
  objId: OAK,
  at: OAK_AT,
  word: "plants",
  standing: true,
  spoken: false,
  issuer: "town",
});

/** A bench with its materials in and `leftS` of labour still owed. */
const bench = (leftS: number, head = "cloth"): CraftBillRow => ({
  siteId: craftSiteId(CRAFT_HI),
  hi: CRAFT_HI,
  spotId: SPOT,
  at: BENCH_AT,
  missing: {},
  required: { [head]: 2 },
  work: { at: BENCH_AT, leftS, urgency: 1 },
  destWord: "house",
  spoken: false,
});

function makeFixture(): Fixture {
  const fellRows: FellRow[] = [];
  const craftRows: CraftBillRow[] = [];
  const chopped: string[] = [];
  const worked: string[] = [];
  const at = new Map<string, { x: number; y: number }>();

  const session = {
    town: {} as unknown,
    wilderness: {} as unknown, // ⇒ `pullLaborOn` (the capability, fail-closed elsewhere)
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
    // THE ONLY NEW FIELDS: the practice ledger and the world's catalogue.
    bodySkills: new Map<string, Map<string, BodySkillRow>>(),
    skills: DEFAULT_SKILL_CATALOGUE,
  } as unknown as QuestSession;

  const deps: ContributeDeps = {
    deltasOf: () => ({ orders: () => [] }),
    scopeCtxOf: () => ({ townId: () => "town" }) as never,
    scopeOfPoint: () => null,
    orderPileIds: (o) => ({ pileId: `orderpile:${o.ord}` }),
    endpointAt: (_s, id) => (id === OAK ? OAK_AT : id === SPOT ? BENCH_AT : null),
    pileWordOf: () => "house",
    bodyAt: (_s, cid) => at.get(cid) ?? null,
    carryOf: () => bare(),
    bagCeilingOf: () => 0,
    orderSiteId: (ord) => `o:${ord}`,
    buildworkSiteAt: () => null,
    // ONE seat at the bench, always free — the fell mark mints its own.
    seatsOf: (_s, siteId) =>
      siteId === craftSiteId(CRAFT_HI)
        ? [{ siteId, link: "refine" as const, key: `${siteId}#seat0`, at: BENCH_AT, index: 0 }]
        : [],
    siteMaterialSources: () => [],
    freeHeadStockWithinReach: () => 0,
    agrHolder: (id) => `agr:${id}`,
    billIssuer: () => "town",
    drawSourceShelf: () => {},
    issueTransferHaul: () => {},
    standAndWork: (_s, cid) => void worked.push(cid),
    chopAt: (_s, cid) => void chopped.push(cid),
    fellRowsOf: () => fellRows,
    craftRowsOf: () => craftRows,
    announce: () => {},
    motiveWeight: () => 1,
    forgoneS: () => 0,
  };

  at.set("novice", BODY_AT);
  at.set("feller", BODY_AT);
  return { session, deps, fellRows, craftRows, chopped, worked };
}

/** The `unitValueS` the reader gives each link right now — derived, never
 *  typed in, so a change in either row's pricing re-tunes this file by itself. */
function valuesOf(f: Fixture, cid: string): { fell: number; refine: number } {
  const links = visibleBills(f.session, cid, f.deps);
  const fell = links.find((l) => l.link === "fell");
  const refine = links.find((l) => l.link === "refine");
  expect(fell).toBeDefined();
  expect(refine).toBeDefined();
  return { fell: fell!.unitValueS, refine: refine!.unitValueS };
}

/** The bench `leftS` at which the SETTLEMENT values the seat `ratio` times the
 *  tree — solved from the reader's own arithmetic rather than guessed. */
function benchLeftSFor(ratio: number, head = "cloth"): number {
  const probe = makeFixture();
  probe.fellRows.push(mark());
  probe.craftRows.push(bench(1000, head));
  const v = valuesOf(probe, "novice");
  return (1000 * ratio * v.fell) / v.refine;
}

// ═══ ① DAY ONE ════════════════════════════════════════════════════════════

describe("① 🚨 with nobody practised the decider is the pre-skill decider", () => {
  it("reads exactly 1× on every link, so every value is the one it always was", () => {
    const f = makeFixture();
    f.fellRows.push(mark());
    f.craftRows.push(bench(1000));
    expect(skillMultiplier(f.session, "novice", "felling")).toBe(1);
    expect(skillMultiplier(f.session, "novice", "refining")).toBe(1);
    const v = valuesOf(f, "novice");
    // …and the LINK values themselves are untouched — the multiplier rides the
    // decider's ① line, never the reader's row pricing.
    const g = makeFixture();
    g.fellRows.push(mark());
    g.craftRows.push(bench(1000));
    practiceSkill(g.session, "novice", "felling", 100_000);
    expect(valuesOf(g, "novice")).toEqual(v);
  });
});

// ═══ ② THE PRACTISED SLICE NETS HIGHER ════════════════════════════════════

describe("② a practised feller's slice nets higher than a novice's", () => {
  it("📏 the SANDWICH: one beatS the practised body clears and the novice does not", () => {
    // Both bodies stand on the same spot, so the claim's price is identical and
    // the ONLY difference between them is what they have done before.
    const f = makeFixture();
    f.fellRows.push(mark());
    practiceSkill(f.session, "feller", "felling", 900); // thirty chops
    const m = skillMultiplier(f.session, "feller", "felling");
    expect(m).toBeGreaterThan(1.4);

    // The rung both nets are quoted on: `CONTRIBUTE_PRIORITY × NEED_PRESSURE_S
    // × urgency × w × m − cost`. Rather than restating the constants, bracket
    // it: no beatS can separate two IDENTICAL bodies, and this one separates
    // these two — which is the whole claim.
    const links = visibleBills(f.session, "novice", f.deps);
    const fell = links.find((l) => l.link === "fell")!;
    expect(fell.objId).toBe(OAK);

    // Search for a separating beatS on the body rung (a bisection over the one
    // number the gate reads — no private field is touched).
    let lo = 0;
    let hi = 1e6;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      const g = makeFixture();
      g.fellRows.push(mark());
      if (decideContribution(g.session, "novice", g.deps, { beatS: mid })) lo = mid;
      else hi = mid;
    }
    const noviceNet = lo; // the novice's own bodyNetS, found by the gate itself

    const above = makeFixture();
    above.fellRows.push(mark());
    practiceSkill(above.session, "feller", "felling", 900);
    // Just ABOVE the novice's net: the novice declines, the practised one takes it.
    const beatS = noviceNet * 1.05;
    expect(decideContribution(above.session, "novice", above.deps, { beatS })).toBe(false);
    expect(decideContribution(above.session, "feller", above.deps, { beatS })).toBe(true);
    expect(above.chopped).toEqual(["feller"]);
  });
});

// ═══ ③ ROLES EMERGE ═══════════════════════════════════════════════════════

describe("③ a practised feller walks past the bench the novice takes", () => {
  const RATIO = 1.05; // the settlement values the seat 5 % above the tree

  it("📏 the SAME world, the SAME body: practice flips the argmax", () => {
    const leftS = benchLeftSFor(RATIO);

    const novice = makeFixture();
    novice.fellRows.push(mark());
    novice.craftRows.push(bench(leftS));
    expect(decideContribution(novice.session, "novice", novice.deps, { beatS: -Infinity })).toBe(true);
    expect(novice.worked).toEqual(["novice"]); // the bench, because it is worth more
    expect(novice.chopped).toEqual([]);

    const feller = makeFixture();
    feller.fellRows.push(mark());
    feller.craftRows.push(bench(leftS));
    practiceSkill(feller.session, "feller", "felling", 900);
    expect(skillMultiplier(feller.session, "feller", "felling")).toBeGreaterThan(RATIO);
    expect(decideContribution(feller.session, "feller", feller.deps, { beatS: -Infinity })).toBe(true);
    expect(feller.chopped).toEqual(["feller"]); // …and now the tree is worth more to HIM
    expect(feller.worked).toEqual([]);
  });

  it("🚫 …and the flip is the SKILL, not the practice: a REFINER still takes the bench", () => {
    const leftS = benchLeftSFor(RATIO);
    const refiner = makeFixture();
    refiner.fellRows.push(mark());
    refiner.craftRows.push(bench(leftS));
    // The same seconds, spent on the other trade.
    practiceSkill(refiner.session, "feller", "refining", 900);
    expect(decideContribution(refiner.session, "feller", refiner.deps, { beatS: -Infinity })).toBe(true);
    expect(refiner.worked).toEqual(["feller"]);
    expect(refiner.chopped).toEqual([]);
  });
});

// ═══ ④ WHICH TRADE ════════════════════════════════════════════════════════

describe("④ the two sides name the SAME trade", () => {
  it("a craft BENCH is `refining` on both sides — its row carries no output head", () => {
    // A `CraftBillRow` has inputs (`required`) and no product head, so the
    // dwell link the reader pushes for it carries none either — and the
    // director's own craft seat asks `skillFor("refine", job.produces)`, which
    // for furniture is `refining` too. The two agree because a bench never
    // makes wood; the MILL (a `refine` ORDER) is the wood path, and its link
    // does carry `head` (`SiteBillRow.work.head`, set from `o.produces`) so
    // `carpentry` is priced and banked by the same name there.
    const f = makeFixture();
    f.fellRows.push(mark());
    f.craftRows.push(bench(1000, "wood")); // "wood" is an INPUT here, not the output
    const link = visibleBills(f.session, "novice", f.deps).find((l) => l.link === "refine")!;
    expect(link.head).toBeUndefined();
    expect(skillFor("refine", link.head)).toBe("refining");
  });

  it("practice in an unrelated trade cannot move a bench seat", () => {
    const leftS = benchLeftSFor(0.95);
    const forager = makeFixture();
    forager.fellRows.push(mark());
    forager.craftRows.push(bench(leftS));
    practiceSkill(forager.session, "novice", "foraging", 4000);
    expect(decideContribution(forager.session, "novice", forager.deps, { beatS: -Infinity })).toBe(true);
    expect(forager.chopped).toEqual(["novice"]); // berries teach nobody to mill
    expect(forager.worked).toEqual([]);

    const refiner = makeFixture();
    refiner.fellRows.push(mark());
    refiner.craftRows.push(bench(leftS));
    practiceSkill(refiner.session, "novice", "refining", 4000);
    expect(decideContribution(refiner.session, "novice", refiner.deps, { beatS: -Infinity })).toBe(true);
    expect(refiner.worked).toEqual(["novice"]); // …and the practised hand wins it back
  });
});
