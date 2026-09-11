// TRADE TOPOLOGY — WHO THE CARAVAN COMES FROM (R&T §⑤, trade-topology-round.md)
//
// The user's ruling this file is the acceptance of: *"lanes form from resource
// complementarity ALONE."*
//
// WHAT WAS WRONG. `bindPartner` had no caller inside the engine. WHO a town
// traded with was decided by an APP, by pure distance, once, at mount time:
// world-lab's `bindTradePartner` took the smallest great-circle angle, and the
// cluster ring took `Math.hypot` to the nearest hamlet. WHAT the lane carried
// was decided by the ENGINE, per visit, from complementarity. So a town traded
// with whoever stood closest even when that neighbour was its own mirror image
// and had nothing it needed — which is exactly the PRE picture this round
// recorded: bound to `hamlet-1` at 1100 m, `imports: []`, the crate holding
// nothing but the rare cookie, forever.
//
// WHAT IS RIGHT. `chooseTradePartner` (quest-host.ts) runs at each caravan
// bucket edge, prices every enumerable partner's whole basket in seconds
// (`rankLanes` — producer cost + freight ÷ what survives the road) and binds
// the lane worth the most. Distance never forms a lane; it only breaks ties
// between equals (R-3).
//
// THE FIXTURE, and why it can prove it: a primary that WANTS clothing (a
// weaver, no tailor — the T4a premise verbatim) between two hamlets, the NEAR
// one its own mirror (no tailor either) and the FAR one a town with a tailor
// to spare. Distance says hamlet-1; complementarity says hamlet-2. Only one of
// those can be right, and they disagree by construction.
//
// ⏱️ COST. A cluster world is three living towns streamed into one window, so
// it runs ~0.33× sim/wall at dt 1/20. This suite therefore runs at `dt: 1/2`
// (the tiers law: logic at ~10×; a bucket edge is a BOOKS fact and the cargo
// sweep is a task-pool pass, neither of which is motion) and on the LIGHTEST
// complementary hamlet-2 that exists: `startPop` was probed over
// {60, 80, 100, 120, 150, 200} at the ring's own seed 150 and 80 is the
// smallest that licenses a tailor (pop 389 — where the transcript fixture's
// 200 costs pop 973). The scratch spec `scripts/worlds/trade-cluster.spec.json`
// KEEPS 200 so the PRE and POST transcripts diff on one fixture.
//
// ONE boot per describe — the boot, not the assertions, is the cost.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bootTextQuest, type TextQuestRun } from "@shared/world-engine/headless/text-quest.js";
import {
  IMPORT_ALLOTMENT,
  TRADE_IMPORT_KINDS,
} from "@shared/world-engine/kernel/town/trade.js";

const SEED = 12;
/** The caravan's own day on the DOLLHOUSE street profile (no `scale` block). */
const DAY_S = 240;
/** Past the first bucket edge (~t=1) AND the second (~t=96). */
const TWO_BUCKETS_S = 150;
/** …and two more (~t=336, ~t=576). */
const TWO_MORE_S = 500;

type Hamlet = { population: number };
/** The scratch spec's envelope, with the ring's per-seat knob open. */
const clusterDoc = (hamlets: Hamlet[]): unknown => ({
  engine: "aivota-world",
  engineVersion: 1,
  uses: [],
  packs: [],
  game: {
    scope: "town",
    world: { seed: SEED, days: 120, cluster: 2, hamlets, syntax: "b", locale: "en" },
    initial_focus: { type: "house" },
    avatar: "spirit",
  },
});

/** Every `🐴 the caravan comes from …` line the run said (R-7's one diegetic
 *  line — the ONLY thing a player sees of this whole mechanism). */
function bindToasts(run: TextQuestRun): string[] {
  const said: string[] = [];
  run.addPresenterTap({
    toast: (text: string) => {
      if (text.includes("the caravan comes from")) said.push(text);
    },
  });
  return said;
}

// ─────────────────────────────────────────────────────────────────────────
// ① THE ACCEPTANCE (ruling 4) — complementarity wins over distance
// ─────────────────────────────────────────────────────────────────────────
describe("⑤ the engine binds the COMPLEMENTARY lane, not the nearest one", () => {
  let run: TextQuestRun;
  let said: string[];
  const trade = () => run.session.town!.stage.trade!;
  const route = () => trade().route;

  beforeAll(() => {
    run = bootTextQuest({ world: clusterDoc([{ population: 60 }, { population: 80 }]), seed: SEED, dt: 1 / 2 });
    said = bindToasts(run);
    run.advanceS(TWO_BUCKETS_S);
  });
  afterAll(() => run?.dispose());

  it("THE PREMISE: the near hamlet mirrors us, the far one has a tailor", () => {
    // Read off the members' OWN plans through the cluster seam — the reserved
    // house range carries which town a resident belongs to.
    const near = run.session.town!.stage.cluster!.resolveHouse!(1001)!;
    const far = run.session.town!.stage.cluster!.resolveHouse!(2001)!;
    expect(near.plan.works.map((w) => w.type)).not.toContain("tailor");
    expect(far.plan.works.map((w) => w.type)).toContain("tailor");
    // …and we are the unlicensed town that wants what only the far one spares.
    const ours = run.session.town!.plan.works.map((w) => w.type);
    expect(ours).toContain("weaver");
    expect(ours).not.toContain("tailor");
  });

  it("binds hamlet-2 — the FARTHER partner — and says so exactly once", () => {
    expect(route().partnerKey).toBe("hamlet-2");
    expect(route().partnerAt).toBeTruthy();
    // The chord to the ring's second seat (1100 + 300·1). The road is the
    // window's own geometry, so it is the distance, not a fiction.
    expect(route().distanceM).toBeCloseTo(1400, 0);
    expect(said).toEqual(["🐴 the caravan comes from hamlet-2 now"]);
  });

  it("carries CLOTHING — the whole allotment — and none of the authored trinkets", () => {
    expect([...route().imports]).toEqual(["clothing"]);
    expect(trade().importUnitsPerVisit("clothing")).toBe(IMPORT_ALLOTMENT);
    // The rare treat still rides along; it is not a complement, it is a treat.
    expect(route().rare.perVisit).toBeGreaterThan(0);
    expect(trade().importUnitsPerVisit(route().rare.kind)).toBeGreaterThan(0);
    // ⚖️ T2 — the authored kinds are what an UNBOUND line brings. A bound one
    // must never show them, or "derived" would just be "derived plus a floor".
    for (const k of TRADE_IMPORT_KINDS) expect(route().imports).not.toContain(k);
  });

  // ─── R-5 HYSTERESIS ────────────────────────────────────────────────────
  it("does not re-bind on later buckets — the band holds the lane", () => {
    run.advanceS(TWO_MORE_S);
    expect(route().partnerKey).toBe("hamlet-2");
    expect(said).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ② R-4 — a world with neighbours and ZERO complementarity still BINDS
// ─────────────────────────────────────────────────────────────────────────
describe("⑤ R-4 — no complement anywhere still binds (the nearest, by tie-break)", () => {
  let run: TextQuestRun;
  let said: string[];
  const route = () => run.session.town!.stage.trade!.route;

  beforeAll(() => {
    // Both hamlets are the primary's own profile: nobody has anything for
    // anybody. An UNBOUND `away:` fiction here would keep the authored
    // trinkets alive, which ruling 4 reserves for worlds with NO neighbours.
    run = bootTextQuest({ world: clusterDoc([{ population: 60 }, { population: 60 }]), seed: SEED, dt: 1 / 2 });
    said = bindToasts(run);
    run.advanceS(TWO_BUCKETS_S);
  });
  afterAll(() => run?.dispose());

  it("binds the NEARER of two equals (R-3: distance breaks ties, never forms lanes)", () => {
    expect(route().partnerKey).toBe("hamlet-1");
    expect(route().partnerAt).toBeTruthy();
    expect(route().distanceM).toBeCloseTo(1100, 0);
    expect(said).toEqual(["🐴 the caravan comes from hamlet-1 now"]);
  });

  it("and the crate carries the rare treat ONLY — no complement, no trinkets", () => {
    expect([...route().imports]).toEqual([]);
    expect(route().rare.perVisit).toBeGreaterThan(0);
    for (const k of TRADE_IMPORT_KINDS) expect(route().imports).not.toContain(k);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ③ 🔒 THE BYTE-HOLD — a world with NO neighbours is untouched
// ─────────────────────────────────────────────────────────────────────────
describe("🔒 the shipped dollhouse document never binds anyone", () => {
  let run: TextQuestRun;
  let said: string[];
  const route = () => run.session.town!.stage.trade!.route;

  beforeAll(() => {
    // The real shipped content, exactly as `trade-import-channel.arc.test.ts`
    // loads it. It declares no `cluster`, so nothing enumerable has a PLACE
    // (a founded-site `away:` row's `at` is null) and R-6 refuses to bind it.
    const doc = JSON.parse(
      readFileSync(join(process.cwd(), "games", "dollhouse", "src", "game.spec.json"), "utf8"),
    );
    doc.game.world.seed = SEED;
    run = bootTextQuest({ world: doc, seed: SEED, dt: 1 / 2 });
    said = bindToasts(run);
    run.advanceS(TWO_BUCKETS_S);
  });
  afterAll(() => run?.dispose());

  it("stays the abstract away: line, with its authored trinkets, and says nothing", () => {
    expect(route().partnerAt).toBeUndefined();
    expect(route().partnerKey).toMatch(/^away:/);
    expect([...route().imports]).toEqual([...TRADE_IMPORT_KINDS]);
    expect(said).toEqual([]);
  });
});
