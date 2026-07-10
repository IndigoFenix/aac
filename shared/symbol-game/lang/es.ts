// shared/symbol-game/lang/es.ts — Spanish, configured from the romance ruleset.
// Pro-drop subjects (quiero, not yo quiero), tú conjugation, a+el → al.

import { makeRomance } from "./romance.js";
import type { Lexeme } from "./core.js";

const L: Record<string, Lexeme> = {
  i_me: { w: "yo" },
  you: { w: "tú" },
  here: { w: "aquí" },
  there: { w: "ahí" },
  want: { w: "quiero", v2: "quieres", v3: "quiere", v3p: "quieren" },
  give: { w: "doy", v2: "das", v3: "da", v3p: "dan" },
  take: { w: "tomo", v2: "tomas", v3: "toma", v3p: "toman" },
  get: { w: "consigo", v2: "consigues", v3: "consigue", v3p: "consiguen" },
  have: { w: "tengo", v2: "tienes", v3: "tiene", v3p: "tienen" },
  help: { w: "ayudo", v2: "ayudas", v3: "ayuda", v3p: "ayudan" },
  think: { w: "pienso", v2: "piensas", v3: "piensa", v3p: "piensan" },
  know: { w: "sé", v2: "sabes", v3: "sabe", v3p: "saben" },
  trade: { w: "cambio", v2: "cambias", v3: "cambia", v3p: "cambian" },
  more: { w: "más" },
  yes: { w: "sí" },
  no: { w: "no" },
  ok: { w: "bien", f: "bien" },
  hi: { w: "hola" },
  goodbye: { w: "adiós" },
  thank_you: { w: "gracias" },
  confused: { w: "confundido" },
  sad: { w: "triste", f: "triste" },
  happy: { w: "feliz", f: "feliz", mpl: "felices", fpl: "felices" },
  big: { w: "grande", f: "grande" },
  small: { w: "pequeño" },
  hot: { w: "caliente", f: "caliente" },
  cold: { w: "frío", f: "fría" },
  clean: { w: "limpio" },
  dirty: { w: "sucio" },
  wet: { w: "mojado" },
  dry: { w: "seco" },
  color_red: { w: "rojo" },
  color_blue: { w: "azul", f: "azul" },
  color_green: { w: "verde", f: "verde" },
  color_yellow: { w: "amarillo" },
  color_orange: { w: "naranja", f: "naranja" },
  color_purple: { w: "morado" },
  color_pink: { w: "rosa", f: "rosa" },
  color_brown: { w: "marrón", f: "marrón", mpl: "marrones", fpl: "marrones" },
  color_black: { w: "negro" },
  color_white: { w: "blanco" },
  place: { w: "dónde" },
  // Cardinal directions — the "cerca/lejos, al norte" answers.
  north: { w: "norte" },
  south: { w: "sur" },
  east: { w: "este" },
  west: { w: "oeste" },
  home: { w: "casa", g: "f" },
  thing: { w: "qué" },
  cookie: { w: "galleta", g: "f" },
  apple: { w: "manzana", g: "f" },
  banana: { w: "plátano", g: "m" },
  grape: { w: "uva", g: "f" },
  ball: { w: "pelota", g: "f" },
  car: { w: "coche", g: "m" },
  train: { w: "tren", g: "m", plw: "trenes" },
  blocks: { w: "bloques", g: "m", pl: true },
  teddy: { w: "osito", g: "m" },
  rabbit: { w: "conejo", g: "m" },
  bear: { w: "oso", g: "m" },
  frog: { w: "rana", g: "f" },
  dog: { w: "perro", g: "m" },
  box: { w: "caja", g: "f" },
  basket: { w: "cesta", g: "f" },
  bubbles: { w: "burbujas", g: "f", pl: true },
  sparks: { w: "chispas", g: "f", pl: true },
  boat: { w: "barco", g: "m" },
  broccoli: { w: "brócoli", g: "m", mass: true },
  sock: { w: "calcetín", g: "m", plw: "calcetines" },
  // Devices (§5) + their toggle states (agree with the device's gender).
  lamp: { w: "lámpara", g: "f" },
  window: { w: "ventana", g: "f" },
  heater: { w: "calefactor", g: "m" },
  generator: { w: "generador", g: "m" },
  switch: { w: "interruptor", g: "m" },
  on: { w: "encendido", f: "encendida" },
  off: { w: "apagado", f: "apagada" },
  open: { w: "abierto", f: "abierta" },
  closed: { w: "cerrado", f: "cerrada" },
  // Motive batch: verbs (infinitives for the want-to frame), conditions,
  // categories, new pool items.
  play: { w: "juego", inf: "jugar" },
  read: { w: "leo", inf: "leer" },
  wear: { w: "me visto", inf: "vestirme" },
  throw: { w: "tiro", v2: "tiras", v3: "tira", v3p: "tiran" },
  lonely: { w: "solo" },
  hungry: { w: "hambriento" }, // rarely surfaces — the feel() clause covers "i_me + hungry"
  smelly: { w: "apestoso" },
  food: { w: "comida", g: "f", mass: true },
  toy: { w: "juguete", g: "m" },
  instrument: { w: "instrumento", g: "m" },
  book: { w: "libro", g: "m" },
  clothing: { w: "ropa", g: "f", mass: true },
  garbage: { w: "basura", g: "f", mass: true },
  hat: { w: "sombrero", g: "m" },
  shirt: { w: "camiseta", g: "f" },
  scarf: { w: "bufanda", g: "f" },
  drum: { w: "tambor", g: "m" },
  guitar: { w: "guitarra", g: "f" },
};

const ES_CONN: Record<string, string> = {
  because: "porque",
  therefore: "por eso",
  in_order_to: "para",
  when: "cuando",
  until: "hasta que",
};

export const es = makeRomance({
  id: "es",
  lexicon: L,
  notWord: "no",
  moreWord: "más",
  art: (def, g, pl, mass) => {
    if (def) return g === "f" ? (pl ? "las" : "la") : pl ? "los" : "el";
    if (pl || mass) return "";
    return g === "f" ? "una" : "un";
  },
  my: () => "mi", // mis for plural
  pronoun: () => "", // pro-drop: "Quiero una manzana"
  estar: { v1: "estoy", v2: "estás", v3: "está", v3p: "están" },
  ser: { v3: "es", v3p: "son" },
  to: (np) => (np.startsWith("el ") ? `al ${np.slice(3)}` : `a ${np}`),
  inside: (np) => `en ${np}`,
  forTrade: (np) => `por ${np}`,
  giveMe: (obj) => `Dame ${obj}.`,
  giveTo: (obj, to) => `Dale ${obj} ${to}.`,
  forYou: (obj) => `¡${obj} es para ti!`,
  forMe: (obj) => `¡${obj} es para mí!`,
  offer: (obj, neg) => (neg ? `No te doy ${obj}.` : `Te doy ${obj}.`),
  whereIs: (np, pl) => `¿Dónde ${pl ? "están" : "está"} ${np}?`,
  whereGet: (np) => `¿Dónde consigo ${np}?`,
  whatWant: "¿Qué quieres?",
  tradeWhat: "¿Cambiar por qué?",
  tradeFor: (forPhrase) => `¿Cambiar ${forPhrase}?`,
  something: "algo",
  // "Tengo frío / calor / hambre" — sensation is tener + noun, not estar + adj.
  feel: (head, subj) => {
    const noun = head === "hot" ? "calor" : head === "hungry" ? "hambre" : "frío";
    const v = subj.head === "i_me" ? "Tengo" : subj.head === "you" ? "Tienes" : "Tiene";
    return `${v} ${noun}.`;
  },
  // "Me gusta la galleta." / "Me gustan los bloques." / "Me gusta el rojo."
  like: (obj) =>
    obj.kind === "quality"
      ? `Me gusta el ${obj.word}.`
      : `Me gusta${obj.plural ? "n" : ""} ${obj.text}.`,
  wantTo: (inf) => `Quiero ${inf}.`,
  takeMeTo: (np) => `Llévame con ${np}.`,
  stayWithMe: "Quédate conmigo.",
  directions: (np, be, proximity, dir) => {
    const tail =
      proximity === "here"
        ? "aquí"
        : proximity === "there"
          ? "ahí"
          : proximity === "street"
            ? "en esta calle"
            : `${proximity === "close" ? "cerca" : "lejos"}, al ${dir}`;
    return `${np} ${be} ${tail}.`;
  },
  smell: { v3: "huele", v3p: "huelen" },
  connective: (head) => ES_CONN[head] ?? head,
  why: "¿Por qué?",
  whyWant: (obj) => `¿Por qué quieres ${obj}?`,
  q: (s) => `¿${s}?`,
  fixed: {
    "i_me + help + you": "Te voy a ayudar.",
    "i_me + help.not + you": "No te voy a ayudar.",
    "i_me + think.not": "No sé.",
    "ok#question": "¿Estás bien?",
    "you + ok#question": "¿Estás bien?",
    confused: "No entiendo.",
    there: "¡Ahí!",
    thank_you: "¡Gracias!",
    goodbye: "¡Adiós!",
    // Motive batch: the stay-with level-a line, the hungry motive alone, the
    // dwell-done thanks.
    stay: "Quédate conmigo.",
    hungry: "Tengo hambre.",
    "i_me + ok + thank_you": "Estoy bien, ¡gracias!",
  },
});
