// shared/symbol-game/lang/en.ts — English rules for glyph-sentence translation.
//
// SVO, adjectives before the noun, a/an ~ the articles, do-support negation.
// Definiteness policy by frame: wants are indefinite ("I want an apple"),
// declines/possession/clues are definite ("I don't want the sock", "The bear
// has the ball"), MORE-quantified nouns pluralize with no article.

import {
  baseWord,
  gloss,
  type Frame,
  type GlyphLanguage,
  type Lexeme,
  type NP,
  type SpeakOpts,
  type Token,
} from "./core.js";

const L: Record<string, Lexeme> = {
  i_me: { w: "I" },
  you: { w: "you" },
  here: { w: "here" },
  there: { w: "there" },
  want: { w: "want" },
  give: { w: "give" },
  take: { w: "take" },
  get: { w: "get" },
  have: { w: "have", v3: "has" },
  help: { w: "help" },
  think: { w: "think" },
  know: { w: "know" },
  trade: { w: "trade" },
  to: { w: "to" },
  in: { w: "in" },
  on: { w: "on" },
  for: { w: "for" },
  more: { w: "more" },
  yes: { w: "yes" },
  no: { w: "no" },
  ok: { w: "okay" },
  hi: { w: "hi" },
  goodbye: { w: "bye-bye" },
  thank_you: { w: "thank you" },
  confused: { w: "confused" },
  sad: { w: "sad" },
  happy: { w: "happy" },
  big: { w: "big" },
  small: { w: "small" },
  hot: { w: "hot" },
  cold: { w: "cold" },
  clean: { w: "clean" },
  dirty: { w: "dirty" },
  wet: { w: "wet" },
  dry: { w: "dry" },
  color_red: { w: "red" },
  color_blue: { w: "blue" },
  color_green: { w: "green" },
  color_yellow: { w: "yellow" },
  color_orange: { w: "orange" },
  color_purple: { w: "purple" },
  color_pink: { w: "pink" },
  color_brown: { w: "brown" },
  color_black: { w: "black" },
  color_white: { w: "white" },
  place: { w: "place" },
  // The village building — "the blue house" location clues. ("home" the AAC
  // feeling-of-home sense never reaches this game's sentences.)
  home: { w: "house" },
  thing: { w: "thing" },
  cookie: { w: "cookie" },
  apple: { w: "apple" },
  banana: { w: "banana" },
  grape: { w: "grape" },
  ball: { w: "ball" },
  car: { w: "car" },
  train: { w: "train" },
  blocks: { w: "blocks", pl: true },
  teddy: { w: "teddy" },
  rabbit: { w: "rabbit" },
  bear: { w: "bear" },
  frog: { w: "frog" },
  dog: { w: "dog" },
  box: { w: "box" },
  basket: { w: "basket" },
  bubbles: { w: "bubbles", pl: true },
  sparks: { w: "sparks", pl: true },
  boat: { w: "boat" },
  broccoli: { w: "broccoli", mass: true },
  sock: { w: "sock" },
  water: { w: "water", mass: true },
  fire: { w: "fire", mass: true },
};

function pluralize(w: string): string {
  if (/(s|x|ch|sh)$/.test(w)) return `${w}es`;
  if (/[^aeiou]y$/.test(w)) return `${w.slice(0, -1)}ies`;
  return `${w}s`;
}

function lex(head: string): Lexeme {
  return L[head] ?? { w: baseWord(en, head) };
}

const isPlural = (t: Token) => !!lex(t.head).pl;
const isMass = (t: Token) => !!lex(t.head).mass;

/** Adjective + possessive words carried on the noun token, in English order. */
function npWords(np: NP): { words: string[]; my: boolean } {
  const adjs = np.noun.mods.filter((m) => m !== "my" && m !== "not").map((m) => lex(m).w);
  return { words: [...adjs, lex(np.noun.head).w], my: np.noun.mods.includes("my") };
}

type Art = "the" | "a" | "none";

function npText(np: NP, art: Art): string {
  const { words, my } = npWords(np);
  if (np.more) {
    const nounIdx = words.length - 1;
    if (!isPlural(np.noun) && !isMass(np.noun)) words[nounIdx] = pluralize(words[nounIdx]!);
    return `more ${words.join(" ")}`;
  }
  if (my) return `my ${words.join(" ")}`;
  if (art === "none" || (art === "a" && (isPlural(np.noun) || isMass(np.noun)))) {
    return words.join(" ");
  }
  if (art === "a") {
    const a = /^[aeiou]/i.test(words[0]!) ? "an" : "a";
    return `${a} ${words.join(" ")}`;
  }
  return `the ${words.join(" ")}`;
}

/** is/are matching the NP's number. */
const be = (np: NP) => (isPlural(np.noun) ? "are" : "is");

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function subjWord(t: Token): string {
  if (t.head === "i_me") return "I";
  if (t.head === "you") return "you";
  return npText({ noun: t }, "the");
}

function conj(verb: Token, subject: Token | undefined, neg: boolean): string {
  const v = lex(verb.head);
  const third = !!subject && subject.head !== "i_me" && subject.head !== "you" && !isPlural(subject);
  if (neg) return `${third ? "doesn't" : "don't"} ${v.w}`;
  return third ? (v.v3 ?? `${v.w}s`) : v.w;
}

function renderSvo(f: Extract<Frame, { kind: "svo" }>, opts: Required<SpeakOpts>): string {
  // give with a "you" subject — or none, in NPC mouth — is a REQUEST: imperative.
  const giveAsAsk = !f.subject && !opts.firstPerson;
  if (f.verb.head === "give" && (giveAsAsk || f.subject?.head === "you") && f.object && !f.neg) {
    const obj = npText(f.object, "the");
    const recip = f.tail?.comp;
    if (!recip || recip.head === "i_me") return `Give me ${obj}.`;
    // "give X to YOU" — the creature means the item is FOR the player.
    if (recip.head === "you") return `${obj.charAt(0).toUpperCase()}${obj.slice(1)} is for you!`;
    return `Give ${obj} to ${npText({ noun: recip }, "the")}.`;
  }
  // give as an "i_me" statement (explicit, negated, or the player's own words)
  // is the OFFER/refusal — directed at the interlocutor: "I'll give YOU it".
  if (
    f.verb.head === "give" &&
    (f.subject?.head === "i_me" || (!f.subject && (f.neg || opts.firstPerson))) &&
    f.object
  ) {
    const obj = npText(f.object, "the");
    const to = f.tail
      ? f.tail.comp.head === "you"
        ? " to you"
        : ` to ${npText({ noun: f.tail.comp }, "the")}`
      : "";
    const recip = f.tail ? "" : "you ";
    return f.neg ? `I won't give ${recip}${obj}${to}.` : `I'll give ${recip}${obj}${to}.`;
  }
  // Subject-less "have"/negated verbs — and any subject-less verb in the
  // player's mouth — are first person ("I want an apple", "I don't have the
  // sock", never the imperative misread "Don't have the sock").
  if (!f.subject && (f.verb.head === "have" || f.neg || opts.firstPerson)) {
    f = { ...f, subject: { head: "i_me", mods: [], q: false } };
  }

  const subj = f.subject ? subjWord(f.subject) : "";
  const art: Art = f.verb.head === "want" && !f.neg && !f.tail ? "a" : "the";
  const obj = f.object ? ` ${npText(f.object, art)}` : "";
  const tail = f.tail
    ? ` ${lex(f.tail.join).w} ${
        f.tail.comp.head === "i_me" ? "me" : f.tail.comp.head === "you" ? "you" : npText({ noun: f.tail.comp }, "the")
      }`
    : "";
  const s = `${subj ? `${subj} ` : ""}${conj(f.verb, f.subject, f.neg)}${obj}${tail}`;
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}${f.question ? "?" : "."}`;
}

export const en: GlyphLanguage = {
  id: "en",
  lexicon: L,
  fixed: {
    "i_me + help + you": "I'll help you.",
    "i_me + help.not + you": "I won't help you.",
    "i_me + think.not": "I don't know.",
    "ok#question": "Are you okay?",
    "you + ok#question": "Are you okay?",
    confused: "I'm confused.",
    there: "Over there!",
    thank_you: "Thank you!",
  },
  render(frame: Frame, opts: Required<SpeakOpts>): string {
    switch (frame.kind) {
      case "word":
        return lex(frame.token.head).w;
      case "np":
        // Level-a naming: the bare phrase models the glyph ("big ball").
        return npText(frame.np, "none");
      case "here":
        return `${cap(npText(frame.np, "the"))} ${be(frame.np)} ${frame.where === "here" ? "here" : "over there"}.`;
      case "mine":
        return frame.no ? `No — ${npText(frame.np, "the")}!` : npText(frame.np, "the");
      case "corrective": {
        const adj = lex(frame.adj.head).w;
        if (!frame.np) return `Not ${adj}.`;
        return `${cap(npText(frame.np, "the"))} ${isPlural(frame.np.noun) ? "aren't" : "isn't"} ${adj}.`;
      }
      case "where":
        if (!frame.np) return "Where?";
        if (frame.get) return `Where do I get ${npText(frame.np, "the")}?`;
        return `Where ${be(frame.np)} ${npText(frame.np, "the")}?`;
      case "what-want":
        return "What do you want?";
      case "copula": {
        const adj = lex(frame.adj.head).w;
        if (frame.subject.head === "i_me") return frame.question ? `Am I ${adj}?` : `I'm ${adj}.`;
        if (frame.subject.head === "you") return frame.question ? `Are you ${adj}?` : `You're ${adj}.`;
        const s = npText({ noun: frame.subject }, "the");
        return frame.question ? `${be({ noun: frame.subject })} ${s} ${adj}?` : `${s} ${be({ noun: frame.subject })} ${adj}.`;
      }
      case "svo":
        return renderSvo(frame, opts);
      case "trade": {
        if (frame.what) return "Trade for what?";
        if (frame.give && frame.get) {
          const s = `${npText(frame.give, "the")} for ${npText(frame.get, "the")}?`;
          return `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
        }
        if (frame.get) return `Trade for ${npText(frame.get, "the")}?`;
        return "Trade?";
      }
      case "pp": {
        const np = npText(frame.np, "the");
        const capNp = `${np.charAt(0).toUpperCase()}${np.slice(1)}`;
        if (frame.comp.head === "you") return `${capNp} is for you!`;
        if (frame.comp.head === "i_me") return `${capNp} is for me!`;
        // Locative fragments read as full clues ("The ball is in the blue
        // house."); directional ones stay directive ("The apple — to the bear.").
        if (frame.join === "in" || frame.join === "on") {
          return `${capNp} ${be(frame.np)} ${lex(frame.join).w} ${npText({ noun: frame.comp }, "the")}.`;
        }
        return `${capNp} — ${lex(frame.join).w} ${npText({ noun: frame.comp }, "the")}.`;
      }
      case "gloss":
        return gloss(en, frame.tokens, "not");
    }
  },
};
