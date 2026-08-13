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
