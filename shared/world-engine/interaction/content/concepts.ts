// shared/world-engine/interaction/content/concepts.ts
//
// The CONCEPT BRIDGE (language-expansion.md): the "noun library" currently
// lives in three disjoint registries — curriculum POOLS (glyph symbol + pool
// affordance, pools.ts), the KIND→CATEGORY map, and the SPECIES body-plan
// catalogue (creatures/species.ts). A ConceptDef JOINS them by SYMBOL, and
// derives the verbs each noun AFFORDS from that data — the exact parameters a
// clinician (or the AI) will later use to add real-life nouns, and the
// noun→verb axis the button surfacer filters by (composeNeed reversed).
//
// DELIBERATELY A BRIDGE, NOT A UNIFICATION (user decision): the three sources
// stay authoritative for their own facets; this module only reads them.
// Economy nouns (goods/buildings — kernel/modules/economy) join later via
// `extraConcepts` when the surfacer needs town-scope vocabulary.
//
// Everything here is DERIVED data — no hand-authored phrase lists. A pool's
// affordance says what its members are FOR; the category and species kind
// refine it. Deterministic: authoring order of POOLS, then members.

import type { AffordanceTag } from "@shared/world-engine/interaction/types.js";
import { KIND_CATEGORY, POOLS } from "./pools.js";
import { propertiesOf } from "./properties.js";
import type { ObjectProperty } from "../../object-properties.js";
import { getSpecies, type SpeciesKind } from "../../creatures/species.js";

export interface ConceptDef {
  symbol: string;
  label: string;
  iconRef?: string;
  /** Every pool this concept belongs to, with the pool's affordance. */
  pools: { id: string; affordance: AffordanceTag }[];
  /** Shared category tag ("food", "toy", "clothing") — parameter matching. */
  category?: string;
  /** Body plan, when the concept is a living thing (species registry). */
  species?: { id: string; kind: SpeciesKind };
  /** Verbs this concept affords (LEXICON verb ids), derived from its pools/
   *  category/species — the surfacer's noun→verb axis. Sorted, deduped. */
  affords: string[];
  /** What the concept IS — spec-derived object properties (properties.ts), the
   *  board's sub-tab filing and the verb pre-load's key. Empty for core engine
   *  concepts, which have no spec and need none. */
  properties?: ObjectProperty[];
}

/** Verbs an AFFORDANCE implies (LEXICON verb ids — parse-intent.ts). */
const AFFORDANCE_VERBS: Record<AffordanceTag, string[]> = {
  "repeatable": ["want"],
  "repeatable-edible": ["eat", "want", "get", "give"],
  "repeatable-effect": ["play", "want"],
  "graspable": ["get", "take", "give", "put", "drop", "throw", "carry", "want"],
  "transferable": ["give", "take", "want"],
  "receptive-npc": ["talk", "ask", "help", "hug", "give", "follow", "go", "play"],
  "openable": ["open", "shut"],
  "container": ["open", "shut", "put"],
  "startable-movable": ["go", "stop", "play"],
  "ongoing-process": ["stop"],
  "toggleable": ["open", "shut"],
  "vertical-movable": ["go"],
  "goal-blocked": ["help"],
  "goal-blocked-heavy": ["help", "push", "pull"],
  "requestable": ["want"],
  "unwanted": ["throw"],
  "attention-worthy": ["show"],
  "rotatable": ["turn"],
  "causative": ["make"],
};

/** Verbs a CATEGORY implies (the chore/self-care seams the compiler dispatches
 *  on — intent-compile CATEGORY_NEEDS / SATISFY_NEED_PREFIX). */
const CATEGORY_VERBS: Record<string, string[]> = {
  food: ["eat", "cook", "heat", "want", "give"],
  toy: ["play", "want", "give"],
  clothing: ["wear", "wash", "want", "give"],
  instrument: ["play", "want"],
  book: ["read", "want"],
};

/** Verbs a SPECIES KIND implies. */
const SPECIES_VERBS: Record<SpeciesKind, string[]> = {
  creature: ["talk", "help", "hug", "follow", "chase", "give"],
  plant: ["cut", "want"],
  fruit: ["eat", "get", "want", "give"],
  spark: [],
};

function conceptFor(symbol: string): ConceptDef {
  const pools: { id: string; affordance: AffordanceTag }[] = [];
  let label = symbol;
  let iconRef: string | undefined;
  for (const pool of Object.values(POOLS)) {
    const m = pool.members.find((mm) => mm.symbol === symbol);
    if (!m) continue;
    pools.push({ id: pool.id, affordance: pool.affordance });
    if (label === symbol) label = m.label.toLowerCase();
    iconRef ??= m.iconRef;
  }
  const category = KIND_CATEGORY[symbol];
  const sp = getSpecies(symbol);
  const affords = new Set<string>();
  for (const p of pools) for (const v of AFFORDANCE_VERBS[p.affordance] ?? []) affords.add(v);
  if (category) for (const v of CATEGORY_VERBS[category] ?? []) affords.add(v);
  if (sp) for (const v of SPECIES_VERBS[sp.kind] ?? []) affords.add(v);
  const properties = propertiesOf(symbol);
  return {
    symbol,
    label,
    ...(iconRef ? { iconRef } : {}),
    pools,
    ...(category ? { category } : {}),
    ...(sp ? { species: { id: sp.id, kind: sp.kind } } : {}),
    affords: [...affords].sort(),
    ...(properties.length ? { properties } : {}),
  };
}

/**
 * The joined concept library, keyed by symbol. Sources: every POOLS member +
 * every KIND_CATEGORY key (some categories tag symbols outside any pool).
 * `extraConcepts` lets a host add scope-specific nouns (economy goods,
 * buildings) without touching the static core. Pure and deterministic.
 */
export function buildConcepts(extraConcepts?: ConceptDef[]): Map<string, ConceptDef> {
  const out = new Map<string, ConceptDef>();
  for (const pool of Object.values(POOLS)) {
    for (const m of pool.members) {
      if (!out.has(m.symbol)) out.set(m.symbol, conceptFor(m.symbol));
    }
  }
  for (const symbol of Object.keys(KIND_CATEGORY)) {
    if (!out.has(symbol)) out.set(symbol, conceptFor(symbol));
  }
  for (const extra of extraConcepts ?? []) {
    if (!out.has(extra.symbol)) out.set(extra.symbol, extra);
  }
  return out;
}
