// shared/symbol-game/lang/pt.ts — Portuguese (Brazilian register), configured
// from the romance ruleset. você conjugates as 3rd person; em/por contract
// with the article (na caixa, pela bola); possessive agrees (meu/minha).

import { makeRomance } from "./romance.js";
import type { Lexeme } from "./core.js";

const L: Record<string, Lexeme> = {
  i_me: { w: "eu" },
  you: { w: "você" },
  here: { w: "aqui" },
  there: { w: "ali" },
  want: { w: "quero", v3: "quer", v3p: "querem" },
  give: { w: "dou", v3: "dá", v3p: "dão" },
  take: { w: "pego", v3: "pega", v3p: "pegam" },
  get: { w: "consigo", v3: "consegue", v3p: "conseguem" },
  have: { w: "tenho", v3: "tem", v3p: "têm" },
  help: { w: "ajudo", v3: "ajuda", v3p: "ajudam" },
  think: { w: "penso", v3: "pensa", v3p: "pensam" },
  know: { w: "sei", v3: "sabe", v3p: "sabem" },
  trade: { w: "troco", v3: "troca", v3p: "trocam" },
  more: { w: "mais" },
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
  smelly: { w: "fedido" },
  food: { w: "comida", g: "f", mass: true },
  toy: { w: "brinquedo", g: "m" },
  instrument: { w: "instrumento", g: "m" },
  book: { w: "livro", g: "m" },
  clothing: { w: "roupa", g: "f", mass: true },
  garbage: { w: "lixo", g: "m", mass: true },
  hat: { w: "chapéu", g: "m" },
  shirt: { w: "camiseta", g: "f" },
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
  pronoun: (head) => (head === "i_me" ? "eu" : "você"),
  estar: { v1: "estou", v2: "está", v3: "está", v3p: "estão" },
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
  // "Estou com frio / calor / fome" — sensation is estar com + noun.
  feel: (head, subj) => {
    const noun = head === "hot" ? "calor" : head === "hungry" ? "fome" : "frio";
    const v = subj.head === "i_me" ? "Estou com" : "Está com";
    return `${v} ${noun}.`;
  },
  // "Eu gosto do biscoito." / "Eu gosto de vermelho." — gostar DE, contracting
  // with the article (de+o → do, de+a → da).
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
