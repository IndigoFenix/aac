// shared/world-engine/interaction/lang/romance.ts
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
  DEVICE_STATE,
  gloss,
  isDeicticNoun,
  isUnspokenMod,
  isIntentVerb,
  isPronoun,
  isQuality,
  NO_NAMES,
  stripEnd,
  type DirProximity,
  type Frame,
  type Gender,
  type GlyphLanguage,
  type Lexeme,
  type NP,
  type PronounHead,
  type SpeakOpts,
  type Token,
} from "./core.js";

/** Inherent qualities take ser; transient states/feelings/device-toggles take
 *  estar ("la lámpara está encendida", "la ventana está abierta"). */
const STATEY = new Set([
  "hot", "cold", "clean", "dirty", "wet", "dry", "sad", "happy", "ok", "lonely", "smelly",
  "on", "off", "open", "closed",
]);

/** Bodily sensations rendered EXPERIENTIALLY per language (es tener-noun,
 *  pt estar-com-noun) — hungry/thirsty join hot/cold here (but NOT in the
 *  Hebrew dative set: "אני רעב"/"אני צמא" are plain adjectives there). */
const FEEL = new Set(["hot", "cold", "hungry", "thirsty"]);

export interface RomanceConfig {
  id: string;
  lexicon: Record<string, Lexeme>;
  notWord: string; // "no" / "não"
  moreWord: string; // "más" / "mais"
  /** Article ("" = none): definite/indefinite × gender × number/mass. */
  art(def: boolean, g: Gender, pl: boolean, mass: boolean): string;
  /** Demonstrative determiner for the `.this` deictic ("este/esta…") —
   *  replaces the article on a particular-instance NP. */
  dem(g: Gender, pl: boolean): string;
  /** Possessive "my", agreeing with the noun. */
  my(g: Gender, pl: boolean): string;
  /** First-person going-to future for the `.will` intent marker ("voy a
   *  comer" / "vou comer") — receives the infinitive (or base form). */
  intentGo(inf: string): string;
  /** Comitative preposition for play/talk objects ("con" / "com"). */
  withWord: string;
  /** "you" conjugates as 3rd person (Brazilian você). */
  youIsThird?: boolean;
  /** Subject pronouns; "" drops the pronoun (Spanish pro-drop). */
  pronoun(head: PronounHead): string;
  /** Object CLITIC, placed before the verb ("te ayudo", "me dá"). */
  clitic(head: PronounHead): string;
  /** TONIC form under a preposition ("a ti", "para mim"). */
  tonic(head: PronounHead): string;
  /** Preference with a pronoun object ("Me gustas." / "Eu gosto de você.") —
   *  the head is the OBJECT of like ("i_me like you" arrives as "you"). */
  likePron(head: PronounHead): string;
  /** estar (states) + ser (qualities) forms. `v1p` is the collective "we are"
   *  ("estamos") — optional, falling back to the 3rd-plural form. */
  estar: { v1: string; v2: string; v3: string; v3p: string; v1p?: string };
  ser: { v3: string; v3p: string };
  /** Prepositions over an already-articled definite NP (handle contractions). */
  to(np: string, g: Gender, pl: boolean): string;
  inside(np: string, g: Gender, pl: boolean): string;
  forTrade(np: string, g: Gender, pl: boolean): string;
  /** THE PROXIMITY PAIR — "cerca de la mesa" / "perto da mesa" (the vicinity)
   *  and "al lado de la mesa" / "ao lado da mesa" (the adjacent spot). Their
   *  own entries because the de-contraction is the language's, and because
   *  falling back to `to` would say "to the table" for an order that means
   *  BESIDE it. */
  near(np: string, g: Gender, pl: boolean): string;
  nextTo(np: string, g: Gender, pl: boolean): string;
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
  /** "algo" — the head of a bare-quality want ("algo caliente"). */
  something: string;
  /** OF over an articled NP, contracted (pt de+o → do) — for verbs whose
   *  Lexeme sets `objPrep: "of"`. Absent = objects stay bare. */
  of?(np: string, g: Gender, pl: boolean): string;
  /** Experiential sensation clause: "Tengo frío / hambre / sed" / "Estou com
   *  calor / fome / sede" — hot/cold/hungry/thirsty are NOT plain
   *  estar-adjectives. */
  feel(head: "hot" | "cold" | "hungry" | "thirsty", subject: Token): string;
  /** Preference clause ("Me gusta la galleta." / "Eu gosto do biscoito."):
   *  a definite NP (text pre-built, plurality given), or a bare QUALITY word
   *  ("el rojo" / "vermelho"). */
  like(obj: { kind: "np"; text: string; plural: boolean } | { kind: "quality"; word: string }): string;
  /** Want + infinitive ("Quiero jugar." / "Quero brincar."). */
  wantTo(inf: string): string;
  /** Placement INABILITY (construction v1): "No puedo poner X ahí." /
   *  "Não posso pôr X aí." — a negated `put` reads as can't, not habit. */
  cantPut(obj: string): string;
  /** Movement (the going frame). `dest` arrives pre-phrased (contractions via
   *  `to`, or the bare `home`/`fetch` forms below). */
  going: {
    i(dest: string): string; // "Voy a casa." / "Vou para casa."
    you(dest: string): string; // the imperative "Ve a casa." / "Vai para casa."
    third(subj: string, dest: string): string; // "Mara va al mercado."
    home: string; // "a casa" / "para casa"
    fetch(np: string): string; // "a buscar comida" / "buscar comida"
    where: string; // "¿Adónde vas?" / "Aonde você vai?"
  };
  /** The escort ask ("Llévame con el oso." / "Me leva até o urso."). */
  takeMeTo(np: string): string;
  /** The company ask ("Quédate conmigo." / "Fica comigo."). */
  stayWithMe: string;
  /** The directions answer ("La casa está cerca, al norte." / "A casa está
   *  perto, ao norte."). `np` arrives capitalized + definite; `be` is the estar
   *  form agreeing with the thing's number; `dir` is the cardinal word. */
  directions(np: string, be: string, proximity: DirProximity, dir: string): string;
  /** Spoilage smell-verb forms ("huele/huelen" / "cheira/cheiram"). */
  smell: { v3: string; v3p: string };
  /** Connective word for the causal frame ("porque", "para", "por eso"). */
  connective(head: string): string;
  /** "¿Por qué?" / "Por quê?" and the full "…do you want X?" form. */
  why: string;
  whyWant(obj: string): string;
  /** Question wrapper ("¿…?" vs "…?"). */
  q(s: string): string;
  fixed: GlyphLanguage["fixed"];
}

export function makeRomance(cfg: RomanceConfig): GlyphLanguage {
  const lex = (head: string): Lexeme => cfg.lexicon[head] ?? { w: head };
  /** The active sentence's PROPER-NOUN book (SpeakOpts.names) — set per render.
   *  A name never takes an article; adjectives agree with the bearer's gender. */
  let NAMES: ReadonlyMap<string, Gender> = NO_NAMES;
  const nameWord = (head: string): string => head.charAt(0).toUpperCase() + head.slice(1);
  const g = (t: Token): Gender => NAMES.get(t.head) ?? lex(t.head).g ?? "m";
  const pl = (t: Token) => !NAMES.has(t.head) && !!lex(t.head).pl;
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
    // A pronoun is never an articled NP — the tonic form stands alone / under
    // a preposition ("a ti", "para mim"), never "el tú".
    if (isPronoun(np.noun.head)) return cfg.tonic(np.noun.head as PronounHead);
    // A NAME never takes an article ("Mara está hambrienta", not "la Mara").
    if (NAMES.has(np.noun.head)) {
      const gen = NAMES.get(np.noun.head)!;
      const adjs = np.noun.mods
        .filter((m) => m !== "my" && m !== "not" && !isUnspokenMod(m))
        .map((m) => adjForm(m, gen, false));
      return [nameWord(np.noun.head), ...adjs].join(" ");
    }
    // A bare QUALITY want ("algo caliente") — masculine, the property alone.
    if (isQuality(np.noun.head)) {
      const extra = np.noun.mods.filter((m) => m !== "not").map((m) => adjForm(m, "m", false));
      return `${cfg.something} ${[adjForm(np.noun.head, "m", false), ...extra].join(" ")}`;
    }
    const gen = g(np.noun);
    const plural = pl(np.noun) || !!np.more;
    const my = np.noun.mods.includes("my");
    const x = lex(np.noun.head);
    const noun = plural && !pl(np.noun) && !mass(np.noun) ? pluralWord(x) : x.w;
    const adjs = np.noun.mods
      .filter((m) => m !== "my" && m !== "not" && !isUnspokenMod(m))
      .map((m) => adjForm(m, gen, plural));
    const core = [noun, ...adjs].join(" ");
    if (np.more) return `${cfg.moreWord} ${core}`;
    if (my) return `${cfg.my(gen, plural)} ${core}`;
    // The deictic (.this): demonstrative determiner replaces the article
    // ("esta manzana", "este juguete").
    if (isDeicticNoun(np.noun)) return `${cfg.dem(gen, plural)} ${core}`;
    const art = cfg.art(def, gen, plural, mass(np.noun));
    return art ? `${art} ${core}` : core;
  }

  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const lc = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

  /** Verb form by subject: i_me → 1sg, you → 2sg (or 3sg), we → 1pl, they →
   *  3pl, noun → 3sg/3pl. */
  function conj(verb: Token, subject: Token | undefined, neg: boolean): string {
    const v = lex(verb.head);
    let form = v.w;
    if (subject && subject.head !== "i_me") {
      if (subject.head === "you") form = cfg.youIsThird ? (v.v3 ?? v.w) : (v.v2 ?? v.w);
      // The collective voice (nations P6): "we" is 1st-PLURAL ("luchamos"),
      // "they" the 3rd-plural a noun subject already reaches.
      else if (subject.head === "we") form = v.v1p ?? v.w;
      else if (subject.head === "they") form = v.v3p ?? v.v3 ?? v.w;
      else form = pl(subject) ? (v.v3p ?? v.v3 ?? v.w) : (v.v3 ?? v.w);
    }
    return neg ? `${cfg.notWord} ${form}` : form;
  }

  /** estar form for a PRONOUN subject (pro-drop still governs the pronoun). */
  function pronBe(h: PronounHead): string {
    if (h === "i_me") return cfg.estar.v1;
    if (h === "you") return cfg.youIsThird ? cfg.estar.v3 : cfg.estar.v2;
    if (h === "we") return cfg.estar.v1p ?? cfg.estar.v3p;
    return cfg.estar.v3p;
  }

  function subjText(t: Token): string {
    if (isPronoun(t.head)) return cfg.pronoun(t.head as PronounHead);
    return npText({ noun: t }, true);
  }

  /** The PP a JOIN word builds over an articled NP. Each language owns its own
   *  contraction (a+el → al, de+o → do), so the choice lives here and the
   *  rulesets only supply the phrases. An unknown join reads directionally
   *  ("a la mesa") — the long-standing default. */
  function joinPhrase(join: string, comp: Token): string {
    const np = npText({ noun: comp }, true);
    const gen = g(comp);
    const plural = pl(comp);
    switch (join) {
      case "in": return cfg.inside(np, gen, plural);
      case "for": return cfg.forTrade(np, gen, plural);
      case "near": return cfg.near(np, gen, plural);
      case "next_to": return cfg.nextTo(np, gen, plural);
      case "under":
      case "over":
      case "behind":
      case "in_front_of": {
        // All four gloss as "<base> de" in the ruleset's lexicon; `of` owns
        // each language's de-contraction ("detrás DEL mercado", "atrás DO
        // mercado"), so the base is the gloss minus its trailing "de".
        const base = lex(join).w.replace(/ de$/, "");
        return `${base} ${cfg.of ? cfg.of(np, gen, plural) : `de ${np}`}`;
      }
      default: return cfg.to(np, gen, plural);
    }
  }

  function renderSvo(f: Extract<Frame, { kind: "svo" }>, opts: Required<SpeakOpts>): string {
    // A negated PUT is INABILITY (construction v1's placement refusal).
    if (f.verb.head === "put" && f.neg) {
      return cfg.cantPut(f.object ? npText(f.object, true) : "");
    }
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
    // Preferences route through the language's own construction (gustar /
    // gostar de) — a QUALITY object reads as the bare color/state word; a
    // PRONOUN object flips through the experiencer form ("Me gustas.").
    if (f.verb.head === "like" && f.object && !f.neg) {
      const o = f.object.noun;
      if (isPronoun(o.head)) return cfg.likePron(o.head as PronounHead);
      return cfg.like(
        isQuality(o.head)
          ? { kind: "quality", word: adjForm(o.head, "m", false) }
          : { kind: "np", text: npText(f.object, true), plural: pl(o) },
      );
    }
    // A bare PRONOUN object is a preverbal CLITIC ("te ayudo", "no me quiere"),
    // never an articled NP after the verb. PLAY/TALK are the exception — they
    // ride the comitative ("hablo con él", never the clitic "lo hablo").
    if (
      f.object &&
      isPronoun(f.object.noun.head) &&
      !f.tail &&
      f.verb.head !== "play" &&
      f.verb.head !== "talk"
    ) {
      const head = f.object.noun.head as PronounHead;
      const subj = f.subject ? subjText(f.subject) : "";
      const s = `${subj ? `${subj} ` : ""}${f.neg ? `${cfg.notWord} ` : ""}${cfg.clitic(head)} ${conj(f.verb, f.subject, false)}`;
      return f.question ? cfg.q(cap(s.trim())) : `${cap(s.trim())}.`;
    }
    // A will-marked verb is a STATEMENT OF INTENT — always first person.
    if (isIntentVerb(f.verb) && !f.subject) {
      f = { ...f, subject: { head: "i_me", mods: [], q: false } };
    }
    const def = f.verb.head !== "want" || f.neg || !!f.tail;
    // A verb governing a preposition wraps its object through the ruleset's
    // contraction ("preciso DO banheiro") — plain verbs take the bare NP.
    // PLAY/TALK objects ride the comitative ("juego con la pelota", "falo com
    // a Mara" — well, with the plain article).
    const objNp = f.object ? npText(f.object, def) : "";
    const obj = f.object
      ? ` ${
          f.verb.head === "play" || f.verb.head === "talk"
            ? `${cfg.withWord} ${objNp}`
            : lex(f.verb.head).objPrep === "of" && cfg.of
              ? cfg.of(objNp, g(f.object.noun), pl(f.object.noun))
              : objNp
        }`
      : "";
    const tail = f.tail ? ` ${joinPhrase(f.tail.join, f.tail.comp)}` : "";
    const subj = f.subject ? subjText(f.subject) : "";
    // The intent construction ("voy a comer…" / "vou comer…") — the going-to
    // future over the infinitive, preverbal negation over the whole complex.
    const verb =
      isIntentVerb(f.verb) && f.subject?.head === "i_me"
        ? `${f.neg ? `${cfg.notWord} ` : ""}${cfg.intentGo(lex(f.verb.head).inf ?? lex(f.verb.head).w)}`
        : conj(f.verb, f.subject, f.neg);
    const s = `${subj ? `${subj} ` : ""}${verb}${obj}${tail}`.trim();
    return f.question ? cfg.q(cap(s)) : `${cap(s)}.`;
  }

  const lang: GlyphLanguage = {
    id: cfg.id,
    lexicon: cfg.lexicon,
    fixed: cfg.fixed,
    render(frame: Frame, opts: Required<SpeakOpts>): string {
      NAMES = opts.names;
      switch (frame.kind) {
        case "word": {
          const t = frame.token;
          // A device state names the DEVICE's state, not the speaker's — masc base.
          if (DEVICE_STATE.has(t.head)) return adjForm(t.head, "m", false);
          if (STATEY.has(t.head) || t.head === "big" || t.head === "small") {
            return adjForm(t.head, opts.speaker, false);
          }
          return lex(t.head).w;
        }
        case "np":
          return npText(frame.np, false);
        case "here": {
          const at = frame.where === "here" ? lex("here").w : lex("there").w;
          // Pronoun subject: "Estoy aquí." / "Você está aqui."
          if (isPronoun(frame.np.noun.head)) {
            const h = frame.np.noun.head as PronounHead;
            const subj = cfg.pronoun(h);
            return `${cap(`${subj ? `${subj} ` : ""}${pronBe(h)} ${at}`)}.`;
          }
          const isPl = pl(frame.np.noun);
          const be = isPl ? cfg.estar.v3p : cfg.estar.v3;
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
          // "¿Dónde estás?" / "Onde você está?" — conjugated, never "el tú".
          if (isPronoun(frame.np.noun.head)) {
            const h = frame.np.noun.head as PronounHead;
            const subj = cfg.pronoun(h);
            return cfg.q(cap(`${lex("place").w} ${subj ? `${subj} ` : ""}${pronBe(h)}`));
          }
          return cfg.whereIs(npText(frame.np, true), pl(frame.np.noun));
        case "what-want":
          return cfg.whatWant;
        case "copula": {
          const s = frame.subject;
          // Bodily sensation is experiential ("Tengo frío / hambre") — negation
          // stays preverbal on the whole construction ("No tengo hambre").
          if (FEEL.has(frame.adj.head)) {
            let c = cfg.feel(frame.adj.head as "hot" | "cold" | "hungry" | "thirsty", s);
            if (frame.neg) c = cap(`${cfg.notWord} ${c.charAt(0).toLowerCase()}${c.slice(1)}`);
            // A NOUN/NAME subject leads the experiential clause ("Mara tiene
            // hambre.", "El oso tiene frío.") — never a bare ambiguous "Tiene".
            // A PRONOUN subject is carried by feel()'s own verb person.
            if (!isPronoun(s.head)) c = `${cap(npText({ noun: s }, true))} ${lc(c)}`;
            return frame.question ? cfg.q(cap(stripEnd(c))) : c;
          }
          // Spoilage reads as a smell VERB ("El pescado huele mal.").
          if (frame.adj.head === "smelly" && !isPronoun(s.head)) {
            const np = cap(npText({ noun: s }, true));
            const v = pl(s) ? cfg.smell.v3p : cfg.smell.v3;
            return `${np} ${frame.neg ? `${cfg.notWord} ` : ""}${v} mal${frame.question ? "?" : "."}`;
          }
          const adj = adjForm(
            frame.adj.head,
            s.head === "i_me" ? opts.speaker : s.head === "you" ? opts.addressee : g(s),
            s.head === "i_me" || s.head === "you" ? false : pl(s),
          );
          const be = isPronoun(s.head)
            ? pronBe(s.head as PronounHead)
            : pl(s)
              ? cfg.estar.v3p
              : cfg.estar.v3;
          const subj = subjText(s);
          const body = `${subj ? `${subj} ` : ""}${frame.neg ? `${cfg.notWord} ` : ""}${be} ${adj}`;
          return frame.question ? cfg.q(cap(body)) : `${cap(body)}.`;
        }
        case "svo":
          return renderSvo(frame, opts);
        case "pp": {
          const np = cap(npText(frame.np, true));
          if (frame.comp.head === "you") return cfg.forYou(np);
          if (frame.comp.head === "i_me") return cfg.forMe(np);
          if (frame.join === "in" || frame.join === "near" || frame.join === "next_to" ||
              frame.join === "under" || frame.join === "over" || frame.join === "behind" || frame.join === "in_front_of") {
            // Locative clue — full estar sentence ("La pelota está en la casa azul.",
            // "La silla está cerca de la mesa.", "…al lado de la mesa.").
            const be = pl(frame.np.noun) ? cfg.estar.v3p : cfg.estar.v3;
            return `${np} ${be} ${joinPhrase(frame.join, frame.comp)}.`;
          }
          return `${np} — ${joinPhrase("to", frame.comp)}.`;
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
        case "causal": {
          const conn = cfg.connective(frame.connective);
          const cause = lc(stripEnd(lang.render(frame.cause, opts)));
          if (!frame.effect) return `${cap(conn)} ${cause}.`;
          return `${stripEnd(lang.render(frame.effect, opts))} ${conn} ${cause}.`;
        }
        case "why":
          if (!frame.thing) return cfg.why;
          return cfg.whyWant(npText(frame.thing, false));
        case "device": {
          // Resultative want: "Quiero la lámpara encendida." / "Quero a janela
          // aberta." — the state adjective agrees with the device.
          const dev = npText({ noun: frame.device }, true);
          const st = adjForm(frame.state.head, g(frame.device), pl(frame.device));
          const verb = cap(conj({ head: "want", mods: [], q: false }, frame.subject, false));
          return `${verb} ${dev} ${st}.`;
        }
        case "wantTo": {
          const v = lex(frame.verb.head);
          const c = cfg.wantTo(v.inf ?? v.w);
          // Negation is preverbal on the whole construction ("No quiero jugar").
          return frame.neg ? cap(`${cfg.notWord} ${c.charAt(0).toLowerCase()}${c.slice(1)}`) : c;
        }
        case "going": {
          const d = frame.fetch
            ? cfg.going.fetch(npText(frame.fetch, false))
            : frame.dest!.head === "home"
              ? cfg.going.home
              : frame.dest!.head === "here" || frame.dest!.head === "there"
                ? lex(frame.dest!.head).w
                : cfg.to(npText({ noun: frame.dest! }, true), g(frame.dest!), pl(frame.dest!));
          const s = frame.subject;
          if (!s || s.head === "i_me") return cfg.going.i(d);
          if (s.head === "you") return cfg.going.you(d);
          return cfg.going.third(cap(npText({ noun: s }, true)), d);
        }
        case "whereGoing":
          return cfg.going.where;
        case "takeMeTo":
          return cfg.takeMeTo(npText({ noun: frame.dest }, true));
        case "stayWith":
          return cfg.stayWithMe;
        case "directions": {
          const np = cap(npText(frame.np, true));
          const be = pl(frame.np.noun) ? cfg.estar.v3p : cfg.estar.v3;
          const dir = lex(frame.cardinal).w;
          return cfg.directions(np, be, frame.proximity, dir);
        }
        case "gloss":
          return gloss(lang, frame.tokens, cfg.notWord);
      }
    },
  };
  return lang;
}
