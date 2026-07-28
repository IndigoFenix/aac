// CIRCULATION AS SEARCH (§9 slice 4, shared/world-engine/kernel/town/
// circulation.ts): hub / enfilade / Jack-and-Jill / spine stop being
// authored branches — the solver finds them (and shapes the ladder never
// had) under the ladder's own constraint set. The §9 guardrail is a
// measurable claim: ON THE FULL SWEEP the search must never realize
// FEWER sleep cells than the ladder, must stay deterministic, and must
// somewhere strictly BEAT it (else it hasn't earned the ladder's seat).
// Pure geometry — no DB / LLM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  ladderBand,
  solveBand,
  type BandLayout,
} from "@shared/world-engine/kernel/town/circulation.js";
import {
  HOUSE_METRICS,
  PARTITION_L,
  houseRoomPlan,
} from "@shared/world-engine/kernel/town/rooms.js";
import type { TownHouse } from "@shared/world-engine/kernel/town/plan.js";

const M = {
  doorClear: HOUSE_METRICS.doorClear,
  doorJamb: HOUSE_METRICS.doorJamb,
  roomDoorW: HOUSE_METRICS.roomDoorW,
  bathDoorW: HOUSE_METRICS.bathDoorW,
  hallDoorW: HOUSE_METRICS.hallDoorW,
  hallW: HOUSE_METRICS.hallW,
  bathW: HOUSE_METRICS.bathW,
  bedMinW: HOUSE_METRICS.bedMinW,
  bedMinD: HOUSE_METRICS.bedMinD,
};

/** rooms.ts's living-depth rule (livingDepth) — mirrored here so the
 *  solver is exercised on exactly the bands houses hand it. */
const vSplitHubOf = (D: number): number => {
  const x = 0.52 * D;
  return x < 4.2 ? 4.2 : x > D - 3.0 ? D - 3.0 : x;
};

const beds = (b: BandLayout | null): number =>
  b ? b.cells.filter((c) => c.cluster === "sleep").length : 0;

/** Full-form band inputs across the TOWN_DIMS range, both coin values. */
function* bandSweep(): Generator<{ L: number; D: number; vSplitHub: number; demand: number; metrics: typeof M; spineCoin: boolean }> {
  for (let L = PARTITION_L; L <= 13.01; L += 0.4) {
    for (let D = 7; D <= 10.01; D += 0.35) {
      for (const spineCoin of [false, true]) {
        for (const demand of [1, 2, 3]) {
          yield { L, D, vSplitHub: vSplitHubOf(D), demand, metrics: M, spineCoin };
        }
      }
    }
  }
}

describe("circulation as search (§9 slice 4)", () => {
  it("NEVER loses to the ladder: solver beds ≥ ladder beds, everywhere, and never over-delivers demand", () => {
    for (const input of bandSweep()) {
      const solved = solveBand(input);
      const ladder = ladderBand(input);
      const label = `${input.L.toFixed(1)}x${input.D.toFixed(1)} d${input.demand} c${input.spineCoin}`;
      // Labeled so a failure names the exact band.
      expect(`${label}: ${beds(solved)} >= ${beds(ladder)}`).toBe(
        `${label}: ${Math.max(beds(solved), beds(ladder))} >= ${beds(ladder)}`,
      );
      expect(beds(solved)).toBeLessThanOrEqual(input.demand);
      // The solver never abandons a full-form band the ladder could serve.
      expect(solved).not.toBeNull();
    }
  });

  it("STRICTLY BEATS the ladder somewhere (the search earned its seat)", () => {
    // The lot the ladder's four shapes can't fill: 11.8 m frontage,
    // 9.2 m deep, wanting 3 cells — too shallow for the spine hall
    // (D − 4.2 − hall = 3.0 < bedMinD), flanks too narrow for J&J —
    // the search CHAINS the third bedroom through the second (a shape
    // the ladder never had).
    const D = 9.2;
    const input = { L: 11.8, D, vSplitHub: vSplitHubOf(D), demand: 3, metrics: M, spineCoin: false };
    const solved = solveBand(input)!;
    const ladder = ladderBand(input);
    expect(beds(ladder)).toBe(2);
    expect(beds(solved)).toBe(3);
    expect(solved.mode).toBe("flat");
    // The novel shape really is a chain: a bedroom routes via another.
    expect(solved.cells.some((c) => c.access.kind === "via" && c.cluster === "sleep")).toBe(true);
  });

  it("reproduces the ladder's taste where the ladder was right", () => {
    // Wide + deep: the bath sits BETWEEN the bedrooms and — since round
    // 7 ranked through-traffic above affinity (the "why does the toilet
    // open into a bedroom?" playtest fix) — doors from the LIVING room:
    // the partition is wide enough to clear the chests for all three
    // cells, so nobody crosses a bedroom to wash. (The old Jack-and-Jill
    // taste returns per town by authoring CLUSTERS.wet.affinity.)
    const jj = solveBand({ L: 12.6, D: 10, vSplitHub: vSplitHubOf(10), demand: 2, metrics: M, spineCoin: false })!;
    const wet = jj.cells.find((c) => c.cluster === "wet")!;
    expect(jj.mode).toBe("flat");
    expect(wet.access.kind).toBe("partition");
    expect(jj.cells.every((c) => c.access.kind === "partition")).toBe(true);
    // Narrow: one bedroom, en-suite wet (a partition door at the band's
    // end can never clear the chests — the interval arithmetic derives
    // hub-1 rather than authoring it).
    const hub1 = solveBand({ L: 8, D: 8, vSplitHub: vSplitHubOf(8), demand: 1, metrics: M, spineCoin: false })!;
    expect(beds(hub1)).toBe(1);
    const wet1 = hub1.cells.find((c) => c.cluster === "wet")!;
    expect(wet1.access.kind).toBe("via");
    // The spine hall is pure circulation — it never adds beds the chain
    // can't reach, so it appears on TIES via the house's variety coin
    // (the ladder's useSpine draw, now decisive).
    const coin = solveBand({ L: 11.8, D: 9.8, vSplitHub: vSplitHubOf(9.8), demand: 3, metrics: M, spineCoin: true })!;
    expect(beds(coin)).toBe(3);
    expect(coin.mode).toBe("spine");
    const noCoin = solveBand({ L: 11.8, D: 9.8, vSplitHub: vSplitHubOf(9.8), demand: 3, metrics: M, spineCoin: false })!;
    expect(beds(noCoin)).toBe(3);
    expect(noCoin.mode).toBe("flat");
  });

  it("round-7 KITCHEN: worth a hall, never a bed", () => {
    // Wide + deep with the kitchen wanted: the corridor is how the extra
    // cell gets doored — the solver builds the spine and hangs the
    // kitchen off the hall, beds intact.
    const spineKit = solveBand({
      L: 12.4, D: 10, vSplitHub: vSplitHubOf(10), demand: 2, metrics: M, spineCoin: false, kitchen: true,
    })!;
    expect(spineKit.mode).toBe("spine");
    expect(spineKit.cells.some((c) => c.cluster === "kitchen")).toBe(true);
    expect(beds(spineKit)).toBe(2);
    // The same lot WITHOUT the kitchen wanted keeps the cheaper flat.
    const noKit = solveBand({
      L: 12.4, D: 10, vSplitHub: vSplitHubOf(10), demand: 2, metrics: M, spineCoin: false,
    })!;
    expect(noKit.mode).toBe("flat");
    // FULL SWEEP: wanting a kitchen NEVER costs a sleep cell, and a
    // realized flat kitchen only ever doors from the LIVING partition
    // (a kitchen reached through a bedroom is nobody's culture).
    for (const input of bandSweep()) {
      const withKit = solveBand({ ...input, kitchen: true });
      expect(beds(withKit)).toBe(beds(solveBand(input)));
      for (const c of withKit?.cells ?? []) {
        if (c.cluster !== "kitchen") continue;
        expect(withKit!.mode === "spine" ? "hall" : c.access.kind).toBe(
          withKit!.mode === "spine" ? "hall" : "partition",
        );
      }
    }
  });

  it("is deterministic (same inputs, same layout)", () => {
    for (const input of [
      { L: 9.4, D: 8.4, vSplitHub: vSplitHubOf(8.4), demand: 2, metrics: M, spineCoin: true },
      { L: 13, D: 8.4, vSplitHub: vSplitHubOf(8.4), demand: 3, metrics: M, spineCoin: false },
    ]) {
      expect(JSON.stringify(solveBand(input))).toBe(JSON.stringify(solveBand(input)));
    }
  });

  it("plans through houseRoomPlan keep the search's wins (end-to-end)", () => {
    // The strict-win lot, as a real house: three bedrooms WITHOUT a hall
    // materialize (the chained flat the ladder never had).
    const center = { x: 100, y: 100 };
    let sawThreeFlat = false;
    for (let index = 0; index < 24; index++) {
      const house: TownHouse = {
        index, dx: -5.9, dy: -4.6, w: 11.8, h: 9.2, door: "south", color: "#a8875f", floors: 1,
      };
      const plan = houseRoomPlan(center, house);
      if (plan.bedrooms.length === 3 && !plan.rooms.some((r) => r.kind === "hall")) sawThreeFlat = true;
    }
    expect(sawThreeFlat).toBe(true);
  });
});
