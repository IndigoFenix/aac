// shared/world-engine/interaction/lang/pt.ts
// from the romance ruleset. você conjugates as 3rd person; em/por contract
// with the article (na caixa, pela bola); possessive agrees (meu/minha).

import { makeRomance } from "./romance.js";
import type { Lexeme } from "./core.js";

const L: Record<string, Lexeme> = {
  i_me: { w: "eu" },
  you: { w: "você" },
  // The collective voice (nations P6) — plural, so agreement machinery
  // (adjectives, estar) reads them without extra branches.
  we: { w: "nós", pl: true },
  they: { w: "eles", pl: true },
  here: { w: "aqui" },
  there: { w: "ali" },
  want: { w: "quero", v3: "quer", v3p: "querem", v1p: "queremos" },
  give: { w: "dou", v3: "dá", v3p: "dão", v1p: "damos" },
  take: { w: "pego", v3: "pega", v3p: "pegam", v1p: "pegamos" },
  get: { w: "consigo", v3: "consegue", v3p: "conseguem" },
  have: { w: "tenho", v3: "tem", v3p: "têm", v1p: "temos" },
  help: { w: "ajudo", v3: "ajuda", v3p: "ajudam" },
  think: { w: "penso", v3: "pensa", v3p: "pensam" },
  know: { w: "sei", v3: "sabe", v3p: "sabem" },
  understand: { w: "entendo", v3: "entende", v3p: "entendem", inf: "entender" },
  go: { w: "vou", v3: "vai", v3p: "vão", v1p: "vamos", inf: "ir" },
  // Nations P6: the political verb the absolute taboo ring forbids, and the
  // places a people speaks of ("our town", "that area").
  fight: { w: "luto", v3: "luta", v3p: "lutam", v1p: "lutamos", inf: "lutar" },
  town: { w: "vila", g: "f" },
  area: { w: "área", g: "f" },
  market: { w: "mercado" },
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
  cookie: { w: "biscoito", g: "m" },
  apple: { w: "maçã", g: "f" },
  banana: { w: "banana", g: "f" },
  grape: { w: "uva", g: "f" },
  ball: { w: "bola", g: "f" },
  car: { w: "carro", g: "m" },
  train: { w: "trem", g: "m", plw: "trens" },
  blocks: { w: "blocos", g: "m", pl: true },
  teddy: { w: "ursinho", g: "m" },
  rabbit: { w: "coelho", g: "m" },
  bear: { w: "urso", g: "m" },
  frog: { w: "sapo", g: "m" },
  dog: { w: "cachorro", g: "m" },
  box: { w: "caixa", g: "f" },
  basket: { w: "cesta", g: "f" },
  bubbles: { w: "bolhas", g: "f", pl: true },
  sparks: { w: "faíscas", g: "f", pl: true },
  boat: { w: "barco", g: "m" },
  broccoli: { w: "brócolis", g: "m", mass: true },
  sock: { w: "meia", g: "f" },
  // Devices (§5) + their toggle states (agree with the device's gender).
  lamp: { w: "lâmpada", g: "f" },
  window: { w: "janela", g: "f" },
  heater: { w: "aquecedor", g: "m" },
  generator: { w: "gerador", g: "m" },
  switch: { w: "interruptor", g: "m" },
  on: { w: "aceso", f: "acesa" },
  off: { w: "apagado", f: "apagada" },
  open: { w: "aberto", f: "aberta" },
  closed: { w: "fechado", f: "fechada" },
  // Motive batch: verbs (infinitives for the want-to frame), conditions,
  // categories, new pool items.
  play: { w: "brinco", inf: "brincar" },
  read: { w: "leio", inf: "ler" },
  wear: { w: "me visto", inf: "me vestir" },
  throw: { w: "jogo", v3: "joga", v3p: "jogam" },
  lonely: { w: "sozinho" },
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
  kitchen: { w: "cozinha", g: "f" },
  bath: { w: "banheira", g: "f" },
  privy: { w: "latrina", g: "f" },
  barrel: { w: "barril", g: "m", plw: "barris" },
  bin: { w: "lixeira", g: "f" },
  bowl: { w: "tigela", g: "f" },
  oven: { w: "forno", g: "m" },
  well: { w: "poço", g: "m" },
  water: { w: "água", g: "f", mass: true },
  food: { w: "comida", g: "f", mass: true },
  toy: { w: "brinquedo", g: "m" },
  instrument: { w: "instrumento", g: "m" },
  book: { w: "livro", g: "m" },
  clothing: { w: "roupa", g: "f", mass: true },
  hat: { w: "chapéu", g: "m" },
  shirt: { w: "camiseta", g: "f" },
  dress: { w: "vestido", g: "m" },
  scarf: { w: "cachecol", g: "m" },
  drum: { w: "tambor", g: "m" },
  guitar: { w: "violão", g: "m" },
};

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
  my: (g, pl) => (g === "f" ? (pl ? "minhas" : "minha") : pl ? "meus" : "meu"),
  youIsThird: true,
  // Portuguese keeps the subject pronoun ("Nós não lutamos.").
  pronoun: (h) => (h === "i_me" ? "eu" : h === "you" ? "você" : h === "we" ? "nós" : "eles"),
  // "Eu te ajudo." / "Ele não me quer." / "Você nos ajuda." / "Eu os ajudo."
  clitic: (h) => (h === "i_me" ? "me" : h === "you" ? "te" : h === "we" ? "nos" : "os"),
  // "para mim", "para você", "com nós", "para eles"
  tonic: (h) => (h === "i_me" ? "mim" : h === "you" ? "você" : h === "we" ? "nós" : "eles"),
  likePron: (h) =>
    h === "i_me"
      ? "Você gosta de mim."
      : h === "you"
        ? "Eu gosto de você."
        : h === "we"
          ? "Você gosta de nós."
          : "Eu gosto deles.",
  estar: { v1: "estou", v2: "está", v3: "está", v3p: "estão", v1p: "estamos" },
  ser: { v3: "é", v3p: "são" },
  to: (np) => `para ${np}`,
  inside: (np) =>
    np.startsWith("a ") ? `na ${np.slice(2)}` : np.startsWith("o ") ? `no ${np.slice(2)}` : `em ${np}`,
  forTrade: (np) =>
    np.startsWith("a ") ? `pela ${np.slice(2)}` : np.startsWith("o ") ? `pelo ${np.slice(2)}` : `por ${np}`,
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
