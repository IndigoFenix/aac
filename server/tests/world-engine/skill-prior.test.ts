/**
 * ⚖️ SKILL-PRIOR — the REGIONAL slice's fold/unfold/regional-average module
 * (skill-learning-round.md §REGIONAL; skill-prior.ts's own header is the
 * design). PURE: no host, no clock, no RNG, no world.
 *
 * `npm run test:engine -- skill-prior`.
 */
import { describe, it, expect } from "@jest/globals";
import {
  foldSkillPriors,
  skillDeviation,
  foldHouseSkills,
  projectHouseSkills,
  regionalSkills,
  regionalSkillMultiplier,
  geographySkillMultipliers,
  SKILL_PIN_EPS,
  SKILL_UNFOLD_SPREAD,
  type SkillCurve,
} from "@shared/world-engine/kernel/town/skill-prior.js";
import {
  DEFAULT_SKILL_CATALOGUE,
  masteryS,
  skillLevel,
  skillOfGood,
  withSkills,
  type BodySkillRow,
} from "@shared/world-engine/kernel/town/skills.js";
import { DOLLHOUSE_SCALE } from "@shared/world-engine/scale.js";

const CURVE: SkillCurve = { skills: DEFAULT_SKILL_CATALOGUE, scale: DOLLHOUSE_SCALE };
const FELLING = DEFAULT_SKILL_CATALOGUE.get("felling")!;
const MASTERY_S = masteryS(FELLING, DOLLHOUSE_SCALE); // 6 000 s at learning:180
const rowsOf = (practiceS: number): Map<string, BodySkillRow> => new Map([["felling", { practiceS }]]);

// ═══ ① foldSkillPriors ═════════════════════════════════════════════════════

describe("① foldSkillPriors — N members' rows → one prior per key", () => {
  it("5 members, 2 with felling practice: share 0.4, meanS the pair's mean, n 5", () => {
    const a = rowsOf(1000);
    const b = rowsOf(3000);
    const prior = foldSkillPriors([a, b, undefined, undefined, undefined]);
    expect(prior.felling).toEqual({ share: 2 / 5, meanS: (1000 + 3000) / 2, n: 5 });
  });

  it("an absent map counts in the denominator (a novice), holds no key", () => {
    const prior = foldSkillPriors([rowsOf(500), undefined, undefined]);
    expect(prior.felling!.share).toBeCloseTo(1 / 3, 12);
    expect(prior.felling!.n).toBe(3);
  });

  it("a non-finite reading is dropped, never propagated", () => {
    const bad = new Map<string, BodySkillRow>([["felling", { practiceS: NaN }]]);
    const good = rowsOf(1000);
    const prior = foldSkillPriors([bad, good]);
    expect(prior.felling).toEqual({ share: 0.5, meanS: 1000, n: 2 });
    const allBad = foldSkillPriors([bad, new Map([["felling", { practiceS: -5 }]])]);
    expect(allBad).toEqual({});
  });

  it("keys come back sorted", () => {
    const rows = new Map<string, BodySkillRow>([
      ["refining", { practiceS: 100 }],
      ["carpentry", { practiceS: 100 }],
      ["felling", { practiceS: 100 }],
    ]);
    expect(Object.keys(foldSkillPriors([rows]))).toEqual(["carpentry", "felling", "refining"]);
  });

  it("[] ⇒ {}", () => {
    expect(foldSkillPriors([])).toEqual({});
  });
});

// ═══ ② skillDeviation ═══════════════════════════════════════════════════════

describe("② skillDeviation — the LEVEL scale, capped at mastery", () => {
  it("two masters (2× and 5× masteryS) deviate 0 from each other's mean — both cap at level 1", () => {
    const rowsA = rowsOf(MASTERY_S * 2);
    const rowsB = rowsOf(MASTERY_S * 5);
    const prior = foldSkillPriors([rowsA, rowsB]);
    expect(skillDeviation(rowsA, prior, CURVE)).toBeCloseTo(0, 12);
    expect(skillDeviation(rowsB, prior, CURVE)).toBeCloseTo(0, 12);
  });

  it("a member holding a key the prior lacks ⇒ Infinity", () => {
    const rows = rowsOf(1000);
    expect(skillDeviation(rows, {}, CURVE)).toBe(Infinity);
  });

  it("no rows ⇒ 0", () => {
    expect(skillDeviation(undefined, {}, CURVE)).toBe(0);
  });
});

// ═══ ③ foldHouseSkills — THE PIN ════════════════════════════════════════════

describe("③ foldHouseSkills — pin the single worst deviant, never contagious", () => {
  const cids = ["c0", "c1", "c2", "c3", "c4"];
  const MASTER = "c0";

  it("one master among four novices ⇒ NO pin — the prior rebuilds it exactly", () => {
    const rows = new Map<string, ReadonlyMap<string, BodySkillRow>>([[MASTER, rowsOf(MASTER_S())]]);
    const fold = foldHouseSkills((cid) => rows.get(cid), cids, CURVE);
    expect(fold.pinned).toEqual({});
    expect(fold.skills.felling).toEqual({ share: 0.2, meanS: MASTER_S(), n: 5 });
  });

  it("master + apprentice (level ≈0.4) + 3 novices ⇒ exactly ONE pin, the apprentice — not the master", () => {
    const appS = APPRENTICE_S();
    expect(skillLevel(appS, MASTERY_S)).toBeCloseTo(0.4, 6);
    const rows = new Map<string, ReadonlyMap<string, BodySkillRow>>([
      [MASTER, rowsOf(MASTER_S())],
      ["c1", rowsOf(appS)],
    ]);
    const fold = foldHouseSkills((cid) => rows.get(cid), cids, CURVE);
    expect(Object.keys(fold.pinned)).toEqual(["c1"]);
    expect(fold.pinned.c1!.felling.practiceS).toBeCloseTo(appS, 9);
    // Re-fold puts the master alone in the prior: share 0.25 over 4, meanS = the master's.
    expect(fold.skills.felling).toEqual({ share: 0.25, meanS: MASTER_S(), n: 4 });

    // Order-free: reversed members give the same result.
    const rev = foldHouseSkills((cid) => rows.get(cid), [...cids].reverse(), CURVE);
    expect(rev.skills).toEqual(fold.skills);
    expect(rev.pinned).toEqual(fold.pinned);
  });

  function MASTER_S(): number {
    return MASTERY_S;
  }
  function APPRENTICE_S(): number {
    const frac = Math.pow(0.4, 1 / 0.4); // level = frac^0.4 = 0.4 ⇒ frac = 0.4^(1/0.4)
    return frac * MASTERY_S;
  }
});

// ═══ ④ projectHouseSkills — CONSERVATION ═══════════════════════════════════

describe("④ projectHouseSkills — Σ seconds conserved exactly", () => {
  const cids = ["c0", "c1", "c2", "c3", "c4"];
  const masterS = MASTERY_S;
  const appS = Math.pow(0.4, 1 / 0.4) * MASTERY_S;

  it("fold ③'s house, project onto the same 5 cids: pinned apprentice byte-equal; one receiver at meanS", () => {
    const rows = new Map<string, ReadonlyMap<string, BodySkillRow>>([
      ["c0", rowsOf(masterS)],
      ["c1", rowsOf(appS)],
    ]);
    const fold = foldHouseSkills((cid) => rows.get(cid), cids, CURVE);
    const phi = (_cid: string, _key: string, index: number) => index; // deterministic, monotone
    // `foldHouseSkills` answers `{skills, pinned}`; `projectHouseSkills` reads
    // `{skills, skillPins}` (the `CohortHouse` field names) — the host's own
    // translation at the demote/promote seam (quest-host.ts `[skills] fold`).
    const houseForProject = { skills: fold.skills, skillPins: fold.pinned };
    const projected = projectHouseSkills(houseForProject, cids, phi);
    const byCid = new Map(projected.map((p) => [p.cid, p]));

    // The pinned apprentice comes back byte-equal.
    expect(byCid.get("c1")!.pinned).toBe(true);
    expect(byCid.get("c1")!.rows.get("felling")).toEqual({ practiceS: appS });

    // k = round(share × unpinned) = round(0.25 × 4) = 1 receiver, at exactly meanS
    // (k=1 ⇒ u=½ ⇒ no stagger).
    const receivers = [...byCid.entries()].filter(([cid, p]) => cid !== "c1" && p.rows.has("felling"));
    expect(receivers.length).toBe(1);
    expect(receivers[0]![1].rows.get("felling")!.practiceS).toBeCloseTo(fold.skills.felling!.meanS, 9);
    expect(receivers[0]![1].pinned).toBe(false);

    // Members that received nothing are omitted.
    expect(projected.length).toBe(2); // the apprentice + the one receiver

    // Determinism: two projections byte-equal.
    const again = projectHouseSkills(houseForProject, cids, phi);
    expect(JSON.stringify([...again].map((p) => [p.cid, [...p.rows], p.pinned])))
      .toBe(JSON.stringify([...projected].map((p) => [p.cid, [...p.rows], p.pinned])));
  });

  it("k=2 (two equal practitioners): receivers straddle meanS symmetrically and SUM to 2×meanS", () => {
    const meanS = 1000;
    const house = { skills: { felling: { share: 0.5, meanS, n: 4 } } };
    const unpinned = ["u0", "u1", "u2", "u3"];
    const phi = (_cid: string, _key: string, index: number) => index; // u0,u1 rank lowest ⇒ receive
    const projected = projectHouseSkills(house, unpinned, phi);
    const receivers = projected.filter((p) => p.rows.has("felling"));
    expect(receivers.length).toBe(2);
    const [lo, hi] = receivers.map((p) => p.rows.get("felling")!.practiceS).sort((a, b) => a - b);
    expect(lo).toBeCloseTo(meanS * (1 + SKILL_UNFOLD_SPREAD * (0.25 - 0.5)), 9);
    expect(hi).toBeCloseTo(meanS * (1 + SKILL_UNFOLD_SPREAD * (0.75 - 0.5)), 9);
    expect(lo + hi).toBeCloseTo(2 * meanS, 9);
  });
});

// ═══ ⑤ ROUND TRIP ═══════════════════════════════════════════════════════════

describe("⑤ fold → project → fold — the prior round-trips, no new pins", () => {
  it("re-folding the projected house gives the same {share, meanS} and no NEW pin", () => {
    const cids = ["c0", "c1", "c2", "c3", "c4"];
    const masterS = MASTERY_S;
    const appS = Math.pow(0.4, 1 / 0.4) * MASTERY_S;
    const rows = new Map<string, ReadonlyMap<string, BodySkillRow>>([
      ["c0", rowsOf(masterS)],
      ["c1", rowsOf(appS)],
    ]);
    const fold1 = foldHouseSkills((cid) => rows.get(cid), cids, CURVE);
    const phi = (_cid: string, _key: string, index: number) => index;
    const houseForProject = { skills: fold1.skills, skillPins: fold1.pinned };
    const projected = projectHouseSkills(houseForProject, cids, phi);
    const projectedRows = new Map<string, ReadonlyMap<string, BodySkillRow>>(
      projected.map((p) => [p.cid, p.rows]),
    );
    const fold2 = foldHouseSkills((cid) => projectedRows.get(cid), cids, CURVE);
    expect(fold2.skills.felling!.share).toBeCloseTo(fold1.skills.felling!.share, 9);
    expect(fold2.skills.felling!.meanS).toBeCloseTo(fold1.skills.felling!.meanS, 6);
    // No NEW pins: still exactly the apprentice (the spread is under SKILL_PIN_EPS
    // on the level scale for whoever received the projected practice).
    expect(Object.keys(fold2.pinned)).toEqual(["c1"]);
  });
});

// ═══ ⑥ regionalSkills ═══════════════════════════════════════════════════════

describe("⑥ regionalSkills — the population mean, read through skillMultiplier", () => {
  it("novices only ⇒ {}", () => {
    expect(regionalSkills({ live: [], liveHeads: 5, pooled: [], curve: CURVE })).toEqual({});
  });

  it("4 live heads, one master feller ⇒ felling.multiplier = (2+3)/4 = 1.25, share 0.25", () => {
    const live: Array<readonly [string, ReadonlyMap<string, BodySkillRow>]> = [["c0", rowsOf(MASTERY_S)]];
    const out = regionalSkills({ live, liveHeads: 4, pooled: [], curve: CURVE });
    expect(out.felling!.multiplier).toBeCloseTo(1.25, 9);
    expect(out.felling!.share).toBeCloseTo(0.25, 9);
  });

  it("liveHeads below the ledger size is raised to it", () => {
    const live: Array<readonly [string, ReadonlyMap<string, BodySkillRow>]> = [
      ["c0", rowsOf(MASTERY_S)],
      ["c1", rowsOf(MASTERY_S)],
    ];
    const out = regionalSkills({ live, liveHeads: 0, pooled: [], curve: CURVE });
    // Raised to at least the 2 live rows: both masters ⇒ multiplier 2.
    expect(out.felling!.multiplier).toBeCloseTo(2, 9);
  });

  it("a pooled house of 5 with one projected master beside 5 live novices ⇒ 10 heads, multiplier 1.1", () => {
    const pooled = [{ members: 5, skills: { felling: { share: 0.2, meanS: MASTERY_S, n: 5 } } }];
    const out = regionalSkills({ live: [], liveHeads: 5, pooled, curve: CURVE });
    expect(out.felling!.multiplier).toBeCloseTo(1.1, 9);
  });

  it("regionalSkillMultiplier on an unlisted key ⇒ 1", () => {
    const regional = regionalSkills({
      live: [["c0", rowsOf(MASTERY_S)]],
      liveHeads: 4,
      pooled: [],
      curve: CURVE,
    });
    expect(regionalSkillMultiplier(regional, "carpentry")).toBe(1);
    expect(regionalSkillMultiplier(null, "felling")).toBe(1);
    expect(regionalSkillMultiplier(regional, null)).toBe(1);
  });

  // 🚨 ENGINE DEFECT (found by this test, reported not patched — the LAWS):
  // `regionalSkills` enumerates `keys` only from bodies' OWN practiced rows
  // (`for (const rows of virt.values()) for (const key of rows.keys()) …`),
  // never from a catalogue key an effective-level reader could answer for a
  // body through inheritance alone. A live master refiner therefore never
  // surfaces a `carpentry` entry in the regional table at all — the "region's
  // average" the brief describes for an inherited-only skill is invisible to
  // this reader, though `skillMultiplier(state, cid, "carpentry")` itself
  // would answer >1 for that same body if asked directly.
  it("the INHERITED share appears: a live master refiner gives carpentry.multiplier > 1 with carpentry.share 0", () => {
    const live: Array<readonly [string, ReadonlyMap<string, BodySkillRow>]> = [
      ["c0", new Map([["refining", { practiceS: masteryS(DEFAULT_SKILL_CATALOGUE.get("refining")!, DOLLHOUSE_SCALE) }]])],
    ];
    const out = regionalSkills({ live, liveHeads: 4, pooled: [], curve: CURVE });
    expect(out.carpentry).toBeDefined();
    expect(out.carpentry!.multiplier).toBeGreaterThan(1);
    expect(out.carpentry!.share).toBe(0); // nobody has OWN carpentry practice
  });
});

// ═══ ⑦ geographySkillMultipliers ════════════════════════════════════════════
// — user law 2026-09-11: goods individually; the taxonomy is naming. The
// closed form now reads `PartnerGeography.yields` (good → presence), never a
// farmland/ore/timber charter sum.

describe("⑦ geographySkillMultipliers — the closed form off the land's yields", () => {
  it("the frontier partner city:12804's own yield vector (scripts/worlds/frontier-cell.spec.json) — every expected number derived from the vector + skillOfGood + the catalogue's own gains", () => {
    // Read straight off the regenerated document, not retyped.
    const yields: Record<string, number> = {
      apple: 0,
      banana: 0.10749127298928933,
      berry: 0,
      block: 0.20630729129679737,
      carrot: 0.004286014831669935,
      cheese: 0.008963907879288599,
      cloth: 0.009817913525971873,
      grape: 0.0037459490620130437,
      meat: 0.06445536644838674,
      milk: 0.044819539396442995,
      nut: 0,
      onion: 0.005078935489586279,
      stone: 0,
      wood: 0.41261458259359474,
      wool: 0.019635827051943746,
    };
    const total = Object.values(yields).reduce((a, b) => a + b, 0);
    const bySkill = new Map<string, number>();
    for (const [good, v] of Object.entries(yields)) {
      if (!(v > 0)) continue;
      const key = skillOfGood(good, DEFAULT_SKILL_CATALOGUE);
      if (!key) continue;
      bySkill.set(key, (bySkill.get(key) ?? 0) + v);
    }
    const out = geographySkillMultipliers({ yields });
    for (const [key, sum] of bySkill) {
      const def = DEFAULT_SKILL_CATALOGUE.get(key)!;
      const share = sum / total;
      expect(out[key]).toBeCloseTo(1 + (def.gain - 1) * share, 9);
    }
    expect(Object.keys(out)).toEqual([...bySkill.keys()].sort());
  });

  it("{}/null/all-zero yields ⇒ {}", () => {
    expect(geographySkillMultipliers(null)).toEqual({});
    expect(geographySkillMultipliers({})).toEqual({});
    expect(geographySkillMultipliers({ yields: {} })).toEqual({});
    expect(geographySkillMultipliers({ yields: { wood: 0, block: 0 } })).toEqual({});
  });

  it("a catalogue that declares mining, over a vector {stone: 0.5, wood: 0.5} ⇒ mining 1.5 and felling 1.5", () => {
    const cat = withSkills({ key: "mining", parent: "labour", masteryHours: 400, gain: 2 });
    const out = geographySkillMultipliers({ yields: { stone: 0.5, wood: 0.5 } }, cat);
    const mining = cat.get("mining")!;
    expect(out.mining).toBeCloseTo(1 + (mining.gain - 1) * 0.5, 9);
    expect(out.felling).toBeCloseTo(1 + (FELLING.gain - 1) * 0.5, 9);
  });

  it("a refined good's presence goes to refining/carpentry by skillOfGood (block → carpentry, cloth → refining)", () => {
    expect(skillOfGood("block", DEFAULT_SKILL_CATALOGUE)).toBe("carpentry");
    expect(skillOfGood("cloth", DEFAULT_SKILL_CATALOGUE)).toBe("refining");
    const out = geographySkillMultipliers({ yields: { block: 0.3, cloth: 0.3 } });
    const carpentry = DEFAULT_SKILL_CATALOGUE.get("carpentry")!;
    const refining = DEFAULT_SKILL_CATALOGUE.get("refining")!;
    expect(out.carpentry).toBeCloseTo(1 + (carpentry.gain - 1) * 0.5, 9);
    expect(out.refining).toBeCloseTo(1 + (refining.gain - 1) * 0.5, 9);
  });
});
