// shared/world-engine/kernel/town/container-seeds.ts
//
// WHAT PORTABLE CONTAINERS THE WORLD STARTS WITH (scope-unification.md step ③,
// the seeding half).
//
// Step ③ deleted the abstract inventory: a body's carry IS the containers it
// holds, and nothing else. That left a world in which the containers did not
// exist — every body in every game, the player included, was a ONE-ITEM body,
// because no basket and no satchel had ever been put anywhere. The law shipped
// without its furniture.
//
// This module is the furniture, and NOTHING ELSE. It answers "what bags stand
// where, and whose are they" as pure data; quest-host walks the answer through
// `spawnLooseProp` / `donWornBag`, which stay the only minters. There is no
// rule here about USING a bag — no fetch-a-basket-before-shopping, no
// auto-equip. Step ④ prices those decisions; existence is all that lands here.
//
// WHY THE OWNER TRAVELS WITH THE SEED. A container without an owner is free for
// anyone to empty (ownership.ts), and the three seeds want three different
// answers: the household's basket is `house:<i>` (communal to its members,
// invisible to the neighbours' walkers), the town's haulage basket is `town`,
// and the market's stock is unowned — goods on offer, like the fruit already
// scattered beside them. Deciding that at each call site is how one of them
// ends up wrong.

import { houseScope, TOWN_SCOPE, type OwnerScope } from "../../interaction/behavior/ownership.js";

/** One container to mint: a glyph, a spot in world coords, and whose it is
 *  (`null` = unowned, the "free for the taking" answer ownership.ts spells). */
export interface ContainerSeed {
  glyph: string;
  at: { x: number; y: number };
  owner: OwnerScope | null;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The bag the player's own body starts WEARING. A satchel and not a basket for
 *  the one reason the pair exists (containers.ts): worn leaves the hands free,
 *  so the player can still pick a quest item up while carrying goods. A basket
 *  would have cost them the hand the whole game is played with. */
export const PLAYER_BAG_GLYPH = "satchel";

/**
 * THE HOUSEHOLD'S BASKET — one per house, standing in the living room where
 * the goods chests corner.
 *
 * ONE, and it belongs to the HOUSE. Giving each resident their own would make a
 * five-basket household and quietly answer step ④'s question ("does a body
 * bring a basket, or does the household have one?") in the most expensive
 * direction. A shared tool is the cheaper claim and the reversible one.
 */
export function houseBagSeeds(houseIndex: number, living: Rect): ContainerSeed[] {
  return [
    {
      glyph: "basket",
      // Center-relative, like the authored floor items (quest-host's
      // `definedItems`) — offset to the OTHER side of the room's middle so a
      // house that also ships authored props does not stack them in one spot.
      at: { x: living.x + living.w / 2 - 1, y: living.y + living.h / 2 + 0.9 },
      owner: houseScope(houseIndex),
    },
  ];
}

/**
 * THE MARKET'S SUPPLY — the bags a body with none can go and get.
 *
 * Two baskets and two satchels on the ground by the stalls, UNOWNED: stock on
 * offer, exactly like the loose fruit already scattered beside them. Both kinds,
 * because the choice between them is the interesting one (a hand, or five units
 * instead of eight) and a market that only sold baskets would make it for you.
 */
export function marketBagSeeds(market: { x: number; y: number }): ContainerSeed[] {
  return [
    { glyph: "basket", at: { x: market.x - 1.2, y: market.y + 1.6 }, owner: null },
    { glyph: "basket", at: { x: market.x - 2.0, y: market.y + 1.9 }, owner: null },
    { glyph: "satchel", at: { x: market.x - 1.4, y: market.y + 2.4 }, owner: null },
    { glyph: "satchel", at: { x: market.x - 2.2, y: market.y + 2.7 }, owner: null },
  ];
}

/**
 * THE BUILDER'S YARD — ONE basket, owned by the `town`.
 *
 * Its own seed and not part of the market's, because the yard is registered
 * BEFORE the houses gate: an age-0 homestead (settlers, no plan houses, no
 * market yet) has a yard with real stock in it, and that is the settlement most
 * in need of something to haul with.
 */
export function yardBagSeeds(yard: { x: number; y: number }): ContainerSeed[] {
  return [{ glyph: "basket", at: { x: yard.x + 1.1, y: yard.y + 0.9 }, owner: TOWN_SCOPE }];
}
