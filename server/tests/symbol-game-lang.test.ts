// Glyph-sentence translation rulesets (shared/symbol-game/lang) — every
// sentence shape the dialogue layer emits, rendered as PROPER language.
//
// English + Hebrew are covered shape-by-shape; Spanish/Portuguese (one shared
// romance ruleset) get representative spot checks. Unknown symbols must
// degrade to a lexicon gloss in glyph order — never crash.
//
// Pure logic — no DB / LLM / GL — safe in `npm test`.

import { describe, it, expect } from "@jest/globals";
import { speakerGender, translateGlyph } from "@shared/symbol-game/lang/index.js";

const en = (g: string, o?: Parameters<typeof translateGlyph>[2]) => translateGlyph(g, "en", o);
const he = (g: string, o?: Parameters<typeof translateGlyph>[2]) => translateGlyph(g, "he-IL", o);
const es = (g: string, o?: Parameters<typeof translateGlyph>[2]) => translateGlyph(g, "es", o);
const pt = (g: string, o?: Parameters<typeof translateGlyph>[2]) => translateGlyph(g, "pt-BR", o);

describe("English — wants, gives, possession", () => {
  it("states a want with an indefinite article", () => {
    expect(en("i_me + want + apple")).toBe("I want an apple.");
    expect(en("i_me + want + ball.big")).toBe("I want a big ball.");
    expect(en("want + apple")).toBe("Want an apple.");
    expect(en("apple")).toBe("apple");
    expect(en("ball.big")).toBe("big ball");
  });
  it("declines with a definite article", () => {
    expect(en("i_me + want.not + sock")).toBe("I don't want the sock.");
    expect(en("want.not + sock")).toBe("I don't want the sock.");
  });
  it("renders requests as imperatives (dative shift for pronouns)", () => {
    expect(en("you + give + apple + to + i_me")).toBe("Give me the apple.");
    expect(en("give + apple")).toBe("Give me the apple.");
    expect(en("you + give + ball + to + bear")).toBe("Give the ball to the bear.");
    expect(en("you + give + apple + to + you")).toBe("The apple is for you!");
  });
  it("renders offers and refusals in first person, directed at the listener", () => {
    expect(en("i_me + give + ball")).toBe("I'll give you the ball.");
    expect(en("i_me + give.not + ball")).toBe("I won't give you the ball.");
    expect(en("give.not + ball")).toBe("I won't give you the ball.");
  });
  it("reads subject-less glyphs by PERSPECTIVE: NPC ask vs player offer", () => {
    // The same glyph, two directions: the NPC requests, the player offers.
    expect(en("give + ball")).toBe("Give me the ball.");
    expect(en("give + ball", { firstPerson: true })).toBe("I'll give you the ball.");
    expect(en("want + apple", { firstPerson: true })).toBe("I want an apple.");
    expect(he("give + apple", { firstPerson: true })).toBe("אני נותן לך את התפוח.");
    expect(he("give + apple", { firstPerson: true, speaker: "f" })).toBe("אני נותנת לך את התפוח.");
    expect(es("give + apple", { firstPerson: true })).toBe("Te doy la manzana.");
    expect(pt("give + apple", { firstPerson: true })).toBe("Eu te dou a maçã.");
  });
  it("conjugates possession by person and number", () => {
    expect(en("i_me + have + ball")).toBe("I have the ball.");
    expect(en("i_me + have.not + apple")).toBe("I don't have the apple.");
    expect(en("have.not + sock")).toBe("I don't have the sock.");
    expect(en("bear + have + ball")).toBe("The bear has the ball.");
    expect(en("you + have + ball")).toBe("You have the ball.");
  });
  it("reads an unknown-holder clue as a locative", () => {
    expect(en("there + have + ball")).toBe("The ball is over there.");
  });
});

describe("English — questions, states, fragments", () => {
  it("builds where-questions with number agreement", () => {
    expect(en("place#question")).toBe("Where?");
    expect(en("place#question + ball")).toBe("Where is the ball?");
    expect(en("place#question + blocks")).toBe("Where are the blocks?");
    expect(en("place#question + get + ball")).toBe("Where do I get the ball?");
  });
  it("builds the vendor greeting", () => {
    expect(en("want + thing#question")).toBe("What do you want?");
    expect(en("you + want + thing#question")).toBe("What do you want?");
  });
  it("handles copulas, moods, and fixed phrases", () => {
    expect(en("i_me + sad")).toBe("I'm sad.");
    expect(en("you + ok#question")).toBe("Are you okay?");
    expect(en("ok#question")).toBe("Are you okay?");
    expect(en("i_me + think.not")).toBe("I don't know.");
    expect(en("i_me + help + you")).toBe("I'll help you.");
    expect(en("i_me + help.not + you")).toBe("I won't help you.");
  });
  it("handles clue/locative/possessive/corrective shapes", () => {
    expect(en("ball + here")).toBe("The ball is here.");
    expect(en("no + cookie.my")).toBe("No — my cookie!");
    expect(en("cookie.my")).toBe("my cookie");
    expect(en("apple + hot.not")).toBe("The apple isn't hot.");
    expect(en("hot.not")).toBe("Not hot.");
  });
  it("pluralizes MORE-quantified count nouns", () => {
    expect(en("i_me + want + more + cookie")).toBe("I want more cookies.");
    expect(en("want + more + apple")).toBe("Want more apples.");
    expect(en("more + teddy")).toBe("more teddies");
  });
  it("renders trade shapes and placement fragments", () => {
    expect(en("trade + thing#question")).toBe("Trade for what?");
    expect(en("trade + ball")).toBe("Trade for the ball?");
    expect(en("cookie + for + ball")).toBe("The cookie for the ball?");
    expect(en("apple + in + box")).toBe("The apple is in the box.");
    expect(en("apple + to + bear")).toBe("The apple — to the bear.");
    expect(en("apple + to + you")).toBe("The apple is for you!");
  });
  it("renders placement wants with both complements", () => {
    expect(en("i_me + want + apple + in + box")).toBe("I want the apple in the box.");
  });
  it("renders building location clues ('in the blue house') in every ruleset", () => {
    expect(en("ball + in + home.color_blue")).toBe("The ball is in the blue house.");
    expect(en("home.color_blue")).toBe("blue house"); // level-a bare place
    expect(he("ball + in + home.color_blue")).toBe("הכדור בבית הכחול.");
    expect(es("ball + in + home.color_blue")).toBe("La pelota está en la casa azul.");
    expect(pt("ball + in + home.color_blue")).toBe("A bola está na casa azul.");
  });

  it("glosses unknown symbols instead of crashing", () => {
    expect(en("i_me + wiggle + banana")).toBe("I wiggle banana");
  });
});

describe("Hebrew — constructions and agreement", () => {
  it("states wants (indefinite, no את)", () => {
    expect(he("i_me + want + apple")).toBe("אני רוצה תפוח.");
    expect(he("i_me + want + ball.big")).toBe("אני רוצה כדור גדול.");
    expect(he("want + more + apple")).toBe("רוצה עוד תפוח.");
  });
  it("declines with definite object + את", () => {
    expect(he("i_me + want.not + sock")).toBe("אני לא רוצה את הגרב.");
  });
  it("uses the יש/אין ל־ possession construction", () => {
    expect(he("i_me + have + ball")).toBe("יש לי כדור.");
    expect(he("i_me + have.not + apple")).toBe("אין לי תפוח.");
    expect(he("have.not + sock")).toBe("אין לי גרב.");
    expect(he("bear + have + ball")).toBe("לדוב יש כדור.");
    expect(he("bear + have + ball.big")).toBe("לדוב יש כדור גדול.");
    expect(he("you + have + ball")).toBe("יש לך כדור.");
  });
  it("renders requests as gendered imperatives", () => {
    expect(he("you + give + apple + to + i_me")).toBe("תן לי את התפוח.");
    expect(he("you + give + apple + to + i_me", { addressee: "f" })).toBe("תני לי את התפוח.");
    expect(he("give + apple")).toBe("תן לי את התפוח.");
    expect(he("you + give + ball + to + bear")).toBe("תן את הכדור לדוב.");
    expect(he("you + give + apple + to + you")).toBe("התפוח בשבילך!");
  });
  it("conjugates the speaker's gender (a frog gives feminine)", () => {
    expect(speakerGender("frog", "he")).toBe("f");
    expect(speakerGender("bear", "he")).toBe("m");
    expect(he("i_me + give + ball")).toBe("אני נותן לך את הכדור.");
    expect(he("i_me + give + ball", { speaker: "f" })).toBe("אני נותנת לך את הכדור.");
    expect(he("i_me + sad")).toBe("אני עצוב.");
    expect(he("i_me + sad", { speaker: "f" })).toBe("אני עצובה.");
    expect(he("i_me + think.not", { speaker: "f" })).toBe("אני לא יודעת.");
  });
  it("agrees adjectives with noun gender, number, definiteness", () => {
    expect(he("apple + hot.not")).toBe("התפוח לא חם.");
    expect(he("cookie + hot.not")).toBe("העוגייה לא חמה.");
    expect(he("blocks + big.not")).toBe("הקוביות לא גדולות.");
    expect(he("i_me + want + apple.hot + in + box")).toBe("אני רוצה את התפוח החם בקופסה.");
  });
  it("builds questions and clue shapes", () => {
    expect(he("place#question + ball")).toBe("איפה הכדור?");
    expect(he("place#question + get + ball")).toBe("איפה אפשר להשיג את הכדור?");
    expect(he("want + thing#question")).toBe("מה אתה רוצה?");
    expect(he("want + thing#question", { addressee: "f" })).toBe("מה את רוצה?");
    expect(he("you + ok#question", { addressee: "f" })).toBe("את בסדר?");
    expect(he("ball + here")).toBe("הכדור כאן.");
    expect(he("there + have + ball")).toBe("הכדור שם.");
    expect(he("no + cookie.my")).toBe("לא — העוגייה שלי!");
    expect(he("apple + in + box")).toBe("התפוח בקופסה.");
    expect(he("apple + to + bear")).toBe("התפוח לדוב.");
  });
  it("renders trade shapes", () => {
    expect(he("trade + thing#question")).toBe("להחליף תמורת מה?");
    expect(he("cookie + for + ball")).toBe("העוגייה תמורת הכדור?");
  });
});

describe("Spanish + Portuguese (shared romance ruleset) — spot checks", () => {
  it("Spanish: pro-drop, articles, contractions, ser/estar", () => {
    expect(es("i_me + want + apple")).toBe("Quiero una manzana.");
    expect(es("bear + have + ball")).toBe("El oso tiene la pelota.");
    expect(es("you + give + apple + to + i_me")).toBe("Dame la manzana.");
    expect(es("you + give + ball + to + bear")).toBe("Dale la pelota al oso.");
    expect(es("place#question + ball")).toBe("¿Dónde está la pelota?");
    expect(es("apple + hot.not")).toBe("La manzana no está caliente.");
    expect(es("ball + big.not")).toBe("La pelota no es grande.");
    expect(es("i_me + sad")).toBe("Estoy triste.");
    expect(es("i_me + think.not")).toBe("No sé.");
    expect(es("want + thing#question")).toBe("¿Qué quieres?");
  });
  it("Portuguese: você-as-3rd, na/pela contractions, gendered thanks", () => {
    expect(pt("i_me + want + apple")).toBe("Eu quero uma maçã.");
    expect(pt("bear + have + ball")).toBe("O urso tem a bola.");
    expect(pt("you + give + apple + to + i_me")).toBe("Me dá a maçã.");
    expect(pt("place#question + ball")).toBe("Onde está a bola?");
    expect(pt("i_me + want + apple + in + box")).toBe("Eu quero a maçã na caixa.");
    expect(pt("cookie + for + ball")).toBe("O biscoito pela bola?");
    expect(pt("thank_you", { speaker: "f" })).toBe("Obrigada!");
    expect(pt("want + thing#question")).toBe("O que você quer?");
  });
});

describe("locale resolution", () => {
  it("resolves regions and falls back to English", () => {
    expect(translateGlyph("i_me + want + apple", "he-IL")).toBe("אני רוצה תפוח.");
    expect(translateGlyph("i_me + want + apple", "fr")).toBe("I want an apple.");
    expect(translateGlyph("i_me + want + apple", undefined)).toBe("I want an apple.");
  });
  it("passes plain prose through untouched (non-glyph prompts)", () => {
    expect(translateGlyph("Which fruit is red?", "he")).toBe("Which fruit is red?");
    expect(translateGlyph("Bring it home. Then rest.", "en")).toBe("Bring it home. Then rest.");
    expect(translateGlyph("ball.big", "he")).toBe("כדור גדול"); // still a glyph
  });
});
