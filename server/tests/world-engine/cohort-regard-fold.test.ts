// THE HOUSEHOLD-RUNG REGARD FOLD (politics-substrate round, F-2 + F-3) — the
// two doors `demoteHouse` / `promoteHouse` call, driven against the REAL
// cohort payload (`demoteHousehold` / `promoteHousehold`) and a stand-in for
// the one thing a pure test cannot boot: the live `"observer|subject"` map.
//
// Three laws are on trial here:
//   ① THE LEAK IS CLOSED — after a demote the live map holds no row whose
//      OBSERVER is a pooled resident, and every row whose SUBJECT is one is
//      still there (somebody else's memory is not this household's to erase).
//   ② A UNIFORM HOUSEHOLD ROUND-TRIPS through the prior; a DEVIANT member
//      comes back verbatim off a pin, and is RELEASED once the deviation has
//      faded (the next demote re-tests).
//   ③ DETERMINISM — two promotes from the same frozen prior are byte-equal.
//      The field is the memory; people do not flicker.
//
// Σpops + pinned = const: a pinned soul is still one of `house.members`, never
// a second population row — pinned here on the cohort payload itself.
//
// No DOM / GL / host.

import { describe, it, expect } from "@jest/globals";
import { makeRelation, type Relation } from "@shared/world-engine/interaction/behavior/relations.js";
import { MEAL_PERIOD_SEC, mealOffset } from "@shared/world-engine/kernel/town/activity.js";
import {
  PIN_EPS,
  foldHouseRegard,
  foldRegard,
  projectHouseRegard,
  regardDeviation,
  unfoldRegard,
} from "@shared/world-engine/kernel/town/regard-prior.js";
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

const membersOf = (houseIndex: number): string[] =>
  Array.from({ length: HOUSEHOLD }, (_, m) => `resident_${houseIndex}_${m}`);

const rel = (affinity: number, trust: number, authority: number, fear: number): Relation =>
  makeRelation({ affinity, trust, authority, fear });

/** The host's own stagger, quoted from `promoteHouse`: the SAME seeded hash the
 *  meter unfold's `SEED_SPREAD` uses, so a frozen prior re-projects identically. */
const phiOf = (_cid: string, subject: string, m: number): number =>
  Math.max(0, Math.min(1, mealOffset(SEED, HOUSE, m * 7 + subject.length) / MEAL_PERIOD_SEC));

/**
 * The two host hunks, transcribed down to their arithmetic: everything below
 * the `session.` prefix is the real pure module, and the fake is only the map.
 */
function demote(
  relations: Map<string, Relation>,
  rows: CohortRow[],
  houseIndex: number,
  spokenTo?: ReadonlySet<string>,
): CohortHouse {
  const members = membersOf(houseIndex);
  const fold = foldHouseRegard(relations, members, spokenTo);
  for (const key of fold.keys) relations.delete(key);
  const regardSubjects = Object.keys(fold.regard).length;
  const pins = Object.keys(fold.pinned).length;
  const house: CohortHouse = {
    index: houseIndex,
    members: HOUSEHOLD,
    ...(regardSubjects > 0 ? { regard: fold.regard } : {}),
    ...(pins > 0 ? { pinned: fold.pinned } : {}),
  };
  demoteHousehold(rows, -1, house, {}, 0.75, 0);
  return house;
}

function promote(relations: Map<string, Relation>, rows: CohortRow[], houseIndex: number): number {
  const promoted = promoteHousehold(rows, houseIndex);
  if (!promoted) return 0;
  const projected = projectHouseRegard(promoted.house, membersOf(houseIndex), phiOf);
  for (const row of projected) relations.set(row.key, row.rel);
  return projected.length;
}

// ---------------------------------------------------------------------------

describe("① the leak is closed — which rows a demote takes", () => {
  it("deletes every OUTGOING row of the household and keeps every incoming one", () => {
    const relations = new Map<string, Relation>();
    for (const cid of membersOf(HOUSE)) {
      relations.set(`${cid}|player`, rel(0.4, 0.6, 0.5, 0));
      relations.set(`${cid}|resident_9_0`, rel(0.1, 0.4, 0, 0));
      // …and what the rest of the town thinks of THIS member.
      relations.set(`resident_9_0|${cid}`, rel(-0.2, 0.3, 0, 0.1));
    }
    relations.set("resident_9_0|player", rel(0.2, 0.4, 0.1, 0)); // a bystander's own book
    const rows: CohortRow[] = [];

    demote(relations, rows, HOUSE);

    for (const key of relations.keys()) {
      const observer = key.slice(0, key.indexOf("|"));
      expect(observer.startsWith(`resident_${HOUSE}_`)).toBe(false);
    }
    // The subject-side rows survive: they are the observer's memory, not ours.
    for (const cid of membersOf(HOUSE)) expect(relations.has(`resident_9_0|${cid}`)).toBe(true);
    expect(relations.has("resident_9_0|player")).toBe(true);
    expect(relations.size).toBe(HOUSEHOLD + 1);
  });

  it("touches no other household's rows", () => {
    const relations = new Map<string, Relation>();
    for (const cid of [...membersOf(HOUSE), ...membersOf(4)]) {
      relations.set(`${cid}|player`, rel(0.3, 0.5, 0.4, 0));
    }
    demote(relations, [], HOUSE);
    for (const cid of membersOf(4)) expect(relations.has(`${cid}|player`)).toBe(true);
    expect(relations.size).toBe(HOUSEHOLD);
  });

  it("a household with no books folds no payload and writes no row back", () => {
    const relations = new Map<string, Relation>();
    const rows: CohortRow[] = [];
    const house = demote(relations, rows, HOUSE);
    expect(house.regard).toBeUndefined();
    expect(house.pinned).toBeUndefined();
    expect(promote(relations, rows, HOUSE)).toBe(0);
    expect(relations.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("② the round trip", () => {
  it("a UNIFORM household demotes and promotes back to its own prior", () => {
    const relations = new Map<string, Relation>();
    const book = rel(0.5, 0.8, 0.8, 0); // the FAMILY_RELATION shape
    for (const cid of membersOf(HOUSE)) relations.set(`${cid}|player`, book);
    const rows: CohortRow[] = [];

    const house = demote(relations, rows, HOUSE);
    expect(house.pinned).toBeUndefined(); // nobody deviates from what everyone feels
    expect(house.regard!.player.n).toBe(HOUSEHOLD);
    expect(relations.size).toBe(0);

    const written = promote(relations, rows, HOUSE);
    expect(written).toBe(HOUSEHOLD);
    const prior = house.regard!.player;
    for (const cid of membersOf(HOUSE)) {
      const back = relations.get(`${cid}|player`)!;
      expect(regardDeviation(back, prior)).toBeLessThanOrEqual(0.1 + 1e-12); // the phi spread
      for (const v of Object.values(back)) expect(Number.isFinite(v)).toBe(true);
    }
    // …and re-folding the promoted household gives the prior back.
    const again = foldRegard(membersOf(HOUSE).map((cid) => relations.get(`${cid}|player`)!))!;
    expect(again.regard).toBeCloseTo(prior.regard, 2);
    expect(again.route).toBe(prior.route);
  });

  it("a DEVIANT member is pinned and comes back VERBATIM", () => {
    const relations = new Map<string, Relation>();
    const members = membersOf(HOUSE);
    for (const cid of members) relations.set(`${cid}|player`, rel(0.5, 0.8, 0.8, 0));
    // One member the spirit terrified: nothing the prior can rebuild.
    const odd = members[2]!;
    const oddBook = rel(-0.9, 0.05, 0, 0.85);
    relations.set(`${odd}|player`, oddBook);
    const rows: CohortRow[] = [];

    const house = demote(relations, rows, HOUSE);
    expect(Object.keys(house.pinned ?? {})).toEqual([odd]);
    expect(regardDeviation(oddBook, house.regard!.player)).toBeGreaterThan(PIN_EPS);

    promote(relations, rows, HOUSE);
    expect(relations.get(`${odd}|player`)).toEqual(oddBook);
    // …while everybody else came off the statistic.
    for (const cid of members) {
      if (cid === odd) continue;
      expect(relations.get(`${cid}|player`)).not.toEqual(oddBook);
    }
  });

  it("🚨 A PIN IS NOT CONTAGIOUS — one outlier does not pin the family", () => {
    const relations = new Map<string, Relation>();
    const members = membersOf(HOUSE);
    for (const cid of members) relations.set(`${cid}|player`, rel(0.5, 0.8, 0.8, 0));
    relations.set(`${members[2]!}|player`, rel(-0.9, 0.05, 0, 0.85));
    const rows: CohortRow[] = [];

    const house = demote(relations, rows, HOUSE);
    // Tested once against the WHOLE household's mean the outlier drags the
    // centre to ~0.31 and all five fail; the trim re-folds without it.
    expect(Object.keys(house.pinned ?? {}).length).toBe(1);
    expect(house.regard!.player.n).toBe(HOUSEHOLD - 1);
    expect(house.regard!.player.regard).toBeCloseTo(foldRegard([rel(0.5, 0.8, 0.8, 0)])!.regard, 12);
  });

  it("a member the player SPOKE TO is pinned whatever its deviation", () => {
    const relations = new Map<string, Relation>();
    const members = membersOf(HOUSE);
    const book = rel(0.5, 0.8, 0.8, 0);
    for (const cid of members) relations.set(`${cid}|player`, book);
    const met = members[1]!;
    const rows: CohortRow[] = [];

    const house = demote(relations, rows, HOUSE, new Set([met]));
    expect(Object.keys(house.pinned ?? {})).toEqual([met]);
    promote(relations, rows, HOUSE);
    expect(relations.get(`${met}|player`)).toEqual(book);
  });

  it("a pin is RELEASED once the deviation has faded (the next demote re-tests)", () => {
    const relations = new Map<string, Relation>();
    const members = membersOf(HOUSE);
    const typical = rel(0.5, 0.8, 0.8, 0);
    for (const cid of members) relations.set(`${cid}|player`, typical);
    const odd = members[4]!;
    relations.set(`${odd}|player`, rel(-0.9, 0.05, 0, 0.85));
    const rows: CohortRow[] = [];

    expect(Object.keys(demote(relations, rows, HOUSE).pinned ?? {})).toEqual([odd]);
    promote(relations, rows, HOUSE);

    // Play moves it back toward the household — the fear passed.
    relations.set(`${odd}|player`, typical);
    const second = demote(relations, rows, HOUSE);
    expect(second.pinned).toBeUndefined();
    expect(relations.size).toBe(0);
  });

  it("a pinned soul is still a MEMBER, never a second population row", () => {
    const relations = new Map<string, Relation>();
    const members = membersOf(HOUSE);
    for (const cid of members) relations.set(`${cid}|player`, rel(0.5, 0.8, 0.8, 0));
    relations.set(`${members[0]!}|player`, rel(-1, 0, 0, 1));
    const rows: CohortRow[] = [];

    const house = demote(relations, rows, HOUSE);
    expect(Object.keys(house.pinned ?? {}).length).toBe(1);
    expect(cohortPopulation(rows)).toBe(HOUSEHOLD);
    expect(rows[0]!.houses[0]!.members).toBe(HOUSEHOLD);
    promote(relations, rows, HOUSE);
    expect(cohortPopulation(rows)).toBe(0);
  });

  it("many subjects fold independently, in sorted order", () => {
    const relations = new Map<string, Relation>();
    for (const cid of membersOf(HOUSE)) {
      relations.set(`${cid}|player`, rel(0.5, 0.8, 0.8, 0));
      relations.set(`${cid}|resident_9_0`, rel(-0.4, 0.2, 0, 0.5));
      relations.set(`${cid}|resident_9_1`, rel(0.1, 0.35, 0, 0));
    }
    const rows: CohortRow[] = [];
    const house = demote(relations, rows, HOUSE);
    expect(Object.keys(house.regard!)).toEqual(["player", "resident_9_0", "resident_9_1"]);
    expect(house.regard!.player!.route).toBe("prestige");
    expect(house.regard!.resident_9_0!.route).toBe("dominance");
    expect(house.regard!.resident_9_0!.regard).toBeLessThan(0);
    expect(promote(relations, rows, HOUSE)).toBe(HOUSEHOLD * 3);
  });
});

// ---------------------------------------------------------------------------

describe("③ determinism", () => {
  it("two promotes from the same frozen prior are byte-equal", () => {
    const build = (): Map<string, Relation> => {
      const m = new Map<string, Relation>();
      for (const cid of membersOf(HOUSE)) {
        m.set(`${cid}|player`, rel(0.5, 0.8, 0.8, 0));
        m.set(`${cid}|resident_9_0`, rel(-0.4, 0.2, 0, 0.5));
      }
      return m;
    };
    const runA = build();
    const rowsA: CohortRow[] = [];
    demote(runA, rowsA, HOUSE);
    promote(runA, rowsA, HOUSE);

    const runB = build();
    const rowsB: CohortRow[] = [];
    demote(runB, rowsB, HOUSE);
    promote(runB, rowsB, HOUSE);

    const dump = (m: Map<string, Relation>): string =>
      JSON.stringify([...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(dump(runA)).toBe(dump(runB));
  });

  it("the projection does not depend on the live map's insertion order", () => {
    const forward = new Map<string, Relation>();
    const backward = new Map<string, Relation>();
    const members = membersOf(HOUSE);
    for (const cid of members) forward.set(`${cid}|player`, rel(0.3 + members.indexOf(cid) * 0.05, 0.6, 0.4, 0));
    for (const cid of [...members].reverse()) {
      backward.set(`${cid}|player`, rel(0.3 + members.indexOf(cid) * 0.05, 0.6, 0.4, 0));
    }
    const a = demote(forward, [], HOUSE);
    const b = demote(backward, [], HOUSE);
    expect(JSON.stringify(a.regard)).toBe(JSON.stringify(b.regard));
    expect(JSON.stringify(a.pinned ?? {})).toBe(JSON.stringify(b.pinned ?? {}));
  });

  it("the payload survives the cohort row's own copy (nothing is aliased)", () => {
    const relations = new Map<string, Relation>();
    for (const cid of membersOf(HOUSE)) relations.set(`${cid}|player`, rel(0.5, 0.8, 0.8, 0));
    relations.set(`${membersOf(HOUSE)[0]!}|player`, rel(-1, 0, 0, 1));
    const rows: CohortRow[] = [];
    const house = demote(relations, rows, HOUSE);
    const stored = rows[0]!.houses[0]!;
    expect(stored.regard).toEqual(house.regard);
    expect(stored.pinned).toEqual(house.pinned);
    expect(stored.regard).not.toBe(house.regard);
    expect(stored.pinned).not.toBe(house.pinned);
  });

  it("a prior re-projects the SAME row for the same member and subject", () => {
    const p = foldRegard([rel(0.5, 0.8, 0.8, 0)])!;
    const cid = `resident_${HOUSE}_2`;
    expect(unfoldRegard(p, phiOf(cid, "player", 2))).toEqual(
      unfoldRegard(p, phiOf(cid, "player", 2)),
    );
    // …and a DIFFERENT member gets a different one (the stagger is real).
    const spread = new Set(
      membersOf(HOUSE).map((c, m) => unfoldRegard(p, phiOf(c, "player", m)).affinity),
    );
    expect(spread.size).toBeGreaterThan(1);
  });
});
