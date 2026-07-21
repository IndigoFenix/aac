// RESPONSE SEMANTICS (city-expansion phase ①a §1): "okay" is RESERVED for
// confirming an accepted order — never a generic acknowledgment. Pins the
// fallback matrix over the dialogue layer's reply paths:
//   • how-are-you = a THIN emotional-state report (worst pressing need first,
//     else the simple positive state), never "ok";
//   • cant / bye / tell replies lost their generic "ok";
//   • the explicit terminal fallback line "i_me + understand.not" renders in
//     all four lang rulesets (the shared game lang layer, not client i18n).
// Pure logic — safe in `npm test`.

import { describe, it, expect } from "@jest/globals";
import { createCreatureWorld, seeItem } from "@shared/world-engine/interaction/behavior/creatures.js";
import {
  selectAct,
  type DialogueAct,
  type ProjectionOpts,
} from "@shared/world-engine/interaction/dialogue/creature-dialogue.js";
import { translateGlyph } from "@shared/world-engine/interaction/lang/index.js";
import { CANT_HERE, WHO_DO_YOU_MEAN } from "@shared/world-engine/interaction/dialogue/host-lines.js";

const opts = (world: ReturnType<typeof createCreatureWorld>): ProjectionOpts => ({
  symbolOf: (id) => world.items[id]?.kind ?? id,
});

const act = (kind: DialogueAct["kind"], extra?: Partial<DialogueAct>): DialogueAct => ({
  kind,
  glyph: "",
  ...extra,
});

describe("how-are-you — a thin emotional-state report (worst problem first)", () => {
  it("a conditioned creature reports its condition ('I am hungry')", () => {
    const w = createCreatureWorld(
      [{ id: "bear", condition: "hungry", needs: [{ itemId: "f1", value: 3, target: { category: "food" } }] }, { id: "me" }],
      [],
    );
    expect(selectAct(w, "bear", "me", act("how-are-you"), "b", opts(w)).responseGlyph).toContain("hungry");
  });

  it("a wanting creature states its want", () => {
    const w = createCreatureWorld(
      [{ id: "bear", needs: [{ itemId: "f1", value: 3, target: { category: "food" } }] }, { id: "me" }],
      [],
    );
    expect(selectAct(w, "bear", "me", act("how-are-you"), "b", opts(w)).responseGlyph).toContain("food");
  });

  it("a problem-free creature reports the simple positive state, not 'ok'", () => {
    const w = createCreatureWorld([{ id: "bear" }, { id: "me" }], []);
    const res = selectAct(w, "bear", "me", act("how-are-you"), "b", opts(w));
    expect(res.responseGlyph).toBe("i_me + happy");
    expect(translateGlyph("i_me + happy", "en")).toBe("I'm happy.");
  });
});

describe("'okay' is reserved — no reply path uses it as a generic acknowledgment", () => {
  it("cant / bye / tell / how-are-you never answer 'ok'", () => {
    const w = createCreatureWorld(
      [{ id: "bear", needs: [{ itemId: "c1", value: 3 }] }, { id: "me" }],
      [{ id: "c1", kind: "cookie" }, { id: "s1", ownerId: "me", kind: "sock" }],
    );
    seeItem(w, "me", "s1", { kind: "held", by: "me" });
    const probes: DialogueAct[] = [
      act("cant", { itemId: "c1" }),
      act("bye"),
      act("tell", { itemId: "s1" }),
      act("how-are-you"),
    ];
    for (const a of probes) {
      const res = selectAct(w, "bear", "me", a, "b", opts(w), {});
      expect(res.responseGlyph).toBeDefined(); // explicit, never silent
      expect(res.responseGlyph).not.toBe("ok");
    }
  });

  it("cant parts calmly (goodbye + close), distinct from the refusal's sad", () => {
    const w = createCreatureWorld(
      [{ id: "bear", needs: [{ itemId: "c1", value: 3 }] }, { id: "me" }],
      [{ id: "c1", kind: "cookie" }],
    );
    const cant = selectAct(w, "bear", "me", act("cant", { itemId: "c1" }), "b", opts(w));
    expect(cant).toMatchObject({ responseGlyph: "goodbye", close: true });
    const refuse = selectAct(w, "bear", "me", act("refuse", { itemId: "c1" }), "b", opts(w));
    expect(refuse.responseGlyph).toBe("i_me + sad");
  });

  it("a farewell is returned in kind", () => {
    const w = createCreatureWorld([{ id: "bear" }, { id: "me" }], []);
    expect(selectAct(w, "bear", "me", act("bye"), "b", opts(w))).toMatchObject({
      responseGlyph: "goodbye",
      close: true,
    });
  });

  it("a told fact is THANKED (and still spreads into knowledge)", () => {
    const w = createCreatureWorld(
      [{ id: "me" }, { id: "bear" }],
      [{ id: "c1", ownerId: "fox", kind: "cookie" }],
    );
    seeItem(w, "me", "c1", { kind: "held", by: "fox" });
    const res = selectAct(w, "bear", "me", act("tell", { itemId: "c1" }), "c", opts(w));
    expect(res.responseGlyph).toBe("thank_you");
    expect(w.creatures.bear!.knowledge.c1).toEqual({ kind: "held", by: "fox" });
  });
});

describe("the explicit terminal fallback — 'I don't understand' in every ruleset", () => {
  const LINE = "i_me + understand.not";
  it("renders properly in en / he / es / pt (lang layer, not client i18n)", () => {
    expect(translateGlyph(LINE, "en")).toBe("I don't understand.");
    expect(translateGlyph(LINE, "he")).toBe("אני לא מבין.");
    expect(translateGlyph(LINE, "he", { speaker: "f" })).toBe("אני לא מבינה.");
    expect(translateGlyph(LINE, "es")).toBe("No entiendo.");
    expect(translateGlyph(LINE, "pt")).toBe("Eu não entendo.");
  });
});

// "why?" must never be answered with SILENCE (outstanding-bugs-family-mode:
// "asking why reveals no answer"). Every other act branch has an honest floor;
// the why branch was the one that returned no responseGlyph at all, so the
// presenter fell back to re-speaking the creature's idle line.
describe("why - an honest floor, never silence", () => {
  it("a creature with a CONDITION explains itself from it", () => {
    const w = createCreatureWorld([{ id: "bear", condition: "scruffy" }, { id: "me" }], []);
    const res = selectAct(w, "bear", "me", act("why"), "b", opts(w));
    expect(res.responseGlyph).toContain("scruffy");
  });

  it("nothing to explain -> 'I do not know', NOT an empty response", () => {
    const w = createCreatureWorld([{ id: "bear" }, { id: "me" }], []);
    const res = selectAct(w, "bear", "me", act("why"), "b", opts(w));
    expect(res.responseGlyph).toBeDefined();
    expect(res.responseGlyph).toContain("think.not");
  });

  it("the scruffy condition renders in every ruleset (the dress motive's answer)", () => {
    for (const loc of ["en", "he", "es", "pt"]) {
      expect(translateGlyph("i_me + scruffy", loc).length).toBeGreaterThan(0);
    }
    expect(translateGlyph("i_me + scruffy", "en")).toBe("I'm scruffy.");
  });
});

// HOST VERDICTS SPEAK (outstanding-bugs-family-mode: "no direct question
// should produce UI messages alone"). The host's refusals used to be English
// DOM banners; they are glyph lines now, so they MUST render in every ruleset
// — a line built from a word no ruleset knows comes out as glyph soup in the
// child's ear, which is worse than the banner it replaced.
describe("host-lines - every host verdict renders as real speech", () => {
  const LINES = { CANT_HERE, WHO_DO_YOU_MEAN };
  for (const [name, line] of Object.entries(LINES)) {
    for (const level of ["a", "b", "c"] as const) {
      it(`${name}[${level}] renders in en/he/es/pt`, () => {
        const glyph = line[level];
        expect(glyph.length).toBeGreaterThan(0);
        for (const loc of ["en", "he", "es", "pt"]) {
          const said = translateGlyph(glyph, loc);
          expect(said.length).toBeGreaterThan(0);
          // Glyph soup detector: an unrendered token keeps its raw markers.
          expect(said).not.toContain("+");
          expect(said).not.toContain("_");
          expect(said).not.toContain(".not");
        }
      });
    }
  }

  it("CANT_HERE says WHY (the place), not just 'no'", () => {
    expect(translateGlyph(CANT_HERE.b, "en")).toBe("The place isn't good.");
  });
});
