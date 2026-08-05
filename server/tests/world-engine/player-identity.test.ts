// PLAYER IDENTITY (multi-entity-conversations.md §3e) — the end of the player
// singleton. Every device names its OWN author "player" (the asymmetric-local
// convention), a remote author is `player:<personId>`, and the translation
// happens only at the net boundary. Two things this suite pins hardest: the
// local value has NOT moved (single-player worlds must stay byte-identical —
// seeds, relation keys and persisted issuers are all keyed by this string), and
// the cid↔peerId mapping round-trips both ways. Pure — no world, no DOM.

import { describe, it, expect } from "@jest/globals";
import {
  LOCAL_PLAYER_CID,
  PLAYER_CID_PREFIX,
  isPlayerCid,
  peerIdOf,
  playerCidOf,
} from "@shared/world-engine/interaction/quest/player-identity.js";

const LOCAL = "person-local";
const PEER = "person-remote";

describe("the constants — byte-identity with the retired singleton", () => {
  it("the LOCAL author is still exactly \"player\"", () => {
    // Moving this re-rolls every seeded stream and orphans every saved ledger.
    expect(LOCAL_PLAYER_CID).toBe("player");
    expect(PLAYER_CID_PREFIX).toBe("player:");
  });

  // ⑪ — the companion test here used to assert that creature-quests' deprecated
  // re-export still resolved to this same value. That re-export is DELETED
  // (multi-entity-conversations.md §4.11) and there is no second name for the
  // local author any more, so the byte-identity claim above is now the whole of
  // it: one constant, one module, one value that must never move.
});

describe("playerCidOf — peer network id → author cid", () => {
  it("maps the LOCAL peer to LOCAL_PLAYER_CID (each device calls its own author \"player\")", () => {
    expect(playerCidOf(LOCAL, LOCAL)).toBe(LOCAL_PLAYER_CID);
  });

  it("prefixes a REMOTE peer", () => {
    expect(playerCidOf(PEER, LOCAL)).toBe("player:person-remote");
    expect(playerCidOf(PEER, LOCAL).startsWith(PLAYER_CID_PREFIX)).toBe(true);
  });

  it("with no local identity (single-player / unknown wire) any named peer is remote", () => {
    expect(playerCidOf(PEER)).toBe("player:person-remote");
    expect(playerCidOf(PEER, null)).toBe("player:person-remote");
  });

  it("an ABSENT sender is the local author — a command that names nobody is this device's", () => {
    expect(playerCidOf("", LOCAL)).toBe(LOCAL_PLAYER_CID);
    expect(playerCidOf("")).toBe(LOCAL_PLAYER_CID);
  });

  it("is IDEMPOTENT — a cid crossing the boundary twice never grows a second prefix", () => {
    expect(playerCidOf(playerCidOf(PEER, LOCAL), LOCAL)).toBe("player:person-remote");
    expect(playerCidOf(LOCAL_PLAYER_CID, LOCAL)).toBe(LOCAL_PLAYER_CID);
  });

  it("gives DISTINCT cids to distinct peers (the point of deleting the singleton)", () => {
    const a = playerCidOf("person-a", LOCAL);
    const b = playerCidOf("person-b", LOCAL);
    expect(a).not.toBe(b);
    expect(a).not.toBe(playerCidOf(LOCAL, LOCAL));
  });
});

describe("peerIdOf — the inverse, at the net boundary", () => {
  it("round-trips a REMOTE author back to its network id", () => {
    expect(peerIdOf(playerCidOf(PEER, LOCAL))).toBe(PEER);
  });

  it("round-trips every peer in a spark set", () => {
    for (const id of ["person-a", "person-b", "someone:with:colons", "0"]) {
      expect(peerIdOf(playerCidOf(id, LOCAL))).toBe(id);
    }
  });

  it("is NULL for the local author (nothing to address on the wire)", () => {
    expect(peerIdOf(LOCAL_PLAYER_CID)).toBeNull();
    expect(peerIdOf(playerCidOf(LOCAL, LOCAL))).toBeNull();
  });

  it("is NULL for a world creature — same answer at the wire, so callers need not distinguish", () => {
    expect(peerIdOf("mara")).toBeNull();
    expect(peerIdOf("players")).toBeNull();
  });

  it("is NULL for a bare prefix with no id behind it", () => {
    expect(peerIdOf(PLAYER_CID_PREFIX)).toBeNull();
  });
});

describe("isPlayerCid — the spark-set membership test (an AUTHOR, no body of its own)", () => {
  it("accepts the local author and any remote one", () => {
    expect(isPlayerCid("player")).toBe(true);
    expect(isPlayerCid("player:x")).toBe(true);
    expect(isPlayerCid(playerCidOf(PEER, LOCAL))).toBe(true);
  });

  it("rejects world creatures — including names that merely start with the word", () => {
    expect(isPlayerCid("mara")).toBe(false);
    expect(isPlayerCid("players")).toBe(false);
    expect(isPlayerCid("playerx")).toBe(false);
    expect(isPlayerCid("")).toBe(false);
  });

  it("holds for every cid playerCidOf can produce", () => {
    for (const id of ["", LOCAL, PEER, "person-c"]) {
      expect(isPlayerCid(playerCidOf(id, LOCAL))).toBe(true);
    }
  });
});
