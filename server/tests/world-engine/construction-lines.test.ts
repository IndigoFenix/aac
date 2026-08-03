// WHAT A BUILDING SITE SAYS — the construction data points as glyph sentences
// that RENDER AS THE CLAIM THEY MEAN, in every shipped ruleset.
//
// The bug this pins: a site's material want was announced as "{material} +
// {prep} + {place}", a shape the frame layer already owns as the LOCATIVE
// assertion — so "the kitchen wants a block" came out of the speaker as "The
// block is in the kitchen", which says the exact opposite (it already arrived)
// and which a child has no way to falsify. Every line below is checked in all
// four rulesets, because English alone always LOOKED fine: `baseWord` falls
// back to the raw glyph key, and the glyph keys are English words.
//
// Pure logic — no DB / LLM / GL.

import { describe, expect, it } from "@jest/globals";
import {
  needsMaterialLine,
  noSourceLine,
  structureDoneLine,
  willMakeLine,
} from "@shared/world-engine/interaction/dialogue/construction-lines.js";
import { asIntent, goalIntentLine, type IntentLineSyms } from "@shared/world-engine/interaction/dialogue/intent-lines.js";
import type { GoalSpec } from "@shared/world-engine/interaction/behavior/rules.js";
import { classify, parseSentence, translateGlyph } from "@shared/world-engine/interaction/lang/index.js";
import { TOWN_PLAY_STRUCTURES } from "@shared/world-engine/interaction/town/town-play.js";

const en = (g: string) => translateGlyph(g, "en");
const he = (g: string) => translateGlyph(g, "he-IL");
const es = (g: string) => translateGlyph(g, "es");
const pt = (g: string) => translateGlyph(g, "pt-BR");

/** The frame a glyph line lands in — the parse check behind every rendering. */
const frameOf = (g: string) => classify(parseSentence(g)).kind;

/** No ruleset may fall back to the raw English glyph key: a Latin-script word
 *  inside a Hebrew sentence is the signature of a missing lexeme. */
const noRawKeys = (hebrew: string) => expect(hebrew).not.toMatch(/[A-Za-z]/);

const syms: IntentLineSyms = {
  item: (ref) => ("id" in ref ? ref.id : (ref.match.kind ?? ref.match.category ?? "thing")),
  place: (p) => (p.kind === "named" ? p.id : p.kind === "home" ? "home" : "there"),
  creature: (id) => (id === "__player__" ? "you" : id),
};

describe("the shape a NEED must never take", () => {
  it("'{material} + in + {place}' is the LOCATIVE — it says the block already arrived", () => {
    // This is the reserved reading, and the reason a bill may not borrow the
    // shape. Kept as a pin: if this ever stops being the locative, the
    // construction lines below need re-deciding, not silently re-pointing.
    expect(frameOf("block + in + kitchen")).toBe("pp");
    expect(en("block + in + kitchen")).toBe("The block is in the kitchen.");
  });

  it("a tailed clause keeps its VERB at level b, so no directive degrades into it", () => {
    const put = goalIntentLine(
      { kind: "putIn", item: { match: { kind: "block" } }, container: { kind: "named", id: "kitchen" } },
      syms,
    )!;
    expect(put.b).toBe("put + block + in + kitchen");
    expect(frameOf(put.b)).toBe("svo");
    expect(en(asIntent(put).b)).toBe("I will put the block in the kitchen.");
  });
});

describe("① a place is short of a material", () => {
  const line = needsMaterialLine("kitchen", "block", true);

  it("parses as a want, with the PLACE as subject — the bill belongs to the room", () => {
    expect(line.c).toBe("kitchen + need + more + block");
    expect(frameOf(line.c)).toBe("svo");
    // Level b keeps the subject: "need + block" is an imperative in English and
    // a first-person "I need blocks" in the romance rulesets, and a site's bill
    // is neither.
    expect(line.b).toBe(line.c);
    expect(line.a).toBe("block");
  });

  it("renders as the request in every ruleset", () => {
    expect(en(line.c)).toBe("The kitchen needs more blocks.");
    expect(he(line.c)).toBe("המטבח צריך עוד לבנים.");
    expect(es(line.c)).toBe("La cocina necesita más bloques.");
    expect(pt(line.c)).toBe("A cozinha precisa de mais blocos.");
    noRawKeys(he(line.c));
  });

  it("a single unit drops the quantifier", () => {
    const one = needsMaterialLine("house", "block");
    expect(one.c).toBe("house + need + block");
    expect(en(one.c)).toBe("The house needs the block.");
    expect(he(one.c)).toBe("הבית צריך את הלבנה.");
  });

  it("the same shape carries a room's furniture want and a building's room want", () => {
    expect(en(needsMaterialLine("bedroom", "bed").c)).toBe("The bedroom needs the bed.");
    expect(en(needsMaterialLine("house", "kitchen").c)).toBe("The house needs the kitchen.");
  });
});

describe("② nothing anywhere covers the bill", () => {
  const line = noSourceLine("wood");

  it("is a DIFFERENT claim from the bill — the collective voice, about the town's stock", () => {
    expect(line.c).toBe("we + have.not + wood");
    expect(frameOf(line.c)).toBe("svo");
    expect(line.b).toBe(line.c);
  });

  it("renders bare (mass) in every ruleset — no particular pile is meant", () => {
    expect(en(line.c)).toBe("We don't have wood.");
    expect(he(line.c)).toBe("אין לנו עץ.");
    expect(es(line.c)).toBe("No tenemos madera.");
    expect(pt(line.c)).toBe("Nós não temos madeira.");
    noRawKeys(he(line.c));
  });

  it("covers stone too — the other mass material", () => {
    expect(en(noSourceLine("stone").c)).toBe("We don't have stone.");
    expect(es(noSourceLine("stone").c)).toBe("No tenemos piedra.");
  });
});

describe("③ the mill is covering the gap", () => {
  const line = willMakeLine("block", true);

  it("is a first-person statement of intent", () => {
    expect(line.c).toBe("i_me + make.will + more + block");
    expect(frameOf(line.c)).toBe("svo");
    expect(en(line.c)).toBe("I will make more blocks.");
    expect(he(line.c)).toBe("אני הולך להכין עוד לבנים.");
    expect(es(line.c)).toBe("Voy a hacer más bloques.");
    expect(pt(line.c)).toBe("Eu vou fazer mais blocos.");
    noRawKeys(he(line.c));
  });
});

describe("④ the structure stands", () => {
  it("is the copula over a STATE word, so it agrees everywhere", () => {
    const line = structureDoneLine("house");
    expect(line.c).toBe("house + finished");
    expect(frameOf(line.c)).toBe("copula");
    expect(en(line.c)).toBe("The house is finished.");
    expect(he(line.c)).toBe("הבית מוכן.");
    expect(es(line.c)).toBe("La casa está terminada.");
    expect(pt(line.c)).toBe("A casa está pronta.");
    noRawKeys(he(line.c));
  });

  it("reads the same for a room", () => {
    expect(en(structureDoneLine("kitchen").c)).toBe("The kitchen is finished.");
    expect(es(structureDoneLine("kitchen").c)).toBe("La cocina está terminada.");
  });
});

describe("⑤ the claimed work — the announcements construction posts to the task pool", () => {
  const speak = (goal: GoalSpec) => asIntent(goalIntentLine(goal, syms)!);

  it("a haul to a site CARRIES, never 'puts' hands that are still empty", () => {
    const line = speak({
      kind: "transfer",
      agreementId: "a0",
      goods: { block: 3 },
      to: { kind: "named", id: "house" },
    });
    expect(line.b).toBe("carry.will + block + to + house");
    expect(frameOf(line.b)).toBe("svo");
    expect(en(line.b)).toBe("I will carry the block to the house.");
    expect(he(line.b)).toBe("אני הולך לשאת את הלבנה לבית.");
    expect(es(line.b)).toBe("Voy a llevar el bloque a la casa.");
    expect(pt(line.b)).toBe("Eu vou levar o bloco para a casa.");
    noRawKeys(he(line.b));
  });

  it("a hand-off to a creature stays a GIVE", () => {
    const line = speak({
      kind: "transfer",
      agreementId: "a1",
      goods: { wood: 1 },
      to: { kind: "creature", id: "__player__" },
    });
    expect(line.c).toContain("give");
    expect(en(line.c)).toBe("The wood is for you!");
  });

  it("the site's own verbs: fetch, build, mill-work, craft", () => {
    expect(en(speak({ kind: "fetch", item: { match: { kind: "wood" } } }).b)).toBe("I will get the wood.");
    expect(he(speak({ kind: "fetch", item: { match: { kind: "wood" } } }).b)).toBe("אני הולך להשיג את העץ.");
    expect(es(speak({ kind: "fetch", item: { match: { kind: "wood" } } }).b)).toBe("Voy a conseguir la madera.");

    expect(en(speak({ kind: "build", structure: "house", cap: 1 }).b)).toBe("I will build the house.");
    expect(he(speak({ kind: "build", structure: "house", cap: 1 }).b)).toBe("אני הולך לבנות את הבית.");

    expect(en(speak({ kind: "buildwork", site: "s0" }).b)).toBe("I will build.");
    expect(en(speak({ kind: "craft", glyph: "furn.bed" }).b)).toBe("I will make the bed.");
    expect(pt(speak({ kind: "craft", glyph: "furn.bed" }).b)).toBe("Eu vou fazer a cama.");
  });

  it("a delivered piece names WHERE it goes", () => {
    const line = speak({
      kind: "place",
      item: { match: { kind: "bed" } },
      at: { relation: "beside", anchor: { kind: "named", id: "table" } },
    });
    expect(en(line.b)).toBe("I will put the bed next to the table.");
    expect(he(line.b)).toBe("אני הולך לשים את המיטה ליד השולחן.");
  });
});

describe("the construction vocabulary is drawable in every ruleset", () => {
  // A word with no lexeme renders as its raw English glyph key — invisible in
  // English, and Latin script inside a Hebrew sentence everywhere else. These
  // are every glyph a build order, a bill or a haul destination can name.
  const MATERIALS = ["block", "wood", "stone", "tree"];
  // Every `glyph` in TOWN_PLAY_STRUCTURES — what "build X" can name — plus the
  // builders' yard, which is a haul's destination when no site owns it.
  const STRUCTURES = [
    ...TOWN_PLAY_STRUCTURES.map((s) => s.glyph),
    "yard",
  ];
  // Every value of structure-board's ROOM_GLYPH — what an annex order names.
  const ROOMS = ["home", "bedroom", "bathroom", "kitchen", "room", "store", "workshop"];

  it.each([...MATERIALS, ...STRUCTURES, ...ROOMS])("'%s' has a Hebrew word", (word) => {
    noRawKeys(he(`i_me + want + ${word}`));
  });

  it.each(["build", "make", "bring", "carry", "cut", "get"])("the verb '%s' conjugates", (verb) => {
    for (const speak of [he, es, pt]) {
      const said = speak(`i_me + ${verb}.will + block`);
      expect(said).not.toContain(verb); // never the raw English key
    }
  });
});
