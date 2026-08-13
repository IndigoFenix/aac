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
  walk: { w: "caminho", v3: "caminha", v3p: "caminham", inf: "caminhar" },
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
  animal: { w: "animal", g: "m", plw: "animais" },
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
  cut: { w: "corto", v2: "cortas", v3: "corta", v3p: "cortam", v1p: "cortamos", inf: "cortar" },
  // The completion state ("a casa está pronta").
  finished: { w: "pronto", f: "pronta" },
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
  therefore: "então",
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
  wantTo: (inf) => `Quero ${inf}.`,
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
  connective: (head) => PT_CONN[head] ?? head,
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
