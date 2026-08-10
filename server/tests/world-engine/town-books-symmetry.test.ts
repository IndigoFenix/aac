// TOWN BOOKS SYMMETRY (economy-arc-opening.md batch 3) — the pure half.
//
// The subject is free lunch #3: imports credited a stockpile that exports
// never debited, and the F4 saturation that hid it (one landed garment was
// worth `RATION_VALUE` on books whose whole town wants 7.7e-4 of one a day).
// Two organs land here, both pure and both DERIVED rather than typed:
//
//  B1 `bookUnitsPerStreetUnit` — the STREET↔BOOKS exchange rate. Not a new
//     number: the compiler already computes its inverse
//     (`perCapitaDaily = perPersonDaily / stapleDaily`), so the ratio back is
//     the staple's own daily draw for every street good, by construction.
//  B4 `equilibriumExportScale` — batch 2's want-gate slope at its FIXED
//     POINT. Once the books debit what the lane carries away (B3), the
//     shortage the slope reads is partly caused by the slope's own answer;
//     the loop has one solution and it can be written down.
//
// The LIVE halves (B2's drain, B3's owed term, B5's caravan debit) are pinned
// where the lane they belong to is: `trade-import-channel.test.ts`. The
// pairwise books transfer (B6) is pinned in `town-barter.test.ts`, beside the
// yard conservation it grew out of. Pure logic — no DOM / GL / DB.

import { describe, it, expect } from "@jest/globals";
import { compileEconomy } from "@shared/world-engine/kernel/modules/economy/index.js";
import {
  bookUnitsPerStreetUnit,
  RATION_VALUE,
} from "@shared/world-engine/interaction/town/town-quests.js";
import { townPlayEconomy } from "@shared/world-engine/interaction/town/town-play.js";
import {
  BARTER_WANT_MIN,
  equilibriumExportScale,
  exportSpareScale,
} from "@shared/world-engine/kernel/town/complementary.js";
import { DOLLHOUSE_SCALE, REAL_SCALE } from "@shared/world-engine/scale.js";

// ─────────────────────────────────────────────────────────────────────────
// B1 — the bridge, on the SHIPPED document
// ─────────────────────────────────────────────────────────────────────────

describe("B1 — the street↔books bridge is the compiler's own inverse", () => {
  const eco = compileEconomy([townPlayEconomy()], { construction: true });

  it("🚨 EVERY street good measures the SAME number — the staple's daily draw", () => {
    // The identity, stated as an identity: value ÷ perCapitaDaily === the
    // staple's `perPersonDaily`, because perCapitaDaily IS the quotient.
    const staple = eco.traitDemands.find((d) => d.resource === "food")!.value;
    expect(staple).toBeCloseTo(0.001, 12); // the caloric anchor, for the record
    const measured = new Map<string, number>();
    for (const good of eco.goods) {
      const demand = eco.traitDemands.find((d) => d.resource === good.key);
      if (!demand) continue; // an intermediate with no household demand
      measured.set(good.key, bookUnitsPerStreetUnit(eco, good.key));
      expect(bookUnitsPerStreetUnit(eco, good.key)).toBeCloseTo(
        demand.value / good.perCapitaDaily,
        12,
      );
      expect(bookUnitsPerStreetUnit(eco, good.key)).toBeCloseTo(staple, 12);
    }
    // Food and clothing are 180:1 apart in the books and 180:1 apart on the
    // street, so the RATE between the two layers is one number for both — the
    // whole reason a single bridge is honest.
    expect([...measured.keys()].sort()).toEqual(["clothing", "food"]);
    expect(measured.get("clothing")).toBe(measured.get("food"));
    const clothing = eco.goods.find((g) => g.key === "clothing")!;
    const food = eco.goods.find((g) => g.key === "food")!;
    expect(food.perCapitaDaily / clothing.perCapitaDaily).toBeCloseTo(180, 9);
  });

  it("🚨 it FOLLOWS the metabolism — a faster world moves both sides together", () => {
    // F4 grounds clothing's demand at the metabolic multiplier, so a world
    // that eats three times a game-day also wears out three times as fast.
    // The bridge must stay ONE number across that change, or the street and
    // the books would drift apart the moment a profile re-scaled time.
    const fast = compileEconomy([townPlayEconomy(DOLLHOUSE_SCALE)], { construction: true });
    const slow = compileEconomy([townPlayEconomy(REAL_SCALE)], { construction: true });
    for (const e of [fast, slow]) {
      expect(bookUnitsPerStreetUnit(e, "clothing")).toBeCloseTo(
        bookUnitsPerStreetUnit(e, "food"),
        12,
      );
    }
  });

  it("🔒 a good the books never metabolize falls back to the delivery convention", () => {
    // `cloth` is a pure intermediate (no `perPersonDaily`, no street box) and
    // nothing here invents a rate for it: a quest reward on a good the
    // aggregate does not count keeps meaning exactly one unit, as it always did.
    expect(bookUnitsPerStreetUnit(eco, "cloth")).toBe(RATION_VALUE);
    expect(bookUnitsPerStreetUnit(eco, "not-a-commodity")).toBe(RATION_VALUE);
  });

  it("🔒 PURE — same economy, same answer, and nothing is written", () => {
    const before = JSON.stringify(eco.goods.map((g) => g.perCapitaDaily));
    const a = bookUnitsPerStreetUnit(eco, "clothing");
    const b = bookUnitsPerStreetUnit(eco, "clothing");
    expect(a).toBe(b);
    expect(JSON.stringify(eco.goods.map((g) => g.perCapitaDaily))).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// B4 — the equilibrium valve
// ─────────────────────────────────────────────────────────────────────────

describe("B4 — the export valve at its fixed point", () => {
  it("🚨 THE AUTHORED EXPORTER: burden 0.3 ⇒ a third out, a tenth felt", () => {
    // `exportDaily = houses × HOUSEHOLD × perCapitaDaily × 0.3`, so in book
    // units the burden against the town's own daily need is 0.3 exactly
    // wherever the plan's beds and the books' souls agree.
    const s = equilibriumExportScale(0, 0.3);
    expect(s).toBeCloseTo(1 / 3, 12);
    // …and the shortage it settles at is S₀ + s*·burden — just under the want
    // gate, so the good stays on the export list while the town feels a pinch.
    expect(0 + s * 0.3).toBeCloseTo(0.1, 12);
    expect(0 + s * 0.3).toBeLessThan(BARTER_WANT_MIN);
  });

  it("🚨 IT IS THE FIXED POINT — feed the answer back and the slope agrees", () => {
    // The whole point of the closed form: `s* === exportSpareScale(S₀ + s*·b)`.
    // If that ever stopped holding, the valve and the slope would be two
    // different laws wearing one name.
    for (const s0 of [0, 0.02, 0.05, 0.1, 0.14]) {
      for (const burden of [0, 0.05, 0.3, 0.7, 2]) {
        const s = equilibriumExportScale(s0, burden);
        expect(s).toBeCloseTo(exportSpareScale(s0 + s * burden), 12);
      }
    }
  });

  it("🔒 BURDEN 0 IS THE G2 SLOPE, byte for byte (a town that exports nothing)", () => {
    // Measured, not asserted: the same expression with `+ 0` on the
    // denominator, so a non-exporter's number is bit-identical to batch 2's.
    for (let s0 = -0.2; s0 <= 1.2; s0 += 0.01) {
      expect(equilibriumExportScale(s0, 0)).toBe(exportSpareScale(s0));
    }
  });

  it("🚨 A FAMINE TOWN DOES NOT EXPORT — G1/G2's gate is preserved exactly", () => {
    expect(equilibriumExportScale(BARTER_WANT_MIN, 0.3)).toBe(0);
    expect(equilibriumExportScale(BARTER_WANT_MIN, 0)).toBe(0);
    expect(equilibriumExportScale(0.7, 0.3)).toBe(0);
    expect(equilibriumExportScale(1, 5)).toBe(0);
  });

  it("🚨 the heavier the commitment, the smaller the share it may keep shipping", () => {
    const at = (burden: number) => equilibriumExportScale(0, burden);
    const burdens = [0, 0.1, 0.3, 0.6, 1, 3];
    const scales = burdens.map(at);
    expect(scales[0]).toBe(1); // nothing committed ⇒ ship it all
    for (let i = 1; i < scales.length; i++) expect(scales[i]!).toBeLessThan(scales[i - 1]!);
    // It approaches 0 but never reaches it while the town is fed: an exporter
    // whose lane is ten times its own draw still lets a trickle out.
    expect(at(100)).toBeGreaterThan(0);
    expect(at(100)).toBeLessThan(0.01);
  });

  it("🔒 degenerate inputs never mint, never NaN, never throw", () => {
    expect(equilibriumExportScale(0, NaN)).toBe(exportSpareScale(0)); // unreadable burden ⇒ the slope
    expect(equilibriumExportScale(0, Infinity)).toBe(exportSpareScale(0));
    expect(equilibriumExportScale(0, -5)).toBe(exportSpareScale(0)); // a negative commitment is none
    // An UNREADABLE SHORTAGE behaves exactly as the shipped slope does — NaN
    // in, NaN out — because this is the same clamp, and a twin that quietly
    // disagreed about a degenerate input would be the worse outcome. The
    // boundary that consumes it rejects a non-finite reading and falls back to
    // 1 (`exportPile`'s clamp, pinned in trade-import-channel).
    expect(Number.isNaN(equilibriumExportScale(NaN, 0.3))).toBe(true);
    expect(Number.isNaN(exportSpareScale(NaN))).toBe(true);
    for (const s0 of [-1, 0, 0.5, 2]) {
      for (const b of [-1, 0, 0.3, 9]) {
        const v = equilibriumExportScale(s0, b);
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it("🔒 the shipped SLOPE is untouched — its own gate, its own line", () => {
    // The G2 suite pins `exportSpareScale` on its own; this is the one-line
    // restatement that B4 added a sibling and did not edit the original.
    expect(exportSpareScale(0)).toBe(1);
    expect(exportSpareScale(BARTER_WANT_MIN)).toBe(0);
    expect(exportSpareScale(BARTER_WANT_MIN / 2)).toBeCloseTo(0.5, 12);
  });
});
