// shared/world-engine/interaction/content/noun-clusters.ts
//
// WHICH CHIPS WOULD CARRY THIS NOUN — asked once, answered once.
//
// A chip is a cluster of nouns: one per object PROPERTY (food, furniture,
// container…) plus the KIND clusters, which answer the questions properties
// cannot — is this somebody, an animal, a plant, a place, or a plain thing.
//
// ⚖️ ONE RULE, THREE READERS. This used to be written out three times: the
// surfacer's `clusterSize` (which decides whether a board may WITHHOLD a noun
// in favour of a chip), the surfacer's `buildGroups` (which builds the chips),
// and the adapter's `thingClusters` (the things tab's sub-chips). Three copies
// of one rule is three chances to disagree, and they did — the mirror that
// predicted the chips did not mirror `MAX_GROUPS`, so 62 of 67 creatures were
// withheld from every desire board in favour of an `animals` chip that was
// built and then discarded. A child could not say "I want the dog".
//
// So the rule lives here and the readers ask. A new cluster is one edit.

import { isAnimal, isPlant } from "./properties.js";
import { placeGroupOf } from "./vocab-order.js";

/** A cluster this noun belongs to. `property` clusters come from the object's
 *  own properties; `kind` clusters from what sort of thing it is. */
export interface NounCluster {
  id: string;
  kind: "property" | "kind";
}

/** The shape every reader has: the surfacer's `SurfaceNoun` and the adapter's
 *  `BuilderNounEntry` both satisfy it. */
export interface ClusterableNoun {
  symbol: string;
  kind?: string;
  properties?: readonly string[];
  /**
   * A SPECIFIC PERSON — this child's own contact, or the character standing in
   * for one inside a game. Not a class of person (`teacher`, `friend`), which
   * is what `creatures` carries: an individual is Mara, or Mum, and it is the
   * only one of the three living clusters whose membership is not static.
   *
   * ⚖️ CARRIED IN, NEVER LOOKED UP (user, 2026-09-01). The in-game builder is
   * imitating the way the board is used outside a game, "just as the student
   * would use that spot to indicate a real, specific person" — so the roster is
   * one list with two sources, and it arrives as DATA on the noun. The surfacer
   * never queries a directory, a party or a session: same sentence + same
   * roster ⇒ same board, which is what keeps the builder deterministic.
   */
  individual?: boolean;
}

/**
 * Every cluster the noun belongs to. Order is stable (properties first, then
 * the one kind cluster) so callers that build in this order stay deterministic.
 */
export function clusterIdsOf(n: ClusterableNoun): NounCluster[] {
  const out: NounCluster[] = (n.properties ?? []).map((id) => ({ id, kind: "property" as const }));
  const kind = (id: string) => out.push({ id, kind: "kind" });
  if (n.kind === "creature") {
    // THE LIVING SPLIT (2026-08-27), plus individuals (2026-09-01). `creatures`
    // is the chip that means SOMEBODY IN GENERAL; an animal is not somebody;
    // and a named person is not a category. Read off the spec registries
    // (`isAnimal`) and the roster flag, never a word list, so a new species row
    // and a new contact both file themselves.
    kind(n.individual ? "individuals" : isAnimal(n.symbol) ? "animals" : "creatures");
  } else if (n.kind === "place") {
    // The place split (2026-08-25): rooms · buildings · outside. One chip for
    // twenty-two places is a chip that opens another paging problem.
    kind(placeGroupOf(n.symbol));
  } else if (n.kind === "item") {
    // A plant keeps its property chips too (`tree` is also timber) — the one a
    // child actually looks for must not be the one it loses.
    if (isPlant(n.symbol)) kind("plants");
    else if (!(n.properties ?? []).length) kind("things");
  }
  return out;
}
