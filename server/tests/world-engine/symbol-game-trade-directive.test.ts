// THE TRADE DIRECTIVE (city-expansion ⑤) — the player surface at the pure
// layer: `trade` is a LEXICON verb ("trade wood with the city"), the frame
// keeps EVERY relation-marked argument (the additive `bound` slot — "trade
// wood FOR food WITH hamlet" loses nothing), intent-compile lands the
// host-routed {kind:"trade"} goal, and the clerk's confirmation SPEAKS THE
// TERMS ("ok — three wood for two food") with refusals named in the honest
// vocabulary. No DOM / GL.

import { describe, it, expect } from "@jest/globals";
import { LEXICON, parseSentence } from "@shared/world-engine/interaction/intent/parse-intent.js";
import { compileIntent, defaultBinder } from "@shared/world-engine/interaction/intent/intent-compile.js";
import {
  barterHasEnoughLine,
  barterRefusalLine,
  barterTermsLine,
  barterWontPartLine,
  quantityGlyph,
} from "@shared/world-engine/interaction/dialogue/barter-lines.js";
import { goalIntentLine, type IntentLineSyms } from "@shared/world-engine/interaction/dialogue/intent-lines.js";
import type { GoalSpec } from "@shared/world-engine/interaction/behavior/rules.js";

const compile = (sentence: string) =>
  compileIntent(parseSentence(sentence), defaultBinder({ player: "__player__", listener: "clerk" }), { id: "t" });

const goalOf = (sentence: string): GoalSpec => {
  const c = compile(sentence);
  expect(c.kind).toBe("goal");
  if (c.kind !== "goal") throw new Error("not a goal");
  return c.goal;
};

// ── 1. Lexicon + parse ───────────────────────────────────────────────────────

describe("trade in the LEXICON — a directive verb", () => {
  it("is registered as a directive transfer verb", () => {
    expect(LEXICON.trade).toMatchObject({ cat: "verb", verb: "trade", directive: true });
  });

  it('"trade + wood + with + hamlet" — give from the object, partner with-marked', () => {
    const f = parseSentence("trade + wood + with + hamlet");
    expect(f.kind).toBe("command");
    expect(f.verb).toBe("trade");
    expect(f.object).toMatchObject({ kind: "entity", symbol: "wood" });
    expect(f.bound).toEqual([
      { relation: "with", ref: { kind: "entity", symbol: "hamlet", modifiers: [] } },
    ]);
  });

  it('"trade + wood + for + food + with + hamlet" — the two-argument frame loses NOTHING', () => {
    const f = parseSentence("trade + wood + for + food + with + hamlet");
    expect(f.object).toMatchObject({ symbol: "wood" });
    expect(f.bound).toHaveLength(2);
    expect(f.bound![0]).toMatchObject({ relation: "for", ref: { symbol: "food" } });
    expect(f.bound![1]).toMatchObject({ relation: "with", ref: { symbol: "hamlet" } });
  });

  it("keeps the spoken quantity on the frame ('trade + all + wood' → a standing route)", () => {
    expect(parseSentence("trade + all + wood + with + city").quantity).toBe("all");
    expect(parseSentence("trade + three + wood").quantity).toBe("three");
  });
});

// ── 2. Compile — the host-routed goal ───────────────────────────────────────

describe("intent-compile — {kind:'trade'} rides give/take/partner", () => {
  it("full frame: give + take + partner", () => {
    expect(goalOf("trade + wood + for + food + with + hamlet")).toEqual({
      kind: "trade",
      give: "wood",
      take: "food",
      partner: "hamlet",
    });
  });

  it("partner only — the take-good stays null (the host defaults it and SAYS it)", () => {
    expect(goalOf("trade + wood + with + city")).toEqual({
      kind: "trade",
      give: "wood",
      take: null,
      partner: "city",
    });
  });

  it("bare give — partner AND take null (the bound partner answers)", () => {
    expect(goalOf("trade + wood")).toEqual({ kind: "trade", give: "wood", take: null, partner: null });
  });

  it("a bare 'trade' stays unbound — the explicit not-understood, never a guess", () => {
    expect(compile("trade").kind).toBe("unbound");
  });

  it("word order stays free — 'wood + trade + with + hamlet' parses the same", () => {
    expect(goalOf("wood + trade + with + hamlet")).toMatchObject({ kind: "trade", give: "wood", partner: "hamlet" });
  });

  it("the goal is host-routed: no intent line (the TERMS are the clerk's, host-side)", () => {
    const syms: IntentLineSyms = {
      item: () => "thing",
      place: () => "there",
      creature: (id) => id,
    };
    expect(goalIntentLine({ kind: "trade", give: "wood", take: null, partner: null }, syms)).toBeNull();
  });
});

// ── 3. The spoken terms + honest refusals ───────────────────────────────────

describe("barter lines — the confirmation speaks the ratio", () => {
  it("quantity glyphs are the exact numeral tokens", () => {
    // The compositor draws a bare digit key as the constructed numeral glyph;
    // the words used to leak untranslated English into every locale.
    expect(quantityGlyph(1)).toBe("1");
    expect(quantityGlyph(2)).toBe("2");
    expect(quantityGlyph(3)).toBe("3");
  });

  it('the terms line: reserved "ok" at level a; the deal itself at b/c', () => {
    const line = barterTermsLine({ give: 3, take: 2 }, "wood", "food");
    expect(line.a).toBe("ok");
    expect(line.b).toBe("3 + wood + for + 2 + food");
    expect(line.c).toBe("ok + 3 + wood + for + 2 + food");
  });

  it("terms shift with the quote — hearing different numbers IS the lesson", () => {
    expect(barterTermsLine({ give: 1, take: 1 }, "wood", "food").b).toBe(
      "1 + wood + for + 1 + food",
    );
    expect(barterTermsLine({ give: 2, take: 3 }, "wood", "food").b).toBe(
      "2 + wood + for + 3 + food",
    );
  });

  it('"they have enough wood" — the has-enough refusal, named', () => {
    const line = barterHasEnoughLine("wood");
    expect(line.a).toBe("no");
    expect(line.b).toBe("they + have + wood");
    // `more`, not `many` (nations P6): `many` has no POS entry, so a
    // sentence containing it never built a frame and this line fell to the
    // raw gloss fallback in every locale. `more` is the quantifier the
    // engine models (core.ts peels it off as NP.more) and half of the
    // more/less pair the market remarks already speak.
    expect(line.c).toContain("they + have + more + wood");
  });

  it('"they won\'t part with food" — the famine refusal, named', () => {
    const line = barterWontPartLine("food");
    expect(line.a).toBe("no");
    expect(line.b).toBe("give.not + food");
    expect(line.c).toContain("give.not + food");
  });

  it("one dispatcher over the willingness verdict", () => {
    expect(barterRefusalLine("has-enough", "wood", "food").b).toBe("they + have + wood");
    expect(barterRefusalLine("wont-part", "wood", "food").b).toBe("give.not + food");
  });
});
