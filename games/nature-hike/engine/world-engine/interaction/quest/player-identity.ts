// shared/world-engine/interaction/quest/player-identity.ts
//
// WHO authored an act — a player, named as a creature id. The SPARK SET: one
// author per joined device, each carrying relations, debts and knowledge of its
// own, and none of them owning a body (a player is a spark, not a puppet). This
// module is the entire naming convention, kept pure and dependency-free so every
// layer that needs the membership question — host, dialogue, ledgers, certifier —
// can ask it without importing the quest world.
//
// THE ASYMMETRIC-LOCAL CONVENTION. The LOCAL device's author keeps the cid
// "player", the exact value the retired PLAYER_CREATURE_ID singleton carried.
// That is not nostalgia. Relation keys, debt keys, persisted fulfill issuers and
// every `hashSeed(worldSeed, …, cid)` stream are keyed BY THIS STRING, so moving
// it would re-roll existing single-player worlds and orphan their ledgers.
// Holding it fixed is what turns "delete the singleton" into a pure
// generalization: a single-player world stays byte-identical, because it is the
// same world with a one-member spark set.
//
// A REMOTE author is `player:<personId>`. Internal ids stay LOCAL on every
// device — each device calls its own author "player" — and the translation
// happens only at the NET BOUNDARY, the same seam `mpWireOut` (quest-host.ts)
// already uses to swap the internal avatar id for this peer's personId on the
// wire. One convention, one seam: inbound, a relayed command's sender becomes a
// cid through `playerCidOf`; outbound, `peerIdOf` takes it back. Nothing in
// between has to know which device it is running on.
//
// Worth stating plainly, because it is what the sweep is for: "is this the
// player?" was always THREE questions wearing one constant — *is this the author
// of this act* (a threaded speakerCid), *does this thing have no body of its own*
// (`isPlayerCid`), and *is this the local device's* (`LOCAL_PLAYER_CID`). Only
// the last is a constant comparison. Reaching for the constant where one of the
// other two was meant is precisely the bug class this module makes visible.

/** The LOCAL device's author — one member of the spark set. Value unchanged from
 *  the deleted PLAYER_CREATURE_ID singleton so single-player worlds stay
 *  byte-identical (seeds, relation keys, persisted issuers all identical). */
export const LOCAL_PLAYER_CID = "player";

/** What every REMOTE author's cid starts with. The colon is deliberate: no
 *  generated body id, node id or species word contains one, so the prefix cannot
 *  collide with a world creature. (The certifier enforces the other direction —
 *  a fulfill-node id may not be minted into this namespace.) */
export const PLAYER_CID_PREFIX = "player:";

/**
 * peer network id (personId) → that peer's player-creature id; the local peer
 * maps to LOCAL_PLAYER_CID.
 *
 * `localPeerId` is this device's own network identity (`multiplayer.localId`),
 * absent in single-player — where there is no wire, there is no remote author,
 * and every call answers "player". An empty/absent `peerId` is likewise the
 * local author: a command that names no sender is one this device made itself,
 * which is exactly how a missing `cmd.from` has always read. Idempotent — a cid
 * handed back in comes back out unchanged, so a value can pass through the
 * boundary twice without growing a second prefix.
 */
export function playerCidOf(peerId: string, localPeerId?: string | null): string {
  if (!peerId) return LOCAL_PLAYER_CID;
  if (isPlayerCid(peerId)) return peerId;
  if (localPeerId && peerId === localPeerId) return LOCAL_PLAYER_CID;
  return PLAYER_CID_PREFIX + peerId;
}

/** Spark-set membership test: an AUTHOR — a player-creature id with no body of
 *  its own. THIS is the check almost every old `=== PLAYER_CREATURE_ID` site
 *  actually wanted; the constant compare means only "the local device's". */
export function isPlayerCid(cid: string): boolean {
  return cid === LOCAL_PLAYER_CID || cid.startsWith(PLAYER_CID_PREFIX);
}

/** Inverse of `playerCidOf` for remote authors; null for the local author.
 *  Null therefore means "no network id to send this to" — the local player, or
 *  something that is not a player at all — which is the same answer at the wire
 *  either way, so callers never have to distinguish the two. */
export function peerIdOf(cid: string): string | null {
  if (!cid.startsWith(PLAYER_CID_PREFIX)) return null;
  return cid.slice(PLAYER_CID_PREFIX.length) || null;
}
