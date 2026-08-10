// THE STREET SPEAKS THE WIDER WORLD (nations P6) — the ship gate for
// "from the street, a student can SEE and SAY each running macro event":
//
//   SAY — every macro-event line renders as a real sentence in EVERY
//         shipped ruleset (en/he/es/pt), at every syntax level, with no
//         raw English glyph leaking into a non-English locale.
//   SEE — a blockade thins the shelf that produces the remark, through
//         the same multiplicative damping that already models an absent
//         farmer (`inboundRouteHealth`).
//
// The leak guard is the load-bearing test here: `we`/`they`/`fight`/
// `town`/`area` shipped in P2/⑤ lines while absent from PRONOUNS, POS and
// every lexeme table, so the flagship taboo refusal rendered as
// "we לא fight" for a Hebrew student and "The they doesn't give the food."
// in English. Nothing caught it because nothing asserted across locales.

import { describe, it, expect } from "@jest/globals";
import { translateGlyph } from "@shared/world-engine/interaction/lang/index.js";
import { tabooRefusalLine } from "@shared/world-engine/interaction/dialogue/law-lines.js";
import { barterRefusalLine } from "@shared/world-engine/interaction/dialogue/barter-lines.js";
import {
  embargoRemarkLine, unionLine, warLine, tributeLine, tidingLine,
} from "@shared/world-engine/interaction/dialogue/tiding-lines.js";
import { inboundRouteHealth } from "@shared/world-engine/kernel/town/barter.js";
import type { TransferAgreement } from "@shared/world-engine/kernel/town/transfer.js";
import type { SyntaxLevel } from "@shared/world-engine/interaction/dialogue/dialogue-gen.js";

/** The rulesets that actually render (lang/index.ts: the other seven app
 *  locales fall back to English BY DESIGN — elision/case/SOV/classifier
 *  systems are not minimal modifications of these four). */
const LOCALES = ["en", "es", "he", "pt"] as const;
const LEVELS: SyntaxLevel[] = ["a", "b", "c"];

/** Every glyph word the political lines are built from. If one of these
 *  ever appears VERBATIM inside a non-English rendering, that word has no
 *  lexeme in that ruleset and the student is being shown English. */
const POLITICAL_GLYPHS = ["we", "they", "fight", "town", "area", "give", "food", "trade"];

const leaks = (text: string): string[] =>
  POLITICAL_GLYPHS.filter(w => new RegExp(`(^|[^\\p{L}])${w}([^\\p{L}]|$)`, "iu").test(text));

describe("the political voice renders in every shipped ruleset", () => {
  it("the taboo refusal is a real sentence in all four — the P2 flagship line", () => {
    const glyph = tabooRefusalLine("fight").c;
    expect(glyph).toBe("we + fight.not");
    expect(translateGlyph(glyph, "en")).toBe("We don't fight.");
    expect(translateGlyph(glyph, "es")).toBe("No luchamos.");
    expect(translateGlyph(glyph, "pt")).toBe("Nós não lutamos.");
    expect(translateGlyph(glyph, "he")).toBe("אנחנו לא נלחמים.");
  });

  it("the partner's honest refusals speak in all four — the ⑤ barter lines", () => {
    const wontPart = barterRefusalLine("wont-part", "wood", "food").c;
    expect(translateGlyph(wontPart, "en")).toBe("They don't give the food.");
    expect(translateGlyph(wontPart, "es")).toBe("No dan la comida.");
    expect(translateGlyph(wontPart, "pt")).toBe("Eles não dão a comida.");
    expect(translateGlyph(wontPart, "he")).toBe("הם לא נותנים את האוכל.");
  });

  it("🚨 OUR OWN refusal speaks in all four too (economy-arc G1's mirror)", () => {
    // A famine on the give-good refuses from THIS side now, and a sentence
    // that cannot be said is not legible (P6): the mirror is the partner's
    // own verb with our own subject, so every shipped ruleset already has it.
    const weWont = barterRefusalLine("we-wont-part", "wood", "food").c;
    expect(weWont).toBe("we + give.not + wood");
    expect(translateGlyph(weWont, "en")).toBe("We don't give the wood.");
    for (const locale of ["es", "pt", "he"]) {
      const text = translateGlyph(weWont, locale);
      expect({ locale, leaked: leaks(text) }).toEqual({ locale, leaked: [] });
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it("no political glyph leaks untranslated into a non-English locale", () => {
    const lines = [
      tabooRefusalLine("fight"),
      barterRefusalLine("wont-part", "wood", "food"),
      barterRefusalLine("we-wont-part", "wood", "food"),
      embargoRemarkLine("food"),
      unionLine("food"),
      warLine("food"),
      tributeLine("food"),
    ];
    for (const line of lines) {
      for (const level of LEVELS) {
        for (const locale of ["es", "he", "pt"]) {
          const text = translateGlyph(line[level], locale);
          expect({ locale, glyph: line[level], text, leaked: leaks(text) })
            .toEqual({ locale, glyph: line[level], text, leaked: [] });
        }
      }
    }
  });

  it("every level of every tiding renders as a non-empty, glyph-free string", () => {
    for (const kind of ["blockade", "union", "war", "tribute"] as const) {
      const line = tidingLine(kind, "food");
      for (const level of LEVELS) {
        for (const locale of LOCALES) {
          const text = translateGlyph(line[level], locale);
          expect(text.length).toBeGreaterThan(0);
          expect(text).not.toContain("+"); // an unrendered glyph string
        }
      }
    }
  });
});

describe("macro events carry their CAUSE (law #6 — visible causation)", () => {
  it("embargo and union are the SAME frame with one word flipped", () => {
    expect(embargoRemarkLine("food").c).toBe("less + food + because + they + give.not + food");
    expect(unionLine("food").c).toBe("more + food + because + they + give + food");
    expect(translateGlyph(embargoRemarkLine("food").c, "en"))
      .toBe("less food because they don't give the food.");
    expect(translateGlyph(unionLine("food").c, "en"))
      .toBe("more food because they give the food.");
  });

  it("the middle level keeps its SUBJECT — never an inverted request", () => {
    // A subject-less "give + food" is the REQUEST frame ("Give me the
    // food."), the exact inverse of tribute; a subject-less negated verb
    // renders first-person ("Because I won't give you the food").
    expect(translateGlyph(tributeLine("food").b, "en")).toBe("We give the food.");
    expect(translateGlyph(embargoRemarkLine("food").b, "en"))
      .toBe("Because they don't give the food.");
  });

  it("tribute states its DIRECTION — the shipped standing pull flows inward", () => {
    // "bring + food + from + Riverside" creates a daily pull TOWARD us, so
    // its spoken confirmation must be "they give", never "we give".
    expect(translateGlyph(tributeLine("food", "in").c, "en")).toBe("They give the food.");
    expect(translateGlyph(tributeLine("food", "out").c, "en")).toBe("We give the food.");
    for (const locale of ["es", "he", "pt"]) {
      expect(leaks(translateGlyph(tributeLine("food", "in").c, locale))).toEqual([]);
    }
  });

  it("level a never puts the forbidden verb in a child's mouth as a command", () => {
    // "fight" alone renders as an imperative in every language. The system
    // exists to make that verb uncommandable — so the war tiding's simplest
    // level is the FACT (the good), never the verb.
    expect(warLine("food").a).toBe("food");
    for (const locale of LOCALES) {
      expect(translateGlyph(warLine("food").a, locale).toLowerCase()).not.toContain("fight");
    }
  });
});

describe("a blockade thins the shelf (the SEE half)", () => {
  const route = (takeGood: string, suspended: boolean, status: TransferAgreement["status"] = "pending"): TransferAgreement => ({
    id: `t-${takeGood}-${suspended}-${status}`,
    from: "a", to: "b", goods: { wood: 3 }, status,
    barter: {
      giveGood: "wood", takeGood, quote: { give: 3, take: 2 },
      partnerKey: "riverside", suspended,
    },
  } as TransferAgreement);

  it("no inbound route ⇒ full shelf: an unconnected village cannot be embargoed", () => {
    expect(inboundRouteHealth([], "food")).toBe(1);
    expect(inboundRouteHealth([route("metal", true)], "food")).toBe(1);
  });

  it("the shelf thins by the SHARE of paused routes, and empties when all stop", () => {
    expect(inboundRouteHealth([route("food", false)], "food")).toBe(1);
    expect(inboundRouteHealth([route("food", true)], "food")).toBe(0);
    expect(inboundRouteHealth(
      [route("food", true), route("food", false)], "food",
    )).toBe(0.5);
  });

  it("settled history doesn't count — only routes that could still run", () => {
    expect(inboundRouteHealth(
      [route("food", true, "done"), route("food", false)], "food",
    )).toBe(1);
    expect(inboundRouteHealth([route("food", true, "failed")], "food")).toBe(1);
  });
});
