// shared/symbol-game/lang/romance.ts — one shared ruleset for the Romance
// languages that stem from it with minimal modification (Spanish, Portuguese).
//
// Shared structure: SVO, preverbal negation (no/não), gendered articles,
// adjectives AFTER the noun agreeing in gender/number, pro-drop-ish subjects,
// estar for states/feelings vs ser for inherent qualities. Each language
// supplies its lexicon, articles, contractions (al/na/pela…) and templates.
//
// French/Italian were DEFERRED: French adds elision (l'), ne…pas negation and
// pre-nominal adjectives — no longer "minimal modification" of these rules.

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

/** Inherent qualities take ser; transient states/feelings take estar. */
const STATEY = new Set(["hot", "cold", "clean", "dirty", "wet", "dry", "sad", "happy", "ok"]);

export interface RomanceConfig {
  id: string;
  lexicon: Record<string, Lexeme>;
  notWord: string; // "no" / "não"
  moreWord: string; // "más" / "mais"
  /** Article ("" = none): definite/indefinite × gender × number/mass. */
  art(def: boolean, g: Gender, pl: boolean, mass: boolean): string;
  /** Possessive "my", agreeing with the noun. */
  my(g: Gender, pl: boolean): string;
  /** "you" conjugates as 3rd person (Brazilian você). */
  youIsThird?: boolean;
  /** Subject pronouns; "" drops the pronoun (Spanish pro-drop). */
  pronoun(head: "i_me" | "you"): string;
  /** estar (states) + ser (qualities) forms. */
  estar: { v1: string; v2: string; v3: string; v3p: string };
  ser: { v3: string; v3p: string };
  /** Prepositions over an already-articled definite NP (handle contractions). */
  to(np: string, g: Gender, pl: boolean): string;
  inside(np: string, g: Gender, pl: boolean): string;
  forTrade(np: string, g: Gender, pl: boolean): string;
  /** Request/offer templates (obj arrives definite). */
  giveMe(obj: string): string;
  giveTo(obj: string, toPhrase: string): string;
  forYou(obj: string): string;
  forMe(obj: string): string;
  offer(obj: string, neg: boolean): string;
  whereIs(np: string, pl: boolean): string;
  whereGet(np: string): string;
  whatWant: string;
  tradeWhat: string;
  tradeFor(forPhrase: string): string;
  /** Question wrapper ("¿…?" vs "…?"). */
  q(s: string): string;
  fixed: GlyphLanguage["fixed"];
}

export function makeRomance(cfg: RomanceConfig): GlyphLanguage {
  const lex = (head: string): Lexeme => cfg.lexicon[head] ?? { w: head };
  const g = (t: Token): Gender => lex(t.head).g ?? "m";
  const pl = (t: Token) => !!lex(t.head).pl;
  const mass = (t: Token) => !!lex(t.head).mass;

  const pluralWord = (x: Lexeme) =>
    x.plw ?? (/[aeiou]$/i.test(x.w) ? `${x.w}s` : `${x.w}es`);

  function adjForm(head: string, gen: Gender, plural: boolean): string {
    const a = lex(head);
    const base = gen === "f" ? (a.f ?? (a.w.endsWith("o") ? `${a.w.slice(0, -1)}a` : a.w)) : a.w;
    if (!plural) return base;
    if (gen === "f" && a.fpl) return a.fpl;
    if (gen === "m" && a.mpl) return a.mpl;
    return /[aeiou]$/i.test(base) ? `${base}s` : `${base}es`;
  }

  function npText(np: NP, def: boolean): string {
    const gen = g(np.noun);
    const plural = pl(np.noun) || !!np.more;
    const my = np.noun.mods.includes("my");
    const x = lex(np.noun.head);
    const noun = plural && !pl(np.noun) && !mass(np.noun) ? pluralWord(x) : x.w;
    const adjs = np.noun.mods
      .filter((m) => m !== "my" && m !== "not")
      .map((m) => adjForm(m, gen, plural));
    const core = [noun, ...adjs].join(" ");
    if (np.more) return `${cfg.moreWord} ${core}`;
    if (my) return `${cfg.my(gen, plural)} ${core}`;
    const art = cfg.art(def, gen, plural, mass(np.noun));
    return art ? `${art} ${core}` : core;
  }

  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  /** Verb form by subject: i_me → 1sg, you → 2sg (or 3sg), noun → 3sg/3pl. */
  function conj(verb: Token, subject: Token | undefined, neg: boolean): string {
    const v = lex(verb.head);
    let form = v.w;
    if (subject && subject.head !== "i_me") {
      if (subject.head === "you") form = cfg.youIsThird ? (v.v3 ?? v.w) : (v.v2 ?? v.w);
      else form = pl(subject) ? (v.v3p ?? v.v3 ?? v.w) : (v.v3 ?? v.w);
    }
    return neg ? `${cfg.notWord} ${form}` : form;
  }

  function subjText(t: Token): string {
    if (t.head === "i_me" || t.head === "you") return cfg.pronoun(t.head);
    return npText({ noun: t }, true);
  }

  function renderSvo(f: Extract<Frame, { kind: "svo" }>, opts: Required<SpeakOpts>): string {
    const giveAsAsk = !f.subject && !opts.firstPerson;
    if (f.verb.head === "give" && (giveAsAsk || f.subject?.head === "you") && f.object && !f.neg) {
      const obj = npText(f.object, true);
      const recip = f.tail?.comp;
      if (recip?.head === "you") return cfg.forYou(cap(obj));
      if (!recip || recip.head === "i_me") return cfg.giveMe(obj);
      return cfg.giveTo(obj, cfg.to(npText({ noun: recip }, true), g(recip), pl(recip)));
    }
    if (
      f.verb.head === "give" &&
      (f.subject?.head === "i_me" || (!f.subject && (f.neg || opts.firstPerson))) &&
      f.object
    ) {
      return cfg.offer(npText(f.object, true), f.neg);
    }
    const def = f.verb.head !== "want" || f.neg || !!f.tail;
    const obj = f.object ? ` ${npText(f.object, def)}` : "";
    const tail = f.tail
      ? ` ${
          f.tail.join === "in"
            ? cfg.inside(npText({ noun: f.tail.comp }, true), g(f.tail.comp), pl(f.tail.comp))
            : f.tail.join === "for"
              ? cfg.forTrade(npText({ noun: f.tail.comp }, true), g(f.tail.comp), pl(f.tail.comp))
              : cfg.to(npText({ noun: f.tail.comp }, true), g(f.tail.comp), pl(f.tail.comp))
        }`
      : "";
    const subj = f.subject ? subjText(f.subject) : "";
    const s = `${subj ? `${subj} ` : ""}${conj(f.verb, f.subject, f.neg)}${obj}${tail}`.trim();
    return f.question ? cfg.q(cap(s)) : `${cap(s)}.`;
  }

  const lang: GlyphLanguage = {
    id: cfg.id,
    lexicon: cfg.lexicon,
    fixed: cfg.fixed,
    render(frame: Frame, opts: Required<SpeakOpts>): string {
      switch (frame.kind) {
        case "word": {
          const t = frame.token;
          if (STATEY.has(t.head) || t.head === "big" || t.head === "small") {
            return adjForm(t.head, opts.speaker, false);
          }
          return lex(t.head).w;
        }
        case "np":
          return npText(frame.np, false);
        case "here": {
          const isPl = pl(frame.np.noun);
          const be = isPl ? cfg.estar.v3p : cfg.estar.v3;
          const at = frame.where === "here" ? lex("here").w : lex("there").w;
          return `${cap(npText(frame.np, true))} ${be} ${at}.`;
        }
        case "mine":
          return frame.no ? `${cap(cfg.notWord)} — ${npText(frame.np, false)}!` : npText(frame.np, false);
        case "corrective": {
          if (!frame.np) return `${cap(cfg.notWord)} ${adjForm(frame.adj.head, opts.speaker, false)}.`;
          const gen = g(frame.np.noun);
          const isPl = pl(frame.np.noun);
          const be = STATEY.has(frame.adj.head)
            ? isPl
              ? cfg.estar.v3p
              : cfg.estar.v3
            : isPl
              ? cfg.ser.v3p
              : cfg.ser.v3;
          return `${cap(npText(frame.np, true))} ${cfg.notWord} ${be} ${adjForm(frame.adj.head, gen, isPl)}.`;
        }
        case "where":
          if (!frame.np) return cfg.q(lex("place").w);
          if (frame.get) return cfg.whereGet(npText(frame.np, true));
          return cfg.whereIs(npText(frame.np, true), pl(frame.np.noun));
        case "what-want":
          return cfg.whatWant;
        case "copula": {
          const s = frame.subject;
          const adj = adjForm(
            frame.adj.head,
            s.head === "i_me" ? opts.speaker : s.head === "you" ? opts.addressee : g(s),
            s.head === "i_me" || s.head === "you" ? false : pl(s),
          );
          const be =
            s.head === "i_me"
              ? cfg.estar.v1
              : s.head === "you"
                ? cfg.youIsThird
                  ? cfg.estar.v3
                  : cfg.estar.v2
                : pl(s)
                  ? cfg.estar.v3p
                  : cfg.estar.v3;
          const subj = subjText(s);
          const body = `${subj ? `${subj} ` : ""}${be} ${adj}`;
          return frame.question ? cfg.q(cap(body)) : `${cap(body)}.`;
        }
        case "svo":
          return renderSvo(frame, opts);
        case "pp": {
          const np = cap(npText(frame.np, true));
          if (frame.comp.head === "you") return cfg.forYou(np);
          if (frame.comp.head === "i_me") return cfg.forMe(np);
          if (frame.join === "in") {
            // Locative clue — full estar sentence ("La pelota está en la casa azul.").
            const be = pl(frame.np.noun) ? cfg.estar.v3p : cfg.estar.v3;
            return `${np} ${be} ${cfg.inside(npText({ noun: frame.comp }, true), g(frame.comp), pl(frame.comp))}.`;
          }
          return `${np} — ${cfg.to(npText({ noun: frame.comp }, true), g(frame.comp), pl(frame.comp))}.`;
        }
        case "trade":
          if (frame.what) return cfg.tradeWhat;
          if (frame.give && frame.get) {
            return cfg.q(
              `${cap(npText(frame.give, true))} ${cfg
                .forTrade(npText(frame.get, true), g(frame.get.noun), pl(frame.get.noun))
                .trim()}`,
            );
          }
          if (frame.get) {
            return cfg.tradeFor(cfg.forTrade(npText(frame.get, true), g(frame.get.noun), pl(frame.get.noun)));
          }
          return cfg.tradeWhat;
        case "gloss":
          return gloss(lang, frame.tokens, cfg.notWord);
      }
    },
  };
  return lang;
}
