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
    expect(en("want + apple")).toBe("I want an apple."); // subject-less want = first person
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
    expect(en("want + more + apple")).toBe("I want more apples.");
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

describe("motive-driven needs — quality wants, sensations, causes, why", () => {
  it("renders a bare-quality want as 'something {quality}', not a fake noun", () => {
    expect(en("i_me + want + hot")).toBe("I want something hot.");
    expect(en("i_me + have.not + hot")).toBe("I don't have something hot.");
    expect(en("place#question + hot")).toBe("Where is something hot?");
    expect(en("i_me + want + color_red")).toBe("I want something red.");
    expect(he("i_me + want + hot")).toBe("אני רוצה משהו חם.");
    expect(he("place#question + hot")).toBe("איפה משהו חם?");
    expect(es("i_me + want + hot")).toBe("Quiero algo caliente.");
    expect(es("place#question + hot")).toBe("¿Dónde está algo caliente?");
    expect(pt("i_me + want + hot")).toBe("Eu quero algo quente.");
  });

  it("renders hot/cold as EXPERIENTIAL, not a plain copula", () => {
    // English is already experiential-by-copula; the others need their own
    // construction (Hebrew dative, Spanish tener, Portuguese estar com).
    expect(en("i_me + cold")).toBe("I'm cold.");
    expect(he("i_me + cold")).toBe("קר לי.");
    expect(he("i_me + hot")).toBe("חם לי.");
    expect(he("i_me + hot", { speaker: "f" })).toBe("חם לי."); // impersonal — no gender
    expect(es("i_me + cold")).toBe("Tengo frío.");
    expect(es("i_me + hot")).toBe("Tengo calor.");
    expect(pt("i_me + cold")).toBe("Estou com frio.");
    expect(pt("i_me + hot")).toBe("Estou com calor.");
  });

  it("renders the two-clause causal line (want … because … cold)", () => {
    const g = "i_me + want + hot + because + i_me + cold";
    expect(en(g)).toBe("I want something hot because I'm cold.");
    expect(he(g)).toBe("אני רוצה משהו חם כי קר לי.");
    expect(es(g)).toBe("Quiero algo caliente porque tengo frío.");
    expect(pt(g)).toBe("Eu quero algo quente porque estou com frio.");
  });

  it("renders a connective-led fragment (the b-level 'because …')", () => {
    expect(en("because + i_me + cold")).toBe("Because I'm cold.");
    expect(he("because + i_me + cold")).toBe("כי קר לי.");
    expect(es("because + i_me + cold")).toBe("Porque tengo frío.");
    expect(pt("because + i_me + cold")).toBe("Porque estou com frio.");
  });

  it("keeps the pronoun 'I' capital when a cause clause is embedded", () => {
    // The real because-fact shape (possessionLack → have.not): the cause leads
    // with "I", which must NOT be lowercased by the mid-sentence embedding.
    expect(en("i_me + sad + because + i_me + have.not + ball")).toBe("I'm sad because I don't have the ball.");
    // A creature-state cause lowercases its article cleanly.
    expect(en("frog + sad + because + bear + happy")).toBe("The frog is sad because the bear is happy.");
  });

  it("renders the WHY question the player asks", () => {
    expect(en("why")).toBe("Why?");
    expect(en("why + you + want + hot")).toBe("Why do you want something hot?");
    expect(en("why + hot")).toBe("Why do you want something hot?");
    expect(he("why")).toBe("למה?");
    expect(he("why + you + want + hot")).toBe("למה אתה רוצה משהו חם?");
    expect(he("why + you + want + hot", { addressee: "f" })).toBe("למה את רוצה משהו חם?");
    expect(es("why")).toBe("¿Por qué?");
    expect(es("why + you + want + hot")).toBe("¿Por qué quieres algo caliente?");
    expect(pt("why + you + want + hot")).toBe("Por que você quer algo quente?");
  });

  it("renders an in_order_to purpose line as 'so that …'", () => {
    const g = "you + give + apple + to + bear + in_order_to + bear + happy";
    expect(en(g)).toBe("Give the apple to the bear so that the bear is happy.");
  });
});

describe("device-state lines (§5) — toggle states as agreeing predicates", () => {
  it("renders the device-state WANT ('I want the {device} {state}')", () => {
    expect(en("i_me + want + generator + on")).toBe("I want the generator on.");
    expect(en("i_me + want + window + open")).toBe("I want the window open.");
    expect(en("i_me + want + lamp + off")).toBe("I want the lamp off.");
    // Hebrew: "I want [that] the {device} [be] {state}", state agreeing.
    expect(he("i_me + want + generator + on")).toBe("אני רוצה שהגנרטור דלוק.");
    expect(he("i_me + want + lamp + off")).toBe("אני רוצה שהמנורה כבויה."); // lamp is fem
    // Spanish/Portuguese: resultative "Quiero la lámpara encendida".
    expect(es("i_me + want + generator + on")).toBe("Quiero el generador encendido.");
    expect(es("i_me + want + window + open")).toBe("Quiero la ventana abierta.");
    expect(pt("i_me + want + window + open")).toBe("Quero a janela aberta.");
    expect(pt("i_me + want + lamp + off")).toBe("Quero a lâmpada apagada.");
  });

  it("renders the bare device-state copula ('The {device} is {state}')", () => {
    expect(en("generator + off")).toBe("The generator is off.");
    expect(en("window + open")).toBe("The window is open.");
    expect(he("generator + off")).toBe("הגנרטור כבוי.");
    expect(he("window + open")).toBe("החלון פתוח.");
    expect(es("generator + off")).toBe("El generador está apagado.");
    expect(es("window + open")).toBe("La ventana está abierta.");
    expect(pt("generator + off")).toBe("O gerador está apagado.");
  });

  it("renders the device WHY answer (…because the generator is off)", () => {
    const g = "i_me + sad + because + generator + off";
    expect(en(g)).toBe("I'm sad because the generator is off.");
    expect(he(g)).toBe("אני עצוב כי הגנרטור כבוי.");
    expect(es(g)).toBe("Estoy triste porque el generador está apagado.");
    expect(pt(g)).toBe("Eu estou triste porque o gerador está apagado.");
  });

  it("renders a bare state glyph at level a", () => {
    expect(en("off")).toBe("off");
    expect(he("off")).toBe("כבוי");
    expect(es("off")).toBe("apagado");
    expect(pt("on")).toBe("aceso");
  });
});

describe("motive batch — stay/escort/preferences/desires/spoilage/categories", () => {
  it("renders the stay-with ask as a proper imperative", () => {
    const g = "you + stay + with + i_me";
    expect(en(g)).toBe("Stay with me.");
    expect(en("stay + with + i_me")).toBe("Stay with me.");
    expect(he(g)).toBe("תישאר איתי.");
    expect(he(g, { addressee: "f" })).toBe("תישארי איתי.");
    expect(es(g)).toBe("Quédate conmigo.");
    expect(pt(g)).toBe("Fica comigo.");
    // Level a — the bare "stay" glyph speaks the full natural ask.
    expect(en("stay")).toBe("Stay with me.");
    expect(he("stay", { addressee: "f" })).toBe("תישארי איתי.");
  });

  it("renders 'I am lonely' and the stay WHY answer", () => {
    expect(en("i_me + lonely")).toBe("I'm lonely.");
    expect(he("i_me + lonely")).toBe("אני בודד.");
    expect(he("i_me + lonely", { speaker: "f" })).toBe("אני בודדה.");
    expect(es("i_me + lonely")).toBe("Estoy solo.");
    expect(es("i_me + lonely", { speaker: "f" })).toBe("Estoy sola.");
    expect(pt("i_me + lonely")).toBe("Eu estou sozinho.");
    const why = "you + stay + with + i_me + because + i_me + lonely";
    expect(en(why)).toBe("Stay with me because I'm lonely.");
    expect(he(why)).toBe("תישאר איתי כי אני בודד.");
    expect(es(why)).toBe("Quédate conmigo porque estoy solo.");
    expect(pt(why)).toBe("Fica comigo porque eu estou sozinho.");
  });

  it("renders the stay-done thanks as a fixed phrase", () => {
    expect(en("i_me + ok + thank_you")).toBe("I'm okay, thank you!");
    expect(he("i_me + ok + thank_you")).toBe("אני בסדר, תודה!");
    expect(es("i_me + ok + thank_you")).toBe("Estoy bien, ¡gracias!");
    expect(pt("i_me + ok + thank_you")).toBe("Estou bem, obrigado!");
    expect(pt("i_me + ok + thank_you", { speaker: "f" })).toBe("Estou bem, obrigada!");
  });

  it("renders the escort ask ('Take me to the bear')", () => {
    const g = "you + take + i_me + to + bear";
    expect(en(g)).toBe("Take me to the bear.");
    expect(en("take + i_me + to + bear")).toBe("Take me to the bear.");
    expect(he(g)).toBe("קח אותי לדוב.");
    expect(he(g, { addressee: "f" })).toBe("קחי אותי לדוב.");
    expect(es(g)).toBe("Llévame con el oso.");
    expect(pt(g)).toBe("Me leva até o urso.");
  });

  it("renders 'I am hungry' experientially + the food want", () => {
    expect(en("i_me + hungry")).toBe("I'm hungry.");
    expect(he("i_me + hungry")).toBe("אני רעב.");
    expect(he("i_me + hungry", { speaker: "f" })).toBe("אני רעבה.");
    expect(es("i_me + hungry")).toBe("Tengo hambre.");
    expect(pt("i_me + hungry")).toBe("Estou com fome.");
    expect(en("i_me + want + food")).toBe("I want food.");
    expect(en("i_me + have.not + food")).toBe("I don't have food.");
    expect(he("i_me + want + food")).toBe("אני רוצה אוכל.");
    expect(es("i_me + want + food")).toBe("Quiero comida.");
    expect(pt("i_me + want + food")).toBe("Eu quero comida.");
    const why = "i_me + want + food + because + i_me + hungry";
    expect(en(why)).toBe("I want food because I'm hungry.");
    expect(he(why)).toBe("אני רוצה אוכל כי אני רעב.");
    expect(es(why)).toBe("Quiero comida porque tengo hambre.");
    expect(pt(why)).toBe("Eu quero comida porque estou com fome.");
  });

  it("renders preferences: 'I like cookies' / 'I like red'", () => {
    expect(en("i_me + like + cookie")).toBe("I like cookies.");
    expect(en("i_me + like + color_red")).toBe("I like red.");
    expect(he("i_me + like + cookie")).toBe("אני אוהב את העוגייה.");
    expect(he("i_me + like + cookie", { speaker: "f" })).toBe("אני אוהבת את העוגייה.");
    expect(he("i_me + like + color_red")).toBe("אני אוהב אדום.");
    expect(es("i_me + like + cookie")).toBe("Me gusta la galleta.");
    expect(es("i_me + like + color_red")).toBe("Me gusta el rojo.");
    expect(pt("i_me + like + cookie")).toBe("Eu gosto do biscoito.");
    expect(pt("i_me + like + ball")).toBe("Eu gosto da bola.");
    expect(pt("i_me + like + color_red")).toBe("Eu gosto de vermelho.");
    const why = "i_me + want + cookie + because + i_me + like + cookie";
    expect(en(why)).toBe("I want a cookie because I like cookies.");
    expect(he(why)).toBe("אני רוצה עוגייה כי אני אוהב את העוגייה.");
    expect(es(why)).toBe("Quiero una galleta porque me gusta la galleta.");
  });

  it("renders desires: want + infinitive ('I want to play/read/get dressed')", () => {
    expect(en("i_me + want + play")).toBe("I want to play.");
    expect(en("i_me + want + read")).toBe("I want to read.");
    expect(en("i_me + want + wear")).toBe("I want to get dressed.");
    expect(he("i_me + want + play")).toBe("אני רוצה לשחק.");
    expect(he("i_me + want + read")).toBe("אני רוצה לקרוא.");
    expect(he("i_me + want + wear")).toBe("אני רוצה להתלבש.");
    expect(es("i_me + want + play")).toBe("Quiero jugar.");
    expect(es("i_me + want + read")).toBe("Quiero leer.");
    expect(es("i_me + want + wear")).toBe("Quiero vestirme.");
    expect(pt("i_me + want + play")).toBe("Quero brincar.");
    expect(pt("i_me + want + read")).toBe("Quero ler.");
    expect(pt("i_me + want + wear")).toBe("Quero me vestir.");
    const why = "i_me + want + toy + because + i_me + want + play";
    expect(en(why)).toBe("I want a toy because I want to play.");
    expect(he(why)).toBe("אני רוצה צעצוע כי אני רוצה לשחק.");
    expect(es(why)).toBe("Quiero un juguete porque quiero jugar.");
    expect(pt(why)).toBe("Eu quero um brinquedo porque quero brincar.");
  });

  it("renders the category wants (toy/instrument/book/clothes)", () => {
    expect(en("i_me + want + toy")).toBe("I want a toy.");
    expect(en("i_me + want + instrument")).toBe("I want an instrument.");
    expect(en("i_me + want + book")).toBe("I want a book.");
    expect(en("i_me + want + clothing")).toBe("I want clothes.");
    expect(he("i_me + want + instrument")).toBe("אני רוצה כלי נגינה.");
    expect(he("place#question + instrument")).toBe("איפה כלי הנגינה?"); // construct definite
    expect(he("i_me + want + clothing")).toBe("אני רוצה בגדים.");
    expect(es("i_me + want + clothing")).toBe("Quiero ropa.");
    expect(pt("i_me + want + book")).toBe("Eu quero um livro.");
  });

  it("renders spoilage as a smell verb + the garbage placement", () => {
    expect(en("cookie + smelly")).toBe("The cookie smells bad.");
    expect(he("cookie + smelly")).toBe("העוגייה מסריחה.");
    expect(he("apple + smelly")).toBe("התפוח מסריח.");
    expect(es("apple + smelly")).toBe("La manzana huele mal.");
    expect(pt("apple + smelly")).toBe("A maçã cheira mal.");
    const why = "i_me + sad + because + apple + smelly";
    expect(en(why)).toBe("I'm sad because the apple smells bad.");
    expect(he(why)).toBe("אני עצוב כי התפוח מסריח.");
    expect(es(why)).toBe("Estoy triste porque la manzana huele mal.");
    // Disposal leads with THROW (2nd-person instruction), distinct from a
    // first-person "I want it in the box" placement.
    const line = "you + throw + apple + in + garbage";
    expect(en(line)).toBe("You throw the apple in the garbage.");
    expect(he(line)).toBe("אתה זורק את התפוח בפח.");
    expect(he(line, { addressee: "f" })).toBe("את זורקת את התפוח בפח.");
    expect(es(line)).toBe("Tiras la manzana en la basura.");
    expect(pt(line)).toBe("Você joga a maçã no lixo.");
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
