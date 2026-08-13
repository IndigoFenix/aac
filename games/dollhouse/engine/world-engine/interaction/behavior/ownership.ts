/**
 * ownership.ts — WHO MAY USE WHAT, as a SCOPE CHAIN (round 4; user:
 * "communal and private property within a house, with multiple layers of
 * ownership — extendable to larger social structures").
 *
 * An OWNER is a SCOPE STRING, and scopes NEST:
 *
 *   creature:<cid>   ⊂   house:<houseIndex>   ⊂   town
 *
 * A creature BELONGS to the chain of scopes around it (itself, its
 * household, its town), and may freely USE anything owned at any tier it
 * belongs to: the personal box is `creature:` (private — housemates'
 * walkers never touch it), the pantry chest is `house:` (communal to the
 * household), the well is `town` (communal to everyone). `null` stays
 * "unowned/free" (a stick on the road).
 *
 * EXTENDING to larger social structures is adding LINKS, not machinery:
 * a future `party`, `guild:<id>`, `civ:<id>` tier is one more entry in
 * `ownerScopesOf`'s chain (threaded from whatever membership data owns
 * it) — every gate that calls `mayUse` inherits the tier for free.
 *
 * A double bed has TWO owners: a `|`-joined owner string means ANY of
 * the listed scopes admits (`creature:a|creature:b`).
 *
 * Two layers of protection use this, deliberately different:
 *   • ABSOLUTE (the walkers): an autonomous creature never even LISTS a
 *     container/station it may not use (residentNeedCtx filters by
 *     `mayUse`) — foreign private property is invisible to its needs.
 *   • SOCIAL (the player + commands): a take of foreign PRIVATE property
 *     is refused while its owner is nearby to object (the same
 *     owner-present rule the vendor-stock veto uses) — the teachable
 *     "that's Mara's!" moment, not an invisible wall.
 */

/** "creature:<cid>" · "house:<hi>" · "town" · (future: "party", "guild:<id>"…).
 *  `|`-joined for multi-owner property (a double bed). */
export type OwnerScope = string;

export const TOWN_SCOPE: OwnerScope = "town";

export function creatureScope(cid: string): OwnerScope {
  return `creature:${cid}`;
}

export function houseScope(houseIndex: number): OwnerScope {
  return `house:${houseIndex}`;
}

/** The scope chain `cid` belongs to — itself, its household (when it has
 *  one), its town. Future tiers (party, guild, civ) slot in here. */
export function ownerScopesOf(cid: string, houseIndex: number | null): OwnerScope[] {
  const scopes: OwnerScope[] = [creatureScope(cid)];
  if (houseIndex !== null && Number.isFinite(houseIndex)) scopes.push(houseScope(houseIndex));
  scopes.push(TOWN_SCOPE);
  return scopes;
}

/** May `cid` (member of `houseIndex`'s household, when not null) freely
 *  use property owned by `owner`? Unowned (`null`/`undefined`) is free;
 *  a `|`-joined owner admits any of its listed scopes. */
export function mayUse(
  cid: string,
  houseIndex: number | null,
  owner: OwnerScope | null | undefined,
): boolean {
  return mayUseByScopes(ownerScopesOf(cid, houseIndex), owner);
}

/**
 * ⚖️ THE SAME QUESTION, ASKED BY A SCOPE RATHER THAN A BODY (S&D S4).
 *
 * `mayUse` asks it of a CREATURE, which is right for everything a creature
 * does. A town's own standing errand is not one of those: the par loop that
 * keeps the storehouse stocked is the TOWN acting, and borrowing whichever
 * body happens to be the issuer hands it that body's household shelves —
 * which is how an ambient civic loop came to be able to spend a family's
 * stores. Given `[TOWN_SCOPE]` this answers the town's own reach: the commons
 * and what nobody owns, and nothing private.
 *
 * Extending is still adding LINKS, not machinery — a guild loop passes
 * `["guild:5", TOWN_SCOPE]` and inherits every gate.
 */
export function mayUseByScopes(
  mine: readonly OwnerScope[],
  owner: OwnerScope | null | undefined,
): boolean {
  if (owner == null || owner === "") return true;
  return owner.split("|").some((o) => mine.includes(o));
}

/** The scope chain an errand acting AS THE TOWN reaches with — the commons and
 *  the unowned, never a household's shelves. */
export const CIVIC_SCOPES: readonly OwnerScope[] = [TOWN_SCOPE];

/** Is this owner string PRIVATE property (some creature's own)? The
 *  social stop-gate (player takes, commanded takes) protects exactly
 *  these — communal tiers are protected from OUTSIDERS by the walkers'
 *  listing filter, but stealing from a house you're standing in stays
 *  physically possible (and visible). */
export function isPrivateOwner(owner: OwnerScope | null | undefined): boolean {
  return !!owner && owner.split("|").every((o) => o.startsWith("creature:"));
}

/** The cids named by a (possibly `|`-joined) owner string — for
 *  surfacing WHO objects ("that's Mara's!"). */
export function ownerCidsOf(owner: OwnerScope | null | undefined): string[] {
  if (!owner) return [];
  return owner
    .split("|")
    .filter((o) => o.startsWith("creature:"))
    .map((o) => o.slice("creature:".length));
}
