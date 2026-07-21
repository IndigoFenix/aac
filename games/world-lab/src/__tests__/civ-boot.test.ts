/**
 * The nations-P0 ship gate: the CIV TIER BOOTS IN WORLD-LAB, headless —
 * `bootDual` (shared kernel/civ) over world-lab's own Composition binding
 * (civ-boot.ts), no grand-dream anywhere. A small two-city dual world
 * runs 30 days with the layers agreeing and people conserved.
 */

import { describe, it, expect } from "vitest";
import { bootDual, type DualSpec } from "@shared/world-engine/kernel/civ/dual";
import type { WorldSpec } from "@shared/world-engine/kernel/cells/spec";
import { bootCiv } from "../civ-boot";

/** Settlement layer: population diffuses along the one road. */
const SETTLEMENT: WorldSpec = {
  id: "settlement",
  entity: {
    id: "town",
    vars: [{ name: "population", min: 0, max: 1_000_000, initial: 0 }],
    rules: [],
  },
  edge: { vars: [{ name: "road", min: 0, max: 1, initial: 0 }] },
  exchanges: [{ scalar: "population", rate: 0.05 }],
};

/** Composition layer: one idea trait, contact-spread. */
const COMPOSITION: Record<string, unknown> = {
  name: "WorldLabCiv",
  start_age: 0,
  use_date: false,
  phase: [{ key: "spread", name: "Spread" }],
  trait: [{
    key: "convinced", name: "Convinced", color: "230,60,60,1",
    transmit: [{ vector: ["v1"], apply: ["convinced"], value: 0.6, sd: 0, phase: "spread", ranged: 0 }],
  }],
  vector: [{ key: "v1", name: "Contact" }],
};

const SPEC: DualSpec = {
  nodes: [
    { key: "city_a", name: "A", pop: 120_000 },
    { key: "city_b", name: "B", pop: 40_000 },
  ],
  edges: [{ a: "city_a", b: "city_b", key: "ab" }],
  settlement: SETTLEMENT,
  composition: COMPOSITION,
  coupling: { populationScalar: "population" },
};

describe("world-lab boots the shared civ tier headless (P0 gate)", () => {
  it("bootDual runs over civ-boot's Composition backend, layers agree, people conserved", async () => {
    const dual = await bootDual(SPEC, 7, bootCiv);
    const startPop = dual.totalPop();
    const day0 = dual.day();
    expect(startPop).toBe(160_000);

    await dual.advanceDays(30);

    // Conservation: nobody minted, nobody lost.
    expect(dual.totalPop() + dual.histfigCount()).toBe(
      startPop + dual.vitalLedger().births - dual.vitalLedger().deaths,
    );
    // The layers-agree contract, both cities, after real stepping.
    for (const key of ["city_a", "city_b"]) {
      expect(dual.settlementPop(key)).toBe(dual.civicPop(key));
    }
    // Migration actually flowed A→B (diffusion down the gradient).
    expect(dual.settlementPop("city_b")).toBeGreaterThan(40_000);
    expect(dual.day()).toBe(day0 + 30);
  });

  it("is deterministic — same spec + seed, same world after 15 days", async () => {
    const run = async () => {
      const dual = await bootDual(SPEC, 11, bootCiv);
      await dual.advanceDays(15);
      // Plain fields only — PopuSim's live pops alias engine objects.
      return JSON.stringify({
        a: dual.settlementPop("city_a"),
        b: dual.settlementPop("city_b"),
        sites: dual.sites().map(s => ({
          key: s.key,
          pop: s.pop,
          pops: s.pops.map(p => ({ pop: p.pop, traits: [...p.syndrome.trait_keys] })),
        })),
      });
    };
    expect(await run()).toBe(await run());
  });
});
