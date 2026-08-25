// POPULATION FOLLOWS CAPACITY (food-scale-round.md STAGE β1/β1b, ⑫) — a
// config that declares a settlement tier declares a BODY, and TWO quantities
// derive from it:
//
//   seats   — `TIER_POP_CAP[tier]` (scale.ts, the MEASURED street-tree
//             capacities): what the streets HOUSE, the number population
//             SETTLES ON (the round's opening ruling: "a 240 m village of
//             28 houses and 140 souls"), and the founding-crowd clamp.
//   ceiling — the Malthus crowding parameter (`vitals.capacity`, bound to
//             the "pop_ceiling" anchor — kernel/civ/tri.ts convention):
//             where births hit ZERO. The logistic taper settles at
//             ceiling × (1 − death/birth), so town-play passes
//             seats ÷ (1 − death/birth), derived from the SAME compiled
//             vitals the TownWorld day step reads — never a literal.
//
// NO tier ⇒ NOTHING — no scalar, no vitals entry, byte-identical books (the
// dollhouse bench replay and the deliberately tierless tier-0 planet
// capitals both stand on the absent path).
//
// MEASURED (2026-08-24, shipped human vitals birth .02 / death .01 ⇒ village
// ceiling 280, hamlet 28): from the seats the population holds them exactly
// (140.000 / 14.000 flat, day 2..900); from below, 40 → 139.14 and
// 5 → 13.94 by day 600; from above, 200 → 180.39 at day 30 (births TAPERED —
// zeroed births measured 149.4 there) → 140.10 by day 600. Uncapped, the
// same config grows to 973 by day 160 (the Earthlike visited-city figure).
//
// Pure logic + headless `buildTownPlay` (no DOM/GL/DB — and NEVER quest-host).

import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileEconomy } from "@shared/world-engine/kernel/modules/economy/index.js";
import { createTownWorld, type TownWorldOpts } from "@shared/world-engine/kernel/town/town-world.js";
import { buildTownPlay, townPlayEconomy } from "@shared/world-engine/interaction/town/town-play.js";
import { TIER_POP_CAP } from "@shared/world-engine/scale.js";

const CHARTER = { farmland: 420, ore_access: 0 } as const;
const CEILING = "pop_ceiling";
const ECO = compileEconomy([townPlayEconomy()], { construction: true });
/** The SAME vitals resolution town-play/town-world apply — the ceiling the
 *  implementation must derive, computed independently here. */
const VIT = ECO.vitals[0] ?? { birthRate: 0.02, deathRate: 0.01 };
const ceilingOf = (seats: number): number =>
  VIT.birthRate > VIT.deathRate ? seats / (1 - VIT.deathRate / VIT.birthRate) : seats;

/** A bare capacity-seat town — the integrator without the street build. */
const mkTown = (key: string, startPop: number, capacity?: number) =>
  createTownWorld({
    economy: ECO,
    charter: { ...CHARTER },
    startPop,
    ...(capacity !== undefined ? { capacity } : {}),
    seedScalars: { farms: 1 },
    key,
  });

describe("town-capacity: population follows capacity (STAGE β1/β1b)", () => {
  it("a village-tier visit settles ON its seats (TIER_POP_CAP.village ± 5%)", () => {
    const seats = TIER_POP_CAP.village;
    // The cityTownConfig shape: startPop 200, seat-clamped to 140 = the
    // equilibrium itself — the population must HOLD there, not sag to
    // ceiling/2 (β1's original defect: capacity==seats settled at 70).
    const play = buildTownPlay({
      seed: 11, key: "cap-v", startPop: 200, days: 160, charter: { ...CHARTER }, tier: "village",
    });
    expect(play.town.scalar("population")).toBeGreaterThanOrEqual(seats * 0.95);
    expect(play.town.scalar("population")).toBeLessThanOrEqual(seats * 1.05);
    play.town.step(440); // day 600 — generous
    const pop = play.town.scalar("population");
    expect(pop).toBeGreaterThanOrEqual(seats * 0.95);
    expect(pop).toBeLessThanOrEqual(seats * 1.05);
  });

  it("a below-seats village GROWS to the seats (± 5% from below)", () => {
    const seats = TIER_POP_CAP.village;
    const t = mkTown("cap-grow", 40, ceilingOf(seats));
    t.step(600); // measured 139.14 — within the band from below
    const pop = t.scalar("population");
    expect(pop).toBeGreaterThanOrEqual(seats * 0.95);
    expect(pop).toBeLessThanOrEqual(seats * 1.05);
  });

  it("startPop above the seats is clamped at boot", () => {
    // days 0: the fast-forward never runs, so the day-0 books show the
    // founding crowd EXACTLY as the seat clamp left it — 200 asked, 140
    // seated. The clamp is the SEATS, never the crowding ceiling.
    const play = buildTownPlay({
      seed: 11, key: "cap-boot", startPop: 200, days: 0, charter: { ...CHARTER }, tier: "village",
    });
    expect(play.town.scalar("population")).toBe(TIER_POP_CAP.village);
  });

  it("population above the seats declines to them — births tapered, not zeroed", () => {
    const seats = TIER_POP_CAP.village;
    const t = mkTown("cap-over", 200, ceilingOf(seats)); // createTownWorld does NOT clamp — decline is the physics
    const samples: number[] = [];
    // (Sampling starts at day 2: the population scalar is written at day
    // START, so after step(1) it still shows the founding books.)
    for (const d of [2, 10, 20, 30]) {
      t.step(d - t.day);
      samples.push(t.scalar("population"));
    }
    expect(samples[0]!).toBeLessThan(200);
    for (let i = 1; i < samples.length; i++) expect(samples[i]!).toBeLessThan(samples[i - 1]!);
    // TAPERED births, not zeroed: 200 sits between seats (140) and ceiling
    // (280), so people are still born on the way down — measured 180.4 at
    // day 30, where a births-zeroed integrator (ceiling==seats) measures
    // 149.4. This is the pin that separates β1b's ceiling from β1's cap.
    expect(samples[3]!).toBeGreaterThan(165);
    t.step(600 - t.day); // measured 140.10
    const settled = t.scalar("population");
    expect(settled).toBeGreaterThanOrEqual(seats * 0.95);
    expect(settled).toBeLessThanOrEqual(seats * 1.05);
  });

  it("the ceiling scalar carries the DERIVED ceiling — seats ÷ (1 − death/birth), from the live vitals", () => {
    const play = buildTownPlay({
      seed: 11, key: "cap-some", startPop: 200, days: 0, charter: { ...CHARTER }, tier: "village",
    });
    const anchor = play.town.dual.entityWorld.scalars[CEILING]?.[0];
    // Computed here from the same vitals source the implementation reads —
    // 280 at the shipped .02/.01, but the pin follows a re-dialled species.
    expect(anchor).toBeCloseTo(ceilingOf(TIER_POP_CAP.village), 9);
    // And it is NOT the seat count itself: a ceiling==seats wiring settles
    // at seats/2, the exact defect β1b corrects.
    expect(anchor).toBeGreaterThan(TIER_POP_CAP.village);
  });

  it("a tierless config declares NOTHING — no ceiling scalar, and growth runs past every tier cap", () => {
    const play = buildTownPlay({
      seed: 11, key: "cap-none", startPop: 200, days: 160, charter: { ...CHARTER },
    });
    // Shape pin: the ceiling anchor must be ABSENT from the books, not 0 —
    // a 0-valued capacity would silently zero births (economy.ts's own
    // warning about undeclared ceiling reads).
    expect(play.town.dual.entityWorld.scalars[CEILING]).toBeUndefined();
    // Behavior pin: an accidental default tier tapers this growth; untouched
    // it clears the village seats by day 160 (measured 973 — the Earthlike
    // visited-city figure).
    expect(play.town.scalar("population")).toBeGreaterThan(TIER_POP_CAP.village);
  });

  it("explicit `capacity: undefined` is the identical world (trajectory equality)", () => {
    const base: TownWorldOpts = {
      economy: ECO, charter: { ...CHARTER }, startPop: 120, seedScalars: { farms: 1 },
    };
    const a = createTownWorld({ ...base, key: "cap-eq-a" });
    const b = createTownWorld({ ...base, key: "cap-eq-b", capacity: undefined });
    expect(a.dual.entityWorld.scalars[CEILING]).toBeUndefined();
    expect(b.dual.entityWorld.scalars[CEILING]).toBeUndefined();
    for (const d of [1, 30, 90, 160]) {
      a.step(d - a.day);
      b.step(d - b.day);
      expect(b.scalar("population")).toBe(a.scalar("population")); // exact, not approximate
    }
  });

  it("the hamlet tier settles on ITS row — the table is live per-tier, not a hardcoded 140", () => {
    const seats = TIER_POP_CAP.hamlet;
    const play = buildTownPlay({
      seed: 11, key: "cap-h", startPop: 200, days: 160, charter: { ...CHARTER }, tier: "hamlet",
    });
    const pop = play.town.scalar("population");
    expect(pop).toBeGreaterThanOrEqual(seats * 0.95); // 14 ± 5% — a 140 hardcode holds ~140 here and reds
    expect(pop).toBeLessThanOrEqual(seats * 1.05);
  });

  it("the seat derivation reads TIER_POP_CAP (source-shape pin, not a literal)", () => {
    const src = readFileSync(
      join(process.cwd(), "shared", "world-engine", "interaction", "town", "town-play.ts"), "utf8",
    );
    // The one seat that sees both config.tier and world creation must go
    // through the measured table — never a copied number.
    expect(src).toMatch(/config\.tier\s*\?\s*TIER_POP_CAP\[config\.tier\]\s*:\s*undefined/);
  });
});
