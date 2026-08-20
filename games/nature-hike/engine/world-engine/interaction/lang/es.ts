// shared/world-engine/interaction/lang/es.ts
// Pro-drop subjects (quiero, not yo quiero), tú conjugation, a+el → al.

import { makeRomance } from "./romance.js";
import type { Lexeme } from "./core.js";
import { specWords } from "../content/words.js";

const CENTRAL: Record<string, Lexeme> = {
  i_me: { w: "yo" },
  you: { w: "tú" },
  // The collective voice (nations P6) — plural, so agreement machinery
  // (adjectives, estar) reads them without extra branches.
  we: { w: "nosotros", pl: true },
  they: { w: "ellos", pl: true },
  here: { w: "aquí" },
  there: { w: "ahí" },
  // THE PROXIMITY PAIR — the gloss forms; a framed sentence goes through
  // `near()`/`nextTo()` below, which contract the article ("cerca del mercado").
  near: { w: "cerca de" },
  next_to: { w: "al lado de" },
  // The vertical + facing placement pairs — all "<base> de" phrases; the
  // framed sentence goes through joinPhrase, which contracts via `of`.
  under: { w: "debajo de" },
  over: { w: "encima de" },
  behind: { w: "detrás de" },
  in_front_of: { w: "delante de" },
  want: { w: "quiero", v2: "quieres", v3: "quiere", v3p: "quieren", v1p: "queremos" },
  give: { w: "doy", v2: "das", v3: "da", v3p: "dan", v1p: "damos" },
  take: { w: "tomo", v2: "tomas", v3: "toma", v3p: "toman", v1p: "tomamos" },
  // `inf` matters: the intent periphrasis ("voy a conseguir la madera") reads
  // it, and without one the will-marked fetch — the commonest builder line —
  // came out as "Voy a consigo".
  get: { w: "consigo", v2: "consigues", v3: "consigue", v3p: "consiguen", v1p: "conseguimos", inf: "conseguir" },
  have: { w: "tengo", v2: "tienes", v3: "tiene", v3p: "tienen", v1p: "tenemos" },
  help: { w: "ayudo", v2: "ayudas", v3: "ayuda", v3p: "ayudan" },
  think: { w: "pienso", v2: "piensas", v3: "piensa", v3p: "piensan" },
  know: { w: "sé", v2: "sabes", v3: "sabe", v3p: "saben" },
  understand: { w: "entiendo", v2: "entiendes", v3: "entiende", v3p: "entienden", inf: "entender" },
  go: { w: "voy", v2: "vas", v3: "va", v3p: "van", v1p: "vamos", inf: "ir" },
  // The movement gaits + pursuit family (semantic-gaps batch).
  run: { w: "corro", v2: "corres", v3: "corre", v3p: "corren", inf: "correr" },
  chase: { w: "persigo", v2: "persigues", v3: "persigue", v3p: "persiguen", inf: "perseguir" },
  follow: { w: "sigo", v2: "sigues", v3: "sigue", v3p: "siguen", inf: "seguir" },
  stop: { w: "paro", v2: "paras", v3: "para", v3p: "paran", inf: "parar" },
  // Board chrome's "go back" word (⑦) — the AAC glyph `return`.
  return: { w: "vuelvo", v2: "vuelves", v3: "vuelve", v3p: "vuelven", inf: "volver" },
  // Nations P6: the political verb the absolute taboo ring forbids, and the
  // places a people speaks of ("our town", "that area").
  fight: { w: "lucho", v2: "luchas", v3: "lucha", v3p: "luchan", v1p: "luchamos", inf: "luchar" },
  town: { w: "pueblo", g: "m" },
  area: { w: "zona", g: "f" },
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
  doll: { w: "muñeca", g: "f" },
  // Creature SPECIES words (reference resolution: "hablo con el/la {especie}").
  person: { w: "persona", g: "f", plw: "personas" },
  animal: { w: "animal", g: "m", plw: "animales" },
  creature: { w: "criatura", g: "f" },
  // Devices (§5) + their toggle states (agree with the device's gender).
  on: { w: "encendido", f: "encendida" },
  off: { w: "apagado", f: "apagada" },
  open: { w: "abierto", f: "abierta" },
  closed: { w: "cerrado", f: "cerrada" },
  // Motive batch: verbs (infinitives for the want-to frame), conditions,
  // categories, new pool items.
  play: { w: "juego", v1p: "jugamos", inf: "jugar" },
  read: { w: "leo", inf: "leer" },
  wear: { w: "me visto", inf: "vestirme" },
  color: { w: "coloreo", v2: "coloreas", v3: "colorea", v3p: "colorean", v1p: "coloreamos", inf: "colorear" },
  throw: { w: "tiro", v2: "tiras", v3: "tira", v3p: "tiran" },
  lonely: { w: "solo" },
  together: { w: "juntos" },
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
  food: { w: "comida", g: "f", mass: true },
  toy: { w: "juguete", g: "m" },
  clothing: { w: "ropa", g: "f", mass: true },
  // Attention/self-care verbs (attention-spark actions) — 1sg + infinitive
  // (the intent construction "voy a comer" needs the infinitive).
  eat: { w: "como", v2: "comes", v3: "come", v3p: "comen", v1p: "comemos", inf: "comer" },
  drink: { w: "bebo", v2: "bebes", v3: "bebe", v3p: "beben", v1p: "bebemos", inf: "beber" },
  see: { w: "veo", v2: "ves", v3: "ve", v3p: "ven", v1p: "vemos", inf: "ver" },
  sleep: { w: "duermo", v2: "duermes", v3: "duerme", v3p: "duermen", v1p: "dormimos", inf: "dormir" },
  // THE POSTURE PAIR (build order L15) — live glyphs with no lexeme here, so
  // the open-ground dwell said "Rest." and the bare self-need "Sit.": the raw
  // English token capitalised into a sentence slot it never earned.
  //
  // `sit` is REFLEXIVE (sentarse), which this layer already knows how to say:
  // `wear` above is the same shape ("me visto" / inf "vestirme"), because the
  // clitic rides each authored form rather than needing a rule. Preverbal
  // negation lands where Spanish wants it ("No me siento") and the going-to
  // future takes the enclitic infinitive ("Voy a sentarme") — no new machinery
  // for either, which is why this ships beside `rest` instead of behind it.
  rest: { w: "descanso", v2: "descansas", v3: "descansa", v3p: "descansan", v1p: "descansamos", inf: "descansar" },
  sit: { w: "me siento", v2: "te sientas", v3: "se sienta", v3p: "se sientan", v1p: "nos sentamos", inf: "sentarme" },
  wash: { w: "lavo", v2: "lavas", v3: "lava", v3p: "lavan", v1p: "lavamos", inf: "lavar" },
  tidy: { w: "ordeno", v2: "ordenas", v3: "ordena", v3p: "ordenan", inf: "ordenar" },
  heat: { w: "caliento", v2: "calientas", v3: "calienta", v3p: "calientan", inf: "calentar" },
  make_cold: { w: "enfrío", v2: "enfrías", v3: "enfría", v3p: "enfrían", inf: "enfriar" },
  talk: { w: "hablo", v2: "hablas", v3: "habla", v3p: "hablan", v1p: "hablamos", inf: "hablar" },
  // Household CHORE verbs the needs templates speak ("voy a cocinar la comida").
  cook: { w: "cocino", v2: "cocinas", v3: "cocina", v3p: "cocinan", inf: "cocinar" },
  // ⚖️ WHY-CHAINS law ④ — the AUTHORITY link's verb ("…porque tú pides").
  ask: { w: "pido", v2: "pides", v3: "pide", v3p: "piden", v1p: "pedimos", inf: "pedir" },
  // ⚖️ WHY-CHAINS law ④ — the BROAD ACTIVITY verb ("no hago nada").
  do: { w: "hago", v2: "haces", v3: "hace", v3p: "hacen", v1p: "hacemos", inf: "hacer" },
  // City-founding areas — the map-reading overlay verb.
  show: { w: "muestro", v2: "muestras", v3: "muestra", v3p: "muestran", inf: "mostrar" },
  // City-founding ③ — the structure board's room words + the demolish verb.
  break: { w: "rompo", v2: "rompes", v3: "rompe", v3p: "rompen", inf: "romper" },
  // Construction ④ — the room-EMPTYING verb (break's stow-only twin).
  empty: { w: "vacío", v2: "vacías", v3: "vacía", v3p: "vacían", inf: "vaciar" },
  room: { w: "habitación", g: "f", plw: "habitaciones" },
  // ── CONSTRUCTION VOCABULARY ───────────────────────────────────────────
  // The building trade shipped as live glyphs with no lexemes here, so a
  // builder said "Build el house" — the raw English keys inside a Spanish
  // sentence, exactly the gap the furniture kinds had.
  // The materials and named structures now live on their spec rows
  // (content/words.ts) — what stays is the core pair and the trade's verbs.
  //
  // STRUCTURES — `house` is the dwelling as an ORDER; `home` stays the place
  // a creature goes back to.
  house: { w: "casa", g: "f" },
  building: { w: "edificio", g: "m" },
  yard: { w: "patio", g: "m" },
  // TRADE VERBS — 1sg in `w`, plus the infinitive the intent periphrasis
  // ("voy a construir") reads.
  build: { w: "construyo", v2: "construyes", v3: "construye", v3p: "construyen", v1p: "construimos", inf: "construir" },
  make: { w: "hago", v2: "haces", v3: "hace", v3p: "hacen", v1p: "hacemos", inf: "hacer" },
  bring: { w: "traigo", v2: "traes", v3: "trae", v3p: "traen", v1p: "traemos", inf: "traer" },
  carry: { w: "llevo", v2: "llevas", v3: "lleva", v3p: "llevan", v1p: "llevamos", inf: "llevar" },
  cut: { w: "corto", v2: "cortas", v3: "corta", v3p: "cortan", v1p: "cortamos", inf: "cortar" },
  // The completion state ("la casa está terminada").
  finished: { w: "terminado", f: "terminada" },

  // ── BUILDER-REACHABLE VOCABULARY (validate-builder-lexicon) ──────────────
  // 85 words the sentence builder can put in front of a child — a category tab
  // lists its whole lexical category, the modifier rail draws AXIS_WORDS, a
  // group chip wears its cluster id — every one of which rendered as an ENGLISH
  // word on the Spanish board, because `baseWord` falls back to the glyph id
  // and a glyph id is English. The same failure the construction trade had;
  // `npm run validate-builder-lexicon` now pins it.

  // Question words.
  what: { w: "qué" },
  where: { w: "dónde" },
  who: { w: "quién" },
  how: { w: "cómo" },
  why: { w: "por qué" },

  // Connectives. Where ES_CONN (below) carries a distinct sentence-joining
  // form, these are the BUTTON words — `connective()` now falls back to the
  // lexicon, so the two can no longer drift apart silently.
  and: { w: "y" },
  but: { w: "pero" },
  or: { w: "o" },
  if: { w: "si" },
  so: { w: "por eso" },
  then: { w: "luego" },
  because: { w: "porque" },
  in_order_to: { w: "para que" },
  when: { w: "cuando" },
  until: { w: "hasta que" },

  // Relations. `above` is "arriba de", NOT "encima de": `over` already owns
  // that phrase, and two placement buttons reading identically would be two
  // buttons a child cannot tell apart. `front` is the LEXICON key for the same
  // relation `in_front_of` spells out.
  from: { w: "de" },
  to: { w: "a" },
  in: { w: "en" },
  with: { w: "con" },
  for: { w: "para" },

  // Descriptors — the modifier rail's axes. The -o words need no `f`: the
  // ruleset's own -o→-a rule handles them.
  bad: { w: "malo" },
  broken: { w: "roto" },
  full: { w: "lleno" },
  long: { w: "largo" },
  short: { w: "corto" },
  tall: { w: "alto" },
  wide: { w: "ancho" },
  thin: { w: "delgado" },
  new: { w: "nuevo" },
  old: { w: "viejo" },
  sick: { w: "enfermo" },
  warm: { w: "tibio" },
  // The possession axis — rendered as a construction by `cfg.my` and filtered
  // out of the adjective walk; these are what the BUTTON and the gloss say.
  my: { w: "mi" },
  your: { w: "tu" },

  // Quantities (the fill + quantity axes, and the quantity tab).
  all: { w: "todo" },
  many: { w: "muchos" },
  some: { w: "un poco" },
  none: { w: "nada" },
  one: { w: "uno" },
  two: { w: "dos" },
  three: { w: "tres" },

  // Verbs — 1sg in `w`, plus the infinitive the intent periphrasis reads.
  come: { w: "vengo", v2: "vienes", v3: "viene", v3p: "vienen", v1p: "venimos", inf: "venir" },
  wait: { w: "espero", v2: "esperas", v3: "espera", v3p: "esperan", v1p: "esperamos", inf: "esperar" },
  stay: { w: "me quedo", v2: "te quedas", v3: "se queda", v3p: "se quedan", v1p: "nos quedamos", inf: "quedarse" },
  turn: { w: "giro", v2: "giras", v3: "gira", v3p: "giran", v1p: "giramos", inf: "girar" },
  push: { w: "empujo", v2: "empujas", v3: "empuja", v3p: "empujan", v1p: "empujamos", inf: "empujar" },
  // "jalar", NOT "tirar": `throw` above already owns "tiro"/"tirar", and pull
  // and throw are opposite acts that must never share a button word.
  pull: { w: "jalo", v2: "jalas", v3: "jala", v3p: "jalan", v1p: "jalamos", inf: "jalar" },
  drop: { w: "suelto", v2: "sueltas", v3: "suelta", v3p: "sueltan", v1p: "soltamos", inf: "soltar" },
  pick_up: { w: "recojo", v2: "recoges", v3: "recoge", v3p: "recogen", v1p: "recogemos", inf: "recoger" },
  // Shares a word with the adjective `full` — as Spanish itself does.
  fill: { w: "lleno", v2: "llenas", v3: "llena", v3p: "llenan", v1p: "llenamos", inf: "llenar" },
  fix: { w: "arreglo", v2: "arreglas", v3: "arregla", v3p: "arreglan", v1p: "arreglamos", inf: "arreglar" },
  dig: { w: "cavo", v2: "cavas", v3: "cava", v3p: "cavan", v1p: "cavamos", inf: "cavar" },
  plant: { w: "planto", v2: "plantas", v3: "planta", v3p: "plantan", v1p: "plantamos", inf: "plantar" },
  shut: { w: "cierro", v2: "cierras", v3: "cierra", v3p: "cierran", v1p: "cerramos", inf: "cerrar" },
  hug: { w: "abrazo", v2: "abrazas", v3: "abraza", v3p: "abrazan", v1p: "abrazamos", inf: "abrazar" },
  share: { w: "comparto", v2: "compartes", v3: "comparte", v3p: "comparten", v1p: "compartimos", inf: "compartir" },
  teach: { w: "enseño", v2: "enseñas", v3: "enseña", v3p: "enseñan", v1p: "enseñamos", inf: "enseñar" },
  feel: { w: "siento", v2: "sientes", v3: "siente", v3p: "sienten", v1p: "sentimos", inf: "sentir" },
  wake_up: { w: "me despierto", v2: "te despiertas", v3: "se despierta", v3p: "se despiertan", v1p: "nos despertamos", inf: "despertarse" },
  brush_teeth: {
    w: "me cepillo los dientes", v2: "te cepillas los dientes", v3: "se cepilla los dientes",
    v3p: "se cepillan los dientes", v1p: "nos cepillamos los dientes", inf: "cepillarse los dientes",
  },
  // `gustar` inverts its subject, so only the 1sg form is meaningful as a
  // button; the SENTENCE goes through the `like` template in `fixed` below.
  like: { w: "me gusta", inf: "gustar" },

  // Social acts — each the alias of a word that already had a lexeme
  // (hi/hello, goodbye/bye, ok/okay, confused/dont_understand). BOTH spellings
  // are listed on the social tab, so both need words.
  thanks: { w: "gracias" },
  sorry: { w: "perdón" },
  mine: { w: "mío" },
  again: { w: "otra vez" },
  dont_understand: { w: "no entiendo" },

  // Deixis the person tab lists beside i_me/you/we.
  this: { w: "esto" },
  that: { w: "eso" },

  // A CORE ENGINE CONCEPT that never got a Spanish word (`fire` had one, water
  // did not). ⚠ Known limitation: "agua" is feminine but takes the masculine
  // article ("el agua") — the stressed-á exception, which `art` does not model.
  // Marked `f` anyway, because the gender is what every ADJECTIVE agreeing with
  // it reads ("el agua fría"); faking `m` to fix one article would break all of
  // those instead.
  water: { w: "agua", g: "f", mass: true },

  // GROUP-CHIP LABELS — the object-property cluster ids. A chip wears
  // `baseWord(lang, id)`, so an untranslated id is an English chip on a Spanish
  // board. food/toy/clothing/book already had words; these are the nine that did not.
  container: { w: "recipiente", g: "m" },
  openable: { w: "se abre" },
  device: { w: "aparato", g: "m" },
  appliance: { w: "electrodoméstico", g: "m" },
  tableware: { w: "vajilla", g: "f" },
  furniture: { w: "mueble", g: "m" },
  instrument: { w: "instrumento", g: "m" },
  material: { w: "material", g: "m" },
  structure: { w: "estructura", g: "f" },
};

/** The ruleset's OWN words — grammar, verbs, adjectives, core concepts. Spec
 *  ITEMS live on their spec rows (content/words.ts joiner) and must not appear
 *  here too; the no-overlap conformance pin reads this export. */
export const CENTRAL_WORDS = CENTRAL;

/** The LIVE word table — central words ⊕ the spec items' own words. Built
 *  BEFORE the makeRomance call, which closes over it: an item's row is
 *  authoritative for its word, in gloss fallback and frame grammar alike. */
const L: Record<string, Lexeme> = { ...CENTRAL, ...specWords("es") };

const ES_CONN: Record<string, string> = {
  because: "porque",
  so: "por eso",
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
  // "Te ayudo." / "No me quiere." / "Nos ayudas." / "Lo/La ayudo." / "Los ayudo."
  clitic: (h) =>
    h === "i_me" ? "me" : h === "you" ? "te" : h === "we" ? "nos" : h === "he" ? "lo" : h === "she" ? "la" : "los",
  // "a ti", "por mí", "con nosotros", "con él/ella", "para ellos"
  tonic: (h) =>
    h === "i_me" ? "mí" : h === "you" ? "ti" : h === "we" ? "nosotros" : h === "he" ? "él" : h === "she" ? "ella" : "ellos",
  // gustar flips experiencer/subject: "i_me like you" → "Me gustas." The head
  // is the OBJECT, so the experiencer is the complementary person.
  likePron: (h) =>
    h === "i_me" ? "Te gusto." : h === "you" ? "Me gustas." : h === "we" ? "Te gustamos." : h === "he" || h === "she" ? "Me gusta." : "Me gustan.",
  estar: { v1: "estoy", v2: "estás", v3: "está", v3p: "están", v1p: "estamos" },
  ser: { v3: "es", v3p: "son" },
  to: (np) => (np.startsWith("el ") ? `al ${np.slice(3)}` : `a ${np}`),
  inside: (np) => `en ${np}`,
  forTrade: (np) => `por ${np}`,
  // de + article contraction (de + el → del) — the shared tail of every
  // "<base> de" locative (detrás del, debajo del…).
  of: (np) => (np.startsWith("el ") ? `del ${np.slice(3)}` : `de ${np}`),
  // "cerca de la mesa" / "al lado de la mesa", contracting de + el → del.
  near: (np) => (np.startsWith("el ") ? `cerca del ${np.slice(3)}` : `cerca de ${np}`),
  nextTo: (np) => (np.startsWith("el ") ? `al lado del ${np.slice(3)}` : `al lado de ${np}`),
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
  // ES_CONN is the OVERRIDE — the form a connective takes when it joins two
  // clauses and that differs from the word on its button ("para" vs "para
  // que"). Everything else falls through to the lexicon, so a connective with
  // one form is authored once. The raw head stays as the last resort, but
  // `validate-builder-lexicon` now fails before a head can reach it.
  connective: (head) => ES_CONN[head] ?? L[head]?.w ?? head,
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
