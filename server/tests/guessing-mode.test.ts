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
  dismissDimension,
  flagExpand,
  rejectCurrentDimension,
  suggestNextDimension,
  isConfident,
  isDominant,
  dominantValue,
  readyForGuesses,
  buildStateInjection,
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
} from "../services/dual-agent/interactive-agent";

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

  it("'None of these' dismisses the current dimension and asks a different one", () => {
    const s = createState();
    applyPress(s, CATEGORY_DIM_ID, "things");
    const before = suggestNextDimension(s).def!;
    expect(before.id).toBe("things.kind");
    rejectCurrentDimension(s);
    // kind is now dismissed → a different dimension is suggested
    const after = suggestNextDimension(s).def;
    expect(after?.id).not.toBe("things.kind");
    expect(s.justRejected).toBe(true);
    // injection tells the AI not to re-offer the rejected options
    expect(buildStateInjection(s).text).toMatch(/none of these/i);
    // a real press clears the rejected flag
    if (after) applyPress(s, after.id, after.values[0]);
    expect(s.justRejected).toBe(false);
  });

  it("'More' re-asks the most recently pressed dimension", () => {
    const s = createState();
    applyPress(s, CATEGORY_DIM_ID, "things");
    applyPress(s, "things.kind", "animal");
    flagExpand(s);
    expect(suggestNextDimension(s).def?.id).toBe("things.kind");
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
});
