// Unit tests for the shared Guessing Mode narrowing engine.
// Pure-logic, no DB / no LLM — safe in the default `npm test` run.

import {
  ALL_DIMENSIONS,
  DIMENSION_BY_ID,
  DIMENSIONS_BY_CATEGORY,
  CATEGORY_VALUES,
  CATEGORY_DIM_ID,
} from "@shared/guessing-mode/dimensions.js";
import {
  createState,
  cloneState,
  applyPress,
  applyCustomFact,
  rejectMostRecentFact,
  dismissDimension,
  expandDimension,
  rejectCurrentDimension,
  suggestNextDimension,
  isConfident,
  isDominant,
  dominantValue,
  readyForGuesses,
  buildStateInjection,
  MAX_SUGGESTION_VALUES,
  UNKNOWN,
} from "@shared/guessing-mode/state.js";
import {
  SUGGESTION_REGISTRY,
  getSuggestionEntry,
  parseSuggestionKey,
  isValidSuggestionKey,
} from "@shared/guessing-mode/suggestion-registry.js";
import {
  expandSuggestionKey,
  splitOutSuggestionButtons,
  extractSuggestionButtonsFromRaw,
  parseBoardButtons,
  expandContrastButton,
  parseStructuredButtonsExpanding,
  serializeGlyph,
  glyphStringToJson,
  parseStructuredBoardButton,
  recoverOfferedSuggestionKey,
} from "../services/dual-agent/interactive-agent";
import { validateBoardButtons } from "../services/dual-agent/board-button-validator";

describe("registry coverage", () => {
  it("has an entry for every dimension value", () => {
    const missing: string[] = [];
    for (const def of ALL_DIMENSIONS) {
      for (const value of def.values) {
        if (!getSuggestionEntry(def.id, value)) missing.push(`${def.id}:${value}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("has an entry for every top-level category", () => {
    for (const c of CATEGORY_VALUES) {
      expect(getSuggestionEntry(CATEGORY_DIM_ID, c)).toBeDefined();
    }
  });

  it("every entry has a non-empty labelKey, labelEn and icon", () => {
    const bad: string[] = [];
    for (const [key, entry] of Object.entries(SUGGESTION_REGISTRY)) {
      if (!entry.labelKey || !entry.labelEn || !entry.icon) bad.push(key);
      if (!entry.labelKey.startsWith("guessing.")) bad.push(`${key} (labelKey)`);
    }
    expect(bad).toEqual([]);
  });

  it("has no duplicate dimension ids", () => {
    expect(Object.keys(DIMENSION_BY_ID).length).toBe(ALL_DIMENSIONS.length);
  });
});

describe("key parsing & validation", () => {
  it("parses dotted dimension keys", () => {
    expect(parseSuggestionKey("suggestion:animal.where_found:at_home")).toEqual({
      dimension: "animal.where_found",
      value: "at_home",
    });
    expect(parseSuggestionKey("suggestion:category:things")).toEqual({
      dimension: "category",
      value: "things",
    });
  });

  it("rejects malformed keys", () => {
    expect(parseSuggestionKey("nope:foo:bar")).toBeNull();
    expect(parseSuggestionKey("suggestion:onlyone")).toBeNull();
    expect(parseSuggestionKey("suggestion:dim:")).toBeNull();
  });

  it("validates real keys and rejects unknown ones", () => {
    expect(isValidSuggestionKey("suggestion:things.kind:animal")).toBe(true);
    expect(isValidSuggestionKey("suggestion:category:feelings")).toBe(true);
    expect(isValidSuggestionKey("suggestion:things.kind:dragon")).toBe(false);
    expect(isValidSuggestionKey("suggestion:made.up:value")).toBe(false);
    expect(isValidSuggestionKey("suggestion:category:nonsense")).toBe(false);
  });
});

describe("press update semantics", () => {
  it("categorical press boosts pressed, decays others, leaves unknown", () => {
    const s = createState();
    applyPress(s, "things.kind", "animal");
    const w = s.dimensions["things.kind"].weights;
    expect(w["animal"]).toBeGreaterThan(w["food"]);
    expect(w[UNKNOWN]).toBe(1); // unknown never decays
    expect(w["food"]).toBeLessThan(1);
    expect(isDominant(s, "things.kind", "animal")).toBe(true);
    expect(dominantValue(s, DIMENSION_BY_ID["things.kind"])).toBe("animal");
  });

  it("binary press halves the opposite value", () => {
    const s = createState();
    applyPress(s, "actions.pace", "fast");
    const w = s.dimensions["actions.pace"].weights;
    expect(w["fast"]).toBe(2);
    expect(w["slow"]).toBe(0.5);
    expect(w[UNKNOWN]).toBe(1);
  });

  it("is mistake tolerant — a conflicting press relaxes rather than eliminates", () => {
    const s = createState();
    applyPress(s, "things.kind", "animal"); // animal=2.0
    applyPress(s, "things.kind", "food"); // food=2*0.7? then others...
    const w = s.dimensions["things.kind"].weights;
    // unknown still 1.0 the whole time, so neither belief is ever driven to ~0
    expect(w[UNKNOWN]).toBe(1);
    expect(w["animal"]).toBeGreaterThan(0);
    expect(w["food"]).toBeGreaterThan(0);
  });

  it("becomes confident after a single clear press", () => {
    const s = createState();
    applyPress(s, "things.kind", "animal");
    expect(isConfident(s, DIMENSION_BY_ID["things.kind"])).toBe(true);
  });

  it("category press sets the mode switch without touching weights", () => {
    const s = createState();
    applyPress(s, CATEGORY_DIM_ID, "things");
    expect(s.category).toBe("things");
    expect(Object.keys(s.dimensions)).toHaveLength(0);
  });

  it("ignores presses for unknown dimensions/values", () => {
    const s = createState();
    applyPress(s, "made.up", "x");
    applyPress(s, "things.kind", "dragon");
    expect(Object.keys(s.dimensions)).toHaveLength(0);
  });
});

describe("next-dimension selection", () => {
  it("asks for a category first when none chosen", () => {
    const s = createState();
    const next = suggestNextDimension(s);
    expect(next.isCategory).toBe(true);
    expect(next.def).toBeNull();
  });

  it("leads with the highest-priority steering dimension (kind) for things", () => {
    const s = createState();
    applyPress(s, CATEGORY_DIM_ID, "things");
    const next = suggestNextDimension(s);
    expect(next.def?.id).toBe("things.kind");
  });

  it("opens nested cluster dimensions only once the parent is dominant", () => {
    const s = createState();
    applyPress(s, CATEGORY_DIM_ID, "things");
    // animal sub-dimensions not applicable yet
    const covering = DIMENSION_BY_ID["animal.covering"];
    expect(covering.applicableWhen!(s)).toBe(false);
    applyPress(s, "things.kind", "animal");
    expect(covering.applicableWhen!(s)).toBe(true);
    // and the assistant now offers a steering, applicable, non-confident dim
    const next = suggestNextDimension(s);
    expect(next.def).toBeTruthy();
    expect(next.def!.role).toBe("steering");
    expect(next.def!.applicableWhen ? next.def!.applicableWhen(s) : true).toBe(true);
  });

  it("never re-asks a confident or dismissed dimension", () => {
    const s = createState();
    applyPress(s, CATEGORY_DIM_ID, "things");
    applyPress(s, "things.kind", "animal"); // kind now confident
    const candIds = DIMENSIONS_BY_CATEGORY.things
      .filter((d) => !d.applicableWhen || d.applicableWhen(s))
      .filter((d) => !isConfident(s, d));
    expect(candIds.find((d) => d.id === "things.kind")).toBeUndefined();

    // dismiss the next suggested dim → it should not come back
    const next = suggestNextDimension(s).def!;
    dismissDimension(s, next.id);
    const after = suggestNextDimension(s).def;
    expect(after?.id).not.toBe(next.id);
  });

  it("'No' DEFERS the current dimension (not dismiss) and asks a different one", () => {
    const s = createState();
    applyPress(s, CATEGORY_DIM_ID, "things");
    const before = suggestNextDimension(s).def!;
    expect(before.id).toBe("things.kind");
    rejectCurrentDimension(s);
    // kind is deferred → a different dimension is suggested now…
    const after = suggestNextDimension(s).def;
    expect(after?.id).not.toBe("things.kind");
    // …but it is NOT dismissed (defer, not drop).
    expect(s.dimensions["things.kind"].dismissed).toBeFalsy();
    expect(s.dimensions["things.kind"].deferredAtTurn).toBeGreaterThanOrEqual(0);
    expect(s.lastAction).toBe("defer");
    // injection frames the move positively (not "you were wrong")
    expect(buildStateInjection(s).text).toMatch(/different question/i);
    // a real press clears lastAction
    if (after) applyPress(s, after.id, after.values[0]);
    expect(s.lastAction).toBeUndefined();
  });

  it("a deferred dimension returns once the fresh ones are spent", () => {
    const s = createState();
    applyPress(s, CATEGORY_DIM_ID, "feelings");
    // Defer dimensions one by one; each defer should pick a different fresh dim,
    // and eventually the engine must come back to a previously-deferred one
    // rather than running out (defer ≠ dismiss).
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const d = suggestNextDimension(s).def;
      if (!d) break;
      seen.add(d.id);
      rejectCurrentDimension(s);
    }
    // After cycling, the engine still offers a dimension (a deferred one returns).
    expect(suggestNextDimension(s).def).toBeTruthy();
  });

  it("'More' pages the SAME dimension's long tail (rarer values)", () => {
    const s = createState();
    applyPress(s, CATEGORY_DIM_ID, "things");
    // things.theme has 18 values → 3 pages of MAX_SUGGESTION_VALUES.
    // Steer onto a long dimension by making kind+place confident first so the
    // engine offers theme, OR just exercise paging on whatever is offered.
    const dim = suggestNextDimension(s).def!;
    const page1 = buildStateInjection(s).suggestionKeys;
    expect(page1.length).toBeGreaterThan(0);
    expandDimension(s);
    expect(s.lastAction).toBe("expand");
    // Still the SAME dimension, but a different (later) slice of its values.
    const next = suggestNextDimension(s).def;
    if (next && next.id === dim.id && dim.values.length > MAX_SUGGESTION_VALUES) {
      const page2 = buildStateInjection(s).suggestionKeys;
      expect(page2).not.toEqual(page1);
      expect(page2.every((k) => !page1.includes(k))).toBe(true);
    } else {
      // Short dimension: paging past the end dismisses it (AI takes over).
      expect(s.dimensions[dim.id].dismissed).toBe(true);
    }
  });

  it("paging through theme's full long tail eventually exhausts it", () => {
    const s = createState();
    applyPress(s, CATEGORY_DIM_ID, "things");
    const theme = DIMENSION_BY_ID["things.theme"];
    expect(theme.values.length).toBeGreaterThan(MAX_SUGGESTION_VALUES);
    // Force theme to be the offered dimension by exhausting higher-priority dims.
    // Simpler: drive pageOffset directly via expandDimension once theme is shown.
    // Walk: make kind confident, then keep expanding whatever is suggested until
    // theme appears, then exhaust it.
    applyPress(s, "things.kind", "animal");
    // Collect all theme keys seen across pages.
    const seen = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const d = suggestNextDimension(s).def;
      if (!d) break;
      if (d.id === "things.theme") {
        for (const k of buildStateInjection(s).suggestionKeys) seen.add(k);
        expandDimension(s);
      } else {
        // skip non-theme dims by deferring them
        rejectCurrentDimension(s);
      }
    }
    // We should have surfaced more theme values than a single page holds.
    expect(seen.size).toBeGreaterThan(MAX_SUGGESTION_VALUES);
  });
});

describe("readiness", () => {
  it("is ready after two confident steering dimensions", () => {
    const s = createState();
    applyPress(s, CATEGORY_DIM_ID, "things");
    applyPress(s, "things.kind", "animal");
    expect(readyForGuesses(s)).toBe(false);
    applyPress(s, "animal.covering", "furry");
    expect(readyForGuesses(s)).toBe(true);
  });

  it("is ready after five total presses", () => {
    const s = createState();
    applyPress(s, CATEGORY_DIM_ID, "feelings");
    applyPress(s, "feelings.valence", "good");
    applyPress(s, "feelings.valence", "bad");
    applyPress(s, "feelings.valence", "mixed");
    applyPress(s, "feelings.intensity", "strong");
    applyPress(s, "feelings.intensity", "small");
    expect(readyForGuesses(s)).toBe(true);
  });
});

describe("injection rendering", () => {
  it("category turn offers all six category keys, all valid", () => {
    const s = createState(["dinosaurs", "trains"]);
    const inj = buildStateInjection(s);
    expect(inj.text).toContain("[GUESSING STATE]");
    expect(inj.text).toContain("dinosaurs");
    expect(inj.suggestionKeys).toHaveLength(CATEGORY_VALUES.length);
    for (const k of inj.suggestionKeys) expect(isValidSuggestionKey(k)).toBe(true);
  });

  it("emits only valid suggestion keys across a full narrowing walk", () => {
    const s = createState();
    // Simulate the assistant pressing whatever it suggests, several turns deep.
    applyPress(s, CATEGORY_DIM_ID, "things");
    for (let turn = 0; turn < 8; turn++) {
      const inj = buildStateInjection(s);
      for (const k of inj.suggestionKeys) {
        expect(isValidSuggestionKey(k)).toBe(true);
      }
      const next = suggestNextDimension(s);
      if (!next.def) break;
      applyPress(s, next.def.id, next.def.values[0]);
    }
  });

  it("renders the focus label and known facts once narrowed", () => {
    const s = createState();
    applyPress(s, CATEGORY_DIM_ID, "things");
    applyPress(s, "things.kind", "animal");
    const inj = buildStateInjection(s);
    expect(inj.text).toContain("Category: things");
    expect(inj.text).toMatch(/Known:.*kind=animal/);
    expect(inj.text).toContain("Now figuring out:");
  });
});

describe("seeding from interests + age", () => {
  it("renders the age line and interests in the category-turn injection", () => {
    const s = createState(["trains", "dinosaurs"], 39);
    const inj = buildStateInjection(s);
    expect(inj.text).toMatch(/age 39/);
    expect(inj.text).toMatch(/adult/);
    expect(inj.text).toContain("trains");
  });

  it("omits the age line when age is unknown", () => {
    const s = createState(["trains"]);
    expect(buildStateInjection(s).text).not.toMatch(/age \d/);
  });

  it("labels a young user as a child and an older one as an adult", () => {
    expect(buildStateInjection(createState([], 7)).text).toMatch(/child \(age 7\)/);
    expect(buildStateInjection(createState([], 45)).text).toMatch(/adult \(age 45\)/);
  });

  it("carries age + interests into the narrowed (non-category) injection too", () => {
    const s = createState(["football"], 30);
    applyPress(s, CATEGORY_DIM_ID, "things");
    applyPress(s, "things.kind", "animal");
    const inj = buildStateInjection(s);
    expect(inj.text).toMatch(/age 30/);
    expect(inj.text).toContain("football");
  });

  it("seeds specialInterests/userAge onto the state and survives a clone", () => {
    const s = createState(["space"], 12);
    expect(s.specialInterests).toEqual(["space"]);
    expect(s.userAge).toBe(12);
    const c = cloneState(s);
    expect(c.userAge).toBe(12);
    expect(c.specialInterests).toEqual(["space"]);
  });
});

describe("theme association dimension", () => {
  it("exposes things.theme and actions.theme sharing one registry cluster", () => {
    expect(DIMENSION_BY_ID["things.theme"]?.cluster).toBe("theme");
    expect(DIMENSION_BY_ID["actions.theme"]?.cluster).toBe("theme");
    // Same cluster ⇒ one shared set of registry entries.
    expect(DIMENSION_BY_ID["things.theme"].values).toEqual(DIMENSION_BY_ID["actions.theme"].values);
  });

  it("every theme value resolves to a valid suggestion key under both namespaces", () => {
    for (const v of DIMENSION_BY_ID["things.theme"].values) {
      expect(isValidSuggestionKey(`suggestion:things.theme:${v}`)).toBe(true);
      expect(isValidSuggestionKey(`suggestion:actions.theme:${v}`)).toBe(true);
    }
  });

  it("is offered as a steering question under things", () => {
    const s = createState();
    applyPress(s, CATEGORY_DIM_ID, "things");
    const offered = DIMENSIONS_BY_CATEGORY.things.some((d) => d.id === "things.theme");
    expect(offered).toBe(true);
  });
});

describe("glyph ⇄ JSON converters", () => {
  it("serializes a multi-glyph sentence with a modifier", () => {
    const { sentence, fallback } = serializeGlyph(
      [{ sym: "i_me" }, { sym: "want" }, { sym: "🍎", mods: ["color_red"] }],
    );
    expect(sentence).toBe("i_me+want+🍎.color_red");
    expect(fallback).toBeUndefined();
  });

  it("appends an operator", () => {
    expect(serializeGlyph([{ sym: "😴" }], "question").sentence).toBe("😴#question");
  });

  it("synthesizes the fallback from per-glyph fb, mirroring non-gen slots", () => {
    const { sentence, fallback } = serializeGlyph([
      { sym: "i_me" }, { sym: "want" }, { sym: "talk" },
      { gen: "planet_mars", fb: { sym: "🌑", mods: ["color_red"] } },
    ]);
    expect(sentence).toBe("i_me+want+talk+generate:planet_mars");
    expect(fallback).toBe("i_me+want+talk+🌑.color_red");
  });

  it("glyphStringToJson inverts a plain sentence", () => {
    expect(glyphStringToJson("i_me+want+🍎.color_red")).toEqual({
      glyph: [{ sym: "i_me" }, { sym: "want" }, { sym: "🍎", mods: ["color_red"] }],
    });
  });

  it("glyphStringToJson recovers op + folds the fallback into the gen glyph's fb", () => {
    expect(
      glyphStringToJson("i_me+talk+generate:planet_mars#future", "i_me+talk+🌑.color_red"),
    ).toEqual({
      glyph: [
        { sym: "i_me" }, { sym: "talk" },
        { gen: "planet_mars", fb: { sym: "🌑", mods: ["color_red"] } },
      ],
      op: "future",
    });
  });

  it("round-trips JSON → string → JSON for the representative shapes", () => {
    const cases = [
      { glyph: [{ sym: "😴" }] },
      { glyph: [{ sym: "i_me" }, { sym: "🤗", mods: ["big", "please"] }] },
      { glyph: [{ sym: "face:mom" }], op: "past" as const },
      { glyph: [{ sym: "i_me" }, { gen: "cello", fb: { sym: "🎻" } }] },
    ];
    for (const c of cases) {
      const { sentence, fallback } = serializeGlyph(c.glyph, (c as any).op);
      expect(glyphStringToJson(sentence, fallback)).toEqual(c);
    }
  });

  it("parseStructuredBoardButton: glyph array and legacy sentence string agree", () => {
    const viaGlyph = parseStructuredBoardButton({
      speech: "I want a red apple",
      glyph: [{ sym: "i_me" }, { sym: "want" }, { sym: "🍎", mods: ["color_red"] }],
      label: "Red apple",
    });
    const viaString = parseStructuredBoardButton({
      speech: "I want a red apple",
      sentence: "i_me+want+🍎.color_red",
      label: "Red apple",
    });
    expect(viaGlyph?.glyph).toBe("i_me+want+🍎.color_red");
    expect(viaGlyph?.glyph).toBe(viaString?.glyph);
    expect(viaGlyph?.sentence).toBe("I want a red apple"); // speech preserved
  });
});

describe("contrast ('closer to A or B?') expansion", () => {
  it("expands [CONTRAST:dim] A | B into two narrow pole buttons", () => {
    const out = expandContrastButton({
      speech: "more like a cat | more like a dog",
      sentence: "🐱 | 🐶",
      label: "[CONTRAST:feel] cat-like | dog-like",
    })!;
    expect(out).toHaveLength(2);
    expect(out.map((b) => b.narrowValue)).toEqual(["cat-like", "dog-like"]);
    expect(out.every((b) => b.buttonType === "narrow")).toBe(true);
    expect(out.every((b) => b.narrowDimension === "feel")).toBe(true);
    // The visible label is the pole; the prefix is stripped.
    expect(out.map((b) => b.label)).toEqual(["cat-like", "dog-like"]);
    // Per-pole speech + glyph align to the poles.
    expect(out[0].sentence).toBe("more like a cat");
    expect(out[1].sentence).toBe("more like a dog");
    expect(out[0].glyph).toBe("🐱");
    expect(out[1].glyph).toBe("🐶");
  });

  it("defaults a pole's voiced speech to the pole text when none is given", () => {
    const out = expandContrastButton({ label: "[CONTRAST:size] tiny | huge" })!;
    expect(out.map((b) => b.sentence)).toEqual(["tiny", "huge"]);
  });

  it("supports more than two poles (a wider split)", () => {
    const out = expandContrastButton({ label: "[CONTRAST:era] past | present | future" })!;
    expect(out.map((b) => b.narrowValue)).toEqual(["past", "present", "future"]);
  });

  it("returns null for a malformed contrast (no dim or <2 poles)", () => {
    expect(expandContrastButton({ label: "[CONTRAST:] a | b" })).toBeNull();
    expect(expandContrastButton({ label: "[CONTRAST:feel] only-one" })).toBeNull();
    expect(expandContrastButton({ label: "just a normal button" })).toBeNull();
    expect(expandContrastButton({ label: "[NARROW:genre] comedy" })).toBeNull();
  });

  it("structured kind:contrast expands into narrow pole buttons", () => {
    const out = expandContrastButton({
      kind: "contrast",
      dimension: "feel",
      poles: [
        { value: "cat-like", speech: "more like a cat", glyph: [{ sym: "🐱" }] },
        { value: "dog-like", speech: "more like a dog", glyph: [{ sym: "🐶" }] },
      ],
    })!;
    expect(out.map((b) => b.narrowValue)).toEqual(["cat-like", "dog-like"]);
    expect(out.every((b) => b.buttonType === "narrow" && b.narrowDimension === "feel")).toBe(true);
    expect(out[0].sentence).toBe("more like a cat");
    expect(out[0].glyph).toBe("🐱");
  });

  it("structured kind:narrow sets narrow fields and labels from value", () => {
    const b = parseStructuredButtonsExpanding({
      kind: "narrow", dimension: "genre", value: "Comedy", glyph: [{ sym: "😂" }], speech: "funny",
    });
    expect(b).toHaveLength(1);
    expect(b[0].buttonType).toBe("narrow");
    expect(b[0].narrowDimension).toBe("genre");
    expect(b[0].narrowValue).toBe("Comedy");
    expect(b[0].label).toBe("Comedy");
    expect(b[0].glyph).toBe("😂");
  });

  it("structured kind:guess sets guess type with the value as label", () => {
    const b = parseStructuredBoardButton({ kind: "guess", value: "Spider-Man", glyph: [{ sym: "🕷️" }] });
    expect(b?.buttonType).toBe("guess");
    expect(b?.label).toBe("Spider-Man");
  });

  // Regression (2026-08-19): `value` doubled as the visible label, so
  // English machine values ("sea", "land") rendered on a Hebrew board. The
  // authored `label` now wins; `value` stays machine-readable and is only a
  // display fallback (pinned by the two tests above).
  it("kind:narrow — the authored label wins over the machine value", () => {
    const b = parseStructuredBoardButton({
      kind: "narrow", dimension: "habitat", value: "sea", label: "ים", speech: "בים", glyph: [{ sym: "🌊" }],
    });
    expect(b?.label).toBe("ים");           // shown: user's language
    expect(b?.narrowValue).toBe("sea");    // recorded: machine value
    expect(b?.narrowDimension).toBe("habitat");
    expect(b?.sentence).toBe("בים");
  });

  it("kind:guess — the authored label wins over the value", () => {
    const b = parseStructuredBoardButton({ kind: "guess", value: "dog", label: "כלב", speech: "כלב" });
    expect(b?.buttonType).toBe("guess");
    expect(b?.label).toBe("כלב");
  });

  it("structured contrast poles — per-pole label wins over the pole value", () => {
    const out = expandContrastButton({
      kind: "contrast",
      dimension: "feel",
      poles: [
        { value: "cat_like", label: "כמו חתול", speech: "יותר כמו חתול", glyph: [{ sym: "🐱" }] },
        { value: "dog_like", label: "כמו כלב", speech: "יותר כמו כלב", glyph: [{ sym: "🐶" }] },
      ],
    })!;
    expect(out.map((b) => b.label)).toEqual(["כמו חתול", "כמו כלב"]);
    expect(out.map((b) => b.narrowValue)).toEqual(["cat_like", "dog_like"]);
  });

  it("parseStructuredButtonsExpanding: contrast→2, normal→1, invalid→0", () => {
    expect(parseStructuredButtonsExpanding({ label: "[CONTRAST:feel] a | b" })).toHaveLength(2);
    expect(parseStructuredButtonsExpanding({ label: "Hello", sentence: "👋" })).toHaveLength(1);
    expect(parseStructuredButtonsExpanding({ label: "" })).toHaveLength(0);
  });

  it("a pressed contrast pole records a custom fact the injection surfaces", () => {
    // Simulate the end-to-end: expand → press a pole → the client would send
    // guessing_narrow{dimension, value, sourceText=button.sentence} → applyCustomFact.
    const [poleA] = expandContrastButton({
      speech: "more like a cat | more like a dog",
      label: "[CONTRAST:feel] cat-like | dog-like",
    })!;
    const s = createState();
    applyPress(s, CATEGORY_DIM_ID, "things");
    applyCustomFact(s, poleA.narrowDimension!, poleA.narrowValue!, poleA.sentence);
    const inj = buildStateInjection(s);
    expect(inj.text).toContain("feel=cat-like");
    expect(inj.text).toContain("more like a cat");
  });
});

describe("server-side suggestion-button expansion", () => {
  it("expands an emoji-backed key into a renderable button", () => {
    const btn = expandSuggestionKey("suggestion:things.kind:animal");
    expect(btn).toBeTruthy();
    expect(btn!.buttonType).toBe("suggestion");
    expect(btn!.suggestionKey).toBe("suggestion:things.kind:animal");
    expect(btn!.label).toBeTruthy();
    // emoji icon renders directly (glyph === iconRef === emoji, no imageKey)
    expect(btn!.imageKey).toBeUndefined();
    expect(btn!.iconRef).toBe(btn!.glyph);
    expect(btn!.glyph).toBeTruthy();
  });

  it("routes a no-emoji key through the generator with a placeholder", () => {
    // body_part:belly has a snake_case icon (no emoji) in the registry.
    const btn = expandSuggestionKey("suggestion:feelings.where_hurts:belly");
    expect(btn).toBeTruthy();
    expect(btn!.buttonType).toBe("suggestion");
    // Either an emoji was found, or it routes to generation with a fallback.
    if (btn!.imageKey) {
      expect(btn!.imageKey).toBe("belly");
      expect(btn!.glyphFallback).toBeTruthy(); // placeholder shown while generating
    } else {
      expect(btn!.iconRef).toBeTruthy();
    }
  });

  it("returns null for invalid keys", () => {
    expect(expandSuggestionKey("suggestion:things.kind:dragon")).toBeNull();
    expect(expandSuggestionKey("not a key")).toBeNull();
  });

  it("recovers ALL keys when the model pipe-crams them with labels (no commas)", () => {
    // Real Gemini output: keys joined with pipes + Hebrew labels, no commas.
    const raw = "suggestion:actions.who:alone|לבד||suggestion:actions.who:with_others|עם אחרים||suggestion:actions.who:together|ביחד";
    const { suggestions, othersRaw } = extractSuggestionButtonsFromRaw(raw);
    expect(suggestions.map((s) => s.suggestionKey)).toEqual([
      "suggestion:actions.who:alone",
      "suggestion:actions.who:with_others",
      "suggestion:actions.who:together",
    ]);
    expect(suggestions.every((s) => s.buttonType === "suggestion")).toBe(true);
    expect(othersRaw.trim()).toBe(""); // nothing left over
  });

  it("extracts comma-separated keys and dedupes", () => {
    const raw = "suggestion:things.kind:animal,suggestion:things.kind:food,suggestion:things.kind:animal";
    const { suggestions } = extractSuggestionButtonsFromRaw(raw);
    expect(suggestions.map((s) => s.suggestionKey)).toEqual([
      "suggestion:things.kind:animal",
      "suggestion:things.kind:food",
    ]);
  });

  it("splits bare suggestion-key buttons out from normal buttons", () => {
    const input = [
      { label: "suggestion:category:things" },
      { label: "I want water", glyph: "i_me+want+water", sentence: "I want water" },
      { label: "suggestion:things.kind:food" },
    ];
    const { others, suggestions } = splitOutSuggestionButtons(input);
    expect(suggestions).toHaveLength(2);
    expect(others).toHaveLength(1);
    expect(others[0].label).toBe("I want water");
    expect(suggestions.every((s) => s.buttonType === "suggestion")).toBe(true);
  });
});

describe("recoverOfferedSuggestionKey", () => {
  const offered = ["suggestion:actions.pace:fast", "suggestion:actions.pace:slow"];

  it("recovers from a narrow button reconstructing dimension+value (the 'fast/slow' bug)", () => {
    // Model copied the offered key's parts into a narrow button instead of
    // echoing the key — the label would render the raw English value.
    const key = recoverOfferedSuggestionKey(
      { label: "fast", narrowDimension: "actions.pace", narrowValue: "fast" },
      offered,
    );
    expect(key).toBe("suggestion:actions.pace:fast");
  });

  it("recovers from a bare-value label by matching an offered key's value", () => {
    expect(recoverOfferedSuggestionKey({ label: "slow" }, offered)).toBe(
      "suggestion:actions.pace:slow",
    );
  });

  it("matches offered values case-insensitively (snake_case values included)", () => {
    const whoOffered = ["suggestion:actions.who:with_others", "suggestion:actions.who:alone"];
    expect(recoverOfferedSuggestionKey({ label: "With_Others" }, whoOffered)).toBe(
      "suggestion:actions.who:with_others",
    );
  });

  it("returns null for a genuine AI guess that matches no offered value", () => {
    expect(
      recoverOfferedSuggestionKey({ label: "Spider-Man" }, offered),
    ).toBeNull();
  });

  it("returns null when no keys are offered and the value isn't a real dim+value", () => {
    expect(recoverOfferedSuggestionKey({ label: "fast" }, [])).toBeNull();
  });
});

describe("cloneState", () => {
  it("produces an independent deep copy", () => {
    const s = createState(["x"]);
    applyPress(s, CATEGORY_DIM_ID, "things");
    applyPress(s, "things.kind", "animal");
    const c = cloneState(s);
    applyPress(c, "things.kind", "food");
    // original untouched
    expect(s.dimensions["things.kind"].weights["food"]).toBeLessThan(
      c.dimensions["things.kind"].weights["food"],
    );
    expect(s.specialInterests).not.toBe(c.specialInterests);
  });

  it("deep-copies customFacts and rejectedFacts so mutations don't leak", () => {
    const s = createState();
    applyCustomFact(s, "genre", "comedy");
    const c = cloneState(s);
    expect(c.customFacts).toEqual(s.customFacts);
    expect(c.customFacts).not.toBe(s.customFacts);
    rejectMostRecentFact(c);
    expect(s.customFacts).toHaveLength(1);
    expect(s.rejectedFacts).toHaveLength(0);
    expect(c.customFacts).toHaveLength(0);
    expect(c.rejectedFacts).toHaveLength(1);
  });
});

describe("custom narrowing facts", () => {
  it("applyCustomFact appends a fact and renders it in the injection", () => {
    const s = createState();
    applyPress(s, CATEGORY_DIM_ID, "things");
    applyCustomFact(s, "genre", "comedy", "what kind of movie?");
    expect(s.customFacts).toHaveLength(1);
    expect(s.customFacts[0].dimension).toBe("genre");
    expect(s.customFacts[0].value).toBe("comedy");
    expect(s.customFacts[0].sourceText).toBe("what kind of movie?");

    const inj = buildStateInjection(s);
    expect(inj.customFacts).toEqual(s.customFacts);
    expect(inj.text).toMatch(/Custom narrowing facts/i);
    expect(inj.text).toContain("genre=comedy");
  });

  it("applyCustomFact ignores empty dimension or value", () => {
    const s = createState();
    applyCustomFact(s, "", "comedy");
    applyCustomFact(s, "genre", "");
    expect(s.customFacts).toHaveLength(0);
    expect(s.history).toHaveLength(0);
  });

  it("rejectMostRecentFact unwinds a custom fact and surfaces it in [GUESSING STATE]", () => {
    const s = createState();
    applyPress(s, CATEGORY_DIM_ID, "things");
    applyCustomFact(s, "genre", "comedy");
    applyCustomFact(s, "era", "modern");

    const ok = rejectMostRecentFact(s);
    expect(ok).toBe(true);
    expect(s.customFacts.map((f) => f.value)).toEqual(["comedy"]);
    expect(s.rejectedFacts.map((f) => `${f.dimension}=${f.value}`)).toEqual(["era=modern"]);
    expect(s.justRejected).toBe(true);

    const inj = buildStateInjection(s);
    expect(inj.text).toMatch(/Rejected/);
    expect(inj.text).toContain("era=modern");
    expect(inj.rejectedFacts).toEqual(s.rejectedFacts);
  });

  it("rejectMostRecentFact on a registry press dismisses that dimension", () => {
    const s = createState();
    applyPress(s, CATEGORY_DIM_ID, "things");
    applyPress(s, "things.kind", "animal");

    const ok = rejectMostRecentFact(s);
    expect(ok).toBe(true);
    expect(s.dimensions["things.kind"].dismissed).toBe(true);
    expect(s.rejectedFacts).toHaveLength(1);
    expect(s.rejectedFacts[0].dimension).toBe("kind"); // localName
    expect(s.rejectedFacts[0].value).toBe("animal");
    expect(s.justRejected).toBe(true);
  });

  it("rejectMostRecentFact skips the category mode-switch press", () => {
    const s = createState();
    applyPress(s, CATEGORY_DIM_ID, "things");
    // Only entry in history is the category mode switch — nothing to reject.
    expect(rejectMostRecentFact(s)).toBe(false);
    expect(s.justRejected).toBe(false);
  });

  it("rejectMostRecentFact returns false on empty history", () => {
    const s = createState();
    expect(rejectMostRecentFact(s)).toBe(false);
  });

  it("parser strips `[NARROW:<dim>] <value>` and tags the button", () => {
    // structured pipe: speech|sentence|fallback|label
    const pipe = `what kind of movie?|🎬|🎬|[NARROW:genre] Comedy`;
    const [btn] = parseBoardButtons(pipe);
    expect(btn).toBeDefined();
    expect(btn.label).toBe("Comedy");
    expect(btn.buttonType).toBe("narrow");
    expect(btn.narrowDimension).toBe("genre");
    expect(btn.narrowValue).toBe("Comedy");
    // The speech field (parser exposes it as `sentence`) is preserved as-is —
    // useful as `sourceText` on the customFact recorded by the press handler.
    expect(btn.sentence).toBe("what kind of movie?");
  });

  it("parser tolerates multi-word dimension labels", () => {
    const pipe = `when?|🌅|🌅|[NARROW:time of day] morning`;
    const [btn] = parseBoardButtons(pipe);
    expect(btn.narrowDimension).toBe("time of day");
    expect(btn.narrowValue).toBe("morning");
    expect(btn.buttonType).toBe("narrow");
    expect(btn.label).toBe("morning");
  });

  it("parser leaves a malformed `[NARROW:]` prefix in the label for the validator", () => {
    // Empty dimension — parser declines to tag and passes the label through.
    const pipe = `what?|🤔|🤔|[NARROW:] something`;
    const [btn] = parseBoardButtons(pipe);
    expect(btn.buttonType).toBeUndefined();
    expect(btn.narrowDimension).toBeUndefined();
    expect(btn.label).toBe("[NARROW:] something");
  });

  it("parser leaves a missing-value `[NARROW:<dim>]` in the label for the validator", () => {
    // No value after the bracket — parser declines to tag.
    const pipe = `pick one|🤔|🤔|[NARROW:genre]`;
    const [btn] = parseBoardButtons(pipe);
    expect(btn.buttonType).toBeUndefined();
    expect(btn.label).toBe("[NARROW:genre]");
  });

  it("validator rejects buttons whose label still begins with [NARROW", () => {
    const malformed = {
      label: "[NARROW:] comedy",
      glyph: "🎬",
      glyphFallback: "🎬",
    };
    const { buttons, errors } = validateBoardButtons([malformed]);
    expect(buttons).toEqual([]);
    expect(errors[0]).toMatch(/malformed \[NARROW/i);
  });

  it("after rejectMostRecentFact the injection prints Rejected: dim=value", () => {
    // Simulates the client's GUESSING_REJECT → rejectMostRecentFact flow on
    // a state where the user picked one custom narrowing step then said no.
    const s = createState();
    applyPress(s, CATEGORY_DIM_ID, "things");
    applyCustomFact(s, "genre", "comedy");
    const undid = rejectMostRecentFact(s);
    expect(undid).toBe(true);
    const inj = buildStateInjection(s);
    expect(inj.text).toMatch(/Rejected/);
    expect(inj.text).toContain("genre=comedy");
    expect(inj.rejectedFacts.map((f) => `${f.dimension}=${f.value}`)).toEqual(["genre=comedy"]);
    // And the engine state must have CLEARED the fact from customFacts.
    expect(inj.customFacts).toEqual([]);
  });

  it("rejectMostRecentFact preserves earlier facts (only the latest is undone)", () => {
    const s = createState();
    applyPress(s, CATEGORY_DIM_ID, "things");
    applyCustomFact(s, "genre", "comedy");
    applyCustomFact(s, "era", "modern");
    rejectMostRecentFact(s);
    expect(s.customFacts.map((f) => f.value)).toEqual(["comedy"]);
    expect(s.rejectedFacts.map((f) => f.value)).toEqual(["modern"]);
    // Build the injection — comedy still appears as a Custom fact, modern as Rejected.
    const inj = buildStateInjection(s);
    expect(inj.text).toContain("genre=comedy");
    expect(inj.text).toContain("era=modern");
    // And the order in the text: Custom facts: ... appears BEFORE Rejected: ...
    expect(inj.text.indexOf("Custom narrowing facts")).toBeLessThan(inj.text.indexOf("Rejected"));
  });

  it("validator passes a well-formed narrow button (post-parser, no prefix in label)", () => {
    const btn = {
      label: "Comedy",
      glyph: "🎬",
      glyphFallback: "🎬",
    };
    const { buttons, errors } = validateBoardButtons([btn]);
    expect(buttons).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it("custom and registry facts compose in history order", () => {
    const s = createState();
    applyPress(s, CATEGORY_DIM_ID, "things");
    applyCustomFact(s, "genre", "comedy");
    applyPress(s, "things.kind", "animal");
    applyCustomFact(s, "era", "modern");

    // Most recent is the era fact.
    rejectMostRecentFact(s);
    expect(s.customFacts.map((f) => f.value)).toEqual(["comedy"]);
    expect(s.rejectedFacts.map((f) => f.value)).toEqual(["modern"]);

    // Next most recent is the registry press for things.kind=animal.
    rejectMostRecentFact(s);
    expect(s.dimensions["things.kind"].dismissed).toBe(true);
    expect(s.rejectedFacts.map((f) => f.value)).toEqual(["modern", "animal"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Contradiction prevention — new positive knowledge about a dimension
// overrides older contradicting knowledge (customFacts + rejectedFacts).
// Within a single dimension, newest-press-wins on weights too.
// ─────────────────────────────────────────────────────────────────────────
describe("contradiction prevention", () => {
  it("applyPress on a new value resets weights so the newest press wins decisively", () => {
    const s = createState();
    applyPress(s, CATEGORY_DIM_ID, "things");
    const dim = "things.kind";
    applyPress(s, dim, "animal");
    expect(dominantValue(s, DIMENSION_BY_ID[dim])).toBe("animal");
    // Switch to a different value within the same dimension — should win cleanly.
    applyPress(s, dim, "food");
    expect(dominantValue(s, DIMENSION_BY_ID[dim])).toBe("food");
    // And the AI's "Known:" line reflects the newest value, not a tie.
    const inj = buildStateInjection(s);
    expect(inj.text).toMatch(/kind=food/);
    expect(inj.text).not.toMatch(/kind=animal/);
  });

  it("applyPress clears a matching rejectedFact for the same dimension", () => {
    const s = createState();
    applyPress(s, CATEGORY_DIM_ID, "things");
    applyPress(s, "things.kind", "animal");
    rejectMostRecentFact(s);
    expect(s.rejectedFacts.some((f) => f.dimension === "kind")).toBe(true);
    // User changes their mind and presses a value for the same dimension —
    // the prior rejection no longer applies.
    applyPress(s, "things.kind", "food");
    expect(s.rejectedFacts.some((f) => f.dimension === "kind")).toBe(false);
  });

  it("applyPress clears a customFact about the same dimension (registry overrides custom)", () => {
    const s = createState();
    applyPress(s, CATEGORY_DIM_ID, "things");
    applyCustomFact(s, "kind", "creature");
    expect(s.customFacts.map((f) => f.value)).toEqual(["creature"]);
    // A registry press for the same dimension supersedes the ad-hoc custom fact.
    applyPress(s, "things.kind", "animal");
    expect(s.customFacts.map((f) => f.value)).toEqual([]);
  });

  it("applyCustomFact replaces a prior customFact for the same dimension", () => {
    const s = createState();
    applyPress(s, CATEGORY_DIM_ID, "things");
    applyCustomFact(s, "size", "big");
    applyCustomFact(s, "size", "small");
    expect(s.customFacts.map((f) => f.value)).toEqual(["small"]);
  });

  it("applyCustomFact clears a matching rejectedFact for the same dimension", () => {
    const s = createState();
    applyPress(s, CATEGORY_DIM_ID, "things");
    applyCustomFact(s, "shape", "round");
    rejectMostRecentFact(s);
    expect(s.rejectedFacts.some((f) => f.dimension === "shape")).toBe(true);
    // User changes mind via a new custom fact for the same dimension.
    applyCustomFact(s, "shape", "long");
    expect(s.rejectedFacts.some((f) => f.dimension === "shape")).toBe(false);
    expect(s.customFacts.map((f) => f.value)).toEqual(["long"]);
  });

  it("rejectCurrentDimension does NOT push the dimension into rejectedFacts", () => {
    // Regression: prior behavior of routing the 'no' press through
    // rejectMostRecentFact pushed `where_found=far_away` to BOTH
    // customFacts/Known AND rejectedFacts — a contradiction the AI
    // can't reconcile. The 'no' press now goes through
    // rejectCurrentDimension, which dismisses without adding a fact.
    const s = createState();
    applyPress(s, CATEGORY_DIM_ID, "things");
    // Force the next dim to be things.kind by suggesting & confirming the press;
    // then a 'no' on the NEXT batch should not retroactively mark kind=animal
    // as rejected.
    applyPress(s, "things.kind", "animal");
    rejectCurrentDimension(s);
    expect(s.rejectedFacts).toHaveLength(0);
    // The user's earlier positive ("animal") stays as Known.
    const inj = buildStateInjection(s);
    expect(inj.text).toMatch(/Known:.*kind=animal/);
    expect(inj.text).not.toMatch(/Rejected.*kind=animal/);
  });
});
