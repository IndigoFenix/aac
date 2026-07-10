// shared/symbol-game/lang/en.ts — English rules for glyph-sentence translation.
//
// SVO, adjectives before the noun, a/an ~ the articles, do-support negation.
// Definiteness policy by frame: wants are indefinite ("I want an apple"),
// declines/possession/clues are definite ("I don't want the sock", "The bear
// has the ball"), MORE-quantified nouns pluralize with no article.

import {
  baseWord,
  gloss,
  isQuality,
  stripEnd,
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
  why: { w: "why" },
  because: { w: "because" },
  therefore: { w: "so" },
  in_order_to: { w: "so that" },
  when: { w: "when" },
  until: { w: "until" },
  something: { w: "something" },
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
  // Cardinal directions — the "close/far, to the {north}" answers.
  north: { w: "north" },
  south: { w: "south" },
  east: { w: "east" },
  west: { w: "west" },
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
  // Devices (§5) + their toggle states (invariant in English).
  lamp: { w: "lamp" },
  window: { w: "window" },
  heater: { w: "heater" },
  generator: { w: "generator" },
  switch: { w: "switch" },
  off: { w: "off" },
  open: { w: "open" },
  closed: { w: "closed" },
  // Motive batch: verbs, conditions, categories, new pool items.
  stay: { w: "stay" },
  like: { w: "like" },
  play: { w: "play" },
  read: { w: "read" },
  wear: { w: "get dressed" }, // only reached via want-to: "I want to get dressed"
  throw: { w: "throw" },
  with: { w: "with" },
  lonely: { w: "lonely" },
  hungry: { w: "hungry" },
  smelly: { w: "smelly" },
  food: { w: "food", mass: true },
  toy: { w: "toy" },
  instrument: { w: "instrument" },
  book: { w: "book" },
  clothing: { w: "clothes", pl: true },
  garbage: { w: "garbage", mass: true },
  hat: { w: "hat" },
  shirt: { w: "shirt" },
  scarf: { w: "scarf" },
  drum: { w: "drum" },
  guitar: { w: "guitar" },
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
  // A bare QUALITY want ("something hot", "something red") — the object isn't a
  // specific thing, only a property (motive-driven-needs.md: non-specific wants
  // read by their quality, never the designated instance).
  if (isQuality(np.noun.head)) {
    const extra = np.noun.mods.filter((m) => m !== "not").map((m) => lex(m).w);
    return `something ${[lex(np.noun.head).w, ...extra].join(" ")}`;
  }
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
// Lowercase a clause for mid-sentence embedding — but never the pronoun "I".
const lcClause = (s: string) => (/^I(\b|')/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1));

const EN_CONN: Record<string, string> = {
  because: "because",
  therefore: "so",
  in_order_to: "so that",
  when: "when",
  until: "until",
};

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
  // Preferences ("I like cookies" / "I like red"): the object is GENERIC —
  // count nouns pluralize with no article, qualities read bare, mass/plural
  // nouns stay bare. Never the specific-instance "the".
  if (f.verb.head === "like" && f.object && !f.neg) {
    const o = f.object.noun;
    const obj = isQuality(o.head)
      ? lex(o.head).w
      : isPlural(o) || isMass(o)
        ? npText(f.object, "none")
        : pluralize(npText(f.object, "none"));
    const subj = f.subject ? subjWord(f.subject) : "I";
    return `${cap(subj)} ${conj(f.verb, f.subject, false)} ${obj}${f.question ? "?" : "."}`;
  }

  // Subject-less "want"/"have"/negated verbs — and any subject-less verb in
  // the player's mouth — are first person ("I want an apple", "I don't have
  // the sock", never the imperative misread "Want an apple"/"Don't have it").
  if (!f.subject && (f.verb.head === "want" || f.verb.head === "have" || f.neg || opts.firstPerson)) {
    f = { ...f, subject: { head: "i_me", mods: [], q: false } };
  }

  const subj = f.subject ? subjWord(f.subject) : "";
  // Wants are indefinite; mass/plural HAVE objects read bare ("I don't have
  // food", "the bear has water") — "the" would imply a specific instance.
  const art: Art =
    f.verb.head === "want" && !f.neg && !f.tail
      ? "a"
      : f.verb.head === "have" && f.object && (isMass(f.object.noun) || isPlural(f.object.noun))
        ? "none"
        : "the";
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
    // Motive batch: the stay-with level-a line + the dwell-done thanks.
    stay: "Stay with me.",
    "i_me + ok + thank_you": "I'm okay, thank you!",
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
        // Spoilage reads as a smell VERB: "The fish smells bad."
        if (frame.adj.head === "smelly") {
          if (frame.subject.head === "i_me") return "I smell bad.";
          if (frame.subject.head === "you") return "You smell bad.";
          const s = npText({ noun: frame.subject }, "the");
          return `${cap(s)} ${isPlural(frame.subject) ? "smell" : "smells"} bad${frame.question ? "?" : "."}`;
        }
        if (frame.subject.head === "i_me") return frame.question ? `Am I ${adj}?` : `I'm ${adj}.`;
        if (frame.subject.head === "you") return frame.question ? `Are you ${adj}?` : `You're ${adj}.`;
        const s = npText({ noun: frame.subject }, "the");
        return frame.question
          ? `${cap(be({ noun: frame.subject }))} ${s} ${adj}?`
          : `${cap(s)} ${be({ noun: frame.subject })} ${adj}.`;
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
      case "causal": {
        const conn = EN_CONN[frame.connective] ?? frame.connective;
        const cause = lcClause(stripEnd(en.render(frame.cause, opts)));
        if (!frame.effect) return `${cap(conn)} ${cause}.`;
        return `${stripEnd(en.render(frame.effect, opts))} ${conn} ${cause}.`;
      }
      case "why":
        if (!frame.thing) return "Why?";
        return `Why do you want ${npText(frame.thing, "a")}?`;
      case "device":
        // Resultative want: "I want the lamp on." / "I want the window open."
        return `I want ${npText({ noun: frame.device }, "the")} ${lex(frame.state.head).w}.`;
      case "wantTo":
        // Want + infinitive: "I want to play." / "I want to get dressed."
        return `I want to ${lex(frame.verb.head).inf ?? lex(frame.verb.head).w}.`;
      case "takeMeTo":
        return `Take me to ${npText({ noun: frame.dest }, "the")}.`;
      case "stayWith":
        return "Stay with me.";
      case "directions": {
        const thing = cap(npText(frame.np, "the"));
        const v = be(frame.np);
        const dir = lex(frame.cardinal).w;
        const tail =
          frame.proximity === "here"
            ? "here"
            : frame.proximity === "there"
              ? "there"
              : frame.proximity === "street"
                ? "on this street"
                : `${frame.proximity === "close" ? "close" : "far"}, to the ${dir}`;
        return `${thing} ${v} ${tail}.`;
      }
      case "gloss":
        return gloss(en, frame.tokens, "not");
    }
  },
};
