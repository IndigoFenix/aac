/**
 * REFINERY LICENSING over the tri world (resources-and-trade.md §③):
 * DISTANCE is the reason refining exists, per settlement. With
 * `refineLicensing` declared, every living city's `weaver_license`
 * scalar is written daily from the transport math — 1 where the nearest
 * market lies beyond raw wool's carry reach (refine it or stay a
 * village), 0 where a market sits inside it (ship the wool; the build
 * rule stays shut). The clothing chain's weaver declares
 * `refines: wool → cloth` in content, so the gate is entirely
 * spec + geography — no code names a good.
 *
 * The map's own site spacing provides both verdicts: cellM is chosen so
 * wool's reach falls BETWEEN the tightest and loosest nearest-neighbour
 * distances, and the pinned expectation is the predicate itself —
 * licensed ⇔ own nearest market beyond reach — plus the printed
 * why-here sentences (the fractal job-description law, live).
 */

import { describe, it, expect } from "vitest";
import { prepareSubstrate, foundTri } from "../tri";
import { TREELINE, FOUNDING, ridgeValley, triBase, triEconomy, CITIZEN } from "../tri-worlds";
import { REAL_SCALE } from "@shared/world-engine/scale";
import { carryReachM, freightOf } from "@shared/world-engine/freight";

describe("refineLicensing — the geography hands out the weaver licenses", () => {
  it("licenses exactly the towns whose market is beyond wool's reach", { timeout: 120000 }, async () => {
    const prep = prepareSubstrate({
      cols: 48, rows: 32, height: ridgeValley, treeline: TREELINE, founding: FOUNDING, oreSeed: 7,
    });
    // A close pair and a genuinely distant third — the ranked sites all sit
    // at minSpacing from each other, so the spread is chosen, not sliced.
    const d = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
      Math.hypot(a.x - b.x, a.y - b.y);
    const s0 = prep.sites[0];
    const near = prep.sites.find(s => s !== s0 && d(s, s0) <= 9)!;
    const far = prep.sites.find(s => d(s, s0) >= 18 && d(s, near) >= 18)!;
    expect(near).toBeDefined();
    expect(far).toBeDefined();
    const sites = [s0, near, far];

    // Each city's market is its nearest neighbour (in cells, flat grid).
    const nearest = sites.map((s, i) =>
      Math.min(...sites.filter((_, j) => j !== i).map(o => d(s, o))));
    expect(Math.min(...nearest)).toBeLessThan(Math.max(...nearest)); // fixture sanity

    // Pitch the world so wool's reach splits the spacings: the geometric
    // mean puts at least one town inside a market's reach and one beyond.
    const woolReachM = carryReachM(REAL_SCALE, freightOf("wool"));
    const cellM = woolReachM / Math.sqrt(Math.min(...nearest) * Math.max(...nearest));

    const eco = { construction: true, goods2: true, clothing: true };
    const tri = await foundTri(prep, {
      base: triBase(eco),
      economy: triEconomy(eco),
      cities: sites.map((at, i) => ({ at, key: `t${i}`, name: `Town ${i}`, site: { ...CITIZEN } })),
      edges: [],
      peopleScale: 25,
      seed: 1206,
      refineLicensing: { scale: REAL_SCALE, cellM },
    });
    await tri.advanceDays(1);

    const lic = tri.dual.entityWorld.scalars.weaver_license;
    const report = tri.refineryReport();
    for (let i = 0; i < 3; i++) {
      const should = nearest[i] * cellM > woolReachM;
      expect(lic[i]).toBe(should ? 1 : 0);
      const rows = report.filter(r => r.city === `t${i}` && r.building === "weaver");
      expect(rows.length).toBe(1);
      expect(rows[0].licensed).toBe(should);
      expect(rows[0].sentence).toMatch(should ? /refines its wool/ : /ships raw wool/);
    }
    // Both verdicts are REAL on this map — the same content, split by
    // nothing but distance.
    expect(new Set([...lic].slice(0, 3)).size).toBe(2);
  });
});
