// shared/symbol-game/lang/he.ts — Hebrew rules for glyph-sentence translation.
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
  type Frame,
  type Gender,
  type GlyphLanguage,
  type Lexeme,
  type NP,
  type SpeakOpts,
  type Token,
} from "./core.js";

const L: Record<string, Lexeme> = {
  i_me: { w: "אני" },
  you: { w: "אתה", f: "את" },
  here: { w: "כאן" },
  there: { w: "שם" },
  want: { w: "רוצה", f: "רוצה" },
  give: { w: "נותן", f: "נותנת" },
  take: { w: "לוקח", f: "לוקחת" },
  get: { w: "מקבל", f: "מקבלת" },
  have: { w: "יש" },
  help: { w: "עוזר", f: "עוזרת" },
  think: { w: "חושב", f: "חושבת" },
  know: { w: "יודע", f: "יודעת" },
  trade: { w: "מחליף", f: "מחליפה" },
  to: { w: "ל" },
  in: { w: "ב" },
  on: { w: "על" },
  for: { w: "תמורת" },
  more: { w: "עוד" },
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
  home: { w: "בית", g: "m" },
  thing: { w: "דבר" },
  cookie: { w: "עוגייה", g: "f" },
  apple: { w: "תפוח", g: "m" },
  banana: { w: "בננה", g: "f" },
  grape: { w: "ענב", g: "m" },
  ball: { w: "כדור", g: "m" },
  car: { w: "מכונית", g: "f" },
  train: { w: "רכבת", g: "f" },
  blocks: { w: "קוביות", g: "f", pl: true },
  teddy: { w: "דובי", g: "m" },
  rabbit: { w: "ארנב", g: "m" },
  bear: { w: "דוב", g: "m" },
  frog: { w: "צפרדע", g: "f" },
  dog: { w: "כלב", g: "m" },
  box: { w: "קופסה", g: "f" },
  basket: { w: "סל", g: "m" },
  bubbles: { w: "בועות", g: "f", pl: true },
  sparks: { w: "ניצוצות", g: "m", pl: true },
  boat: { w: "סירה", g: "f" },
  broccoli: { w: "ברוקולי", g: "m", mass: true },
  sock: { w: "גרב", g: "m" },
  water: { w: "מים", g: "m", pl: true, mass: true },
  fire: { w: "אש", g: "f", mass: true },
};

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

/** Present-tense verb agreeing with a gendered singular subject. */
function verbForm(head: string, g: Gender): string {
  const v = lex(head);
  return g === "f" ? (v.f ?? suffix(v.w, "ת")) : v.w;
}

const nounGender = (t: Token): Gender => lex(t.head).g ?? "m";
const nounPlural = (t: Token) => !!lex(t.head).pl;

/**
 * Noun phrase: noun + agreeing adjectives, definite ה on BOTH when definite,
 * "שלי" after for possessives (always definite: "העוגייה שלי"), "עוד" for MORE.
 */
function npText(np: NP, def: boolean): string {
  const g = nounGender(np.noun);
  const pl = nounPlural(np.noun);
  const my = np.noun.mods.includes("my");
  const adjs = np.noun.mods
    .filter((m) => m !== "my" && m !== "not")
    .map((m) => adjForm(m, g, pl));
  const definite = def || my;
  const noun = definite ? `ה${lex(np.noun.head).w}` : lex(np.noun.head).w;
  const words = [noun, ...adjs.map((a) => (definite ? `ה${a}` : a))];
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

/** Dative for a person token: לי / לך / לדוב. */
function dative(t: Token, addressee: Gender): string {
  void addressee; // לך is spelled the same for both genders
  if (t.head === "i_me") return "לי";
  if (t.head === "you") return "לך";
  return fuse("ל", { noun: t });
}

function subjGender(t: Token | undefined, opts: Required<SpeakOpts>): Gender {
  if (!t || t.head === "i_me") return opts.speaker;
  if (t.head === "you") return opts.addressee;
  return nounGender(t);
}

function subjText(t: Token, opts: Required<SpeakOpts>): string {
  if (t.head === "i_me") return "אני";
  if (t.head === "you") return opts.addressee === "f" ? "את" : "אתה";
  return npText({ noun: t }, true);
}

function renderSvo(f: Extract<Frame, { kind: "svo" }>, opts: Required<SpeakOpts>): string {
  // -- possession: יש / אין ל־ ------------------------------------------------
  if (f.verb.head === "have") {
    const yesh = f.neg ? "אין" : "יש";
    const obj = f.object ? ` ${npText(f.object, false)}` : "";
    if (!f.subject || f.subject.head === "i_me" || f.subject.head === "you") {
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

  // The player's own subject-less statements are first person ("אני רוצה…").
  if (!f.subject && opts.firstPerson && f.verb.head !== "have") {
    f = { ...f, subject: { head: "i_me", mods: [], q: false } };
  }

  // -- the general present-tense frame ---------------------------------------
  const g = subjGender(f.subject, opts);
  const verb = `${f.neg ? "לא " : ""}${verbForm(f.verb.head, g)}`;
  // Wants are indefinite ("אני רוצה תפוח"); declines and placements name the
  // specific thing — definite, with את ("אני לא רוצה את הגרב").
  const objDef = f.verb.head !== "want" || f.neg || !!f.tail;
  const obj = f.object ? ` ${objDef ? et(f.object) : npText(f.object, false)}` : "";
  const tail = f.tail
    ? ` ${
        f.tail.join === "to"
          ? dative(f.tail.comp, opts.addressee)
          : f.tail.join === "for"
            ? `תמורת ${npText({ noun: f.tail.comp }, true)}`
            : fuse(lex(f.tail.join).w, { noun: f.tail.comp })
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
    "ok#question": (o) => (o.addressee === "f" ? "את בסדר?" : "אתה בסדר?"),
    "you + ok#question": (o) => (o.addressee === "f" ? "את בסדר?" : "אתה בסדר?"),
    confused: "לא הבנתי.",
    there: "שם!",
    thank_you: "תודה!",
    goodbye: "להתראות!",
  },
  render(frame: Frame, opts: Required<SpeakOpts>): string {
    switch (frame.kind) {
      case "word": {
        const t = frame.token;
        // A bare adjective (the sad greet, states) agrees with the speaker.
        if (["sad", "happy", "big", "small", "hot", "cold", "clean", "dirty", "wet", "dry"].includes(t.head)) {
          return adjForm(t.head, opts.speaker, false);
        }
        return lex(t.head).w;
      }
      case "np":
        return npText(frame.np, false);
      case "here":
        return `${npText(frame.np, true)} ${frame.where === "here" ? "כאן" : "שם"}.`;
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
        return `איפה ${npText(frame.np, true)}?`;
      case "what-want":
        return opts.addressee === "f" ? "מה את רוצה?" : "מה אתה רוצה?";
      case "copula": {
        const s = frame.subject;
        const g = subjGender(s, opts);
        const adj = adjForm(frame.adj.head, g, s.head === "i_me" || s.head === "you" ? false : nounPlural(s));
        return `${subjText(s, opts)} ${adj}${frame.question ? "?" : "."}`;
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
            : fuse(lex(frame.join).w, { noun: frame.comp });
        return `${np} ${at}.`;
      }
      case "trade":
        if (frame.what) return "להחליף תמורת מה?";
        if (frame.give && frame.get) {
          return `${npText(frame.give, true)} תמורת ${npText(frame.get, true)}?`;
        }
        if (frame.get) return `להחליף תמורת ${npText(frame.get, true)}?`;
        return "להחליף?";
      case "gloss":
        return gloss(he, frame.tokens, "לא");
    }
  },
};
