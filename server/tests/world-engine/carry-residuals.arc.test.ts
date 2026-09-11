/**
 * ⚖️ CARRY RESIDUALS (2026-09-06) — AN ABANDONED LOAD IS A SOURCE, AND A
 * BARE-HANDED RE-ISSUE PROMISES WHAT IT CAN CARRY.
 *
 * Two residuals off the carry-integrity closer, both about what happens to
 * GOODS when a haul gives up:
 *
 *  R-D  `abandonHaul` used to set bagged units down as BARE LOOSE PROPS
 *       (`dropFromStack` → `spawnLooseProp`, one per unit). A bare prop is not
 *       a container — `spawnLooseProp` stamps `relation` only for a container
 *       glyph — so `stockEndpointOf` answers NULL for it: no source for
 *       `siteMaterialSources`, nothing `decideCollect` can build a haul from.
 *       The units were conserved, visible, and unreachable by every row in the
 *       game. Under pull labour a BAGGED abandon now sets the BASKET DOWN WITH
 *       THE LOAD IN IT — a registered container standing on the ground, which
 *       `stockedEntries` has always listed and `looseGoodOf` now answers for.
 *
 *  R-B  the bag-leg re-issue (a porter that could not reach its basket goes on
 *       bare-handed) kept the bill's full promise, so an eight-block row
 *       delivered ONE and announced *"delivered 1 of 8"*. The promise was the
 *       lie: `narrowHaulTo` cuts the row to the body's real capacity and hands
 *       the surplus back — reservation included — for a porter that still has
 *       a basket.
 *
 * 🚨 HOW R-D IS FORCED, AND WHY IT HAS TO BE FORCED. On the frontier arc every
 * abandon fires on the BAG or LOAD leg, before any goods are taken (`set down
 * 0× block`, measured at every shipped dt by two rounds now) — the one event
 * this pin is about does not happen on its own. So it is provoked through the
 * host's OWN doors and nothing else: `host.addWildFeature` (the public door
 * `pull-labor-collect` ⑥ plants its probe oak with) grows a ring of SOLID rock
 * outcrops around a porter that is really carrying a loaded basket. Nothing is
 * written into the session; the world simply closes around a body, the stall
 * watchdog force-passes the vertex it can no longer reach, and `onAbandon`
 * runs for real.
 *
 * ⚠️ TWO THINGS THE HARNESS LEARNED THE HARD WAY, both recorded so the next
 * reader does not repeat them:
 *   • A DOWNED feature and a flora BODY are not obstacles — `spawnWildFeature`
 *     marks only the standing OBJECT arm `solid`, and a felled trunk is
 *     `solid: false` on purpose. `species: "rock"` (kind `mineral`, never
 *     embodied) is the one that walls.
 *   • The wall must go up FAR FROM EVERY HUMAN. A FLOW force-pass is view-gated
 *     (`stalled && !watched`, VIEW_R = 42 m) because the host re-routes bodies a
 *     person can see — so a thicket planted in view freezes the porter forever
 *     and never abandons. Measured: the body sat motionless for 110 s with the
 *     agreement still `moving`.
 *
 * DB-free / GL-free — `npm run test:engine -- residuals`.
 */
import { describe, it, expect, afterAll } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bootTextQuest, type TextQuestRun } from "@shared/world-engine/headless/text-quest.js";
import { livesOnTheFloor } from "@shared/world-engine/kernel/town/container-home.js";
import type { WildernessFeature } from "@shared/world-engine/interaction/quest/wilderness.js";

const DOC = () =>
  JSON.parse(readFileSync(join(process.cwd(), "scripts", "worlds", "frontier.spec.json"), "utf8"));

let live: TextQuestRun | null = null;
afterAll(() => live?.dispose());

function totalUnits(stock: Readonly<Record<string, number>> | undefined): number {
  let n = 0;
  for (const v of Object.values(stock ?? {})) n += Math.max(0, v);
  return n;
}

describe("⚖️ R-D — a wedged carrier sets the BASKET down, load and all", () => {
  it("🧺 the abandoned load stands on the ground as a drawable stack", () => {
    const run = (live = bootTextQuest({ world: DOC(), seed: 11, dt: 0.5 }));
    const { session, state } = run;

    /** A porter really carrying a LOADED basket for a live haul. */
    const loadedPorter = (): { cid: string; objId: string; units: number; agr: string } | null => {
      for (const a of session.transfers.all()) {
        if (a.status !== "moving" || !a.executor) continue;
        if (Object.values(a.carried ?? {}).reduce((s, n) => s + n, 0) <= 0) continue;
        for (const [objId, o] of Object.entries(state.objects)) {
          if (o.carriedBy !== a.executor) continue;
          const rec = session.containerRecords.get(objId);
          if (!rec?.glyph || !livesOnTheFloor(rec.glyph)) continue;
          const units = totalUnits(rec.stock);
          if (units > 0) return { cid: a.executor, objId, units, agr: a.id };
        }
      }
      return null;
    };

    let spoke = false;
    let target: { cid: string; objId: string; units: number; agr: string } | null = null;
    for (let i = 0; i < 1600 && !target; i++) {
      run.stepFrame();
      if (!spoke && session.townClock >= 12) {
        spoke = true;
        run.speak("build + house"); // the arc: a house wants 120 blocks staged
      }
      const p = loadedPorter();
      if (!p) continue;
      const av = state.avatars[p.cid];
      if (!av) continue;
      const humans = Object.values(state.avatars).filter(
        (a) => !/^(resident_|pet_|npc_|settler|flora:|wild:|fauna:)/.test(a.id),
      );
      if (!humans.every((h) => Math.hypot(h.x - av.x, h.y - av.y) > 65)) continue;
      target = p;
      // THE WALL: 72 standing outcrops on a 2.2 m circle — 0.19 m apart, each
      // 0.55 m of solid sphere, so there is no gap a body fits through.
      for (let k = 0; k < 72; k++) {
        const ang = (k / 72) * Math.PI * 2;
        const f: WildernessFeature = {
          id: `probe:wall_${k}`,
          species: "rock",
          x: av.x + Math.cos(ang) * 2.2,
          y: av.y + Math.sin(ang) * 2.2,
          stock: { stone: 10 },
        };
        run.host.addWildFeature(f);
      }
    }
    // PREMISE, not the finding: the arc really did put a loaded basket in a
    // pair of hands out of sight. Without it every assertion below is vacuous.
    if (!target) throw new Error("no loaded porter far from every human — fixture broken, not a finding");

    const loadWas = target.units;
    const bagObj = () => state.objects[target!.objId];
    for (let i = 0; i < 400 && bagObj()?.carriedBy; i++) run.stepFrame();

    // ① THE BASKET IS ON THE GROUND, and it is the SAME basket.
    expect(bagObj()).toBeDefined();
    expect(bagObj()!.carriedBy).toBeFalsy();
    const rec = session.containerRecords.get(target.objId);
    expect(rec?.mount).toBe("loose");

    // ② THE LOAD IS STILL IN IT — units MOVE, they are never minted or lost
    //    (item conservation). A bare-prop unpack would have emptied the stack.
    expect(totalUnits(rec?.stock)).toBe(loadWas);

    // ③ …AND THAT MAKES IT A SOURCE. `siteMaterialSources` iterates
    //    `stockedEntries` — every row that has a `stock` — and `looseGoodOf`
    //    asks exactly these questions: a stack, resolvable, nobody's, not worn
    //    or folded, not in anybody's hands. All four hold, which is the whole
    //    of "an abandoned load is not stranded".
    expect(rec?.stock).toBeDefined();
    expect(rec?.mount === "worn" || rec?.mount === "folded").toBe(false);

    // ④ THE BILL REOPENS: the agreement is terminal, so the bookkeeper's sweep
    //    posts the work again rather than waiting on a trip nobody is walking.
    expect(session.transfers.get(target.agr)?.status).toBe("failed");
  }, 600_000);
});

describe("⚖️ R-B — a haul that loses its basket keeps an honest promise", () => {
  it("📦 another basket first, and a bare trip promises only what hands hold", () => {
    live?.dispose();
    const run = (live = bootTextQuest({ world: DOC(), seed: 11, dt: 0.5 }));
    const { session, state } = run;

    // The host says so out loud at the seam, and the LEDGER is read in the same
    // breath inside the log hook — so this pins the row's LIVE promise at the
    // instant the trip is re-cut, never a number scraped out of a sentence.
    const withAnotherBasket: string[] = [];
    const bare: { agr: string; promised: number }[] = [];
    const shortDeliveries: string[] = [];
    const realLog = console.log;
    console.log = (...a: unknown[]) => {
      const s = a.map((x) => String(x)).join(" ");
      const alt = /\[haul\] \S+ RE-ISSUED (\S+) with another basket/.exec(s);
      if (alt) withAnotherBasket.push(alt[1]!);
      const m = /\[haul\] \S+ RE-ISSUED (\S+) bare-handed/.exec(s);
      if (m) {
        const goods = session.transfers.get(m[1]!)?.goods ?? {};
        bare.push({ agr: m[1]!, promised: Object.values(goods).reduce((s2, n) => s2 + n, 0) });
      }
    };
    run.addPresenterTap({
      toast: (text: string) => {
        if (/delivered \d+ of \d+/.test(text)) shortDeliveries.push(text);
      },
    });
    /**
     * 🚨 THE BAG-LEG GIVE-UP IS NOW FORCED, AND IT HAS TO BE (watched-body-stall
     * round, user ruling 2026-09-07). This pin used to ride the arc: *"the bag
     * leg is given up TWICE inside 250 sim s"*. It is not any more — the stall
     * ladder RE-ROUTES a porter that cannot reach its basket before anything
     * gives up, and the whole 1 400 s arc now logs **zero** `RE-ISSUED` and
     * **zero** `ABANDONED` where the round-start tree logged 1 and 2. The
     * premise below went vacuous because the round DELETED the event, which is
     * exactly the carry-fold lesson one step further on.
     *
     * So it is provoked through the host's own door — the same one R-D above
     * uses (`host.addWildFeature`, `species: "rock"`, the only kind that walls)
     * — and it needs no session state forged, because `haulBagLeg` PRICES a
     * basket by distance and never asks whether it can be reached. That is the
     * very gap R-B exists for. Ring every idle floor-living container before
     * the order goes out and the next bagged haul walks to a basket it cannot
     * get to, exhausts its re-routes, and takes BOTH arms in turn: another
     * basket (also ringed), then bare-handed. Nothing is asserted about the
     * ring; it only makes the event happen on purpose instead of by luck.
     */
    const ringBaskets = (): number => {
      let rung = 0;
      for (const [objId, o] of Object.entries(state.objects)) {
        if (o.carriedBy) continue;
        const rec = session.containerRecords.get(objId);
        if (!rec?.glyph || !livesOnTheFloor(rec.glyph)) continue;
        for (let k = 0; k < 36; k++) {
          const ang = (k / 36) * Math.PI * 2;
          run.host.addWildFeature({
            id: `probe:bagwall_${objId}_${k}`,
            species: "rock",
            x: o.x + Math.cos(ang) * 1.9,
            y: o.y + Math.sin(ang) * 1.9,
            stock: { stone: 10 },
          } as WildernessFeature);
        }
        rung++;
      }
      return rung;
    };

    let ringed = 0;
    try {
      let spoke = false;
      for (let i = 0; i < 900; i++) {
        run.stepFrame();
        if (!spoke && session.townClock >= 12) {
          spoke = true;
          ringed = ringBaskets();
          run.speak("build + house");
        }
      }
    } finally {
      console.log = realLog;
    }

    // FIXTURE PREMISE FIRST: the wall really went up round some baskets.
    expect(ringed).toBeGreaterThan(0);
    // PREMISE, not the finding (the carry-fold lesson: a window that no longer
    // contains the event makes every assertion below vacuous). With the ring in
    // place the bag leg is given up inside the window; without it, on the
    // post-ruling tree, it is never given up at all.
    expect(withAnotherBasket.length + bare.length).toBeGreaterThan(0);

    // ① A BASKET THAT CANNOT BE REACHED IS STRUCK OFF, NOT THE BILL. The trip
    //    is worth eight units; the arithmetic that chose that basket never knew
    //    it was unreachable, so the honest second question is the same question
    //    with that one excluded. Bounded at two trips: `avoidBags` is set only
    //    on this arm, so a second failure falls through to the bare arm.
    expect(withAnotherBasket.length).toBeGreaterThan(0);

    // ② AND A BARE TRIP PROMISES ONE WHOLE THING — the law of a body with no
    //    container. Before this round the promise stayed at eight and the
    //    landing announced "delivered 1 of 8" (measured: 3 lines per 1 400 s).
    for (const r of bare) expect(r.promised).toBeLessThanOrEqual(1);

    // ③ …WHICH IS THE SAME CLAIM READ OFF THE PLAYER'S OWN TOASTS: no delivery
    //    reports a promise a carrier could never have kept.
    expect(shortDeliveries.filter((t) => /delivered 1 of [2-9]/.test(t))).toEqual([]);
  }, 600_000);
});
