// shared/world-engine/interaction/lang/en.ts
//
// SVO, adjectives before the noun, a/an ~ the articles, do-support negation.
// Definiteness policy by frame: wants are indefinite ("I want an apple"),
// declines/possession/clues are definite ("I don't want the sock", "The bear
// has the ball"), MORE-quantified nouns pluralize with no article.

import {
  baseWord,
  gloss,
  isDeicticNoun,
  isUnspokenMod,
  isIntentVerb,
  isPronoun,
  isQuality,
  NO_NAMES,
  stripEnd,
  type Frame,
  type Gender,
  type GlyphLanguage,
  type Lexeme,
  type NP,
  type SpeakOpts,
  type Token,
} from "./core.js";

const L: Record<string, Lexeme> = {
  i_me: { w: "I" },
  you: { w: "you" },
  // The collective voice (nations P6) — plural, so `conj` picks "don't"
  // and `be` picks "are" with no new branch.
  we: { w: "we", pl: true },
  they: { w: "they", pl: true },
  here: { w: "here" },
  there: { w: "there" },
  together: { w: "together" },
  // Third-person pronouns (subject forms; object forms in OBJ_PRON below).
  he: { w: "he" },
  she: { w: "she" },
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
  // THE PROXIMITY PAIR (construction v1's placement relations): `near` is the
  // room-scaled vicinity, `next_to` the adjacent spot right against the piece.
  // Both mean BESIDE a thing, never inside it.
  near: { w: "near" },
  next_to: { w: "next to" },
  // The remaining placement relations: the vertical pair and the facing pair.
  under: { w: "under" },
  over: { w: "over" },
  behind: { w: "behind" },
  in_front_of: { w: "in front of" },
  more: { w: "more" },
  less: { w: "less" },
  rare: { w: "rare" },
  easy: { w: "easy" },
  hard: { w: "hard" },
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
  work: { w: "work" }, // the workplace — "I go to work" commute answers
  thing: { w: "thing" },
  cookie: { w: "cookie" },
  apple: { w: "apple" },
  banana: { w: "banana" },
  grape: { w: "grape" },
  ball: { w: "ball" },
  // The rest of the toy family. (`toy` itself is already below, with the
  // category words — it doubles as the DOLL descriptor, `rabbit.toy`.)
  blocks: { w: "blocks", pl: true },
  puzzle: { w: "puzzle" },
  doll: { w: "doll" },
  car: { w: "car" },
  train: { w: "train" },
  rabbit: { w: "rabbit" },
  bear: { w: "bear" },
  frog: { w: "frog" },
  dog: { w: "dog" },
  // Creature SPECIES words (reference resolution: "I talk to the {species}").
  // The animal-people (bear/frog/dog/rabbit) reuse the words above; these fill
  // the remaining registered species so a creature is never "the there".
  person: { w: "person", plw: "people" },
  animal: { w: "animal" },
  creature: { w: "creature" },
  cow: { w: "cow" },
  deer: { w: "deer", plw: "deer" },
  ram: { w: "ram" },
  sheep: { w: "sheep", plw: "sheep" },
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
  // Transitive "wear the shirt"; the bare want-to keeps the idiom via inf
  // ("I want to get dressed").
  wear: { w: "wear", inf: "get dressed" },
  color: { w: "color" }, // recolour an item at the tub ("color the shirt red")
  throw: { w: "throw" },
  with: { w: "with" },
  lonely: { w: "lonely" },
  hungry: { w: "hungry" },
  tired: { w: "tired" },
  bored: { w: "bored" },
  smelly: { w: "smelly" },
  // The DRESS motive's condition — the worn garment wants changing.
  scruffy: { w: "scruffy" },
  // Round-2 motives: thirst/hygiene conditions, the waste need, its stations.
  thirsty: { w: "thirsty" },
  need: { w: "need" },
  // Construction v1: the placement verb + the refusal-cause quality.
  put: { w: "put", inf: "put" },
  good: { w: "good" },
  // Phase ①a: the "I don't understand" fallback.
  understand: { w: "understand" },
  // Movement (the going frame renders it; listed for wantTo/gloss paths).
  go: { w: "go", v3: "goes" },
  // The movement gaits + pursuit family (semantic-gaps batch): commandable
  // verbs render conjugated, never as raw symbols.
  walk: { w: "walk" },
  run: { w: "run" },
  chase: { w: "chase" },
  follow: { w: "follow" },
  stop: { w: "stop" },
  // Nations P6 — the political words. `fight` is what the absolute taboo
  // ring forbids; `town`/`area` are the law-scope nouns P2 put on the
  // board ("no + fight + in + town") without ever giving them a lexeme.
  fight: { w: "fight", v3: "fights" },
  town: { w: "town" },
  area: { w: "area" },
  bathroom: { w: "bathroom" },
  kitchen: { w: "kitchen" },
  bath: { w: "bath" },
  toilet: { w: "toilet" },
  barrel: { w: "barrel" },
  // FURNITURE as a spoken noun. An unplaced piece stacks as `furn.<kind>` and
  // now speaks as its kind (core.ts canonicalToken), so the kinds need words —
  // English only ever LOOKED right because the fallback spells the raw glyph,
  // and every other language said "chair" in Latin script.
  chair: { w: "chair" },
  table: { w: "table" },
  bed: { w: "bed" },
  // The `chest` and `cupboard` KINDS speak `box` and `cabinet` (types.ts
  // FIXTURE_WORD) — the vocabulary draws no chest/box distinction, and those
  // two words are not in it. `box` already has its entry above.
  cabinet: { w: "cabinet" },
  workbench: { w: "workbench" },
  bin: { w: "bin" },
  bowl: { w: "bowl" },
  oven: { w: "oven" },
  well: { w: "well" },
  food: { w: "food", mass: true },
  toy: { w: "toy" },
  book: { w: "book" },
  clothing: { w: "clothes", pl: true },
  hat: { w: "hat" },
  shirt: { w: "shirt" },
  dress: { w: "dress" },
  scarf: { w: "scarf" },
  // Grammar-marker words (gloss safety only — the markers normally render as
  // constructions, never as these bare words).
  this: { w: "this" },
  will: { w: "will" },
  // Attention/self-care verbs (attention-spark actions): lexemes so the
  // conjugation table owns them explicitly rather than via fallback.
  eat: { w: "eat", inf: "eat" },
  drink: { w: "drink", inf: "drink" },
  sleep: { w: "sleep", inf: "sleep" },
  wash: { w: "wash", inf: "wash" },
  tidy: { w: "tidy", inf: "tidy" },
  heat: { w: "heat", inf: "heat" },
  cool: { w: "cool", inf: "cool" },
  talk: { w: "talk", inf: "talk" },
  // Household CHORE verbs the needs templates speak ("I will cook the food").
  cook: { w: "cook", inf: "cook" },
  // City-founding areas — the map-reading overlay verb.
  show: { w: "show" },
  // City-founding ③ — the structure board's room words + the demolish verb.
  break: { w: "break" },
  room: { w: "room" },
  door: { w: "door" },
  bedroom: { w: "bedroom" },
  store: { w: "storeroom" },
  workshop: { w: "workshop" },
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
  const adjs = np.noun.mods
    .filter((m) => m !== "my" && m !== "not" && !isUnspokenMod(m))
    .map((m) => lex(m).w);
  return { words: [...adjs, lex(np.noun.head).w], my: np.noun.mods.includes("my") };
}

type Art = "the" | "a" | "none";

/** Object-case pronoun forms — a pronoun NP is never articled ("help me",
 *  never "help the you"). */
const OBJ_PRON: Record<string, string> = {
  i_me: "me",
  you: "you",
  we: "us",
  they: "them",
  he: "him",
  she: "her",
};

/** Subject-case pronoun forms (a 3rd-person pronoun leading a clause). */
const SUBJ_PRON: Record<string, string> = {
  i_me: "I",
  you: "you",
  we: "we",
  they: "they",
  he: "he",
  she: "she",
};

/** The active sentence's PROPER-NOUN book (SpeakOpts.names) — set per render.
 *  A name never takes an article and reads capitalized ("Mara is hungry"). */
let NAMES: ReadonlyMap<string, Gender> = NO_NAMES;
const nameWord = (head: string): string => head.charAt(0).toUpperCase() + head.slice(1);

function npText(np: NP, art: Art): string {
  if (isPronoun(np.noun.head)) return OBJ_PRON[np.noun.head]!;
  if (NAMES.has(np.noun.head)) return nameWord(np.noun.head);
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
  // The deictic (.this) names a PARTICULAR instance — the demonstrative
  // replaces the article ("this apple", "these clothes").
  if (isDeicticNoun(np.noun)) return `${isPlural(np.noun) ? "these" : "this"} ${words.join(" ")}`;
  if (art === "none" || (art === "a" && (isPlural(np.noun) || isMass(np.noun)))) {
    return words.join(" ");
  }
  if (art === "a") {
    const a = /^[aeiou]/i.test(words[0]!) ? "an" : "a";
    return `${a} ${words.join(" ")}`;
  }
  return `the ${words.join(" ")}`;
}

/** am/is/are matching the NP's person and number. */
const be = (np: NP) =>
  np.noun.head === "i_me" ? "am" : np.noun.head === "you" || isPlural(np.noun) ? "are" : "is";

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
  // Pronoun subjects take the SUBJECT form ("I"/"we"/"he"), never the object
  // "me"/"us"/"him" npText would hand back, and never articled.
  if (isPronoun(t.head)) return SUBJ_PRON[t.head] ?? lex(t.head).w;
  return npText({ noun: t }, "the");
}

/** A movement destination phrase: bare adverbials (home/here/there), the
 *  workplace idiom ("to work"), else "to the {place}". */
function goDest(dest: Token): string {
  if (dest.head === "home") return "home";
  if (dest.head === "here" || dest.head === "there") return dest.head;
  if (dest.head === "work") return "to work";
  return `to ${npText({ noun: dest }, "the")}`;
}

function conj(verb: Token, subject: Token | undefined, neg: boolean): string {
  const v = lex(verb.head);
  // The intent marker (.will) — a statement of what the speaker is about to
  // do: "will eat" / "won't eat", any subject.
  if (isIntentVerb(verb)) return `${neg ? "won't" : "will"} ${v.w}`;
  const third = !!subject && subject.head !== "i_me" && subject.head !== "you" && !isPlural(subject);
  if (neg) return `${third ? "doesn't" : "don't"} ${v.w}`;
  return third ? (v.v3 ?? `${v.w}s`) : v.w;
}

function renderSvo(f: Extract<Frame, { kind: "svo" }>, opts: Required<SpeakOpts>): string {
  // A negated PUT is INABILITY, not habit (construction v1's refusal):
  // "i_me + put.not + chair" → "I can't put the chair there."
  if (f.verb.head === "put" && f.neg) {
    const obj = f.object ? npText(f.object, "the") : "it";
    return `I can't put ${obj} there${f.question ? "?" : "."}`;
  }
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
      : isPronoun(o.head) || isPlural(o) || isMass(o)
        ? npText(f.object, "none")
        : pluralize(npText(f.object, "none"));
    const subj = f.subject ? subjWord(f.subject) : "I";
    return `${cap(subj)} ${conj(f.verb, f.subject, false)} ${obj}${f.question ? "?" : "."}`;
  }

  // Subject-less "want"/"have"/negated verbs — and any subject-less verb in
  // the player's mouth — are first person ("I want an apple", "I don't have
  // the sock", never the imperative misread "Want an apple"/"Don't have it").
  // A will-marked verb is a STATEMENT OF INTENT and is always first person:
  // "eat.will + apple" reads "I will eat the apple", never "Eat the apple".
  if (
    !f.subject &&
    (f.verb.head === "want" || f.verb.head === "have" || f.neg || opts.firstPerson || isIntentVerb(f.verb))
  ) {
    f = { ...f, subject: { head: "i_me", mods: [], q: false } };
  }

  // Verbs whose object rides a preposition ("play WITH the ball", "talk TO
  // Mara") — the glyph line stays verb+object, the surface adds the joint.
  if ((f.verb.head === "play" || f.verb.head === "talk") && f.object && !f.tail) {
    const joint = f.verb.head === "play" ? "with" : "to";
    const subj0 = f.subject ? subjWord(f.subject) : "I";
    const s0 = `${subj0} ${conj(f.verb, f.subject ?? { head: "i_me", mods: [], q: false }, f.neg)} ${joint} ${npText(f.object, "the")}`;
    return `${cap(s0)}${f.question ? "?" : "."}`;
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
  // npText renders pronoun complements in object case ("to me", "to you").
  const tail = f.tail ? ` ${lex(f.tail.join).w} ${npText({ noun: f.tail.comp }, "the")}` : "";
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
    "i_me + understand.not": "I don't understand.",
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
    NAMES = opts.names;
    switch (frame.kind) {
      case "word":
        return lex(frame.token.head).w;
      case "np":
        // Level-a naming: the bare phrase models the glyph ("big ball").
        return npText(frame.np, "none");
      case "here": {
        // Pronoun subjects read in subject case ("I am here", never "me is here").
        const who = isPronoun(frame.np.noun.head) ? subjWord(frame.np.noun) : npText(frame.np, "the");
        return `${cap(who)} ${be(frame.np)} ${frame.where === "here" ? "here" : "over there"}.`;
      }
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
        // "Where are you?" / "Where am I?" — subject case after the copula.
        if (isPronoun(frame.np.noun.head)) return `Where ${be(frame.np)} ${subjWord(frame.np.noun)}?`;
        return `Where ${be(frame.np)} ${npText(frame.np, "the")}?`;
      case "what-want":
        return "What do you want?";
      case "copula": {
        const adj = frame.neg ? `not ${lex(frame.adj.head).w}` : lex(frame.adj.head).w;
        // Spoilage reads as a smell VERB: "The fish smells bad."
        if (frame.adj.head === "smelly") {
          const dont = frame.neg ? "don't " : "";
          if (frame.subject.head === "i_me") return `I ${dont}smell bad.`;
          if (frame.subject.head === "you") return `You ${dont}smell bad.`;
          const s = npText({ noun: frame.subject }, "the");
          const smell = frame.neg
            ? `${isPlural(frame.subject) ? "don't" : "doesn't"} smell`
            : isPlural(frame.subject)
              ? "smell"
              : "smells";
          return `${cap(s)} ${smell} bad${frame.question ? "?" : "."}`;
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
        if (frame.join === "in" || frame.join === "on" || frame.join === "near" || frame.join === "next_to" ||
            frame.join === "under" || frame.join === "over" || frame.join === "behind" || frame.join === "in_front_of") {
          // "in + work" is the workplace idiom — "Mara is at work".
          if (frame.comp.head === "work") return `${capNp} ${be(frame.np)} at work.`;
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
        // Want + infinitive: "I want to play." / negated, the play-command
        // refusal: "I don't want to play."
        return `I ${frame.neg ? "don't want" : "want"} to ${lex(frame.verb.head).inf ?? lex(frame.verb.head).w}.`;
      case "going": {
        const dest = frame.fetch ? `to get ${npText(frame.fetch, "a")}` : goDest(frame.dest!);
        const s = frame.subject;
        // The intent form ("go.will"): "I will go to the bathroom."
        if (frame.intent && (!s || s.head === "i_me")) return `I will go ${dest}.`;
        if (!s || s.head === "i_me") return `I'm going ${dest}.`;
        if (s.head === "you") return `Go ${dest}.`;
        if (frame.intent) return `${cap(npText({ noun: s }, "the"))} will go ${dest}.`;
        return `${cap(npText({ noun: s }, "the"))} is going ${dest}.`;
      }
      case "whereGoing":
        return "Where are you going?";
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
