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
  KINSHIP_NAMES,
} from "./core.js";
import { specWords } from "../content/words.js";

const CENTRAL: Record<string, Lexeme> = {
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
  // The rest of the toy family. (`toy` itself is already below, with the
  // category words — it doubles as the DOLL descriptor, `rabbit.toy`.)
  doll: { w: "doll" },
  // Creature SPECIES words (reference resolution: "I talk to the {species}").
  // The animal-people (bear/frog/dog/rabbit) reuse the words above; these fill
  // the remaining registered species so a creature is never "the there".
  person: { w: "person", plw: "people" },
  // KINSHIP AND ROLE WORDS (2026-08-24) — the people a child names. CORE ENGINE
  // CONCEPTS by law (they are frame words, not spec'd objects), so their lexemes
  // live here rather than on any registry row; the student's OWN people arrive
  // separately, as named creatures from the people directory.
  outside: { w: "outside" },
  mom: { w: "mom" },
  dad: { w: "dad" },
  baby: { w: "baby", plw: "babies" },
  girl: { w: "girl" },
  boy: { w: "boy" },
  friend: { w: "friend" },
  teacher: { w: "teacher" },
  street: { w: "street" },
  animal: { w: "animal" },
  // The plant CATEGORY word — the head is `plants`, not `plant`, because
  // `plant` is the VERB (he שותל, es planto): one head, one lexeme, and the
  // builder's [plants] chip must not wear a conjugated verb.
  plants: { w: "plant", plw: "plants" },
  // THE SPECIFIC PEOPLE this child knows (2026-09-01) — the [individuals]
  // chip's label. Distinct from `person`, which is somebody in general: this
  // one names the roster, real contacts out of game and a scene's own
  // characters in it.
  individuals: { w: "my people", plw: "my people" },
  creature: { w: "creature" },
  water: { w: "water", mass: true },
  fire: { w: "fire", mass: true },
  // Devices (§5) + their toggle states (invariant in English).
  off: { w: "off" },
  open: { w: "open" },
  closed: { w: "closed" },
  // Motive batch: verbs, conditions, categories, new pool items.
  stay: { w: "stay" },
  like: { w: "like" },
  see: { w: "see" },
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
  run: { w: "run" },
  chase: { w: "chase" },
  follow: { w: "follow" },
  stop: { w: "stop" },
  // BOARD CHROME (⑦ board-chrome.ts): the "go back a step" word every list
  // wears. The AAC vocabulary already draws it (glyph `return`, 🔙); this is
  // the lexeme so the button SPEAKS in the player's language.
  return: { w: "return", v3: "returns" },
  // Nations P6 — the political words. `fight` is what the absolute taboo
  // ring forbids; `town`/`area` are the law-scope nouns P2 put on the
  // board ("no + fight + in + town") without ever giving them a lexeme.
  fight: { w: "fight", v3: "fights" },
  town: { w: "town" },
  area: { w: "area" },
  bathroom: { w: "bathroom" },
  food: { w: "food", mass: true },
  toy: { w: "toy" },
  clothing: { w: "clothes", pl: true },
  // Grammar-marker words (gloss safety only — the markers normally render as
  // constructions, never as these bare words).
  this: { w: "this" },
  will: { w: "will" },
  // Attention/self-care verbs (attention-spark actions): lexemes so the
  // conjugation table owns them explicitly rather than via fallback.
  eat: { w: "eat", inf: "eat" },
  drink: { w: "drink", inf: "drink" },
  sleep: { w: "sleep", inf: "sleep" },
  // THE POSTURE PAIR (build order L15). English needed no entry to LOOK right —
  // `baseWord` falls back to the glyph id, which is an English word — and that
  // is precisely why the gap went unseen in the other three rulesets for as
  // long as it did. Authored here for the same reason every verb above is: the
  // conjugation table owns the word rather than inheriting it by accident.
  rest: { w: "rest", inf: "rest" },
  sit: { w: "sit", inf: "sit" },
  wash: { w: "wash", inf: "wash" },
  tidy: { w: "tidy", inf: "tidy" },
  heat: { w: "heat", inf: "heat" },
  make_cold: { w: "cool", inf: "cool" },
  talk: { w: "talk", inf: "talk" },
  // Household CHORE verbs the needs templates speak ("I will cook the food").
  cook: { w: "cook", inf: "cook" },
  // ⚖️ WHY-CHAINS law ④ — the AUTHORITY link's verb ("…because you ask"). The
  // concept already ships (`ask` is an INTENT_LEXICON verb and a registered
  // glyph with its own `aac.glyph.ask` label); only the sentence-rendering
  // lexeme was missing, and without it a Hebrew chain would have spoken the
  // English token. Subject + verb only: no locale here can govern this verb's
  // OBJECT (Hebrew wants ממני, not the accusative), so "you ask" is the shape.
  ask: { w: "ask", inf: "ask" },
  // ⚖️ WHY-CHAINS law ④ — the BROAD ACTIVITY verb ("I am not doing (anything)"
  // — `notDoing(who, "do")`, the shipped idle answer, which spoke the raw
  // English token in every locale because the lexeme was never added). Same
  // standing as `ask`: an INTENT_LEXICON verb and a registered glyph
  // (`aac.glyph.do`) with no sentence-rendering entry until now.
  do: { w: "do", inf: "do" },
  // City-founding areas — the map-reading overlay verb.
  show: { w: "show" },
  // City-founding ③ — the structure board's room words + the demolish verb.
  break: { w: "break" },
  // Construction ④ — the room-EMPTYING verb (break's stow-only twin).
  empty: { w: "empty" },
  room: { w: "room" },
  // ── CONSTRUCTION VOCABULARY ───────────────────────────────────────────
  // Every word a building site can SAY. These shipped as live glyphs long
  // before they had lexemes, so the whole trade spoke raw English keys inside
  // the other rulesets ("אני build את הhouse") — English only ever LOOKED
  // right because `baseWord` falls back to the glyph id, which is an English
  // word. Same lesson the furniture kinds taught above. The materials and the
  // named structures now live on their spec rows (content/words.ts ITEM_WORDS
  // until products.ts/town-play.ts settle); what stays here is the core pair
  // (`house`/`building` are CORE_CONCEPTS) and the trade's own verbs.
  //
  // `house` is the spoken word for a dwelling ORDER; `home` stays the place a
  // creature returns to — two words because they are two things.
  house: { w: "house", plw: "houses" },
  building: { w: "building" },
  // The builders' YARD — where a town's materials pile up between orders, and
  // the default destination of a haul with no site to name.
  yard: { w: "yard" },
  // The TRADE VERBS. `build` raises a structure, `make` produces a piece (user
  // law: you make a toy, you build a house), `bring` is the haul — fetch first,
  // then deliver — and `cut` fells the tree the chain starts at.
  build: { w: "build", inf: "build" },
  make: { w: "make", inf: "make" },
  bring: { w: "bring", inf: "bring" },
  carry: { w: "carry", v3: "carries", inf: "carry" },
  use: { w: "use", v3: "uses", inf: "use" },
  cut: { w: "cut", inf: "cut" },
  // The completion state ("the house is finished").
  finished: { w: "finished" },

  // ── BUILDER-REACHABLE VOCABULARY (validate-builder-lexicon) ──────────────
  // Every word below is one press away on the sentence builder — a category
  // tab lists its whole lexical category, the modifier rail draws AXIS_WORDS,
  // and a group chip wears its cluster id — yet none of them had a lexeme.
  //
  // In ENGLISH that was invisible, and the reason is worth stating once more
  // (the furniture kinds and the construction trade each taught it already):
  // `baseWord` falls back to the raw glyph id, and a glyph id IS an English
  // word, so English looked perfect while he/es/pt put an English word on the
  // child's board. `npm run validate-builder-lexicon` is what now catches it.
  //
  // Authored here rather than on a spec row because none of these is a spec
  // OBJECT: they are function words, verbs, descriptors and category labels —
  // the ruleset's own vocabulary. (A game-spec object's words live ONLY on its
  // spec row; the no-overlap pin in lexicon-spec-words.test.ts holds that line.)

  // Question words. The builder spells the where-ask "where" while the glyph
  // registry spells it `place#question`; `classify` aliases them, and these are
  // the words the BUTTONS wear either way.
  what: { w: "what" },
  where: { w: "where" },
  who: { w: "who" },
  how: { w: "how" },

  // Connectives. `so` and `therefore` are separate LEXICON keys for one
  // relation, as are `then`/`and` for sequence — both spellings surface as
  // buttons, so both need words.
  and: { w: "and" },
  but: { w: "but" },
  or: { w: "or" },
  if: { w: "if" },
  so: { w: "so" },
  then: { w: "then" },

  // Relations. `front` is the LEXICON key; `in_front_of` above is the same
  // relation under the spelling the placement grammar uses.
  from: { w: "from" },

  // Descriptors — the modifier rail's axes (object-properties AXIS_WORDS).
  // `good` shipped long ago and `bad` never did, which is exactly the kind of
  // half-covered pair a validator catches and a reader doesn't.
  bad: { w: "bad" },
  broken: { w: "broken" },
  full: { w: "full" },
  long: { w: "long" },
  short: { w: "short" },
  tall: { w: "tall" },
  wide: { w: "wide" },
  thin: { w: "thin" },
  new: { w: "new" },
  old: { w: "old" },
  sick: { w: "sick" },
  warm: { w: "warm" },
  // The possession axis. Both are rendered as CONSTRUCTIONS in the agreement
  // rulesets (`cfg.my`, Hebrew's של) and filtered out of the adjective list —
  // these lexemes are what the BUTTON and the gloss fallback say.
  my: { w: "my" },
  your: { w: "your" },

  // Quantities (the fill + quantity axes, and the quantity tab).
  all: { w: "all" },
  many: { w: "many" },
  some: { w: "some" },
  none: { w: "none" },
  one: { w: "one" },
  two: { w: "two" },
  three: { w: "three" },

  // Verbs the parser has always understood and no ruleset could say. `v3` is
  // authored wherever the bare `${w}s` rule is wrong — a sibilant stem, or a
  // particle verb where the -s belongs on the FIRST word ("picks up").
  come: { w: "come", inf: "come" },
  wait: { w: "wait", inf: "wait" },
  turn: { w: "turn", inf: "turn" },
  push: { w: "push", v3: "pushes", inf: "push" },
  pull: { w: "pull", inf: "pull" },
  drop: { w: "drop", inf: "drop" },
  pick_up: { w: "pick up", v3: "picks up", inf: "pick up" },
  fill: { w: "fill", inf: "fill" },
  fix: { w: "fix", v3: "fixes", inf: "fix" },
  dig: { w: "dig", inf: "dig" },
  plant: { w: "plant", inf: "plant" },
  shut: { w: "shut", inf: "shut" },
  hug: { w: "hug", inf: "hug" },
  share: { w: "share", inf: "share" },
  teach: { w: "teach", v3: "teaches", inf: "teach" },
  feel: { w: "feel", inf: "feel" },
  wake_up: { w: "wake up", v3: "wakes up", inf: "wake up" },
  brush_teeth: { w: "brush teeth", v3: "brushes teeth", inf: "brush teeth" },

  // Social acts. Each is an alias of a word that already had a lexeme
  // (`hi`/`hello`, `goodbye`/`bye`, `ok`/`okay`, `confused`/`dont_understand`)
  // — and BOTH spellings are listed on the social tab, so both need words.
  thanks: { w: "thanks" },
  sorry: { w: "sorry" },
  mine: { w: "mine" },
  again: { w: "again" },
  dont_understand: { w: "I don't understand" },

  // Deixis the person tab lists beside i_me/you/we.
  that: { w: "that" },

  // GROUP-CHIP LABELS — the object-property cluster ids (object-properties.ts
  // OBJECT_PROPERTIES). A chip wears `baseWord(lang, id)`, so an untranslated
  // property id is an English chip on a Hebrew board. `food`, `toy`, `clothing`
  // and `book` already had words; these are the nine that did not.
  container: { w: "container" },
  openable: { w: "opens" },
  device: { w: "device" },
  appliance: { w: "appliance" },
  tableware: { w: "dishes", pl: true },
  furniture: { w: "furniture", mass: true },
  instrument: { w: "instrument" },
  material: { w: "material" },
  structure: { w: "structure" },
};

/** The ruleset's OWN words — grammar, verbs, adjectives, core concepts. Spec
 *  ITEMS live on their spec rows (content/words.ts joiner) and must not appear
 *  here too; the no-overlap conformance pin reads this export. */
export const CENTRAL_WORDS = CENTRAL;

/** The LIVE word table — central words ⊕ the spec items' own words. Built
 *  BEFORE the renderer, which closes over it: an item's row is authoritative
 *  for its word, in the gloss fallback and the frame grammar alike. */
const L: Record<string, Lexeme> = { ...CENTRAL, ...specWords("en") };

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

/** The preposition a verb governs on its object ("play WITH the ball", "talk TO
 *  Mara"). One owner: the finite arm and the want-to arm both read it, so a
 *  desire cannot say "I want to play a ball" while the plain sentence says
 *  "you play with the ball". */
const objJoin = (verb: string): string | null =>
  verb === "play" ? "with" : verb === "talk" ? "to" : null;

function npText(np: NP, art: Art): string {
  if (isPronoun(np.noun.head)) return OBJ_PRON[np.noun.head]!;
  // "Mom", never "a mom" — a kinship word is what the child CALLS them.
  if (KINSHIP_NAMES.has(np.noun.head)) return cap(lex(np.noun.head).w);
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
  so: "so",
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
  if (objJoin(f.verb.head) && f.object && !f.tail) {
    const joint = objJoin(f.verb.head)!;
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

/** ENGLISH'S REGULAR PLURAL — the -s/-es/-ies rule, for nouns the lexicon gave
 *  no explicit `plw`. Irregulars stay authored (`plw`), which is what that field
 *  is for; this only stops a generated count from printing "2 bed". */
function enPlural(word: string): string {
  if (/(?:s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

export const en: GlyphLanguage = {
  id: "en",
  lexicon: L,
  pluralize: enPlural,
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
      case "wantTo": {
        // Desire + infinitive: "I want to play." / "I need to eat a cookie." /
        // negated, the play-command refusal: "I don't want to play."
        const inf = lex(frame.verb.head).inf ?? lex(frame.verb.head).w;
        const modal = lex(frame.modal).w;
        const join = objJoin(frame.verb.head);
        const obj = frame.object ? ` ${join ? `${join} ` : ""}${npText(frame.object, "a")}` : "";
        return `I ${frame.neg ? `don't ${modal}` : modal} to ${inf}${obj}.`;
      }
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
