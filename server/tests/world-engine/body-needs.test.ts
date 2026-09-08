/**
 * ⚖️ THE BODY-ANCHORED NEED PRIMITIVE (body-needs-round.md D1) — the PURE half.
 *
 * `shared/world-engine/interaction/behavior/body-needs.ts` is a lazily-stamped
 * meter: `{ level, at }`, read as a closed form at the moment somebody asks and
 * never ticked. These are the laws that make that safe to build a settler's
 * whole life on, each stated as a test rather than as a comment:
 *
 *  ① LAZY — the level at `now` is `level + rate × (now − at)`, and asking does
 *    not move it. Two reads at the same `now` agree; a read at a past `now`
 *    never un-eats a meal.
 *  ② CLOSED-FORM CROSSING — a lazy row knows the SECOND it fires, which is
 *    what lets a settler sleep instead of re-deciding on a cap.
 *  ③ A SATISFY WRITES A TIMESTAMP — "cleared" without a clock is a level that
 *    starts rising again from whenever it was last read.
 *  ④ REST/WAKE IS AN IDENTITY, byte for byte, and stocks (levels) never move
 *    through it — fold.ts's persistence-arm law.
 *  ⑤ THE GROUND IS A SATISFIER OF QUALITY 0.5, not a missing bed: a bed clears
 *    (byte-identical to every rest-arrival site the engine already had), the
 *    ground leaves half the deficit behind.
 *  ⑥ THE LADDER AND THE LIVELOCK INVARIANT — the homeless body's rows are the
 *    resident rows at the resident priorities, and hunger (which ACQUIRES food)
 *    outranks every deposit-shaped row for food.
 *
 * DB-free / GL-free / host-free — `npm run test:engine -- body-needs`.
 */
import { describe, it, expect } from "@jest/globals";
import {
  REST_QUALITY,
  bodyNeedAdvance,
  bodyNeedCrossingAt,
  bodyNeedLevel,
  bodyNeedSatisfy,
  bodyNeedTemplates,
  restBodyNeeds,
  restClear,
  wakeBodyNeeds,
  type BodyNeedRow,
} from "@shared/world-engine/interaction/behavior/body-needs.js";
import { DOLLHOUSE_SCALE, NEED_FILL_DAYS, needRate } from "@shared/world-engine/scale.js";
import {
  MEAL_PERIOD_SEC,
  mealOffset,
  scheduledEnergy,
} from "@shared/world-engine/kernel/town/activity.js";
import {
  energyTemplate,
  hungerTemplate,
  type NeedTemplate,
} from "@shared/world-engine/interaction/behavior/needs.js";

// The dollhouse scale's own energy rate — every rate in this file comes from
// the ONE rate source, never from a number written here (D1 law ③).
const HUNGER_RATE = needRate(DOLLHOUSE_SCALE, "hunger");
const ENERGY_RATE = needRate(DOLLHOUSE_SCALE, "energy");

describe("① THE LAZY READ — a level is a function of time, not a thing that ticks", () => {
  it("advances by rate × elapsed from the stamp", () => {
    const row: BodyNeedRow = { level: 0.25, at: 100 };
    expect(bodyNeedLevel(row, HUNGER_RATE, 100)).toBeCloseTo(0.25, 12);
    expect(bodyNeedLevel(row, HUNGER_RATE, 100 + 1 / HUNGER_RATE)).toBeCloseTo(1.25, 12);
  });

  it("READING DOES NOT MOVE IT — the row is untouched, so two readers agree", () => {
    const row: BodyNeedRow = { level: 0.4, at: 50 };
    const a = bodyNeedLevel(row, HUNGER_RATE, 500);
    const b = bodyNeedLevel(row, HUNGER_RATE, 500);
    expect(a).toBe(b);
    expect(row).toEqual({ level: 0.4, at: 50 });
  });

  it("a `now` BEFORE the stamp reads the stamped level — never a negative advance", () => {
    const row: BodyNeedRow = { level: 0.8, at: 900 };
    expect(bodyNeedLevel(row, HUNGER_RATE, 0)).toBe(0.8);
  });

  it("a rate of 0 is a DUTY, not a deficit — the level never moves", () => {
    const row: BodyNeedRow = { level: 0.3, at: 0 };
    expect(bodyNeedLevel(row, 0, 1e6)).toBe(0.3);
  });

  it("ADVANCE re-anchors without changing what the row says", () => {
    const row: BodyNeedRow = { level: 0.2, at: 10 };
    const moved = bodyNeedAdvance(row, HUNGER_RATE, 250);
    expect(moved.at).toBe(250);
    expect(moved.level).toBeCloseTo(bodyNeedLevel(row, HUNGER_RATE, 250), 12);
    // …and the re-anchored row reads the SAME as the original from then on.
    expect(bodyNeedLevel(moved, HUNGER_RATE, 999)).toBeCloseTo(
      bodyNeedLevel(row, HUNGER_RATE, 999),
      12,
    );
  });
});

describe("② THE CROSSING — a lazy row knows the second it fires", () => {
  it("is the closed form `at + (threshold − level)/rate`", () => {
    const row: BodyNeedRow = { level: 0, at: 40 };
    // hunger fills in NEED_FILL_DAYS.hunger × dayLengthS seconds by definition
    const fillS = NEED_FILL_DAYS.hunger * DOLLHOUSE_SCALE.dayLengthS;
    expect(bodyNeedCrossingAt(row, HUNGER_RATE, 1)).toBeCloseTo(40 + fillS, 6);
  });

  it("a row ALREADY at threshold crosses in the PAST — every caller reads that as 'decide now'", () => {
    const row: BodyNeedRow = { level: 1.5, at: 200 };
    expect(bodyNeedCrossingAt(row, HUNGER_RATE, 1)).toBeLessThan(200);
  });

  it("a zero rate NEVER crosses — Infinity, so a duty row cannot pin a re-decide every frame", () => {
    expect(bodyNeedCrossingAt({ level: 0, at: 0 }, 0, 1)).toBe(Number.POSITIVE_INFINITY);
    expect(bodyNeedCrossingAt({ level: 0, at: 0 }, -1, 1)).toBe(Number.POSITIVE_INFINITY);
  });

  it("the crossing AGREES with the lazy read — at that second the row is exactly firing", () => {
    const row: BodyNeedRow = { level: 0.31, at: 77 };
    const t = bodyNeedCrossingAt(row, ENERGY_RATE, 1);
    expect(bodyNeedLevel(row, ENERGY_RATE, t)).toBeCloseTo(1, 9);
  });
});

describe("③ SATISFY WRITES A TIMESTAMP", () => {
  it("pins the level AND stamps the clock", () => {
    const row: BodyNeedRow = { level: 1.4, at: 10 };
    const after = bodyNeedSatisfy(row, HUNGER_RATE, 640, 0);
    expect(after).toEqual({ level: 0, at: 640 });
  });

  it("and the stamp is what makes the next read honest — a satisfied row rises from NOW", () => {
    const row: BodyNeedRow = { level: 1.4, at: 10 };
    const after = bodyNeedSatisfy(row, HUNGER_RATE, 640, 0);
    // one fill-time later it is firing again, measured from the SATISFY, not
    // from the original stamp.
    const fillS = NEED_FILL_DAYS.hunger * DOLLHOUSE_SCALE.dayLengthS;
    expect(bodyNeedLevel(after, HUNGER_RATE, 640 + fillS)).toBeCloseTo(1, 9);
  });

  it("a partial satisfy keeps the remainder (the ground's half-rest)", () => {
    const row: BodyNeedRow = { level: 1.8, at: 0 };
    const after = bodyNeedSatisfy(row, ENERGY_RATE, 300, restClear(1.8, REST_QUALITY.ground));
    expect(after.level).toBeCloseTo(1.3, 12);
    expect(after.at).toBe(300);
  });

  it("never writes a negative level", () => {
    expect(bodyNeedSatisfy({ level: 0.2, at: 0 }, ENERGY_RATE, 5, -3).level).toBe(0);
  });
});

describe("④ REST / WAKE — the identity law, byte for byte", () => {
  const payload = {
    "hunger:food": { level: 0.625, at: 120.5 },
    energy: { level: 1.25, at: 44.25 },
  } as const;

  it("wake(rest(p, t), t) ≡ p", () => {
    for (const t of [0, 1, 240, 1000, 4096.5]) {
      expect(wakeBodyNeeds(restBodyNeeds(payload, t), t)).toEqual(payload);
    }
  });

  it("REST rebases the stamps RELATIVE to now", () => {
    const rested = restBodyNeeds(payload, 100);
    expect(rested["hunger:food"]!.at).toBe(20.5);
    expect(rested.energy!.at).toBe(-55.75);
  });

  it("LEVELS NEVER MOVE THROUGH EITHER — conservation is untouched by time travel", () => {
    const rested = restBodyNeeds(payload, 987.5);
    const woken = wakeBodyNeeds(rested, 12.25);
    for (const k of Object.keys(payload) as (keyof typeof payload)[]) {
      expect(rested[k]!.level).toBe(payload[k].level);
      expect(woken[k]!.level).toBe(payload[k].level);
    }
  });

  it("neither arm mutates its input", () => {
    const p = { energy: { level: 0.5, at: 3 } };
    restBodyNeeds(p, 9);
    wakeBodyNeeds(p, 9);
    expect(p).toEqual({ energy: { level: 0.5, at: 3 } });
  });
});

describe("⑤ THE SATISFIER'S QUALITY — a bed clears, the ground half-clears", () => {
  it("a BED is quality 1 and clears outright (every existing rest site, byte-identical)", () => {
    expect(REST_QUALITY.bed).toBe(1);
    expect(restClear(0, REST_QUALITY.bed)).toBe(0);
    expect(restClear(1, REST_QUALITY.bed)).toBe(0);
    expect(restClear(9.5, REST_QUALITY.bed)).toBe(0);
  });

  it("the GROUND is quality 0.5 and leaves the remainder", () => {
    expect(REST_QUALITY.ground).toBe(0.5);
    expect(restClear(1.8, REST_QUALITY.ground)).toBeCloseTo(1.3, 12);
    expect(restClear(0.5, REST_QUALITY.ground)).toBe(0);
    expect(restClear(0.2, REST_QUALITY.ground)).toBe(0); // never negative
  });

  it("BAD REST IS MORE SLEEPING, NOT A LONGER NAP — a rough night converges, it does not spin", () => {
    // The livelock question in one arithmetic: a body sleeping rough clears
    // 0.5 per sleep and gains only the dwell's worth back, so the deficit
    // strictly decreases and the sequence terminates.
    const dwellS = DOLLHOUSE_SCALE.sleepFraction * DOLLHOUSE_SCALE.dayLengthS;
    let level = 2.0;
    let sleeps = 0;
    while (level >= 1 && sleeps < 50) {
      level = restClear(level, REST_QUALITY.ground) + ENERGY_RATE * dwellS;
      sleeps++;
    }
    expect(level).toBeLessThan(1);
    expect(sleeps).toBeGreaterThan(1); // …and it took MORE THAN ONE sleep
    expect(sleeps).toBeLessThan(10);
  });
});

describe("⑥ THE HOMELESS BODY'S ROWS — one behavior model, the resident ladder", () => {
  const rows = bodyNeedTemplates(DOLLHOUSE_SCALE, { pullOn: false });
  const pullRows = bodyNeedTemplates(DOLLHOUSE_SCALE, { pullOn: true });
  const byKey = (rs: readonly NeedTemplate[], k: string) => rs.find((r) => r.key === k);

  it("hunger and energy, and nothing invented", () => {
    expect(rows.map((r) => r.key)).toEqual(["hunger:food", "energy"]);
  });

  it("the PRIORITIES are the resident ones — the ladder F2 and the livelock pin are written on", () => {
    expect(byKey(rows, "hunger:food")!.priority).toBe(hungerTemplate("food", 1).priority);
    expect(byKey(rows, "energy")!.priority).toBe(energyTemplate(1).priority);
    expect(byKey(rows, "hunger:food")!.priority).toBe(5);
    expect(byKey(rows, "energy")!.priority).toBe(4);
  });

  it("HUNGER EATS IN PLACE — no table, because there is no dining room", () => {
    const h = byKey(rows, "hunger:food")!;
    expect(h.satisfy).toEqual({ kind: "consume", at: [] });
  });

  it("REST does not REQUIRE a station — no bed ⇒ the ground, never 'blocked'", () => {
    const e = byKey(rows, "energy")!;
    expect(e.satisfy.kind).toBe("rest");
    expect((e.satisfy as { requireStation?: boolean }).requireStation).toBeUndefined();
    expect((e.satisfy as { at?: readonly string[] }).at).toEqual(["bed"]);
  });

  it("the RATES come from the scale, never from this module", () => {
    expect((byKey(rows, "hunger:food")!.drive as { rate: number }).rate).toBe(HUNGER_RATE);
    expect((byKey(rows, "energy")!.drive as { rate: number }).rate).toBe(ENERGY_RATE);
  });

  it("the put-down row rides the CAPABILITY, and is the ladder's bottom rung", () => {
    expect(byKey(rows, "relieve")).toBeUndefined();
    expect(byKey(pullRows, "relieve")!.priority).toBe(0.8);
  });

  it("🚨 THE LIVELOCK INVARIANT — hunger ACQUIRES food and outranks every deposit-shaped row", () => {
    const acquirers = pullRows.filter((r) => r.acquire.length > 0);
    const deposits = pullRows.filter((r) => r.satisfy.kind === "deposit");
    expect(acquirers.map((r) => r.key)).toEqual(["hunger:food"]);
    for (const d of deposits) {
      // structurally safe: the deposit rows here have NO acquire branches at
      // all, so they can never pick up what hunger put down…
      expect(d.acquire).toEqual([]);
      // …and they are outranked anyway.
      for (const a of acquirers) expect(a.priority).toBeGreaterThan(d.priority);
    }
  });

  it("hunger acquires through the container→source→storage→loose branches (forage is a CANDIDATE, not a branch)", () => {
    expect(byKey(rows, "hunger:food")!.acquire).toEqual(hungerTemplate("food", 1, []).acquire);
  });
});

/**
 * ⑦ ⚖️ 0-3 — ENERGY HAS A SCHEDULE PHASE (politics-substrate STAGE 0).
 *
 * `scheduledEnergy` is the twin of `scheduledHunger`: what a body's tiredness
 * would be if it had been living its life off-screen. The seed it replaces was
 * a per-body HASH (`mealOffset/period × 0.7`) — deterministic, stable, and
 * completely uncorrelated with the time of day, so a resident promoted at dusk
 * arrived as fresh as one promoted at dawn and the U4 demote-home-to-rest
 * (which IS a dark household's sleep) fired ONCE in a 2.54-day frontier arc.
 *
 * The laws, as tests: it is a DAY PHASE (rises across the day, clears at the
 * night edge); it is PERIODIC in the day; it STAGGERS by the same per-member
 * hash the meal schedule rides; and — the property the old seed lacked — it
 * MOVES WITH THE CLOCK, which is the whole difference between "tired because
 * it is late" and "tired because of who you are".
 */
describe("⑦ THE ENERGY SCHEDULE PHASE — tired because it is late", () => {
  const off = mealOffset(7, 3, 1);

  it("LOW after the night, HIGH late in the day — and it never leaves [0, 1)", () => {
    // The phase-dawn for this body is where its own sawtooth resets.
    const dawn = (MEAL_PERIOD_SEC - off) % MEAL_PERIOD_SEC;
    expect(scheduledEnergy(off, dawn)).toBeCloseTo(0, 9);
    expect(scheduledEnergy(off, dawn + MEAL_PERIOD_SEC * 0.25)).toBeCloseTo(0.25, 9);
    expect(scheduledEnergy(off, dawn + MEAL_PERIOD_SEC * 0.95)).toBeCloseTo(0.95, 9);
    for (let t = 0; t < MEAL_PERIOD_SEC * 3; t += 7) {
      const v = scheduledEnergy(off, t);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("RISES monotonically through the day and RESETS at the night edge", () => {
    const dawn = (MEAL_PERIOD_SEC - off) % MEAL_PERIOD_SEC;
    let prev = -1;
    for (let u = 0; u < MEAL_PERIOD_SEC - 1; u += 3) {
      const v = scheduledEnergy(off, dawn + u);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
    // …and the very next day starts over: the night cleared it.
    expect(scheduledEnergy(off, dawn + MEAL_PERIOD_SEC)).toBeCloseTo(0, 9);
  });

  it("is PERIODIC in the day — the same phase a day later reads the same", () => {
    for (const t of [0, 31, 117, 199]) {
      expect(scheduledEnergy(off, t + MEAL_PERIOD_SEC)).toBeCloseTo(scheduledEnergy(off, t), 9);
      expect(scheduledEnergy(off, t + 5 * MEAL_PERIOD_SEC)).toBeCloseTo(scheduledEnergy(off, t), 9);
    }
  });

  it("STAGGERS the household by the SAME hash the meal schedule rides", () => {
    const members = [0, 1, 2, 3, 4].map((m) => scheduledEnergy(mealOffset(7, 3, m * 7 + "energy".length), 100));
    expect(new Set(members).size).toBe(members.length); // no two in one frame
  });

  it("🚨 MOVES WITH THE CLOCK — which the constant seed it replaces never did", () => {
    const old = (o: number) => (o / MEAL_PERIOD_SEC) * 0.7; // the shipped seed, verbatim
    expect(old(off)).toBe(old(off)); // time-invariant by construction
    const a = scheduledEnergy(off, 10);
    const b = scheduledEnergy(off, 10 + MEAL_PERIOD_SEC * 0.5);
    expect(Math.abs(a - b)).toBeCloseTo(0.5, 9);
  });

  it("a body woken by the schedule is BELOW the firing threshold; one at dusk is at its door", () => {
    const dawn = (MEAL_PERIOD_SEC - off) % MEAL_PERIOD_SEC;
    const dusk = dawn + MEAL_PERIOD_SEC * 0.99;
    // The live meter then advances at the scale's own rate from the seed — so
    // the dusk body fires within a fraction of the fill and the dawn one does
    // not fire for most of a day. (Threshold 1, the engine's one meter unit.)
    const toFireS = (seed: number) => (1 - seed) / ENERGY_RATE;
    expect(toFireS(scheduledEnergy(off, dusk))).toBeLessThan(toFireS(scheduledEnergy(off, dawn)) / 50);
  });
});
