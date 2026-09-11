// THE HOUSEHOLD-RUNG SKILL FOLD (skill-learning-round.md, the REGIONAL slice)
// — the two host doors quest-host.ts calls at `[skills] fold` / `[skills]
// unfold`, driven against the REAL cohort payload (`demoteHousehold` /
// `promoteHousehold`) and a stand-in for the one thing a pure test cannot
// boot: the live `session.bodySkills` map. Transcribed from
// `cohort-regard-fold.test.ts`, the same household rung one map over.
//
// Three laws are on trial here:
//   ① THE LEAK IS CLOSED — after a demote no MEMBER row survives in the live
//      map; a NON-member's rows are untouched (they belong to nobody's fold).
//   ② A NOVICE household carries NO `skills` field on the payload, and
//      promotes with no rows; a PRACTISED household round-trips (Σ seconds
//      conserved, pinned apprentice verbatim).
//   ③ DETERMINISM — two promotes from the same frozen payload are byte-equal,
//      and the payload survives the cohort codec's own `JSON.parse(JSON.
//      stringify(...))` copy.
//
// No DOM / GL / host.

import { describe, it, expect } from "@jest/globals";
import { MEAL_PERIOD_SEC, mealOffset } from "@shared/world-engine/kernel/town/activity.js";
import { foldHouseSkills, projectHouseSkills } from "@shared/world-engine/kernel/town/skill-prior.js";
import {
  DEFAULT_SKILL_CATALOGUE,
  masteryS,
  type BodySkillRow,
} from "@shared/world-engine/kernel/town/skills.js";
import { DOLLHOUSE_SCALE } from "@shared/world-engine/scale.js";
import {
  cohortPopulation,
  demoteHousehold,
  promoteHousehold,
  type CohortHouse,
  type CohortRow,
} from "@shared/world-engine/kernel/town/population.js";

const HOUSEHOLD = 5;
const HOUSE = 3;
const SEED = 1234;
const CURVE = { skills: DEFAULT_SKILL_CATALOGUE, scale: DOLLHOUSE_SCALE };
const MASTERY_S = masteryS(DEFAULT_SKILL_CATALOGUE.get("felling")!, DOLLHOUSE_SCALE);

const membersOf = (houseIndex: number): string[] =>
  Array.from({ length: HOUSEHOLD }, (_, m) => `resident_${houseIndex}_${m}`);

/** The host's own stagger, quoted from `promoteHouse`: the SAME seeded hash
 *  the meter and regard unfolds stagger by. */
const phiOf = (_cid: string, key: string, m: number): number =>
  Math.max(0, Math.min(1, mealOffset(SEED, HOUSE, m * 7 + key.length) / MEAL_PERIOD_SEC));

const rowsOf = (practiceS: number): Map<string, BodySkillRow> => new Map([["felling", { practiceS }]]);

/**
 * The two host hunks, transcribed down to their arithmetic: everything below
 * the `bodySkills.` prefix is the real pure module, and the fake is only the
 * map (`quest-host.ts`'s `session.bodySkills`).
 */
function demote(
  bodySkills: Map<string, Map<string, BodySkillRow>>,
  rows: CohortRow[],
  houseIndex: number,
): CohortHouse {
  const members = membersOf(houseIndex);
  const fold = foldHouseSkills((cid) => bodySkills.get(cid), members, CURVE);
  for (const cid of members) bodySkills.delete(cid);
  const skillKeys = Object.keys(fold.skills).length;
  const skillPins = Object.keys(fold.pinned).length;
  const house: CohortHouse = {
    index: houseIndex,
    members: HOUSEHOLD,
    ...(skillKeys > 0 ? { skills: fold.skills } : {}),
    ...(skillPins > 0 ? { skillPins: fold.pinned } : {}),
  };
  demoteHousehold(rows, -1, house, {}, 0.75, 0);
  return house;
}

function promote(bodySkills: Map<string, Map<string, BodySkillRow>>, rows: CohortRow[], houseIndex: number): number {
  const promoted = promoteHousehold(rows, houseIndex);
  if (!promoted) return 0;
  const projected = projectHouseSkills(promoted.house, membersOf(houseIndex), phiOf);
  for (const r of projected) bodySkills.set(r.cid, r.rows);
  return projected.length;
}

// ---------------------------------------------------------------------------

describe("① the leak is closed — which rows a demote takes", () => {
  it("deletes every member's rows and leaves a non-member's untouched", () => {
    const bodySkills = new Map<string, Map<string, BodySkillRow>>();
    for (const cid of membersOf(HOUSE)) bodySkills.set(cid, rowsOf(1000));
    bodySkills.set("resident_9_0", rowsOf(2000)); // a bystander, another household
    const rows: CohortRow[] = [];

    demote(bodySkills, rows, HOUSE);

    for (const cid of membersOf(HOUSE)) expect(bodySkills.has(cid)).toBe(false);
    expect(bodySkills.has("resident_9_0")).toBe(true);
    expect(bodySkills.size).toBe(1);
  });

  it("touches no other household's rows", () => {
    const bodySkills = new Map<string, Map<string, BodySkillRow>>();
    for (const cid of [...membersOf(HOUSE), ...membersOf(4)]) bodySkills.set(cid, rowsOf(1000));
    demote(bodySkills, [], HOUSE);
    for (const cid of membersOf(4)) expect(bodySkills.has(cid)).toBe(true);
    expect(bodySkills.size).toBe(HOUSEHOLD);
  });
});

describe("② novice vs practised households", () => {
  it("a household of NOVICES carries no `skills` field, and promotes with no rows", () => {
    const bodySkills = new Map<string, Map<string, BodySkillRow>>();
    const rows: CohortRow[] = [];
    const house = demote(bodySkills, rows, HOUSE);
    expect(house.skills).toBeUndefined();
    expect(house.skillPins).toBeUndefined();
    expect(promote(bodySkills, rows, HOUSE)).toBe(0);
    expect(bodySkills.size).toBe(0);
  });

  it("a PRACTISED household round-trips: Σ seconds conserved, pinned apprentice verbatim", () => {
    const bodySkills = new Map<string, Map<string, BodySkillRow>>();
    const members = membersOf(HOUSE);
    const appS = Math.pow(0.4, 1 / 0.4) * MASTERY_S;
    bodySkills.set(members[0]!, rowsOf(MASTERY_S)); // the master
    bodySkills.set(members[1]!, rowsOf(appS)); // the apprentice — deviates past SKILL_PIN_EPS
    const rows: CohortRow[] = [];

    const house = demote(bodySkills, rows, HOUSE);
    expect(Object.keys(house.skillPins ?? {})).toEqual([members[1]]);
    expect(house.skills!.felling!.meanS).toBeCloseTo(MASTERY_S, 6); // the master alone, re-folded
    expect(bodySkills.size).toBe(0);

    const written = promote(bodySkills, rows, HOUSE);
    expect(written).toBeGreaterThan(0);
    // The pinned apprentice comes back byte-equal.
    expect(bodySkills.get(members[1]!)!.get("felling")).toEqual({ practiceS: appS });
    // Σ seconds is conserved: exactly one of the unpinned members now carries
    // the master's practice (k = round(0.25 × 4) = 1, at meanS exactly).
    let sumUnpinned = 0;
    let holders = 0;
    for (const cid of members) {
      if (cid === members[1]) continue;
      const p = bodySkills.get(cid)?.get("felling")?.practiceS ?? 0;
      if (p > 0) {
        holders++;
        sumUnpinned += p;
      }
    }
    expect(holders).toBe(1);
    expect(sumUnpinned).toBeCloseTo(MASTERY_S, 6);

    // …and re-folding the promoted household gives the prior back.
    const rows2: CohortRow[] = [];
    const again = demote(bodySkills, rows2, HOUSE);
    expect(again.skills!.felling!.meanS).toBeCloseTo(house.skills!.felling!.meanS, 6);
    expect(again.skills!.felling!.share).toBeCloseTo(house.skills!.felling!.share, 9);
  });

  it("a pinned soul is still a MEMBER, never a second population row", () => {
    const bodySkills = new Map<string, Map<string, BodySkillRow>>();
    const members = membersOf(HOUSE);
    const appS = Math.pow(0.4, 1 / 0.4) * MASTERY_S;
    bodySkills.set(members[0]!, rowsOf(MASTERY_S));
    bodySkills.set(members[1]!, rowsOf(appS));
    const rows: CohortRow[] = [];
    const house = demote(bodySkills, rows, HOUSE);
    expect(Object.keys(house.skillPins ?? {}).length).toBe(1);
    expect(cohortPopulation(rows)).toBe(HOUSEHOLD);
    expect(rows[0]!.houses[0]!.members).toBe(HOUSEHOLD);
    promote(bodySkills, rows, HOUSE);
    expect(cohortPopulation(rows)).toBe(0);
  });
});

describe("③ determinism", () => {
  it("two promotes from the same frozen payload are byte-equal", () => {
    const build = (): Map<string, Map<string, BodySkillRow>> => {
      const m = new Map<string, Map<string, BodySkillRow>>();
      const members = membersOf(HOUSE);
      m.set(members[0]!, rowsOf(MASTERY_S));
      m.set(members[2]!, rowsOf(MASTERY_S * 0.5));
      return m;
    };
    const dump = (m: Map<string, Map<string, BodySkillRow>>): string =>
      JSON.stringify(
        [...m.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([cid, rows]) => [cid, [...rows.entries()].sort()]),
      );

    const bodyA = build();
    const rowsA: CohortRow[] = [];
    demote(bodyA, rowsA, HOUSE);
    promote(bodyA, rowsA, HOUSE);

    const bodyB = build();
    const rowsB: CohortRow[] = [];
    demote(bodyB, rowsB, HOUSE);
    promote(bodyB, rowsB, HOUSE);

    expect(dump(bodyA)).toBe(dump(bodyB));
  });

  it("the payload survives the cohort row's own JSON round trip (nothing is aliased)", () => {
    const bodySkills = new Map<string, Map<string, BodySkillRow>>();
    const members = membersOf(HOUSE);
    bodySkills.set(members[0]!, rowsOf(MASTERY_S));
    bodySkills.set(members[1]!, rowsOf(Math.pow(0.4, 1 / 0.4) * MASTERY_S));
    const rows: CohortRow[] = [];
    const house = demote(bodySkills, rows, HOUSE);
    const stored = rows[0]!.houses[0]!;
    expect(stored.skills).toEqual(house.skills);
    expect(stored.skillPins).toEqual(house.skillPins);
    expect(stored.skills).not.toBe(house.skills);
    expect(stored.skillPins).not.toBe(house.skillPins);
    // The cohort codec's own copy: a JSON round trip changes nothing.
    const revived = JSON.parse(JSON.stringify(stored)) as typeof stored;
    expect(revived).toEqual(stored);
  });
});
