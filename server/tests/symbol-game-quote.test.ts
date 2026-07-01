// Quote-model unit tests for the symbol-game content layer.
//
// Validates the endpoint-first Quote model (planning-docs/symbol-learning-game-plan.md):
//   • the FREEZE invariant: one binding is shared across a whole exchange, so a
//     slot resolves to the SAME pool member in the prompt and every response;
//   • every bound quote resolves to a glyph SENTENCE that parseGlyph accepts and
//     whose slots come out as expected;
//   • the symbol-resolution worklist (§6.5) correctly separates shipped symbols
//     from intentionally-queued ones, and surfaces ZERO `missing` (authoring
//     errors) across the A-family catalog;
//   • the build-artifact worklist lists exactly the not-yet-shipped symbols.
//
// Pure logic — no DB / LLM / GL — safe in `npm test`.

import { describe, it, expect } from "@jest/globals";
import { parseGlyph } from "@shared/glyph-compositor.js";
import { getVocabularyItem } from "@shared/glyph-registry.js";
import {
  POOLS,
  REQUESTING_EXCHANGES,
  bindExchange,
  bindSlots,
  firstMemberPicker,
  randomMemberPicker,
  resolveBoundSymbols,
  symbolWorklist,
  templateSlots,
  type MemberPicker,
} from "@shared/symbol-game/index.js";

describe("symbol-game quote binder", () => {
  it("every quote's declared `slots` matches its glyph template", () => {
    for (const ex of REQUESTING_EXCHANGES) {
      for (const q of [ex.prompt, ...ex.responses.map((r) => r.quote)]) {
        expect([...q.slots].sort()).toEqual(templateSlots(q.glyph).sort());
      }
    }
  });

  it("binds an exchange under ONE frozen binding (freeze invariant)", () => {
    // A6 shares {toy} between the prompt and the GIVE/TAKE response pair.
    const a6 = REQUESTING_EXCHANGES.find((e) => e.id === "a6-give-or-take")!;
    const bound = bindExchange(a6, POOLS, firstMemberPicker);

    // firstMemberPicker → friend=rabbit, toy=ball (first members of each pool).
    expect(bound.binding.friend!.symbol).toBe("rabbit");
    expect(bound.binding.toy!.symbol).toBe("ball");

    // The SAME {toy} appears in the prompt and in both responses — minimal pair.
    expect(bound.prompt.glyph).toBe("rabbit + have.not + ball");
    const giveGlyphs = bound.responses.map((r) => r.bound.glyph);
    expect(giveGlyphs).toEqual(["give + ball", "take + ball"]);
  });

  it("resolves operators as #-tags and produces parseable sentences", () => {
    const a2 = REQUESTING_EXCHANGES.find((e) => e.id === "a2-want-or-not")!;
    const bound = bindExchange(a2, POOLS, firstMemberPicker);
    expect(bound.prompt.glyph).toBe("want + cookie#question");

    const parsed = parseGlyph(bound.prompt.glyph);
    expect(parsed.toneTags).toContain("question");
    expect(parsed.slots.map((s) => s.key)).toEqual(["want", "cookie"]);
  });

  it("a randomly-bound exchange still keeps one member per slot across all quotes", () => {
    const a6 = REQUESTING_EXCHANGES.find((e) => e.id === "a6-give-or-take")!;
    for (let trial = 0; trial < 25; trial++) {
      const bound = bindExchange(a6, POOLS, randomMemberPicker);
      const toy = bound.binding.toy!.symbol;
      for (const r of bound.responses) {
        expect(parseGlyph(r.bound.glyph).slots.some((s) => s.key === toy)).toBe(true);
      }
    }
  });
});

describe("symbol resolution & worklist (§6.5)", () => {
  // A picker that prefers a QUEUED member when one exists, to exercise the
  // queued path (e.g. toy→blocks, treat→grape).
  const queuedPreferringPicker: MemberPicker = (pool) =>
    pool.members.find((m) => m.glyphStatus === "queued") ?? pool.members[0]!;

  it("flags ZERO missing symbols across the whole A-family (no authoring errors)", () => {
    for (const ex of REQUESTING_EXCHANGES) {
      const bound = bindExchange(ex, POOLS, firstMemberPicker);
      for (const bq of [bound.prompt, ...bound.responses.map((r) => r.bound)]) {
        const res = resolveBoundSymbols(bq);
        expect(res.missing).toEqual([]);
      }
    }
  });

  it("a queued pool member resolves as `queued`, not `missing` or `resolved`", () => {
    const a1 = REQUESTING_EXCHANGES.find((e) => e.id === "a1-want-fetch")!;
    const bound = bindExchange(a1, POOLS, queuedPreferringPicker);
    // treat→grape (queued); i_me + want ship.
    expect(bound.binding.treat!.symbol).toBe("grape");
    const res = resolveBoundSymbols(bound.prompt);
    expect(res.queued).toContain("grape");
    expect(res.resolved).toEqual(expect.arrayContaining(["i_me", "want"]));
    expect(res.missing).toEqual([]);
  });

  it("registry is authoritative: a shipped member is never `queued`", () => {
    const a1 = REQUESTING_EXCHANGES.find((e) => e.id === "a1-want-fetch")!;
    const bound = bindExchange(a1, POOLS, firstMemberPicker); // treat→cookie (ships)
    const res = resolveBoundSymbols(bound.prompt);
    expect(res.resolved).toContain("cookie");
    expect(res.queued).not.toContain("cookie");
  });

  it("worklist lists not-yet-shipped symbols and excludes shipped ones", () => {
    const work = symbolWorklist(POOLS, REQUESTING_EXCHANGES);
    // Declared-queued members that genuinely aren't in the registry:
    expect(work).toEqual(expect.arrayContaining(["grape", "blocks", "bubbles", "broccoli"]));
    // Nothing on the worklist may actually exist in the registry:
    for (const sym of work) expect(getVocabularyItem(sym)).toBeUndefined();
  });
});

describe("bindSlots guards", () => {
  it("throws on an unknown slot pool", () => {
    expect(() => bindSlots(["no_such_pool"], POOLS, firstMemberPicker)).toThrow(/no pool/);
  });
});
