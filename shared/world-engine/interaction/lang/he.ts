// shared/world-engine/interaction/lang/he.ts
//
// Modern Hebrew is SVO like the glyph order, but almost everything else is a
// construction of its own:
//   • possession is "יש ל־" ("יש לי כדור", "לדוב יש כדור"), negated "אין ל־"
//   • adjectives FOLLOW the noun and agree in gender, number AND definiteness
//     ("הכדור הגדול", "עוגייה חמה")
//   • definite direct objects take "את" ("תן לי את התפוח")
//   • requests are gendered imperatives (תן / תני) — addressee gender
//   • present-tense verbs and predicate adjectives agree with the speaker
//     (a frog — צפרדע, feminine — says "אני נותנת", "אני עצובה")
// Word choices follow the client-aac i18n glyph labels (he.ts aac.glyph).
// Output is unpointed text for TTS; ל/ב fuse silently with ה in spelling.

import {
  gloss,
  isDeicticNoun,
  isUnspokenMod,
  isIntentVerb,
  isPluralPronoun,
  isPronoun,
  isQuality,
  NO_NAMES,
  SENSATION,
  stripEnd,
  type Frame,
  type Gender,
  type GlyphLanguage,
  type Lexeme,
  type NP,
  type SpeakOpts,
  type Token,
} from "./core.js";
import { specWords } from "../content/words.js";

const CENTRAL: Record<string, Lexeme> = {
  i_me: { w: "אני" },
  you: { w: "אתה", f: "את" },
  // The collective voice (nations P6). Both are PLURAL: a group speaking of
  // itself ("אנחנו לא נלחמים") or of its neighbours ("הם לא נותנים את האוכל").
  // Gender-mixed / unknown groups take the masculine plural, as standard.
  we: { w: "אנחנו" },
  they: { w: "הם" },
  here: { w: "כאן" },
  there: { w: "שם" },
  together: { w: "ביחד" },
  want: { w: "רוצה", f: "רוצה", vmpl: "רוצים", vfpl: "רוצות" },
  give: { w: "נותן", f: "נותנת", vmpl: "נותנים", vfpl: "נותנות" },
  take: { w: "לוקח", f: "לוקחת", vmpl: "לוקחים", vfpl: "לוקחות" },
  // ACQUIRE, not receive: `get` is the fetch verb ("I will get the wood" — the
  // commonest thing a builder says), and מקבל is what you do when somebody
  // hands you something. משיג/להשיג is the root this ruleset already used for
  // the where-do-I-get idiom below; the whole card now agrees with it, and the
  // infinitive is what the intent periphrasis ("אני הולך להשיג") needs — without
  // one the `.will` marker was silently dropped and the line came out present.
  get: { w: "משיג", f: "משיגה", vmpl: "משיגים", vfpl: "משיגות", inf: "להשיג" },
  // "יש" is invariant — possession renders through the יש ל־ construction, so
  // these plural slots only matter if a gloss ever reaches the verb directly.
  have: { w: "יש", vmpl: "יש", vfpl: "יש" },
  help: { w: "עוזר", f: "עוזרת", objPrep: "to" }, // עוזר ל־: "אני עוזר לך"
  think: { w: "חושב", f: "חושבת" },
  know: { w: "יודע", f: "יודעת" },
  understand: { w: "מבין", f: "מבינה" },
  go: { w: "הולך", f: "הולכת", vmpl: "הולכים", vfpl: "הולכות", inf: "ללכת" },
  // The movement gaits + pursuit family (semantic-gaps batch). NOTE walk IS
  // go in Hebrew (ללכת covers both) — the cross-language signal that the
  // pair is one primitive wearing two English words.
  walk: { w: "הולך", f: "הולכת", vmpl: "הולכים", vfpl: "הולכות", inf: "ללכת" },
  run: { w: "רץ", f: "רצה", vmpl: "רצים", vfpl: "רצות", inf: "לרוץ" },
  chase: { w: "רודף", f: "רודפת", vmpl: "רודפים", vfpl: "רודפות", inf: "לרדוף" },
  follow: { w: "עוקב", f: "עוקבת", vmpl: "עוקבים", vfpl: "עוקבות", inf: "לעקוב" },
  stop: { w: "עוצר", f: "עוצרת", vmpl: "עוצרים", vfpl: "עוצרות", inf: "לעצור" },
  // Board chrome's "go back" word (⑦) — the AAC glyph `return`.
  return: { w: "חוזר", f: "חוזרת", vmpl: "חוזרים", vfpl: "חוזרות", inf: "לחזור" },
  trade: { w: "מחליף", f: "מחליפה", vmpl: "מחליפים", vfpl: "מחליפות" },
  // Nations P6: the verb the absolute taboo ring forbids (root ל.ח.מ).
  fight: { w: "נלחם", f: "נלחמת", vmpl: "נלחמים", vfpl: "נלחמות", inf: "להילחם" },
  to: { w: "ל" },
  in: { w: "ב" },
  for: { w: "תמורת" },
  // THE PROXIMITY PAIR (construction v1's placement relations). Hebrew keeps
  // them apart the same way the client's glyph labels do: קרוב = in the
  // vicinity, ליד = right beside it. The trailing ל of "קרוב ל" is a clitic —
  // `prepNp` fuses it with the article ("קרוב לשולחן").
  near: { w: "קרוב ל" },
  next_to: { w: "ליד" },
  // The vertical + facing placement pairs. `prepNp` does the work: the
  // trailing-ל of "מתחת ל" fuses with the article ("מתחת לשולחן"); the
  // standalone words keep it ("מאחורי השולחן", "מעל השולחן").
  under: { w: "מתחת ל" },
  over: { w: "מעל" },
  behind: { w: "מאחורי" },
  in_front_of: { w: "לפני" },
  more: { w: "עוד" },
  many: { w: "הרבה" },
  less: { w: "פחות" },
  rare: { w: "נדיר" },
  easy: { w: "קל" },
  hard: { w: "קשה" },
  why: { w: "למה" },
  because: { w: "כי" },
  therefore: { w: "לכן" },
  in_order_to: { w: "כדי ש" },
  when: { w: "כש" },
  until: { w: "עד ש" },
  something: { w: "משהו" },
  yes: { w: "כן" },
  no: { w: "לא" },
  ok: { w: "בסדר", f: "בסדר" },
  hi: { w: "שלום" },
  goodbye: { w: "להתראות" },
  thank_you: { w: "תודה" },
  confused: { w: "מבולבל", f: "מבולבלת" },
  sad: { w: "עצוב" },
  happy: { w: "שמח" },
  big: { w: "גדול" },
  small: { w: "קטן" },
  hot: { w: "חם" },
  cold: { w: "קר" },
  // Proximity adjectives for directions ("הכדור קרוב/רחוק"), agreeing with the
  // thing's gender/number.
  close: { w: "קרוב" },
  far: { w: "רחוק" },
  clean: { w: "נקי", f: "נקייה", mpl: "נקיים", fpl: "נקיות" },
  dirty: { w: "מלוכלך", f: "מלוכלכת" },
  wet: { w: "רטוב" },
  dry: { w: "יבש" },
  color_red: { w: "אדום" },
  color_blue: { w: "כחול" },
  color_green: { w: "ירוק" },
  color_yellow: { w: "צהוב" },
  color_orange: { w: "כתום" },
  color_purple: { w: "סגול" },
  color_pink: { w: "ורוד" },
  color_brown: { w: "חום" },
  color_black: { w: "שחור" },
  color_white: { w: "לבן" },
  place: { w: "מקום" },
  // Settlement / territory words — P2 puts these on the board (the taboo and
  // claim lines speak of a town and of an area).
  town: { w: "עיירה", g: "f" },
  area: { w: "אזור", g: "m" },
  // Cardinal directions — the "קרוב/רחוק, לכיוון צפון" answers.
  north: { w: "צפון" },
  south: { w: "דרום" },
  east: { w: "מזרח" },
  west: { w: "מערב" },
  home: { w: "בית", g: "m" },
  work: { w: "עבודה", g: "f" },
  thing: { w: "דבר" },
  doll: { w: "בובה", g: "f" },
  // Creature SPECIES words (reference resolution: "אני מדבר עם ה{מין}").
  person: { w: "אדם", g: "m", plw: "אנשים" },
  animal: { w: "חיה", g: "f", plw: "חיות" },
  creature: { w: "יצור", g: "m" },
  water: { w: "מים", g: "m", pl: true, mass: true },
  fire: { w: "אש", g: "f", mass: true },
  // Devices (§5) + their toggle states (agree with the device's gender).
  on: { w: "דלוק", f: "דלוקה" },
  off: { w: "כבוי", f: "כבויה" },
  open: { w: "פתוח", f: "פתוחה" },
  closed: { w: "סגור", f: "סגורה" },
  // Motive batch: verbs (present + infinitive), conditions, categories, items.
  stay: { w: "נשאר", f: "נשארת", inf: "להישאר" },
  like: { w: "אוהב", f: "אוהבת" },
  play: { w: "משחק", f: "משחקת", inf: "לשחק" },
  read: { w: "קורא", f: "קוראת", inf: "לקרוא" },
  wear: { w: "מתלבש", f: "מתלבשת", inf: "להתלבש" },
  color: { w: "צובע", f: "צובעת", vmpl: "צובעים", vfpl: "צובעות", inf: "לצבוע" },
  throw: { w: "זורק", f: "זורקת" },
  with: { w: "עם" },
  lonely: { w: "בודד", f: "בודדה" },
  hungry: { w: "רעב", f: "רעבה" },
  tired: { w: "עייף", f: "עייפה" },
  bored: { w: "משועמם", f: "משועממת" },
  smelly: { w: "מסריח", f: "מסריחה" },
  scruffy: { w: "מרושל", f: "מרושלת" },
  // Round-2 motives: thirst/hygiene conditions, the waste need, its stations.
  thirsty: { w: "צמא", f: "צמאה" },
  need: { w: "צריך", f: "צריכה" },
  // Construction v1: the placement verb + the refusal-cause quality.
  put: { w: "שם", f: "שמה", inf: "לשים" },
  good: { w: "טוב", f: "טובה" },
  bathroom: { w: "שירותים", g: "m", pl: true },
  food: { w: "אוכל", g: "m", mass: true },
  // TOY is a NOUN used attributively, never an adjective: Hebrew says
  // "מכונית צעצוע" (a construct pair), not "מכונית צעצועה". Without invariant
  // forms the adjective walk synthesised a feminine and agreed it with the
  // noun, which is a word that does not exist.
  toy: { w: "צעצוע", g: "m", f: "צעצוע", mpl: "צעצוע", fpl: "צעצוע" },
  clothing: { w: "בגדים", g: "m", pl: true },
  // Attention/self-care verbs (attention-spark actions) — present + infinitive
  // (the intent periphrasis "הולך לאכול" needs the infinitive).
  eat: { w: "אוכל", f: "אוכלת", vmpl: "אוכלים", vfpl: "אוכלות", inf: "לאכול" },
  drink: { w: "שותה", f: "שותה", vmpl: "שותים", vfpl: "שותות", inf: "לשתות" },
  sleep: { w: "ישן", f: "ישנה", vmpl: "ישנים", vfpl: "ישנות", inf: "לישון" },
  // THE POSTURE PAIR (build order L15). Both shipped as live glyphs with no
  // lexeme here, so a Hebrew creature said "אני rest." — the raw English token
  // sitting in the verb slot, the same failure the construction words had, and
  // English only ever LOOKED right because the fallback spells the glyph id.
  // Reached by the open-ground dwell (`restHere` — the one rest with no walk in
  // it) and by the bare self-needs ("you rest", "you sit").
  //
  // נח is the INTRANSITIVE rest — the body at ease, never English's transitive
  // "rest a thing", which is the second half of what was wrong with the old
  // line. The feminine is נחה: the regular ת suffix would synthesise "נחת",
  // which is a different word, so the card carries it. יושב is the seated
  // posture, and takes the regular suffixes. Both carry the infinitive the
  // intent periphrasis reads ("אני הולך לנוח").
  rest: { w: "נח", f: "נחה", vmpl: "נחים", vfpl: "נחות", inf: "לנוח" },
  sit: { w: "יושב", f: "יושבת", vmpl: "יושבים", vfpl: "יושבות", inf: "לשבת" },
  wash: { w: "רוחץ", f: "רוחצת", vmpl: "רוחצים", vfpl: "רוחצות", inf: "לרחוץ" },
  tidy: { w: "מסדר", f: "מסדרת", vmpl: "מסדרים", vfpl: "מסדרות", inf: "לסדר" },
  heat: { w: "מחמם", f: "מחממת", vmpl: "מחממים", vfpl: "מחממות", inf: "לחמם" },
  make_cold: { w: "מקרר", f: "מקררת", vmpl: "מקררים", vfpl: "מקררות", inf: "לקרר" },
  talk: { w: "מדבר", f: "מדברת", vmpl: "מדברים", vfpl: "מדברות", inf: "לדבר" },
  // Household CHORE verbs the needs templates speak ("אני הולך לבשל את האוכל").
  cook: { w: "מבשל", f: "מבשלת", vmpl: "מבשלים", vfpl: "מבשלות", inf: "לבשל" },
  // ⚖️ WHY-CHAINS law ④ — the AUTHORITY link's verb ("…כי אתה מבקש").
  ask: { w: "מבקש", f: "מבקשת", vmpl: "מבקשים", vfpl: "מבקשות", inf: "לבקש" },
  // ⚖️ WHY-CHAINS law ④ — the BROAD ACTIVITY verb ("אני לא עושה כלום").
  do: { w: "עושה", f: "עושה", vmpl: "עושים", vfpl: "עושות", inf: "לעשות" },
  // City-founding areas — the map-reading overlay verb.
  show: { w: "מראה", f: "מראה", vmpl: "מראים", vfpl: "מראות", inf: "להראות" },
  // City-founding ③ — the structure board's room words + the demolish verb.
  break: { w: "שובר", f: "שוברת", vmpl: "שוברים", vfpl: "שוברות", inf: "לשבור" },
  // Construction ④ — the room-EMPTYING verb (break's stow-only twin).
  empty: { w: "מרוקן", f: "מרוקנת", vmpl: "מרוקנים", vfpl: "מרוקנות", inf: "לרוקן" },
  room: { w: "חדר", g: "m" },
  // ── CONSTRUCTION VOCABULARY ───────────────────────────────────────────
  // The building trade's words. They shipped as live glyphs with no lexemes,
  // so a builder here said "אני build את הhouse" — the raw English key inside
  // a Hebrew sentence, the same failure the furniture kinds had.
  // The materials and named structures now live on their spec rows
  // (content/words.ts) — what stays is the core pair and the trade's verbs.
  //
  // STRUCTURES. `house` is the dwelling as an ORDER ("build a house"); `home`
  // stays the place you go back to.
  house: { w: "בית", g: "m", plw: "בתים" },
  building: { w: "מבנה", g: "m", plw: "מבנים" },
  yard: { w: "חצר", g: "f", plw: "חצרות" },
  // TRADE VERBS — present tense in four agreement forms + the infinitive the
  // intent periphrasis ("הולך לבנות") needs.
  build: { w: "בונה", f: "בונה", vmpl: "בונים", vfpl: "בונות", inf: "לבנות" },
  make: { w: "מכין", f: "מכינה", vmpl: "מכינים", vfpl: "מכינות", inf: "להכין" },
  bring: { w: "מביא", f: "מביאה", vmpl: "מביאים", vfpl: "מביאות", inf: "להביא" },
  carry: { w: "נושא", f: "נושאת", vmpl: "נושאים", vfpl: "נושאות", inf: "לשאת" },
  cut: { w: "כורת", f: "כורתת", vmpl: "כורתים", vfpl: "כורתות", inf: "לכרות" },
  // The completion state ("הבית מוכן").
  finished: { w: "מוכן", f: "מוכנה", mpl: "מוכנים", fpl: "מוכנות" },
};

/** The ruleset's OWN words — grammar, verbs, adjectives, core concepts. Spec
 *  ITEMS live on their spec rows (content/words.ts joiner) and must not appear
 *  here too; the no-overlap conformance pin reads this export. */
export const CENTRAL_WORDS = CENTRAL;

/** The LIVE word table — central words ⊕ the spec items' own words. Built
 *  BEFORE the renderer, which closes over it: an item's row is authoritative
 *  for its word, in the gloss fallback and the frame grammar alike. */
const L: Record<string, Lexeme> = { ...CENTRAL, ...specWords("he") };

function lex(head: string): Lexeme {
  return L[head] ?? { w: head };
}

/** Suffix a Hebrew word, un-finalizing its last letter (ך→כ, ם→מ, ן→נ, ף→פ, ץ→צ). */
function suffix(w: string, sfx: string): string {
  const FINALS: Record<string, string> = { "ך": "כ", "ם": "מ", "ן": "נ", "ף": "פ", "ץ": "צ" };
  const last = w.slice(-1);
  return (FINALS[last] ? w.slice(0, -1) + FINALS[last] : w) + sfx;
}

/** Adjective form agreeing with gender + number. */
function adjForm(head: string, g: Gender, pl: boolean): string {
  const a = lex(head);
  if (pl) return g === "f" ? (a.fpl ?? suffix(a.w, "ות")) : (a.mpl ?? suffix(a.w, "ים"));
  return g === "f" ? (a.f ?? suffix(a.w, "ה")) : a.w;
}

/** Present-tense verb agreeing with the subject's gender AND number.
 *  Singular is the historical behaviour (`w` / `f`); a PLURAL subject — only
 *  the collective pronouns reach it — takes `vmpl`/`vfpl`, falling back to the
 *  regular participle suffixes on the masculine base (נותן → נותנים/נותנות). */
function verbForm(head: string, g: Gender, pl = false): string {
  const v = lex(head);
  if (pl) return g === "f" ? (v.vfpl ?? suffix(v.w, "ות")) : (v.vmpl ?? suffix(v.w, "ים"));
  return g === "f" ? (v.f ?? suffix(v.w, "ת")) : v.w;
}

/** The active sentence's PROPER-NOUN book (SpeakOpts.names) — set per render.
 *  A name never takes the definite ה and agrees by its OWN gender ("מרה רעבה"). */
let NAMES: ReadonlyMap<string, Gender> = NO_NAMES;
const nameWord = (head: string): string => head.charAt(0).toUpperCase() + head.slice(1);

const nounGender = (t: Token): Gender => NAMES.get(t.head) ?? lex(t.head).g ?? "m";
const nounPlural = (t: Token) => !NAMES.has(t.head) && !!lex(t.head).pl;

/**
 * Noun phrase: noun + agreeing adjectives, definite ה on BOTH when definite,
 * "שלי" after for possessives (always definite: "העוגייה שלי"), "עוד" for MORE.
 */
/** Direct-object pronoun forms (אות־): "אני אוהב אותך", never "את האתה". */
const OBJ_PRON: Record<string, string> = {
  i_me: "אותי",
  you: "אותך",
  we: "אותנו",
  they: "אותם",
  he: "אותו",
  she: "אותה",
};

/** Subject pronoun forms. "you" is gendered by the ADDRESSEE and so is not
 *  listed here — every caller that can see a "you" resolves it first. */
const SUBJ_PRON: Record<string, string> = { i_me: "אני", we: "אנחנו", they: "הם", he: "הוא", she: "היא" };

/** Dative pronoun forms (ל־ fused): "יש לנו", "אין להם". */
const DAT_PRON: Record<string, string> = { i_me: "לי", you: "לך", we: "לנו", they: "להם", he: "לו", she: "לה" };

/** Comitative pronoun forms (עם fused): "מדבר איתו", "איתה". */
const COM_PRON: Record<string, string> = {
  i_me: "איתי",
  you: "איתך",
  we: "איתנו",
  they: "איתם",
  he: "איתו",
  she: "איתה",
};

/** Does this subject take PLURAL agreement? Only the collective pronouns do —
 *  lexically plural NOUN subjects keep their historical singular verb, so this
 *  never changes an existing rendering. */
const subjPlural = (t: Token | undefined): boolean => !!t && isPluralPronoun(t.head);

function npText(np: NP, def: boolean): string {
  // A pronoun is never an articled NP — masculine subject form as the safe
  // fallback (gendered/object positions branch before reaching here).
  if (isPronoun(np.noun.head)) return SUBJ_PRON[np.noun.head] ?? "אתה";
  // A NAME never takes ה; adjectives agree with the bearer's own gender.
  if (NAMES.has(np.noun.head)) {
    const adjs = np.noun.mods
      .filter((m) => m !== "my" && m !== "not")
      .map((m) => adjForm(m, nounGender(np.noun), false));
    return [nameWord(np.noun.head), ...adjs].join(" ");
  }
  // A bare QUALITY want ("something hot" = "משהו חם") — impersonal masculine,
  // the property alone, never the designated instance.
  if (isQuality(np.noun.head)) {
    const extra = np.noun.mods.filter((m) => m !== "not").map((m) => adjForm(m, "m", false));
    return `משהו ${[adjForm(np.noun.head, "m", false), ...extra].join(" ")}`;
  }
  const g = nounGender(np.noun);
  // MORE is a QUANTIFIER, and in Hebrew it governs an INDEFINITE PLURAL: "עוד
  // לבנים", never "את עוד הלבנה" — a definite singular behind עוד is not
  // Hebrew at all. So a more-NP pluralizes (where the lexeme carries a plural)
  // and overrides the caller's definiteness, the same way "more blocks" drops
  // the article in English. Reached by every bill a building site speaks
  // ("the kitchen needs more blocks").
  const pl = nounPlural(np.noun) || (!!np.more && !!lex(np.noun.head).plw);
  const my = np.noun.mods.includes("my");
  const deictic = isDeicticNoun(np.noun);
  const adjs = np.noun.mods
    .filter((m) => m !== "my" && m !== "not" && !isUnspokenMod(m))
    .map((m) => adjForm(m, g, pl));
  // The deictic (.this) is always definite: "התפוח הזה", "השמלה הזאת".
  const definite = (def || my || deictic) && !np.more;
  const base = (np.more ? (lex(np.noun.head).plw ?? lex(np.noun.head).w) : lex(np.noun.head).w);
  // Construct nouns override their definite form ("כלי נגינה" → "כלי הנגינה").
  const noun = definite ? (lex(np.noun.head).defw ?? `ה${base}`) : base;
  const words = [noun, ...adjs.map((a) => (definite ? `ה${a}` : a))];
  if (deictic) words.push(pl ? "האלה" : g === "f" ? "הזאת" : "הזה");
  if (my) words.push("שלי");
  return np.more ? `עוד ${words.join(" ")}` : words.join(" ");
}

/** "את " before a definite direct object. */
const et = (np: NP) => `את ${npText(np, true)}`;

/** Fuse a one-letter preposition with a definite NP (ל + הדוב → לדוב). */
function fuse(prep: string, np: NP): string {
  const d = npText(np, true);
  return prep + (d.startsWith("ה") ? d.slice(1) : d);
}

/** A preposition before a definite NP. A one-letter CLITIC fuses and swallows
 *  the article — whether it stands alone (ב + השולחן → בשולחן) or ENDS a
 *  phrase (קרוב ל + השולחן → קרוב לשולחן). A standalone word (ליד, עם) keeps
 *  its space and the article ("ליד השולחן"); fusing it would run the two
 *  together. */
function prepNp(prep: string, np: NP): string {
  const i = prep.lastIndexOf(" ");
  const tail = i < 0 ? prep : prep.slice(i + 1);
  if (tail.length === 1) return (i < 0 ? "" : prep.slice(0, i + 1)) + fuse(tail, np);
  return `${prep} ${npText(np, true)}`;
}

/** Dative for a person token: לי / לך / לדוב. */
function dative(t: Token, addressee: Gender): string {
  void addressee; // לך is spelled the same for both genders
  const p = DAT_PRON[t.head];
  if (p) return p;
  return fuse("ל", { noun: t });
}

function subjGender(t: Token | undefined, opts: Required<SpeakOpts>): Gender {
  if (!t || t.head === "i_me") return opts.speaker;
  if (t.head === "you") return opts.addressee;
  return nounGender(t);
}

function subjText(t: Token, opts: Required<SpeakOpts>): string {
  if (t.head === "you") return opts.addressee === "f" ? "את" : "אתה";
  const p = SUBJ_PRON[t.head];
  if (p) return p;
  return npText({ noun: t }, true);
}

function renderSvo(f: Extract<Frame, { kind: "svo" }>, opts: Required<SpeakOpts>): string {
  // A negated PUT is INABILITY (construction v1's refusal): "אני לא יכול
  // לשים את הכיסא שם."
  if (f.verb.head === "put" && f.neg) {
    const obj = f.object ? npText(f.object, true) : "את זה";
    return `אני לא יכול לשים ${obj} שם${f.question ? "?" : "."}`;
  }
  // -- possession: יש / אין ל־ ------------------------------------------------
  if (f.verb.head === "have") {
    const yesh = f.neg ? "אין" : "יש";
    const obj = f.object ? ` ${npText(f.object, false)}` : "";
    // Any PRONOUN possessor takes the dative form ("יש לי", "יש להם"); only a
    // noun possessor fronts as a topic.
    if (!f.subject || isPronoun(f.subject.head)) {
      const dat = dative(f.subject ?? { head: "i_me", mods: [], q: false }, opts.addressee);
      return `${yesh} ${dat}${obj}${f.question ? "?" : "."}`;
    }
    // Noun possessor fronts as a topic: "לדוב יש כדור."
    return `${fuse("ל", { noun: f.subject })} ${yesh}${obj}${f.question ? "?" : "."}`;
  }

  // -- requests: gendered imperative "תן/תני" (a "you" subject, or a
  // subject-less give in the NPC's mouth) -------------------------------------
  const giveAsAsk = !f.subject && !opts.firstPerson;
  if (f.verb.head === "give" && (giveAsAsk || f.subject?.head === "you") && f.object && !f.neg) {
    const ten = opts.addressee === "f" ? "תני" : "תן";
    const recip = f.tail?.comp;
    if (recip?.head === "you") return `${npText(f.object, true)} בשבילך!`; // it's FOR you
    if (!recip || recip.head === "i_me") return `${ten} לי ${et(f.object)}.`;
    return `${ten} ${et(f.object)} ${dative(recip, opts.addressee)}.`;
  }

  // -- the offer/refusal: "אני (לא) נותן לך את הכדור" — directed at the listener
  if (
    f.verb.head === "give" &&
    (f.subject?.head === "i_me" || (!f.subject && (f.neg || opts.firstPerson))) &&
    f.object
  ) {
    const v = `${f.neg ? "לא " : ""}${verbForm("give", opts.speaker)}`;
    const recip = f.tail ? dative(f.tail.comp, opts.addressee) : "לך";
    return `אני ${v} ${recip} ${et(f.object)}.`;
  }

  // Preferences with a QUALITY object read the bare color/state ("אני אוהב
  // אדום"), never the "משהו אדום" want form; noun objects ride the generic
  // frame below ("אני אוהב את העוגייה").
  if (f.verb.head === "like" && f.object && isQuality(f.object.noun.head)) {
    const g = subjGender(f.subject, opts);
    const subj = f.subject ? `${subjText(f.subject, opts)} ` : "";
    return `${subj}${verbForm("like", g, subjPlural(f.subject))} ${adjForm(f.object.noun.head, "m", false)}${f.question ? "?" : "."}`;
  }

  // The player's own subject-less statements are first person ("אני רוצה…").
  if (!f.subject && opts.firstPerson && f.verb.head !== "have") {
    f = { ...f, subject: { head: "i_me", mods: [], q: false } };
  }

  // -- the general present-tense frame ---------------------------------------
  // A will-marked verb is a STATEMENT OF INTENT — always first person.
  if (isIntentVerb(f.verb) && !f.subject) {
    f = { ...f, subject: { head: "i_me", mods: [], q: false } };
  }
  const g = subjGender(f.subject, opts);
  let verb = `${f.neg ? "לא " : ""}${verbForm(f.verb.head, g, subjPlural(f.subject))}`;
  // The intent periphrasis ("הולך לאכול" — going-to future) when the verb has
  // an infinitive; negated / infinitive-less intent stays present tense (an
  // honest near-future reading in Hebrew).
  if (isIntentVerb(f.verb) && !f.neg && f.subject?.head === "i_me") {
    const inf = lex(f.verb.head).inf;
    if (inf) verb = `${verbForm("go", g)} ${inf}`;
  }
  // TRANSITIVE wear ("לובש את החולצה") — the lexeme's מתלבש/להתלבש is the
  // intransitive get-dressed idiom (kept for the bare want-to); an object
  // switches the root.
  if (f.verb.head === "wear" && f.object) {
    verb =
      isIntentVerb(f.verb) && !f.neg && f.subject?.head === "i_me"
        ? `${verbForm("go", g)} ללבוש`
        : `${f.neg ? "לא " : ""}${g === "f" ? "לובשת" : "לובש"}`;
  }
  // Wants are indefinite ("אני רוצה תפוח"); declines and placements name the
  // specific thing — definite, with את ("אני לא רוצה את הגרב"). A dative verb
  // (objPrep "to") governs ל־ on its object ("אני עוזר לך", "אני עוזר לדוב");
  // a pronoun object elsewhere takes the אות־ form ("אני אוהב אותך"). PLAY
  // takes ב־ ("משחק בכדור"); TALK takes עם ("מדבר עם מרה").
  // A MORE-quantified object is indefinite by construction ("עוד לבנים"), and
  // את marks only definite direct objects — "צריך את עוד לבנים" would be
  // ungrammatical twice over.
  const objDef = (f.verb.head !== "want" || f.neg || !!f.tail) && !f.object?.more;
  const obj = f.object
    ? ` ${
        f.verb.head === "play" && !isPronoun(f.object.noun.head)
          ? fuse("ב", f.object)
          : f.verb.head === "talk"
            ? (isPronoun(f.object.noun.head)
                ? COM_PRON[f.object.noun.head]!
                : `עם ${npText(f.object, true)}`)
            : lex(f.verb.head).objPrep === "to"
              ? dative(f.object.noun, opts.addressee)
              : isPronoun(f.object.noun.head)
                ? OBJ_PRON[f.object.noun.head]
                : objDef
                  ? et(f.object)
                  : npText(f.object, false)
      }`
    : "";
  const tail = f.tail
    ? ` ${
        f.tail.join === "to"
          ? dative(f.tail.comp, opts.addressee)
          : f.tail.join === "for"
            ? `תמורת ${npText({ noun: f.tail.comp }, true)}`
            : prepNp(lex(f.tail.join).w, { noun: f.tail.comp })
      }`
    : "";
  const subj = f.subject ? `${subjText(f.subject, opts)} ` : "";
  return `${subj}${verb}${obj}${tail}${f.question ? "?" : "."}`;
}

export const he: GlyphLanguage = {
  id: "he",
  lexicon: L,
  fixed: {
    "i_me + help + you": "אני אעזור לך.",
    "i_me + help.not + you": "אני לא אעזור לך.",
    "i_me + think.not": (o) => (o.speaker === "f" ? "אני לא יודעת." : "אני לא יודע."),
    "i_me + understand.not": (o) => (o.speaker === "f" ? "אני לא מבינה." : "אני לא מבין."),
    "ok#question": (o) => (o.addressee === "f" ? "את בסדר?" : "אתה בסדר?"),
    "you + ok#question": (o) => (o.addressee === "f" ? "את בסדר?" : "אתה בסדר?"),
    confused: "לא הבנתי.",
    there: "שם!",
    thank_you: "תודה!",
    goodbye: "להתראות!",
    // Motive batch: the stay-with level-a line + the dwell-done thanks.
    stay: (o) => (o.addressee === "f" ? "תישארי איתי." : "תישאר איתי."),
    "i_me + ok + thank_you": "אני בסדר, תודה!",
  },
  render(frame: Frame, opts: Required<SpeakOpts>): string {
    NAMES = opts.names;
    switch (frame.kind) {
      case "word": {
        const t = frame.token;
        // A bare sensation ("cold" as a motive, or a "something hot" target at
        // level a) reads impersonal masculine — "קר"/"חם", not speaker-agreeing.
        if (SENSATION.has(t.head)) return lex(t.head).w;
        // Other bare adjectives (the sad greet, states) agree with the speaker.
        if (["sad", "happy", "big", "small", "clean", "dirty", "wet", "dry", "lonely", "hungry", "tired", "bored", "smelly", "thirsty", "scruffy"].includes(t.head)) {
          return adjForm(t.head, opts.speaker, false);
        }
        return lex(t.head).w;
      }
      case "np":
        return npText(frame.np, false);
      case "here": {
        // Pronoun subject reads gendered ("את כאן", "אני כאן"), never "האתה".
        const who = isPronoun(frame.np.noun.head)
          ? subjText(frame.np.noun, opts)
          : npText(frame.np, true);
        return `${who} ${frame.where === "here" ? "כאן" : "שם"}.`;
      }
      case "mine":
        return frame.no ? `לא — ${npText(frame.np, true)}!` : npText(frame.np, true);
      case "corrective": {
        // "The offered one isn't {adj}" — a full negated predicate sentence.
        if (!frame.np) return `לא ${adjForm(frame.adj.head, opts.speaker, false)}.`;
        const g = nounGender(frame.np.noun);
        const pl = nounPlural(frame.np.noun);
        return `${npText(frame.np, true)} לא ${adjForm(frame.adj.head, g, pl)}.`;
      }
      case "where":
        if (!frame.np) return "איפה?";
        if (frame.get) return `איפה אפשר להשיג ${et(frame.np)}?`;
        // "איפה אתה?" / "איפה את?" — the gendered subject form, never "האתה".
        if (isPronoun(frame.np.noun.head)) return `איפה ${subjText(frame.np.noun, opts)}?`;
        return `איפה ${npText(frame.np, true)}?`;
      case "what-want":
        return opts.addressee === "f" ? "מה את רוצה?" : "מה אתה רוצה?";
      case "copula": {
        const s = frame.subject;
        // Bodily sensation is EXPERIENTIAL: "קר לי" (cold to-me), "חם לדוב" —
        // the impersonal adjective + a dative, not "אני קר".
        if (SENSATION.has(frame.adj.head)) {
          // Negated sensation keeps the experiential shape: "לא קר לי".
          return `${frame.neg ? "לא " : ""}${lex(frame.adj.head).w} ${dative(s, opts.addressee)}${frame.question ? "?" : "."}`;
        }
        const g = subjGender(s, opts);
        const adj = adjForm(frame.adj.head, g, isPronoun(s.head) ? subjPlural(s) : nounPlural(s));
        return `${subjText(s, opts)} ${frame.neg ? "לא " : ""}${adj}${frame.question ? "?" : "."}`;
      }
      case "svo":
        return renderSvo(frame, opts);
      case "pp": {
        // Verbless fragment: "התפוח בקופסה." / "הכדור לדוב." / "התפוח בשבילך!"
        const np = npText(frame.np, true);
        if (frame.comp.head === "you") return `${np} בשבילך!`;
        if (frame.comp.head === "i_me") return `${np} בשבילי!`;
        const at =
          frame.join === "to"
            ? dative(frame.comp, opts.addressee)
            : prepNp(lex(frame.join).w, { noun: frame.comp });
        return `${np} ${at}.`;
      }
      case "trade":
        if (frame.what) return "להחליף תמורת מה?";
        if (frame.give && frame.get) {
          return `${npText(frame.give, true)} תמורת ${npText(frame.get, true)}?`;
        }
        if (frame.get) return `להחליף תמורת ${npText(frame.get, true)}?`;
        return "להחליף?";
      case "causal": {
        // The connective word ("כי", "כדי ש", "עד ש"); those ending in ש attach
        // to the following word ("כדי שהדוב שמח").
        const conn = lex(frame.connective).w;
        const attach = conn.endsWith("ש");
        const cause = stripEnd(he.render(frame.cause, opts));
        const joined = attach ? `${conn}${cause}` : `${conn} ${cause}`;
        if (!frame.effect) return `${joined}.`;
        return `${stripEnd(he.render(frame.effect, opts))} ${joined}.`;
      }
      case "why":
        if (!frame.thing) return "למה?";
        return `למה ${opts.addressee === "f" ? "את" : "אתה"} רוצה ${npText(frame.thing, false)}?`;
      case "device": {
        // "אני רוצה שהמנורה דלוקה" — I want [that] the {device} [be] {state},
        // the state adjective agreeing with the device's gender.
        const dev = npText({ noun: frame.device }, true);
        const st = adjForm(frame.state.head, nounGender(frame.device), nounPlural(frame.device));
        return `אני רוצה ש${dev} ${st}.`;
      }
      case "wantTo": {
        // "אני רוצה לשחק" — want + infinitive, the finite verb agreeing;
        // negated: "אני לא רוצה לשחק".
        const inf = lex(frame.verb.head).inf ?? lex(frame.verb.head).w;
        return `אני ${frame.neg ? "לא " : ""}${verbForm("want", opts.speaker)} ${inf}.`;
      }
      case "going": {
        // Movement: "אני הולך הביתה" / "אני הולכת לשוק" / imperative "לך הביתה."
        const dest = frame.fetch
          ? `להביא ${npText(frame.fetch, false)}`
          : frame.dest!.head === "home"
            ? "הביתה"
            : frame.dest!.head === "here"
              ? "לכאן"
              : frame.dest!.head === "there"
                ? "לשם"
                : fuse("ל", { noun: frame.dest! });
        const s = frame.subject;
        if (s?.head === "you") return `${opts.addressee === "f" ? "לכי" : "לך"} ${dest}.`;
        if (!s || s.head === "i_me") {
          return `אני ${opts.speaker === "f" ? "הולכת" : "הולך"} ${dest}.`;
        }
        // A collective subject walks in the plural ("אנחנו הולכים לשוק").
        if (subjPlural(s)) return `${subjText(s, opts)} ${verbForm("go", "m", true)} ${dest}.`;
        return `${npText({ noun: s }, true)} ${nounGender(s) === "f" ? "הולכת" : "הולך"} ${dest}.`;
      }
      case "whereGoing":
        return opts.addressee === "f" ? "לאן את הולכת?" : "לאן אתה הולך?";
      case "takeMeTo":
        // Gendered imperative + pronoun object: "קח אותי לדוב."
        return `${opts.addressee === "f" ? "קחי" : "קח"} אותי ${fuse("ל", { noun: frame.dest })}.`;
      case "stayWith":
        return `${opts.addressee === "f" ? "תישארי" : "תישאר"} איתי.`;
      case "directions": {
        // Present-tense location — no copula ("הכדור כאן"). קרוב/רחוק agree with
        // the thing; the cardinal reads "לכיוון צפון" (toward the north).
        const np = npText(frame.np, true);
        const g = nounGender(frame.np.noun);
        const pl = nounPlural(frame.np.noun);
        const dir = lex(frame.cardinal).w;
        const tail =
          frame.proximity === "here"
            ? "כאן"
            : frame.proximity === "there"
              ? "שם"
              : frame.proximity === "street"
                ? "ברחוב הזה"
                : `${adjForm(frame.proximity, g, pl)}, לכיוון ${dir}`;
        return `${np} ${tail}.`;
      }
      case "gloss":
        return gloss(he, frame.tokens, "לא");
    }
  },
};
