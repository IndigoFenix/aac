// shared/world-engine/interaction/content/pools.ts
//
// The working shared pools (§5.2 / §6.2). Each pool is doubly constrained: an
// AffordanceTag AND glyphed members. "Glyphed" means "has a SYMBOL or a queued
// one" — members whose symbol isn't in the registry yet carry glyphStatus
// "queued" and land on the §6.5 worklist; they don't block authoring (pillar 5).
//
// Member `symbol` keys are verified against shared/glyph-registry.ts. As of the
// 2026-07-28 Tier B pass every member but `sock` resolves — and `sock` is not
// waiting on art, it is waiting on a decision: the board already carries `socks`,
// so one side needs renaming before a record can be added without duplicating a
// referent. The binder is registry-authoritative regardless, so a glyphStatus
// that drifts from reality is corrected at bind time, not trusted.

import type { PoolDef } from "@shared/world-engine/interaction/types.js";

export const POOLS: Record<string, PoolDef> = {
  treat: {
    id: "treat",
    affordance: "repeatable-edible",
    members: [
      {
        id: "cookie",
        label: "Cookie",
        iconRef: "🍪",
        symbol: "cookie",
        words: {
          en: { w: "cookie" },
          he: { w: "עוגייה", g: "f" },
          es: { w: "galleta", g: "f" },
          pt: { w: "biscoito", g: "m" },
        },
      },
      {
        id: "apple",
        label: "Apple",
        iconRef: "🍎",
        symbol: "apple",
        words: {
          en: { w: "apple" },
          he: { w: "תפוח", g: "m" },
          es: { w: "manzana", g: "f" },
          pt: { w: "maçã", g: "f" },
        },
      },
      {
        id: "banana",
        label: "Banana",
        iconRef: "🍌",
        symbol: "banana",
        words: {
          en: { w: "banana" },
          he: { w: "בננה", g: "f" },
          es: { w: "plátano", g: "m" },
          pt: { w: "banana", g: "f" },
        },
      },
      {
        id: "grape",
        label: "Grape",
        iconRef: "🍇",
        symbol: "grape",
        words: {
          en: { w: "grape" },
          he: { w: "ענב", g: "m" },
          es: { w: "uva", g: "f" },
          pt: { w: "uva", g: "f" },
        },
      },
    ],
  },
  // ── AAC VOCABULARY STUBS (2026-08-24) ───────────────────────────────────
  // Everyday food and drink a child asks for that the simulation does not model
  // as a good yet. They are here — on the SPEC side, beside the treats — rather
  // than in any board-side list, because a noun's spec row is the ONE place its
  // words, its icon, its properties and its game role come from
  // (planning-docs/sentence-builder-default-vocabulary.md §6). Stubs: the words
  // and the category are real, the goods/economy rows come later.
  //
  // DRINK IS ITS OWN CATEGORY, not a kind of food: "I want to drink" and "I want
  // to eat" are different requests, and `PROPERTY_FOR_VERB` now sends them to
  // different boards. `water` is a CORE ENGINE CONCEPT, so it rides here for the
  // category and the affordance but authors NO words — the central lexicons own
  // that head (one definition per head, words.ts).
  drink: {
    id: "drink",
    affordance: "repeatable-edible",
    members: [
      { id: "water", label: "Water", iconRef: "💧", symbol: "water" },
      {
        id: "milk",
        label: "Milk",
        iconRef: "🥛",
        symbol: "milk",
        words: {
          en: { w: "milk", mass: true },
          he: { w: "חלב", g: "m", mass: true },
          es: { w: "leche", g: "f", mass: true },
          pt: { w: "leite", g: "m", mass: true },
        },
      },
      {
        id: "juice",
        label: "Juice",
        iconRef: "🧃",
        symbol: "juice",
        words: {
          en: { w: "juice", mass: true },
          he: { w: "מיץ", g: "m", mass: true },
          es: { w: "jugo", g: "m", mass: true },
          pt: { w: "suco", g: "m", mass: true },
        },
      },
    ],
  },
  // The everyday plate — staples, as opposed to the `treat` pool's rewards.
  staple: {
    id: "staple",
    affordance: "repeatable-edible",
    members: [
      {
        id: "bread",
        label: "Bread",
        iconRef: "🍞",
        symbol: "bread",
        words: {
          en: { w: "bread", mass: true },
          he: { w: "לחם", g: "m", mass: true },
          es: { w: "pan", g: "m", mass: true },
          pt: { w: "pão", g: "m", plw: "pães", mass: true },
        },
      },
      {
        id: "cheese",
        label: "Cheese",
        iconRef: "🧀",
        symbol: "cheese",
        words: {
          en: { w: "cheese", mass: true },
          he: { w: "גבינה", g: "f", mass: true },
          es: { w: "queso", g: "m", mass: true },
          pt: { w: "queijo", g: "m", mass: true },
        },
      },
      {
        id: "meat",
        label: "Meat",
        iconRef: "🍖",
        symbol: "meat",
        words: {
          en: { w: "meat", mass: true },
          he: { w: "בשר", g: "m", mass: true },
          es: { w: "carne", g: "f", mass: true },
          pt: { w: "carne", g: "f", mass: true },
        },
      },
    ],
  },
  // THE AUTHORED TOYS (toys-and-song-expansion.md). These are the toys with
  // their OWN head word and their own model; DOLLS are not listed here and never
  // will be, because a doll is not a member of a pool — it is the `toy` FORM
  // facet on whatever creature or vehicle the world already contains
  // (`rabbit.toy` — world-engine/toys.ts). Enumerating dolls here would mean
  // re-listing the species registry, which is exactly what the facet avoids.
  //
  // Members mirror TOY_ITEMS: the pool is the SPEAKABLE side, toys.ts is the
  // craftable side, and a test pins them in sync so a toy can never be makeable
  // but unaskable (or the reverse). `teddy` stays gone — a teddy bear IS
  // `bear.toy` now, which is the same word a child uses for the animal.
  toy: {
    id: "toy",
    affordance: "graspable",
    members: [
      {
        id: "ball",
        label: "Ball",
        iconRef: "⚽",
        symbol: "ball",
        words: {
          en: { w: "ball" },
          he: { w: "כדור", g: "m" },
          es: { w: "pelota", g: "f" },
          pt: { w: "bola", g: "f" },
        },
      },
      {
        id: "blocks",
        label: "Blocks",
        iconRef: "🧱",
        symbol: "blocks",
        words: {
          en: { w: "blocks", pl: true },
          he: { w: "קוביות", g: "f", pl: true },
          es: { w: "bloques", g: "m", pl: true },
          pt: { w: "blocos", g: "m", pl: true },
        },
      },
      {
        id: "puzzle",
        label: "Puzzle",
        iconRef: "🧩",
        symbol: "puzzle",
        words: {
          en: { w: "puzzle" },
          he: { w: "פאזל", g: "m" },
          es: { w: "rompecabezas", g: "m", plw: "rompecabezas" },
          pt: { w: "quebra-cabeça", g: "m", plw: "quebra-cabeças" },
        },
      },
    ],
  },
  friend: {
    id: "friend",
    affordance: "receptive-npc",
    members: [
      {
        id: "rabbit",
        label: "Rabbit",
        iconRef: "🐰",
        symbol: "rabbit",
        words: {
          en: { w: "rabbit" },
          he: { w: "ארנב", g: "m" },
          es: { w: "conejo", g: "m" },
          pt: { w: "coelho", g: "m" },
        },
      },
      {
        id: "bear",
        label: "Bear",
        iconRef: "🐻",
        symbol: "bear",
        words: {
          en: { w: "bear" },
          he: { w: "דוב", g: "m" },
          es: { w: "oso", g: "m" },
          pt: { w: "urso", g: "m" },
        },
      },
      {
        id: "frog",
        label: "Frog",
        iconRef: "🐸",
        symbol: "frog",
        words: {
          en: { w: "frog" },
          he: { w: "צפרדע", g: "f" },
          es: { w: "rana", g: "f" },
          pt: { w: "sapo", g: "m" },
        },
      },
      { id: "dog", label: "Dog", iconRef: "🐶", symbol: "dog" },
      // AAC stub: an animal every child names, with no species row yet (a
      // species needs a blueprint; the word does not have to wait for it).
      {
        id: "bird",
        label: "Bird",
        iconRef: "🐦",
        symbol: "bird",
        words: {
          en: { w: "bird" },
          he: { w: "ציפור", g: "f" },
          es: { w: "pájaro", g: "m", plw: "pájaros" },
          pt: { w: "pássaro", g: "m" },
        },
      },
    ],
  },
  container: {
    id: "container",
    affordance: "openable",
    members: [
      { id: "box", label: "Box", iconRef: "📦", symbol: "box" },
      {
        id: "basket",
        label: "Basket",
        iconRef: "🧺",
        symbol: "basket",
        words: {
          en: { w: "basket" },
          he: { w: "סל", g: "m" },
          es: { w: "cesta", g: "f" },
          pt: { w: "cesta", g: "f" },
        },
      },
      {
        id: "satchel",
        label: "Satchel",
        iconRef: "🎒",
        symbol: "satchel",
        words: {
          en: { w: "satchel" },
          he: { w: "ילקוט", g: "m" },
          es: { w: "bolso", g: "m" },
          pt: { w: "bolsa", g: "f" },
        },
      },
    ],
  },
  // AAC stubs: the table setting. `bowl` is a STATION (the kitchen fixture) and
  // owns its own words there; the cup and the plate have no station row, so the
  // pool is where they live until the kitchen models them.
  tableware: {
    id: "tableware",
    affordance: "graspable",
    members: [
      {
        id: "cup",
        label: "Cup",
        iconRef: "🥤",
        symbol: "cup",
        words: {
          en: { w: "cup" },
          he: { w: "כוס", g: "f" },
          es: { w: "taza", g: "f" },
          pt: { w: "copo", g: "m" },
        },
      },
      {
        id: "plate",
        label: "Plate",
        iconRef: "🍽️",
        symbol: "plate",
        words: {
          en: { w: "plate" },
          he: { w: "צלחת", g: "f", plw: "צלחות" },
          es: { w: "plato", g: "m" },
          pt: { w: "prato", g: "m" },
        },
      },
    ],
  },
  emit: {
    id: "emit",
    affordance: "repeatable-effect",
    members: [
      {
        id: "bubbles",
        label: "Bubbles",
        iconRef: "🫧",
        symbol: "bubbles",
        words: {
          en: { w: "bubbles", pl: true },
          he: { w: "בועות", g: "f", pl: true },
          es: { w: "burbujas", g: "f", pl: true },
          pt: { w: "bolhas", g: "f", pl: true },
        },
      },
      {
        id: "sparks",
        label: "Sparks",
        iconRef: "✨",
        symbol: "sparks",
        words: {
          en: { w: "sparks", pl: true },
          he: { w: "ניצוצות", g: "m", pl: true },
          es: { w: "chispas", g: "f", pl: true },
          pt: { w: "faíscas", g: "f", pl: true },
        },
      },
    ],
  },
  vehicle: {
    id: "vehicle",
    affordance: "startable-movable",
    members: [
      {
        id: "car",
        label: "Car",
        iconRef: "🚗",
        symbol: "car",
        words: {
          en: { w: "car" },
          he: { w: "מכונית", g: "f" },
          es: { w: "coche", g: "m" },
          pt: { w: "carro", g: "m" },
        },
      },
      {
        id: "train",
        label: "Train",
        iconRef: "🚂",
        symbol: "train",
        words: {
          en: { w: "train" },
          he: { w: "רכבת", g: "f" },
          es: { w: "tren", g: "m", plw: "trenes" },
          pt: { w: "trem", g: "m", plw: "trens" },
        },
      },
      {
        id: "boat",
        label: "Boat",
        iconRef: "⛵",
        symbol: "boat",
        words: {
          en: { w: "boat" },
          he: { w: "סירה", g: "f" },
          es: { w: "barco", g: "m" },
          pt: { w: "barco", g: "m" },
        },
      },
    ],
  },
  device: {
    id: "device",
    affordance: "toggleable",
    members: [
      {
        id: "lamp",
        label: "Lamp",
        iconRef: "💡",
        symbol: "lamp",
        words: {
          en: { w: "lamp" },
          he: { w: "מנורה", g: "f" },
          es: { w: "lámpara", g: "f" },
          pt: { w: "lâmpada", g: "f" },
        },
      },
      {
        id: "window",
        label: "Window",
        iconRef: "🪟",
        symbol: "window",
        words: {
          en: { w: "window" },
          he: { w: "חלון", g: "m" },
          es: { w: "ventana", g: "f" },
          pt: { w: "janela", g: "f" },
        },
      },
      {
        id: "heater",
        label: "Heater",
        iconRef: "🔥",
        symbol: "heater",
        words: {
          en: { w: "heater" },
          he: { w: "מחמם", g: "m" },
          es: { w: "calefactor", g: "m" },
          pt: { w: "aquecedor", g: "m" },
        },
      },
    ],
  },
  powerSource: {
    id: "powerSource",
    affordance: "toggleable",
    members: [
      {
        id: "generator",
        label: "Generator",
        iconRef: "🔋",
        symbol: "generator",
        words: {
          en: { w: "generator" },
          he: { w: "גנרטור", g: "m" },
          es: { w: "generador", g: "m" },
          pt: { w: "gerador", g: "m" },
        },
      },
      {
        id: "switch",
        label: "Switch",
        iconRef: "🎚️",
        symbol: "switch",
        words: {
          en: { w: "switch" },
          he: { w: "מתג", g: "m" },
          es: { w: "interruptor", g: "m" },
          pt: { w: "interruptor", g: "m" },
        },
      },
    ],
  },
  // -- motive-batch pools (motive-driven-needs.md follow-ups) ------------------
  // The `instrument` pool (drum, guitar) is GONE, together with the `music`
  // motive it fed: both members were art-less placeholders, and an instrument is
  // a toy — it belongs to the toy system being built, not to a pool of two words
  // nothing could play. A motive whose pool is empty can never bind an item, so
  // leaving `music` behind would have meant a quest that silently never issues.
  reading: {
    id: "reading",
    affordance: "graspable",
    members: [
      {
        id: "book",
        label: "Book",
        iconRef: "📖",
        symbol: "book",
        words: {
          en: { w: "book" },
          he: { w: "ספר", g: "m" },
          es: { w: "libro", g: "m" },
          pt: { w: "livro", g: "m" },
        },
      },
    ],
  },
  clothing: {
    id: "clothing",
    affordance: "graspable",
    members: [
      {
        id: "hat",
        label: "Hat",
        iconRef: "🧢",
        symbol: "hat",
        words: {
          en: { w: "hat" },
          he: { w: "כובע", g: "m" },
          es: { w: "sombrero", g: "m" },
          pt: { w: "chapéu", g: "m" },
        },
      },
      {
        id: "shirt",
        label: "Shirt",
        iconRef: "👕",
        symbol: "shirt",
        words: {
          en: { w: "shirt" },
          he: { w: "חולצה", g: "f" },
          es: { w: "camiseta", g: "f" },
          pt: { w: "camiseta", g: "f" },
        },
      },
      {
        id: "scarf",
        label: "Scarf",
        iconRef: "🧣",
        symbol: "scarf",
        words: {
          en: { w: "scarf" },
          he: { w: "צעיף", g: "m" },
          es: { w: "bufanda", g: "f" },
          pt: { w: "cachecol", g: "m" },
        },
      },
      // AAC stubs: the two garments a child dresses in every morning that no
      // GARMENT row models yet (CLOTHING_HEADS is the wearable-goods spec; these
      // join it when the wardrobe grows).
      //
      // THE HEADS ARE THE GLYPH REGISTRY'S (`shoes`, `jacket`), not tidier
      // singulars of my own: art already ships under those keys, and a second
      // spelling for one referent is exactly the unresolved wart `sock`/`socks`
      // at the top of this file — one that has cost a rename argument already.
      {
        id: "shoes",
        label: "Shoes",
        iconRef: "👟",
        symbol: "shoes",
        words: {
          en: { w: "shoes", pl: true },
          he: { w: "נעליים", g: "f", pl: true },
          es: { w: "zapatos", g: "m", pl: true },
          pt: { w: "sapatos", g: "m", pl: true },
        },
      },
      {
        id: "jacket",
        label: "Jacket",
        iconRef: "🧥",
        symbol: "jacket",
        words: {
          en: { w: "jacket" },
          he: { w: "מעיל", g: "m" },
          es: { w: "chaqueta", g: "f" },
          pt: { w: "casaco", g: "m" },
        },
      },
    ],
  },
  // THE REJECT POOL SITS LOW ON PURPOSE (2026-08-24). Pool declaration order is
  // the vocabulary's priority statement now — it is what `content/vocab-order.ts`
  // ranks nouns by — and this pool exists to supply things a child says NO to.
  // Authored above the real vocabulary it made `sock` the face of [clothing] and
  // ranked broccoli over every hat and shirt.
  reject: {
    id: "reject",
    affordance: "unwanted",
    members: [
      {
        id: "broccoli",
        label: "Broccoli",
        iconRef: "🥦",
        symbol: "broccoli",
        words: {
          en: { w: "broccoli", mass: true },
          he: { w: "ברוקולי", g: "m", mass: true },
          es: { w: "brócoli", g: "m", mass: true },
          pt: { w: "brócolis", g: "m", mass: true },
        },
      },
      {
        id: "sock",
        label: "Sock",
        iconRef: "🧦",
        symbol: "sock",
        glyphStatus: "queued",
        words: {
          en: { w: "sock" },
          he: { w: "גרב", g: "m" },
          es: { w: "calcetín", g: "m", plw: "calcetines" },
          pt: { w: "meia", g: "f" },
        },
      },
    ],
  },
  disposal: {
    id: "disposal",
    affordance: "container",
    // The bin IS the disposal can (its model is a lidded trash can). One word,
    // not a redundant "garbage" twin — see glyph-registry `bin`.
    members: [{ id: "bin", label: "Bin", iconRef: "🗑️", symbol: "bin" }],
  },
};

/**
 * KIND → CATEGORY (motive-driven-needs.md parameter matching): the shared tag a
 * category-target need matches against ("I want food" ← any treat). One flat
 * map, read by the derivation when it builds item facets — pool membership and
 * category deliberately stay separate (a sock is reject-pool but clothing).
 */
export const KIND_CATEGORY: Record<string, string> = {
  cookie: "food",
  apple: "food",
  banana: "food",
  grape: "food",
  broccoli: "food",
  ball: "toy",
  blocks: "toy",
  puzzle: "toy",
  // car/train/boat stay CATEGORISED as toys — a toy car is a toy even though the
  // speakable member comes from the `vehicle` pool. That dual filing is now
  // load-bearing rather than incidental: it is precisely what makes them
  // DEPICTABLE, so `car.toy` is a real doll of a real vehicle. Drum and guitar
  // are still gone with the instrument pool.
  car: "toy",
  train: "toy",
  boat: "toy",
  book: "book",
  hat: "clothing",
  shirt: "clothing",
  scarf: "clothing",
  sock: "clothing",
  // ── AAC vocabulary stubs (2026-08-24) ────────────────────────────────────
  // DRINK is a category of its own: `PROPERTY_FOR_VERB` sends `eat` to food and
  // `drink` to drink, so a board that asks "what do you want to drink" must not
  // answer with the fruit bowl. Water is core, and is categorised here like any
  // other drink — the category is what a NEED matches on, and thirst matches
  // water first of all.
  water: "drink",
  milk: "drink",
  juice: "drink",
  bread: "food",
  cheese: "food",
  meat: "food",
  shoes: "clothing",
  jacket: "clothing",
  cup: "tableware",
  plate: "tableware",
  // `paper` only: `cloth` and `wool` are loom stock with no bundled artwork, and
  // a category tag is what puts a word on a child's board — an artless button is
  // a blank one. They keep their words (ITEM_WORDS) and join this map when the
  // art queue reaches them (`npm run validate-glyphs:art`).
  paper: "material",
};

/** Look up a pool by id (slot name). */
export function getPool(id: string): PoolDef | undefined {
  return POOLS[id];
}

/**
 * THE LIBRARY IS KNOWN BY DEFAULT (language-expansion.md): every pool CONCEPT
 * is a speakable noun from frame 1 — knowing the word for "apple" is not
 * hidden information; only specific CHARACTERS stay encounter-added. One
 * symbol per concept (a car is a toy AND a vehicle — first pool wins),
 * deterministic order (authoring order of POOLS, then members).
 */
export function libraryNouns(): { symbol: string; label: string }[] {
  const seen = new Set<string>();
  const out: { symbol: string; label: string }[] = [];
  for (const pool of Object.values(POOLS)) {
    for (const m of pool.members) {
      if (seen.has(m.symbol)) continue;
      seen.add(m.symbol);
      out.push({ symbol: m.symbol, label: m.label.toLowerCase() });
    }
  }
  return out;
}
