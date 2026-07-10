/**
 * Step 6 — the PLANNED event stream (civilization-emergence.md §3b) and
 * its §3c AGREEMENT CONTRACT: providers for the same layer must agree at
 * the interface. The planner (plan.ts — real settlement engine + float
 * Malthus + the live event gates, no composition layer) and the live tri
 * sim run over IDENTICAL rested substrates; the test asserts the big
 * facts land together — roster, founding order and timing, buildings,
 * populations, per-commodity fills at maturity — within tolerance.
 * Divergence localizes to whichever gate the plan mis-approximates,
 * which is exactly the list of things to fix.
 */

import { describe, it, expect } from "vitest";
import { prepareSubstrate, foundTri, type TriPrep, type FoundTriOpts } from "../tri";
import { planHistory, type PlanOpts } from "../plan";
import { civTargetAt } from "../civ-scrub";
import {
  TREELINE, TIERS, MERGE, COLONIZE, HISTORY, FOUNDING, ridgeValley,
  villageSeed, triBase, CITIZEN,
} from "../tri-worlds";

const DAYS = 300;

function freshPrep(): TriPrep {
  return prepareSubstrate({ cols: 48, rows: 32, height: ridgeValley, treeline: TREELINE, founding: FOUNDING, oreSeed: 7 });
}

/** The SAME options for both providers — shared gates kill drift. */
function worldOpts(): Pick<PlanOpts, "cities" | "edges" | "peopleScale" | "autoFound" | "colonize" | "merge" | "mining" | "tiers"> {
  return {
    cities: [],
    edges: [],
    peopleScale: 25,
    autoFound: {
      every: 5,
      maxCities: 3,
      cityFactory: (_site, index) => ({
        key: `city${index}`,
        name: `City ${index}`,
        scalars: villageSeed,
        site: CITIZEN,
      }),
    },
    colonize: COLONIZE,
    merge: MERGE,
    mining: { oreOutScalar: "ore_out", rate: 0.3 },
    tiers: TIERS,
  };
}

describe("planned history (step 6): the §3c agreement contract", () => {
  it("plan and live sim agree on the big facts; the plan is deterministic and scrubbable", { timeout: 300000 }, async () => {
    const base = triBase({ construction: true, goods2: true }); // politics stays live-only

    // The plan: instant, pure, grid untouched.
    const planned = planHistory(freshPrep(), {
      base, ...worldOpts(), days: DAYS, history: HISTORY, civ: "member_x",
    });
    // The lived history: the full dual world over an identical substrate.
    const tri = await foundTri(freshPrep(), {
      base, ...worldOpts(), seed: 17, history: HISTORY,
    } as FoundTriOpts);
    await tri.advanceDays(DAYS);
    const live = tri.history()!;
    const d = tri.dual;

    // --- Roster: same settlements, same places, same founding ORDER.
    expect(planned.cities.length).toBe(tri.cities.length);
    planned.cities.forEach((c, i) => {
      expect([c.key, c.x, c.y, c.colonyOf ?? null]).toEqual(
        [tri.cities[i].key, tri.cities[i].x, tri.cities[i].y, tri.cities[i].colonyOf ?? null],
      );
      expect(c.harvested).toBe(tri.cities[i].harvested); // standing crowds are exact
    });

    // --- Timing: each settlement appears in the two histories within a
    // frame or two of itself (wild foundings should be day-exact; colony
    // timing rides the economy and may drift a little).
    const firstFrame = (frames: Array<{ pop: number[] }>, ci: number): number =>
      frames.findIndex(f => f.pop.length > ci);
    planned.cities.forEach((c, ci) => {
      const p = firstFrame(planned.history.frames, ci);
      const l = firstFrame(live.frames, ci);
      const tol = c.colonyOf ? 4 : 0; // colonies: ±4 frames (20 days)
      expect(Math.abs(p - l)).toBeLessThanOrEqual(tol);
    });

    // --- Maturity: populations within 10%, buildings within 1, fills close.
    const planPop = planned.history.frames[planned.history.frames.length - 1].pop;
    planned.cities.forEach((c, i) => {
      if (c.dead) return;
      const livePop = d.settlementPop(c.key);
      expect(Math.abs(planPop[i] - livePop)).toBeLessThanOrEqual(Math.max(500, livePop * 0.1));
    });
    for (const b of ["farms", "mines", "smelters", "sawmills", "smithies"]) {
      planned.cities.forEach((c, i) => {
        if (c.dead) return;
        expect(Math.abs(planned.world.scalars[b][i] - d.settlementScalar(c.key, b))).toBeLessThanOrEqual(1);
      });
    }
    for (const [got, need] of [["food_got", "food_need"], ["metal_got", "metal_need"], ["planks_got", "smith_plank_draw"], ["tools_got", "tools_need"]]) {
      planned.cities.forEach((c, i) => {
        if (c.dead) return;
        const pf = planned.world.scalars[need][i] > 0 ? planned.world.scalars[got][i] / planned.world.scalars[need][i] : 1;
        const ln = d.settlementScalar(c.key, need);
        const lf = ln > 0 ? d.settlementScalar(c.key, got) / ln : 1;
        expect(Math.abs(pf - lf)).toBeLessThanOrEqual(0.15);
      });
    }

    // --- Events: the same colonies from the same parents; the same deaths.
    const liveColonies = tri.cities.filter(c => c.colonyOf).map(c => [c.key, c.colonyOf]);
    const planColonies = planned.events.filter(e => e.kind === "colony").map(e => [e.key, e.other]);
    expect(planColonies).toEqual(liveColonies);
    expect(planned.cities.filter(c => c.dead).map(c => c.key))
      .toEqual(tri.cities.filter(c => c.dead).map(c => c.key));

    // --- The development clock: cumulative planned births are monotone
    // across events and track the live ledger.
    for (let i = 1; i < planned.events.length; i++) {
      expect(planned.events[i].births).toBeGreaterThanOrEqual(planned.events[i - 1].births);
    }
    const { births } = d.vitalLedger();
    expect(Math.abs(planned.births - births)).toBeLessThanOrEqual(Math.max(1000, births * 0.1));

    // --- The seam: a planned history is a CivHistory — same invariants,
    // same scrubber. Scrub the middle of a past that never ran.
    let prevCities = 0;
    for (const f of planned.history.frames) {
      expect(f.pop.length).toBeGreaterThanOrEqual(prevCities);
      prevCities = f.pop.length;
      expect(f.civ.length).toBe(f.pop.length);
      expect(f.road.length).toBe(f.edgeCount);
    }
    expect(planned.history.frames.length).toBe(live.frames.length);
    const mid = civTargetAt(planned.history, 0.5);
    expect(mid.cities.some(c => c.present && c.pop > 0)).toBe(true);

    // --- Deterministic: same substrate, same plan, byte for byte.
    const again = planHistory(freshPrep(), {
      base: triBase({ construction: true, goods2: true }),
      ...worldOpts(), days: DAYS, history: HISTORY, civ: "member_x",
    });
    expect(JSON.stringify({ h: again.history, e: again.events, c: again.cities }))
      .toBe(JSON.stringify({ h: planned.history, e: planned.events, c: planned.cities }));
  });
});
