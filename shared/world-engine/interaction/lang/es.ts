// shared/world-engine/interaction/lang/es.ts
// Pro-drop subjects (quiero, not yo quiero), tú conjugation, a+el → al.

import { makeRomance } from "./romance.js";
import type { Lexeme } from "./core.js";

const L: Record<string, Lexeme> = {
  i_me: { w: "yo" },
  you: { w: "tú" },
  // The collective voice (nations P6) — plural, so agreement machinery
  // (adjectives, estar) reads them without extra branches.
  we: { w: "nosotros", pl: true },
  they: { w: "ellos", pl: true },
  here: { w: "aquí" },
  there: { w: "ahí" },
  want: { w: "quiero", v2: "quieres", v3: "quiere", v3p: "quieren", v1p: "queremos" },
  give: { w: "doy", v2: "das", v3: "da", v3p: "dan", v1p: "damos" },
  take: { w: "tomo", v2: "tomas", v3: "toma", v3p: "toman", v1p: "tomamos" },
  get: { w: "consigo", v2: "consigues", v3: "consigue", v3p: "consiguen" },
  have: { w: "tengo", v2: "tienes", v3: "tiene", v3p: "tienen", v1p: "tenemos" },
  help: { w: "ayudo", v2: "ayudas", v3: "ayuda", v3p: "ayudan" },
  think: { w: "pienso", v2: "piensas", v3: "piensa", v3p: "piensan" },
  know: { w: "sé", v2: "sabes", v3: "sabe", v3p: "saben" },
  understand: { w: "entiendo", v2: "entiendes", v3: "entiende", v3p: "entienden", inf: "entender" },
  go: { w: "voy", v2: "vas", v3: "va", v3p: "van", v1p: "vamos", inf: "ir" },
  // The movement gaits + pursuit family (semantic-gaps batch).
  walk: { w: "camino", v2: "caminas", v3: "camina", v3p: "caminan", inf: "caminar" },
  run: { w: "corro", v2: "corres", v3: "corre", v3p: "corren", inf: "correr" },
  chase: { w: "persigo", v2: "persigues", v3: "persigue", v3p: "persiguen", inf: "perseguir" },
  follow: { w: "sigo", v2: "sigues", v3: "sigue", v3p: "siguen", inf: "seguir" },
  stop: { w: "paro", v2: "paras", v3: "para", v3p: "paran", inf: "parar" },
  // Nations P6: the political verb the absolute taboo ring forbids, and the
  // places a people speaks of ("our town", "that area").
  fight: { w: "lucho", v2: "luchas", v3: "lucha", v3p: "luchan", v1p: "luchamos", inf: "luchar" },
  town: { w: "pueblo", g: "m" },
  area: { w: "zona", g: "f" },
  market: { w: "mercado" },
  trade: { w: "cambio", v2: "cambias", v3: "cambia", v3p: "cambian", v1p: "cambiamos" },
  more: { w: "más" },
  less: { w: "menos" },
  rare: { w: "raro" },
  easy: { w: "fácil" },
  hard: { w: "difícil" },
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
  work: { w: "trabajo", g: "m" },
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
  color: { w: "coloreo", v2: "coloreas", v3: "colorea", v3p: "colorean", v1p: "coloreamos", inf: "colorear" },
  throw: { w: "tiro", v2: "tiras", v3: "tira", v3p: "tiran" },
  lonely: { w: "solo" },
  hungry: { w: "hambriento" }, // rarely surfaces — the feel() clause covers "i_me + hungry"
  tired: { w: "cansado" },
  bored: { w: "aburrido" },
  smelly: { w: "apestoso" },
  scruffy: { w: "desaliñado" },
  // Round-2 motives: thirst/hygiene conditions, the waste need, its stations.
  thirsty: { w: "sediento" },
  need: { w: "necesito", v2: "necesitas", v3: "necesita", v3p: "necesitan" },
  // Construction v1: the placement verb + the refusal-cause quality.
  put: { w: "pongo", v2: "pones", v3: "pone", v3p: "ponen", inf: "poner" },
  good: { w: "bueno", f: "buena" },
  bathroom: { w: "baño", g: "m" },
  kitchen: { w: "cocina", g: "f" },
  bath: { w: "bañera", g: "f" },
  privy: { w: "letrina", g: "f" },
  barrel: { w: "barril", g: "m", plw: "barriles" },
  bin: { w: "papelera", g: "f" },
  bowl: { w: "cuenco", g: "m" },
  oven: { w: "horno", g: "m", plw: "hornos" },
  well: { w: "pozo", g: "m" },
  food: { w: "comida", g: "f", mass: true },
  toy: { w: "juguete", g: "m" },
  instrument: { w: "instrumento", g: "m" },
  book: { w: "libro", g: "m" },
  clothing: { w: "ropa", g: "f", mass: true },
  hat: { w: "sombrero", g: "m" },
  shirt: { w: "camiseta", g: "f" },
  dress: { w: "vestido", g: "m" },
  scarf: { w: "bufanda", g: "f" },
  drum: { w: "tambor", g: "m" },
  guitar: { w: "guitarra", g: "f" },
  // Attention/self-care verbs (attention-spark actions) — 1sg + infinitive
  // (the intent construction "voy a comer" needs the infinitive).
  eat: { w: "como", v2: "comes", v3: "come", v3p: "comen", inf: "comer" },
  drink: { w: "bebo", v2: "bebes", v3: "bebe", v3p: "beben", inf: "beber" },
  sleep: { w: "duermo", v2: "duermes", v3: "duerme", v3p: "duermen", inf: "dormir" },
  wash: { w: "lavo", v2: "lavas", v3: "lava", v3p: "lavan", inf: "lavar" },
  talk: { w: "hablo", v2: "hablas", v3: "habla", v3p: "hablan", inf: "hablar" },
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
  dem: (g, pl) => (g === "f" ? (pl ? "estas" : "esta") : pl ? "estos" : "este"),
  intentGo: (inf) => `voy a ${inf}`,
  withWord: "con",
  my: () => "mi", // mis for plural
  pronoun: () => "", // pro-drop, every person: "Quiero una manzana", "No luchamos"
  // "Te ayudo." / "No me quiere." / "Nos ayudas." / "Los ayudo."
  clitic: (h) => (h === "i_me" ? "me" : h === "you" ? "te" : h === "we" ? "nos" : "los"),
  // "a ti", "por mí", "con nosotros", "para ellos"
  tonic: (h) => (h === "i_me" ? "mí" : h === "you" ? "ti" : h === "we" ? "nosotros" : "ellos"),
  // gustar flips experiencer/subject: "i_me like you" → "Me gustas." The head
  // is the OBJECT, so the experiencer is the complementary person.
  likePron: (h) =>
    h === "i_me" ? "Te gusto." : h === "you" ? "Me gustas." : h === "we" ? "Te gustamos." : "Me gustan.",
  estar: { v1: "estoy", v2: "estás", v3: "está", v3p: "están", v1p: "estamos" },
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
  // "Tengo frío / calor / hambre / sed" — sensation is tener + noun, not estar + adj.
  feel: (head, subj) => {
    const noun = head === "hot" ? "calor" : head === "hungry" ? "hambre" : head === "thirsty" ? "sed" : "frío";
    const v =
      subj.head === "i_me"
        ? "Tengo"
        : subj.head === "you"
          ? "Tienes"
          : subj.head === "we"
            ? "Tenemos"
            : subj.head === "they"
              ? "Tienen"
              : "Tiene";
    return `${v} ${noun}.`;
  },
  // "Me gusta la galleta." / "Me gustan los bloques." / "Me gusta el rojo."
  like: (obj) =>
    obj.kind === "quality"
      ? `Me gusta el ${obj.word}.`
      : `Me gusta${obj.plural ? "n" : ""} ${obj.text}.`,
  wantTo: (inf) => `Quiero ${inf}.`,
  cantPut: (obj) => (obj ? `No puedo poner ${obj} ahí.` : "No puedo ponerlo ahí."),
  going: {
    i: (dest) => `Voy ${dest}.`,
    you: (dest) => `Ve ${dest}.`,
    third: (subj, dest) => `${subj} va ${dest}.`,
    home: "a casa",
    fetch: (np) => `a buscar ${np}`,
    where: "¿Adónde vas?",
  },
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
    "i_me + understand.not": "No entiendo.",
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
