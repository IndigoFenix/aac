/**
 * ⚖️ SKILLS — THE BODY SLICE, the PURE half (skill-learning-round.md §3.1).
 *
 * The owner's spec (`skill-learning-quality.md`) in one sentence: *"the more an
 * individual performs a task, the better they get at that task, and the lower
 * that task costs for them. This would cause roles to emerge naturally."*
 *
 * What this file pins, none of it needing a host, a boot, a DB or GL:
 *
 *  ① THE CATALOGUE — the seven shipped rows, include-then-extend (`withSkills`,
 *    later key WINS), a cycle refused at build, an unknown parent refused.
 *  ② THE CURVE — novice = 1×, mastery = `gain`×, capped past mastery, monotone,
 *    and the exponent is the 0.4 power law rather than a straight line.
 *  ③ THE FOLD — practice credits every ancestor at `INHERIT_SHARE`, and
 *    competence flows back DOWN at the same share (a refiner is half as good at
 *    carpentry as at refining; an untouched carpentry row reads exactly that).
 *  ④ THE ONE DIAL — `learning`: declared wins, undeclared follows the RESOLVED
 *    `construction`, REAL is 1, and the round-trip through `scaleSpecOf` holds.
 *  ⑤ THE SPEC SIDE — a `skills` block in the manifest, path-exact refusals,
 *    merged field-by-field over the shipped row of the same key.
 *  ⑥ THE ACTION MAP — `skillFor`, including the ONE material sub-skill, read off
 *    the products catalogue rather than a second hand-written wood list.
 *  ⑦ 🚨 DAY ONE IS BYTE-IDENTICAL — an unpractised body reads exactly 1×, so
 *    every baseline dwell and rate in the engine is what it always was.
 *
 * `npm run test:engine -- skills`.
 */
import { describe, it, expect } from "@jest/globals";
import {
  DEFAULT_SKILLS,
  DEFAULT_SKILL_CATALOGUE,
  INHERIT_SHARE,
  LEARNING_CURVE_EXPONENT,
  masteryS,
  multiplierOf,
  parseSkillsSpec,
  practiceSkill,
  resolveSkillCatalogue,
  skillEffectiveLevel,
  skillFor,
  skillLevel,
  skillMultiplier,
  skillOfGood,
  withSkills,
  woodHeads,
  type BodySkillRow,
  type SkillState,
} from "@shared/world-engine/kernel/town/skills.js";
import {
  DOLLHOUSE_SCALE,
  REAL_SCALE,
  parseWorldScaleSpec,
  resolveWorldScale,
  scaleSpecOf,
} from "@shared/world-engine/scale.js";
import { parseGameSettings } from "@shared/world-engine/kernel/manifest.js";

/** A minimal skill-bearing session: the three fields the kernel reads. */
const state = (scale = DOLLHOUSE_SCALE): SkillState => ({
  bodySkills: new Map<string, Map<string, BodySkillRow>>(),
  skills: DEFAULT_SKILL_CATALOGUE,
  scale,
});

const practiceOf = (s: SkillState, cid: string, key: string): number =>
  s.bodySkills?.get(cid)?.get(key)?.practiceS ?? 0;

// ═══ ① THE CATALOGUE ══════════════════════════════════════════════════════

describe("① the catalogue is spec-defined and include-then-extend", () => {
  it("ships exactly the seven rows the body slice needs, rooted at `labour`", () => {
    expect(DEFAULT_SKILLS.map((r) => r.key)).toEqual([
      "labour",
      "felling",
      "hauling",
      "building",
      "refining",
      "carpentry",
      "foraging",
    ]);
    // The REAL anchors — hours of practice to mastery, "roughly normal".
    const hours = Object.fromEntries(DEFAULT_SKILLS.map((r) => [r.key, r.masteryHours]));
    expect(hours).toMatchObject({
      felling: 300,
      hauling: 100,
      building: 600,
      refining: 600,
      carpentry: 800,
      foraging: 200,
    });
    // Every row doubles at mastery — one number, moved together or not at all.
    expect(new Set(DEFAULT_SKILLS.map((r) => r.gain))).toEqual(new Set([2]));
    // …and the tree: four trades under `labour`, carpentry under refining.
    const parent = Object.fromEntries(DEFAULT_SKILLS.map((r) => [r.key, r.parent ?? null]));
    expect(parent).toEqual({
      labour: null,
      felling: "labour",
      hauling: "labour",
      building: "labour",
      refining: "labour",
      carpentry: "refining",
      foraging: "labour",
    });
  });

  it("a LATER KEY WINS — extending is one row, never a restatement of seven", () => {
    const cat = withSkills(
      { key: "felling", parent: "labour", masteryHours: 50, gain: 3 },
      { key: "masonry", parent: "labour", masteryHours: 700, gain: 2 },
    );
    expect(cat.get("felling")!.masteryHours).toBe(50);
    expect(cat.get("felling")!.gain).toBe(3);
    expect(cat.get("masonry")!.masteryHours).toBe(700);
    // …and the six it did not name are untouched, in their shipped order.
    expect(cat.rows.map((r) => r.key)).toEqual([
      "labour", "felling", "hauling", "building", "refining", "carpentry", "foraging", "masonry",
    ]);
    expect(DEFAULT_SKILL_CATALOGUE.get("felling")!.masteryHours).toBe(300); // the shipped tree is not mutated
  });

  it("refuses a CYCLE and an unknown parent — at build, once, not at every walk", () => {
    expect(() => withSkills(
      { key: "labour", parent: "carpentry", masteryHours: 1, gain: 2 },
    )).toThrow(/cycle/);
    expect(() => withSkills(
      { key: "thatching", parent: "roofing", masteryHours: 100, gain: 2 },
    )).toThrow(/unknown parent/);
  });
});

// ═══ ② THE CURVE ══════════════════════════════════════════════════════════

describe("② the curve is the power law of practice, capped at mastery", () => {
  const def = DEFAULT_SKILL_CATALOGUE.get("felling")!;

  it("mastery is the REAL anchor over the dial — never a day length", () => {
    // 300 h × 3600 ÷ 180 = 6 000 s: the frontier's own number.
    expect(masteryS(def, { learning: 180 })).toBeCloseTo(6000, 9);
    // …and at REAL_SCALE it is the real apprenticeship, in seconds.
    expect(masteryS(def, REAL_SCALE)).toBeCloseTo(300 * 3600, 9);
    // 🚨 THE TWO CLOCKS: nothing here scales with the day. A 240 s street day
    // and a real 86 400 s day at the SAME `learning` agree to the second.
    const street = resolveWorldScale({ rotation: 360, construction: 180 });
    const slow = resolveWorldScale({ rotation: 1, construction: 180 });
    expect(street.dayLengthS).not.toBe(slow.dayLengthS);
    expect(masteryS(def, street)).toBe(masteryS(def, slow));
  });

  it("novice = 1×, mastery = gain×, and past mastery buys nothing", () => {
    const m = masteryS(def, { learning: 180 });
    expect(multiplierOf(skillLevel(0, m), def.gain)).toBe(1);
    expect(multiplierOf(skillLevel(m, m), def.gain)).toBeCloseTo(def.gain, 9);
    expect(multiplierOf(skillLevel(m * 100, m), def.gain)).toBeCloseTo(def.gain, 9);
    expect(multiplierOf(skillLevel(-5, m), def.gain)).toBe(1); // nonsense floors, never throws
  });

  it("is MONOTONE, and it is the 0.4 power law rather than a line", () => {
    const m = masteryS(def, { learning: 180 });
    let prev = -1;
    for (const frac of [0, 0.05, 0.1, 0.25, 0.5, 0.75, 1]) {
      const lvl = skillLevel(frac * m, m);
      expect(lvl).toBeGreaterThanOrEqual(prev);
      expect(lvl).toBeCloseTo(Math.pow(frac, LEARNING_CURVE_EXPONENT), 9);
      prev = lvl;
    }
    // FAST EARLY GAINS: a tenth of the way to mastery is already ~40 % of it
    // (0.1^0.4 = 0.3981), which is what makes a role emerge inside a ten-day
    // arc — and it is FOUR TIMES the straight line's 0.1.
    expect(skillLevel(0.1 * m, m)).toBeCloseTo(0.3981, 4);
    expect(skillLevel(0.1 * m, m)).toBeGreaterThan(3.9 * 0.1);
  });

  it("📏 THE WORKED FRONTIER NUMBER: 30 fells ⇒ 1.47× (the brief's own arithmetic)", () => {
    const m = masteryS(def, { learning: 180 }); // 6 000 s
    const practised = 30 * 30; // thirty chops at CHOP_DWELL_S
    expect(practised / m).toBeCloseTo(0.15, 9);
    expect(skillLevel(practised, m)).toBeCloseTo(Math.pow(0.15, 0.4), 9);
    // 0.15^0.4 = 0.468205… ⇒ 1 + (2 − 1) × 0.4682 = 1.4682. (The brief quotes
    // 1.47 from a rounded 0.47; this is the number to the digit.)
    expect(multiplierOf(skillLevel(practised, m), def.gain)).toBeCloseTo(1.46821, 5);
  });
});

// ═══ ③ THE FOLD ═══════════════════════════════════════════════════════════

describe("③ a sub-skill inherits — both ways, at INHERIT_SHARE per rung", () => {
  it("practising carpentry credits refining at ½ and labour at ¼", () => {
    const s = state();
    practiceSkill(s, "a", "carpentry", 1000);
    expect(practiceOf(s, "a", "carpentry")).toBeCloseTo(1000, 9);
    expect(practiceOf(s, "a", "refining")).toBeCloseTo(1000 * INHERIT_SHARE, 9);
    expect(practiceOf(s, "a", "labour")).toBeCloseTo(1000 * INHERIT_SHARE * INHERIT_SHARE, 9);
    // …and it ACCUMULATES rather than overwriting.
    practiceSkill(s, "a", "carpentry", 500);
    expect(practiceOf(s, "a", "carpentry")).toBeCloseTo(1500, 9);
  });

  it("a body with ONLY refining practice is HALF as good at carpentry as at refining", () => {
    const s = state();
    practiceSkill(s, "a", "refining", 4000);
    expect(practiceOf(s, "a", "carpentry")).toBe(0); // nothing was written down there
    const refining = skillEffectiveLevel(s, "a", "refining");
    const carpentry = skillEffectiveLevel(s, "a", "carpentry");
    expect(refining).toBeGreaterThan(0);
    expect(carpentry).toBeCloseTo(INHERIT_SHARE * refining, 9);
  });

  it("the OWN row wins the moment it beats the inherited share", () => {
    const s = state();
    practiceSkill(s, "a", "refining", 4000);
    const inherited = skillEffectiveLevel(s, "a", "carpentry");
    practiceSkill(s, "a", "carpentry", 4000);
    expect(skillEffectiveLevel(s, "a", "carpentry")).toBeGreaterThan(inherited);
  });

  it("a lifetime of BUILDING makes a slightly better feller — through `labour`, faintly", () => {
    const s = state();
    practiceSkill(s, "b", "building", 20_000);
    const bleed = skillMultiplier(s, "b", "felling");
    expect(bleed).toBeGreaterThan(1);
    // …and it never rivals real practice: a dedicated feller of far fewer
    // seconds is comfortably ahead. This is what keeps roles legible.
    practiceSkill(s, "f", "felling", 900);
    expect(skillMultiplier(s, "f", "felling")).toBeGreaterThan(bleed);
  });

  it("is PURE over the body's own rows — one body's practice never reaches another", () => {
    const s = state();
    practiceSkill(s, "a", "felling", 5000);
    expect(skillMultiplier(s, "b", "felling")).toBe(1);
  });
});

// ═══ ④ THE ONE DIAL ═══════════════════════════════════════════════════════

describe("④ `learning` — the one compression allowed near practice", () => {
  it("DECLARED wins", () => {
    expect(resolveWorldScale({ construction: 180, learning: 12 }).learning).toBe(12);
  });

  it("UNDECLARED follows the RESOLVED construction — labour compression is one class", () => {
    expect(resolveWorldScale({ construction: 180 }).learning).toBe(180);
    expect(resolveWorldScale({ construction: 720 }).learning).toBe(720);
    // …and with neither declared, both fall to the real anchor.
    expect(resolveWorldScale({}).learning).toBe(REAL_SCALE.construction);
  });

  it("REAL is 1, and the shipped profiles carry it", () => {
    expect(REAL_SCALE.learning).toBe(1);
    expect(DOLLHOUSE_SCALE.learning).toBe(DOLLHOUSE_SCALE.construction);
  });

  it("round-trips through `scaleSpecOf`, and refuses nonsense path-exactly", () => {
    expect(resolveWorldScale(scaleSpecOf(DOLLHOUSE_SCALE)).learning).toBe(DOLLHOUSE_SCALE.learning);
    expect(scaleSpecOf(resolveWorldScale({ learning: 7 }))).toMatchObject({ learning: 7 });
    // …and the gate is `parseWorldScaleSpec`'s, with the same message shape the
    // other dials use.
    expect(() => parseWorldScaleSpec({ learning: 0 }, "game.scale")).toThrow(
      /game\.scale\.learning: must be in 0\.01\.\.1000000/,
    );
    expect(parseWorldScaleSpec({ learning: 0.01 }, "game.scale")).toEqual({ learning: 0.01 });
  });

  it("📏 THE A/B KNOB: `learning: 0.01` puts mastery out of reach ⇒ every body reads 1×", () => {
    const off = state(resolveWorldScale({ construction: 180, learning: 0.01 }));
    practiceSkill(off, "a", "felling", 900); // thirty chops
    expect(skillMultiplier(off, "a", "felling")).toBeLessThan(1.02);
    const on = state(resolveWorldScale({ construction: 180 }));
    practiceSkill(on, "a", "felling", 900);
    expect(skillMultiplier(on, "a", "felling")).toBeCloseTo(1.46821, 5);
  });
});

// ═══ ⑤ THE SPEC SIDE ══════════════════════════════════════════════════════

describe("⑤ the `skills` block in the manifest", () => {
  const envelope = (skills: unknown) => ({
    scope: "town",
    world: { seed: 1 },
    ...(skills === undefined ? {} : { skills }),
  });

  it("parses a row and refuses an unknown field path-exactly", () => {
    expect(parseSkillsSpec({ masonry: { parent: "labour", mastery_hours: 700 } }, "game.skills")).toEqual({
      masonry: { parent: "labour", mastery_hours: 700 },
    });
    expect(() => parseSkillsSpec({ masonry: { hours: 700 } }, "game.skills")).toThrow(
      /game\.skills\.masonry\.hours: unknown field/,
    );
    expect(() => parseSkillsSpec({ masonry: { gain: 0.5 } }, "game.skills")).toThrow(
      /game\.skills\.masonry\.gain: out of range/,
    );
    expect(() => parseSkillsSpec([], "game.skills")).toThrow(/game\.skills: expected an object/);
  });

  it("rides the game envelope beside `scale`, and is NULL when nobody declares one", () => {
    expect(parseGameSettings(envelope(undefined), "game").skills).toBeNull();
    expect(parseGameSettings(envelope({ masonry: { mastery_hours: 700 } }), "game").skills).toEqual({
      masonry: { mastery_hours: 700 },
    });
    expect(() => parseGameSettings({ ...envelope(undefined), skils: {} }, "game")).toThrow(
      /game\.skils: unknown field/,
    );
  });

  it("resolves FIELD BY FIELD over the shipped row — a one-liner is legal", () => {
    expect(resolveSkillCatalogue(null)).toBe(DEFAULT_SKILL_CATALOGUE);
    const cat = resolveSkillCatalogue({ felling: { mastery_hours: 50 } });
    expect(cat.get("felling")).toEqual({ key: "felling", parent: "labour", masteryHours: 50, gain: 2 });
    // …and a genuinely new row lands whole.
    const withMason = resolveSkillCatalogue({ masonry: { parent: "labour", mastery_hours: 700, gain: 3 } });
    expect(withMason.get("masonry")).toEqual({ key: "masonry", parent: "labour", masteryHours: 700, gain: 3 });
    expect(withMason.get("felling")!.masteryHours).toBe(300);
  });
});

// ═══ ⑥ THE ACTION MAP ═════════════════════════════════════════════════════

describe("⑥ `skillFor` — one map, never a switch scattered through the host", () => {
  it("names the trade of every action the pull decider and the forage walker do", () => {
    expect(skillFor("fell")).toBe("felling");
    expect(skillFor("haul")).toBe("hauling");
    expect(skillFor("build")).toBe("building");
    expect(skillFor("forage")).toBe("foraging");
  });

  it("REFINE splits on the MATERIAL, and the wood family is read off the products catalogue", () => {
    // The raw and what it is milled into — both derived, neither typed out here.
    expect([...woodHeads()].sort()).toEqual(["block", "wood"]);
    expect(skillFor("refine", "wood")).toBe("carpentry");
    expect(skillFor("refine", "block")).toBe("carpentry");
    expect(skillFor("refine", "wood.wet")).toBe("carpentry"); // a facet pays toward its head
    expect(skillFor("refine", "cloth")).toBe("refining");
    expect(skillFor("refine", "cheese")).toBe("refining");
    expect(skillFor("refine")).toBe("refining"); // headless row = the general trade
  });
});

// ═══ ⑦ DAY ONE ════════════════════════════════════════════════════════════

describe("⑦ 🚨 an unpractised world is byte-identical to the pre-skill tree", () => {
  it("every read is exactly 1 — no rows, no body, no catalogue, no scale", () => {
    expect(skillMultiplier(state(), "nobody", "felling")).toBe(1);
    expect(skillMultiplier({ scale: DOLLHOUSE_SCALE }, "nobody", "felling")).toBe(1);
    expect(skillMultiplier({}, "nobody", "felling")).toBe(1);
    // …and a key no catalogue has cannot accidentally read as competence.
    const s = state();
    practiceSkill(s, "a", "sorcery", 10_000);
    expect(s.bodySkills!.size).toBe(0);
    expect(skillMultiplier(s, "a", "sorcery")).toBe(1);
  });

  it("a WRITE with no store is a no-op rather than a crash (the fixture shape)", () => {
    expect(() => practiceSkill({ scale: DOLLHOUSE_SCALE }, "a", "felling", 10)).not.toThrow();
    const s = state();
    practiceSkill(s, "a", "felling", 0);
    practiceSkill(s, "", "felling", 10);
    expect(s.bodySkills!.size).toBe(0);
  });
});

// ═══ ⑧ skillOfGood (the REGIONAL slice's catalogue function) ═══════════════

describe("⑧ skillOfGood — which skill makes a traded good, derived never named", () => {
  it("wood → felling (the raw take)", () => {
    expect(skillOfGood("wood")).toBe("felling");
  });

  it("every woodHeads() member that is NOT a raw product glyph → carpentry (the milled form)", () => {
    for (const head of woodHeads()) {
      const expectRefined = skillOfGood(head) === "carpentry";
      // `wood` itself is a raw take (felling); anything else `woodHeads()`
      // carries (what wood mills INTO, e.g. `block`) is the refined form.
      if (head === "wood") expect(skillOfGood(head)).toBe("felling");
      else expect(expectRefined).toBe(true);
    }
  });

  it("a natural food or drink, or a self-consuming take, → foraging", () => {
    for (const good of ["food", "apple", "banana", "milk", "meat"]) {
      expect(skillOfGood(good)).toBe("foraging");
    }
  });

  it("a refined-tier good → refining", () => {
    for (const good of ["cloth", "clothing", "cheese"]) {
      expect(skillOfGood(good)).toBe("refining");
    }
  });

  it("raw bulk that is not wood (stone) → null on the shipped catalogue, `mining` on one that declares it", () => {
    expect(skillOfGood("stone")).toBeNull();
    const withMining = withSkills({ key: "mining", parent: "labour", masteryHours: 400, gain: 2 });
    expect(skillOfGood("stone", withMining)).toBe("mining");
  });

  it("an unknown good → null", () => {
    expect(skillOfGood("this-good-does-not-exist")).toBeNull();
  });

  // 📝 CORRECTED FROM THE BRIEF: the brief's own list named `wool`/`block` as
  // both reading null. Read off the kernel directly (never typed): `wool` has
  // no natural-source row and no refined-tier freight reading, so it IS null
  // — but `block` is what `woodHeads()` carries as wood's milled form
  // (skills.test.ts's own ⑥ block, line ~328: `woodHeads()` = ["block",
  // "wood"]), so `skillOfGood("block")` is `carpentry` by the function's own
  // documented rule ("wood, and what wood mills into → felling / carpentry"),
  // not null. Pinned as the module actually reads it.
  it("wool → null; block (wood's milled form) → carpentry, not null", () => {
    expect(skillOfGood("wool")).toBeNull();
    expect(skillOfGood("block")).toBe("carpentry");
  });
});
