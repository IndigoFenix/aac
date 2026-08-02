/**
 * GATE C over the tri world (settlement-emergence.md §5, step ⑥): size
 * licensed by FUNCTION. With `ceilings.jobs` declared, every living
 * city's `pop_ceiling` becomes min(resource ceiling, license cap) — the
 * §④ anchor and the reason-to-exist anchor meeting in one scalar, both
 * consumed by the same vitals-capacity machinery. The village line comes
 * from the world's OWN tier vocabulary (the second threshold — a ratio of
 * declared quantities, never a new number).
 *
 * The map provides both verdicts: a HUB with three living spokes holds
 * the store-of-last-resort job and stays unbounded by function; its
 * spokes — picked deliberately from sites whose terrain holds NO job —
 * cap at the town line, whatever their land could feed.
 */

import { describe, it, expect } from "vitest";
import { prepareSubstrate, foundTri } from "../tri";
import {
  TREELINE, FOUNDING, ridgeValley, triBase, triEconomy, villageSeed, CITIZEN,
} from "../tri-worlds";
import { REAL_SCALE } from "@shared/world-engine/scale";
import { carryReachM } from "@shared/world-engine/freight";
import { classifyNode, type ConstraintDef } from "@shared/world-engine/kernel/cells/index.js";
import { NODE_JOB_TYPES } from "@shared/world-engine/kernel/civ/jobs";

const cellM = carryReachM(REAL_SCALE, { valueDensity: 1, transit: "selfConsuming" }) / 6;
const CONSTRAINTS: ConstraintDef[] = [
  { key: "food", field: "fertility", headsPerUnit: 10 },
];

describe("Gate C — a settlement with no hinterland job caps at village", () => {
  it("the hub is licensed by its spokes; the jobless spokes cap at the town line", { timeout: 120000 }, async () => {
    const p = prepareSubstrate({
      cols: 48, rows: 32, height: ridgeValley, treeline: TREELINE, founding: FOUNDING, oreSeed: 7,
    });
    // Spokes chosen from sites whose TERRAIN holds no job — so their only
    // possible license would be the graph, and degree 1 is not a hub.
    const jobless = p.sites.filter(s =>
      !classifyNode(p.grid, s.cell).types.some(t => NODE_JOB_TYPES.includes(t)));
    expect(jobless.length).toBeGreaterThanOrEqual(4);
    const [hubSite, ...spokes] = jobless.slice(0, 4);

    const eco = { construction: true };
    const tri = await foundTri(p, {
      base: triBase(eco),
      economy: triEconomy(eco),
      cities: [
        { at: hubSite, key: "hub", name: "Hub", site: { ...CITIZEN }, scalars: (c, pop) => villageSeed(c, pop) },
        ...spokes.map((at, i) => ({
          at, key: `spoke${i}`, name: `Spoke ${i}`, site: { ...CITIZEN },
          scalars: (c: Parameters<typeof villageSeed>[0], pop: number) => villageSeed(c, pop),
        })),
      ],
      // The star: three roads meet at the hub's granary.
      edges: [["hub", "spoke0"], ["hub", "spoke1"], ["hub", "spoke2"]],
      peopleScale: 25,
      seed: 1206,
      tiers: [
        { key: "village", min: 0 },
        { key: "town", min: 2000 },
        { key: "city", min: 8000 },
      ],
      ceilings: {
        scale: REAL_SCALE, cellM, constraints: CONSTRAINTS,
        jobs: {}, // villageHeads reads the world's own town line (2000)
      },
    });
    await tri.advanceDays(1);

    const arr = tri.dual.entityWorld.scalars.pop_ceiling;
    const report = tri.ceilingReport();

    const hub = report.find(r => r.city === "hub")!;
    expect(hub.license!.licensed).toBe(true);
    expect(hub.license!.jobs.map(j => j.kind)).toContain("hub");
    expect(hub.sentence).toMatch(/3 roads meet at its granary/);
    // Licensed: the FUNCTION does not bind — only the land does.
    expect(hub.ceiling).toBe(hub.reading.ceiling);

    for (let i = 0; i < 3; i++) {
      const s = report.find(r => r.city === `spoke${i}`)!;
      expect(s.license!.licensed).toBe(false);
      expect(s.license!.cap).toBe(2000); // the world's own tier vocabulary
      expect(s.ceiling).toBe(Math.min(s.reading.ceiling, 2000));
      expect(s.sentence).toMatch(/has no job for its hinterland/);
    }

    // The scalar the vitals capacity reads IS the effective min, per city.
    for (const r of report) {
      const ci = ["hub", "spoke0", "spoke1", "spoke2"].indexOf(r.city);
      expect(arr[ci]).toBe(r.ceiling);
    }
  });
});
