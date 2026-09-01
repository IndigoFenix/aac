// shared/world-engine/interaction/lang/pt.ts
// from the romance ruleset. você conjugates as 3rd person; em/por contract
// with the article (na caixa, pela bola); possessive agrees (meu/minha).

import { makeRomance } from "./romance.js";
import type { Lexeme } from "./core.js";
import { specWords } from "../content/words.js";

const CENTRAL: Record<string, Lexeme> = {
  i_me: { w: "eu" },
  you: { w: "você" },
  // The collective voice (nations P6) — plural, so agreement machinery
  // (adjectives, estar) reads them without extra branches.
  we: { w: "nós", pl: true },
  they: { w: "eles", pl: true },
  here: { w: "aqui" },
  there: { w: "ali" },
  // THE PROXIMITY PAIR — the gloss forms; a framed sentence goes through
  // `near()`/`nextTo()` below, which contract the article ("perto do mercado").
  near: { w: "perto de" },
  next_to: { w: "ao lado de" },
  // The vertical + facing placement pairs — all "<base> de" phrases; the
  // framed sentence goes through joinPhrase, which contracts via `of`.
  under: { w: "debaixo de" },
  over: { w: "em cima de" },
  behind: { w: "atrás de" },
  in_front_of: { w: "em frente de" },
  want: { w: "quero", v3: "quer", v3p: "querem", v1p: "queremos" },
  give: { w: "dou", v3: "dá", v3p: "dão", v1p: "damos" },
  take: { w: "pego", v3: "pega", v3p: "pegam", v1p: "pegamos" },
  // `inf` matters: the intent periphrasis ("vou conseguir a madeira") reads it,
  // and without one the will-marked fetch — the commonest builder line — came
  // out as "Eu vou consigo".
  get: { w: "consigo", v2: "consegues", v3: "consegue", v3p: "conseguem", v1p: "conseguimos", inf: "conseguir" },
  have: { w: "tenho", v3: "tem", v3p: "têm", v1p: "temos" },
  help: { w: "ajudo", v3: "ajuda", v3p: "ajudam" },
  think: { w: "penso", v3: "pensa", v3p: "pensam" },
  know: { w: "sei", v3: "sabe", v3p: "sabem" },
  understand: { w: "entendo", v3: "entende", v3p: "entendem", inf: "entender" },
  go: { w: "vou", v3: "vai", v3p: "vão", v1p: "vamos", inf: "ir" },
  // The movement gaits + pursuit family (semantic-gaps batch).
  run: { w: "corro", v3: "corre", v3p: "correm", inf: "correr" },
  chase: { w: "persigo", v3: "persegue", v3p: "perseguem", inf: "perseguir" },
  follow: { w: "sigo", v3: "segue", v3p: "seguem", inf: "seguir" },
  stop: { w: "paro", v3: "para", v3p: "param", inf: "parar" },
  // Board chrome's "go back" word (⑦) — the AAC glyph `return`.
  return: { w: "volto", v3: "volta", v3p: "voltam", inf: "voltar" },
  // Nations P6: the political verb the absolute taboo ring forbids, and the
  // places a people speaks of ("our town", "that area").
  fight: { w: "luto", v3: "luta", v3p: "lutam", v1p: "lutamos", inf: "lutar" },
  town: { w: "vila", g: "f" },
  area: { w: "área", g: "f" },
  trade: { w: "troco", v3: "troca", v3p: "trocam", v1p: "trocamos" },
  more: { w: "mais" },
  less: { w: "menos" },
  rare: { w: "raro" },
  easy: { w: "fácil" },
  hard: { w: "difícil" },
  yes: { w: "sim" },
  no: { w: "não" },
  ok: { w: "bem", f: "bem" },
  hi: { w: "oi" },
  goodbye: { w: "tchau" },
  thank_you: { w: "obrigado" },
  confused: { w: "confuso" },
  sad: { w: "triste", f: "triste" },
  happy: { w: "feliz", f: "feliz", mpl: "felizes", fpl: "felizes" },
  big: { w: "grande", f: "grande" },
  small: { w: "pequeno" },
  hot: { w: "quente", f: "quente" },
  cold: { w: "frio", f: "fria" },
  clean: { w: "limpo" },
  dirty: { w: "sujo" },
  wet: { w: "molhado" },
  dry: { w: "seco" },
  color_red: { w: "vermelho" },
  color_blue: { w: "azul", f: "azul", mpl: "azuis", fpl: "azuis" },
  color_green: { w: "verde", f: "verde" },
  color_yellow: { w: "amarelo" },
  color_orange: { w: "laranja", f: "laranja" },
  color_purple: { w: "roxo" },
  color_pink: { w: "rosa", f: "rosa" },
  color_brown: { w: "marrom", f: "marrom", mpl: "marrons", fpl: "marrons" },
  color_black: { w: "preto" },
  color_white: { w: "branco" },
  place: { w: "onde" },
  // Cardinal directions — the "perto/longe, ao norte" answers.
  north: { w: "norte" },
  south: { w: "sul" },
  east: { w: "leste" },
  west: { w: "oeste" },
  home: { w: "casa", g: "f" },
  work: { w: "trabalho", g: "m" },
  thing: { w: "quê" },
  doll: { w: "boneca", g: "f" },
  // Creature SPECIES words (reference resolution: "falo com o/a {espécie}").
  person: { w: "pessoa", g: "f", plw: "pessoas" },
  // KINSHIP AND ROLE WORDS (2026-08-24) — see en.ts.
  outside: { w: "fora", g: "m" },
  mom: { w: "mamãe", g: "f" },
  dad: { w: "papai", g: "m" },
  baby: { w: "bebê", g: "m", plw: "bebês" },
  girl: { w: "menina", g: "f" },
  boy: { w: "menino", g: "m" },
  friend: { w: "amigo", g: "m" },
  teacher: { w: "professor", g: "m" },
  street: { w: "rua", g: "f" },
  animal: { w: "animal", g: "m", plw: "animais" },
  plants: { w: "planta", g: "f" },
  individuals: { w: "minha gente", g: "f" },
  creature: { w: "criatura", g: "f" },
  // Devices (§5) + their toggle states (agree with the device's gender).
  on: { w: "aceso", f: "acesa" },
  off: { w: "apagado", f: "apagada" },
  open: { w: "aberto", f: "aberta" },
  closed: { w: "fechado", f: "fechada" },
  // Motive batch: verbs (infinitives for the want-to frame), conditions,
  // categories, new pool items.
  play: { w: "brinco", v1p: "brincamos", inf: "brincar" },
  read: { w: "leio", inf: "ler" },
  wear: { w: "me visto", inf: "me vestir" },
  color: { w: "coloro", v3: "colore", v3p: "colorem", v1p: "colorimos", inf: "colorir" },
  throw: { w: "jogo", v3: "joga", v3p: "jogam" },
  lonely: { w: "sozinho" },
  together: { w: "juntos" },
  hungry: { w: "faminto" }, // rarely surfaces — the feel() clause covers "i_me + hungry"
  tired: { w: "cansado" },
  bored: { w: "entediado" },
  smelly: { w: "fedido" },
  scruffy: { w: "desalinhado" },
  // Round-2 motives: thirst/hygiene conditions, the waste need, its stations.
  thirsty: { w: "sedento" },
  need: { w: "preciso", v2: "precisas", v3: "precisa", v3p: "precisam", objPrep: "of" }, // precisar DE
  // Construction v1: the placement verb + the refusal-cause quality.
  put: { w: "ponho", v2: "pões", v3: "põe", v3p: "põem", inf: "pôr" },
  good: { w: "bom", f: "boa" },
  bathroom: { w: "banheiro", g: "m" },
  water: { w: "água", g: "f", mass: true },
  food: { w: "comida", g: "f", mass: true },
  toy: { w: "brinquedo", g: "m" },
  clothing: { w: "roupa", g: "f", mass: true },
  // Attention/self-care verbs (attention-spark actions) — 1sg + infinitive
  // (the intent construction "vou comer" needs the infinitive).
  eat: { w: "como", v2: "comes", v3: "come", v3p: "comem", v1p: "comemos", inf: "comer" },
  drink: { w: "bebo", v2: "bebes", v3: "bebe", v3p: "bebem", v1p: "bebemos", inf: "beber" },
  see: { w: "vejo", v2: "vês", v3: "vê", v3p: "veem", v1p: "vemos", inf: "ver" },
  sleep: { w: "durmo", v2: "dormes", v3: "dorme", v3p: "dormem", v1p: "dormimos", inf: "dormir" },
  // THE POSTURE PAIR (build order L15) — live glyphs with no lexeme here, so
  // the open-ground dwell said "Eu rest." and the bare self-need "Eu sit."
  //
  // `sentar` takes no clitic in the Brazilian usage this ruleset is written in
  // ("eu sento na cadeira"), so unlike Spanish's sentarse it declines like any
  // other -ar verb; `você` conjugates 3rd person, which the `youIsThird` flag
  // already routes. Both carry the infinitive the going-to future reads
  // ("Eu vou descansar").
  rest: { w: "descanso", v2: "descansas", v3: "descansa", v3p: "descansam", v1p: "descansamos", inf: "descansar" },
  sit: { w: "sento", v2: "sentas", v3: "senta", v3p: "sentam", v1p: "sentamos", inf: "sentar" },
  wash: { w: "lavo", v2: "lavas", v3: "lava", v3p: "lavam", v1p: "lavamos", inf: "lavar" },
  tidy: { w: "arrumo", v2: "arrumas", v3: "arruma", v3p: "arrumam", inf: "arrumar" },
  heat: { w: "aqueço", v2: "aqueces", v3: "aquece", v3p: "aquecem", inf: "aquecer" },
  make_cold: { w: "esfrio", v2: "esfrias", v3: "esfria", v3p: "esfriam", inf: "esfriar" },
  talk: { w: "falo", v2: "falas", v3: "fala", v3p: "falam", v1p: "falamos", inf: "falar" },
  // Household CHORE verbs the needs templates speak ("vou cozinhar a comida").
  cook: { w: "cozinho", v2: "cozinhas", v3: "cozinha", v3p: "cozinham", inf: "cozinhar" },
  // ⚖️ WHY-CHAINS law ④ — the AUTHORITY link's verb ("…porque tu pedes").
  ask: { w: "peço", v2: "pedes", v3: "pede", v3p: "pedem", v1p: "pedimos", inf: "pedir" },
  // ⚖️ WHY-CHAINS law ④ — the BROAD ACTIVITY verb ("não faço nada").
  do: { w: "faço", v2: "fazes", v3: "faz", v3p: "fazem", v1p: "fazemos", inf: "fazer" },
  // City-founding areas — the map-reading overlay verb.
  show: { w: "mostro", v2: "mostras", v3: "mostra", v3p: "mostram", inf: "mostrar" },
  // City-founding ③ — the structure board's room words + the demolish verb.
  break: { w: "quebro", v2: "quebras", v3: "quebra", v3p: "quebram", inf: "quebrar" },
  // Construction ④ — the room-EMPTYING verb (break's stow-only twin).
  empty: { w: "esvazio", v2: "esvazias", v3: "esvazia", v3p: "esvaziam", inf: "esvaziar" },
  room: { w: "cômodo", g: "m" },
  // ── CONSTRUCTION VOCABULARY ───────────────────────────────────────────
  // The building trade shipped as live glyphs with no lexemes here, so a
  // builder said "Eu build o house" — the raw English keys inside a Portuguese
  // sentence, exactly the gap the furniture kinds had.
  // The materials and named structures now live on their spec rows
  // (content/words.ts) — what stays is the core pair and the trade's verbs.
  //
  // STRUCTURES — `house` is the dwelling as an ORDER; `home` stays the place
  // a creature goes back to.
  house: { w: "casa", g: "f" },
  building: { w: "prédio", g: "m" },
  yard: { w: "quintal", g: "m", plw: "quintais" },
  // TRADE VERBS — 1sg in `w`, plus the infinitive the intent periphrasis
  // ("vou construir") reads.
  build: { w: "construo", v2: "constróis", v3: "constrói", v3p: "constroem", v1p: "construímos", inf: "construir" },
  make: { w: "faço", v2: "fazes", v3: "faz", v3p: "fazem", v1p: "fazemos", inf: "fazer" },
  bring: { w: "trago", v2: "trazes", v3: "traz", v3p: "trazem", v1p: "trazemos", inf: "trazer" },
  carry: { w: "levo", v2: "levas", v3: "leva", v3p: "levam", v1p: "levamos", inf: "levar" },
  use: { w: "uso", v2: "usas", v3: "usa", v3p: "usam", v1p: "usamos", inf: "usar" },
  cut: { w: "corto", v2: "cortas", v3: "corta", v3p: "cortam", v1p: "cortamos", inf: "cortar" },
  // The completion state ("a casa está pronta").
  finished: { w: "pronto", f: "pronta" },

  // ── BUILDER-REACHABLE VOCABULARY (validate-builder-lexicon) ──────────────
  // 84 words the sentence builder can put in front of a child — a category tab
  // lists its whole lexical category, the modifier rail draws AXIS_WORDS, a
  // group chip wears its cluster id — every one of which rendered as an ENGLISH
  // word on the Portuguese board, because `baseWord` falls back to the glyph id
  // and a glyph id is English. The same failure the construction trade had;
  // `npm run validate-builder-lexicon` now pins it.

  // Question words.
  what: { w: "o que" },
  where: { w: "onde" },
  who: { w: "quem" },
  how: { w: "como" },
  why: { w: "por que" },

  // Connectives. Where PT_CONN (below) carries a distinct sentence-joining
  // form, these are the BUTTON words — `connective()` now falls back to the
  // lexicon, so the two can no longer drift apart silently.
  and: { w: "e" },
  but: { w: "mas" },
  or: { w: "ou" },
  if: { w: "se" },
  so: { w: "então" },
  then: { w: "depois" },
  because: { w: "porque" },
  in_order_to: { w: "para que" },
  when: { w: "quando" },
  until: { w: "até que" },

  // Relations. `above` is "acima de", NOT "em cima de": `over` already owns
  // that phrase, and two placement buttons reading identically would be two
  // buttons a child cannot tell apart. `front` is the LEXICON key for the same
  // relation `in_front_of` spells out.
  from: { w: "de" },
  to: { w: "a" },
  in: { w: "em" },
  with: { w: "com" },
  for: { w: "para" },

  // Descriptors — the modifier rail's axes. The -o words need no `f`: the
  // ruleset's own -o→-a rule handles them. `bad` is the exception (mau/má).
  bad: { w: "mau", f: "má" },
  broken: { w: "quebrado" },
  full: { w: "cheio" },
  long: { w: "comprido" },
  short: { w: "curto" },
  tall: { w: "alto" },
  wide: { w: "largo" },
  thin: { w: "fino" },
  new: { w: "novo" },
  old: { w: "velho" },
  sick: { w: "doente" },
  warm: { w: "morno" },
  // The possession axis — rendered as a construction by `cfg.my` and filtered
  // out of the adjective walk; these are what the BUTTON and the gloss say.
  my: { w: "meu" },
  your: { w: "seu" },

  // Quantities (the fill + quantity axes, and the quantity tab).
  all: { w: "tudo" },
  many: { w: "muitos" },
  some: { w: "um pouco" },
  none: { w: "nada" },
  one: { w: "um" },
  two: { w: "dois" },
  three: { w: "três" },

  // Verbs — 1sg in `w`, plus the infinitive the intent periphrasis reads.
  // Brazilian forms throughout, matching this ruleset's `você` (youIsThird).
  come: { w: "venho", v2: "vens", v3: "vem", v3p: "vêm", v1p: "vimos", inf: "vir" },
  wait: { w: "espero", v2: "esperas", v3: "espera", v3p: "esperam", v1p: "esperamos", inf: "esperar" },
  stay: { w: "fico", v2: "ficas", v3: "fica", v3p: "ficam", v1p: "ficamos", inf: "ficar" },
  turn: { w: "viro", v2: "viras", v3: "vira", v3p: "viram", v1p: "viramos", inf: "virar" },
  push: { w: "empurro", v2: "empurras", v3: "empurra", v3p: "empurram", v1p: "empurramos", inf: "empurrar" },
  pull: { w: "puxo", v2: "puxas", v3: "puxa", v3p: "puxam", v1p: "puxamos", inf: "puxar" },
  drop: { w: "solto", v2: "soltas", v3: "solta", v3p: "soltam", v1p: "soltamos", inf: "soltar" },
  // "levantar" (lift into the hands), NOT "pegar": `take` above already owns
  // "pego"/"pegar". The two are different acts — take ACQUIRES, pick_up LIFTS —
  // and one word on both buttons would collapse that distinction on the board.
  pick_up: { w: "levanto", v2: "levantas", v3: "levanta", v3p: "levantam", v1p: "levantamos", inf: "levantar" },
  fill: { w: "encho", v2: "enches", v3: "enche", v3p: "enchem", v1p: "enchemos", inf: "encher" },
  fix: { w: "conserto", v2: "consertas", v3: "conserta", v3p: "consertam", v1p: "consertamos", inf: "consertar" },
  dig: { w: "cavo", v2: "cavas", v3: "cava", v3p: "cavam", v1p: "cavamos", inf: "cavar" },
  plant: { w: "planto", v2: "plantas", v3: "planta", v3p: "plantam", v1p: "plantamos", inf: "plantar" },
  shut: { w: "fecho", v2: "fechas", v3: "fecha", v3p: "fecham", v1p: "fechamos", inf: "fechar" },
  hug: { w: "abraço", v2: "abraças", v3: "abraça", v3p: "abraçam", v1p: "abraçamos", inf: "abraçar" },
  share: { w: "compartilho", v2: "compartilhas", v3: "compartilha", v3p: "compartilham", v1p: "compartilhamos", inf: "compartilhar" },
  teach: { w: "ensino", v2: "ensinas", v3: "ensina", v3p: "ensinam", v1p: "ensinamos", inf: "ensinar" },
  feel: { w: "sinto", v2: "sentes", v3: "sente", v3p: "sentem", v1p: "sentimos", inf: "sentir" },
  wake_up: { w: "acordo", v2: "acordas", v3: "acorda", v3p: "acordam", v1p: "acordamos", inf: "acordar" },
  brush_teeth: {
    w: "escovo os dentes", v2: "escovas os dentes", v3: "escova os dentes",
    v3p: "escovam os dentes", v1p: "escovamos os dentes", inf: "escovar os dentes",
  },
  like: { w: "gosto", v2: "gostas", v3: "gosta", v3p: "gostam", v1p: "gostamos", inf: "gostar" },

  // Social acts — each the alias of a word that already had a lexeme
  // (hi/hello, goodbye/bye, ok/okay, confused/dont_understand). BOTH spellings
  // are listed on the social tab, so both need words.
  thanks: { w: "obrigado" },
  sorry: { w: "desculpa" },
  mine: { w: "meu" },
  again: { w: "outra vez" },
  dont_understand: { w: "não entendo" },

  // Deixis the person tab lists beside i_me/you/we.
  this: { w: "isto" },
  that: { w: "isso" },

  // GROUP-CHIP LABELS — the object-property cluster ids. A chip wears
  // `baseWord(lang, id)`, so an untranslated id is an English chip on a
  // Portuguese board. food/toy/clothing/book already had words; these are the
  // nine that did not.
  container: { w: "recipiente", g: "m" },
  openable: { w: "abre" },
  device: { w: "aparelho", g: "m" },
  appliance: { w: "eletrodoméstico", g: "m" },
  tableware: { w: "louça", g: "f" },
  furniture: { w: "móvel", g: "m", plw: "móveis" },
  instrument: { w: "instrumento", g: "m" },
  material: { w: "material", g: "m", plw: "materiais" },
  structure: { w: "estrutura", g: "f" },
};

/** The ruleset's OWN words — grammar, verbs, adjectives, core concepts. Spec
 *  ITEMS live on their spec rows (content/words.ts joiner) and must not appear
 *  here too; the no-overlap conformance pin reads this export. */
export const CENTRAL_WORDS = CENTRAL;

/** The LIVE word table — central words ⊕ the spec items' own words. Built
 *  BEFORE the makeRomance call, which closes over it: an item's row is
 *  authoritative for its word, in gloss fallback and frame grammar alike. */
const L: Record<string, Lexeme> = { ...CENTRAL, ...specWords("pt") };

const PT_CONN: Record<string, string> = {
  because: "porque",
  so: "então",
  in_order_to: "para",
  when: "quando",
  until: "até",
};

export const pt = makeRomance({
  id: "pt",
  lexicon: L,
  notWord: "não",
  moreWord: "mais",
  art: (def, g, pl, mass) => {
    if (def) return g === "f" ? (pl ? "as" : "a") : pl ? "os" : "o";
    if (pl || mass) return "";
    return g === "f" ? "uma" : "um";
  },
  dem: (g, pl) => (g === "f" ? (pl ? "estas" : "esta") : pl ? "estes" : "este"),
  intentGo: (inf) => `vou ${inf}`,
  withWord: "com",
  my: (g, pl) => (g === "f" ? (pl ? "minhas" : "minha") : pl ? "meus" : "meu"),
  youIsThird: true,
  // Portuguese keeps the subject pronoun ("Nós não lutamos.").
  pronoun: (h) =>
    h === "i_me" ? "eu" : h === "you" ? "você" : h === "we" ? "nós" : h === "he" ? "ele" : h === "she" ? "ela" : "eles",
  // "Eu te ajudo." / "Ele não me quer." / "Você nos ajuda." / "Eu o/a ajudo." / "Eu os ajudo."
  clitic: (h) =>
    h === "i_me" ? "me" : h === "you" ? "te" : h === "we" ? "nos" : h === "he" ? "o" : h === "she" ? "a" : "os",
  // "para mim", "para você", "com nós", "com ele/ela", "para eles"
  tonic: (h) =>
    h === "i_me" ? "mim" : h === "you" ? "você" : h === "we" ? "nós" : h === "he" ? "ele" : h === "she" ? "ela" : "eles",
  likePron: (h) =>
    h === "i_me"
      ? "Você gosta de mim."
      : h === "you"
        ? "Eu gosto de você."
        : h === "we"
          ? "Você gosta de nós."
          : h === "he"
            ? "Eu gosto dele."
            : h === "she"
              ? "Eu gosto dela."
              : "Eu gosto deles.",
  estar: { v1: "estou", v2: "está", v3: "está", v3p: "estão", v1p: "estamos" },
  ser: { v3: "é", v3p: "são" },
  to: (np) => `para ${np}`,
  inside: (np) =>
    np.startsWith("a ") ? `na ${np.slice(2)}` : np.startsWith("o ") ? `no ${np.slice(2)}` : `em ${np}`,
  forTrade: (np) =>
    np.startsWith("a ") ? `pela ${np.slice(2)}` : np.startsWith("o ") ? `pelo ${np.slice(2)}` : `por ${np}`,
  // "perto da mesa" / "ao lado do mercado" — de + a/o contract.
  near: (np) =>
    np.startsWith("a ")
      ? `perto da ${np.slice(2)}`
      : np.startsWith("o ")
        ? `perto do ${np.slice(2)}`
        : `perto de ${np}`,
  nextTo: (np) =>
    np.startsWith("a ")
      ? `ao lado da ${np.slice(2)}`
      : np.startsWith("o ")
        ? `ao lado do ${np.slice(2)}`
        : `ao lado de ${np}`,
  giveMe: (obj) => `Me dá ${obj}.`,
  giveTo: (obj, to) => `Dá ${obj} ${to}.`,
  forYou: (obj) => `${obj} é para você!`,
  forMe: (obj) => `${obj} é para mim!`,
  offer: (obj, neg) => (neg ? `Eu não te dou ${obj}.` : `Eu te dou ${obj}.`),
  whereIs: (np, pl) => `Onde ${pl ? "estão" : "está"} ${np}?`,
  whereGet: (np) => `Onde eu consigo ${np}?`,
  whatWant: "O que você quer?",
  tradeWhat: "Trocar pelo quê?",
  tradeFor: (forPhrase) => `Trocar ${forPhrase}?`,
  something: "algo",
  // "Estou com frio / calor / fome / sede" — sensation is estar com + noun.
  feel: (head, subj) => {
    const noun = head === "hot" ? "calor" : head === "hungry" ? "fome" : head === "thirsty" ? "sede" : "frio";
    const v =
      subj.head === "i_me"
        ? "Estou com"
        : subj.head === "we"
          ? "Estamos com"
          : subj.head === "they"
            ? "Estão com"
            : "Está com";
    return `${v} ${noun}.`;
  },
  // "Eu gosto do biscoito." / "Eu gosto de vermelho." — gostar DE, contracting
  // with the article (de+o → do, de+a → da).
  // de + article contraction (do/da/dos/das) — gostar DE, precisar DE.
  of: (t) =>
    t.startsWith("o ")
      ? `do ${t.slice(2)}`
      : t.startsWith("a ")
        ? `da ${t.slice(2)}`
        : t.startsWith("os ")
          ? `dos ${t.slice(3)}`
          : t.startsWith("as ")
            ? `das ${t.slice(3)}`
            : `de ${t}`,
  like: (obj) => {
    if (obj.kind === "quality") return `Eu gosto de ${obj.word}.`;
    const t = obj.text;
    const de = t.startsWith("o ")
      ? `do ${t.slice(2)}`
      : t.startsWith("a ")
        ? `da ${t.slice(2)}`
        : t.startsWith("os ")
          ? `dos ${t.slice(3)}`
          : t.startsWith("as ")
            ? `das ${t.slice(3)}`
            : `de ${t}`;
    return `Eu gosto ${de}.`;
  },
  // "Quero comer." / "Preciso comer um biscoito." / "Gosto de comer." —
  // `like` governs `de` before the infinitive.
  wantTo: (modal, inf, obj) => {
    const head = modal === "need" ? "Preciso" : modal === "like" ? "Gosto de" : "Quero";
    return `${head} ${inf}${obj ? ` ${obj}` : ""}.`;
  },
  cantPut: (obj) => (obj ? `Não posso pôr ${obj} aí.` : "Não posso pôr isso aí."),
  going: {
    i: (dest) => `Vou ${dest}.`,
    you: (dest) => `Vai ${dest}.`,
    third: (subj, dest) => `${subj} vai ${dest}.`,
    home: "para casa",
    fetch: (np) => `buscar ${np}`,
    where: "Aonde você vai?",
  },
  takeMeTo: (np) => `Me leva até ${np}.`,
  stayWithMe: "Fica comigo.",
  directions: (np, be, proximity, dir) => {
    const tail =
      proximity === "here"
        ? "aqui"
        : proximity === "there"
          ? "ali"
          : proximity === "street"
            ? "nesta rua"
            : `${proximity === "close" ? "perto" : "longe"}, ao ${dir}`;
    return `${np} ${be} ${tail}.`;
  },
  smell: { v3: "cheira", v3p: "cheiram" },
  // PT_CONN is the OVERRIDE — the form a connective takes when it joins two
  // clauses and that differs from the word on its button ("para" vs "para
  // que"). Everything else falls through to the lexicon, so a connective with
  // one form is authored once. The raw head stays as the last resort, but
  // `validate-builder-lexicon` now fails before a head can reach it.
  connective: (head) => PT_CONN[head] ?? L[head]?.w ?? head,
  why: "Por quê?",
  whyWant: (obj) => `Por que você quer ${obj}?`,
  q: (s) => `${s}?`,
  fixed: {
    "i_me + help + you": "Vou te ajudar.",
    "i_me + help.not + you": "Não vou te ajudar.",
    "i_me + think.not": "Não sei.",
    "i_me + understand.not": "Eu não entendo.",
    "ok#question": "Você está bem?",
    "you + ok#question": "Você está bem?",
    confused: "Não entendi.",
    there: "Ali!",
    "thank_you": (o) => (o.speaker === "f" ? "Obrigada!" : "Obrigado!"),
    goodbye: "Tchau!",
    // Motive batch: the stay-with level-a line, the hungry motive alone, the
    // dwell-done thanks (speaker-gendered obrigado/a).
    stay: "Fica comigo.",
    hungry: "Estou com fome.",
    "i_me + ok + thank_you": (o) => (o.speaker === "f" ? "Estou bem, obrigada!" : "Estou bem, obrigado!"),
  },
});
