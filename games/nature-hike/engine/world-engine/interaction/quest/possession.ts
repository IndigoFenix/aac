// shared/world-engine/interaction/quest/possession.ts
//
// SPIRIT ↔ AVATAR possession (city-expansion step 0): in SPIRIT mode the
// player may ask any creature to JOIN them — that creature becomes the
// player's AVATAR (the spirit enters its body: the creature's own drives are
// suspended, its body is replaced by the player-driven walker wearing its
// model). DISMISSING it (stop / stay) returns the player to spirit mode and
// stands the creature back in the world where the body is.
//
// This module is the PURE state machine — one possession at a time, spirit
// sessions only, guarded transitions, side effects delegated to the host's
// `apply` seam. The quest host executes the body/camera/model swap; boots
// listen through the host's onPossession callback. Headless-tested in
// server/tests/symbol-game-possession.test.ts.

export type PossessionDenied =
  | "not-spirit" // possession is a spirit-mode move — a walker already has a body
  | "already-possessed" // one body at a time; dismiss first
  | "no-creature" // the target isn't a live creature of this session
  | "not-possessed"; // nothing to dismiss

export type PossessionResult = { ok: true } | { ok: false; reason: PossessionDenied };

export interface PossessionDeps {
  /** Is the session a spirit session (possession's home mode)? */
  isSpirit(): boolean;
  /** Is `creatureId` a live creature the session knows? */
  creatureExists(creatureId: string): boolean;
  /** Execute the swap: `creatureId` = enter that body; null = step back out.
   *  `prev` is the body being left (null on possess-from-spirit). Called only
   *  on a GUARD-PASSED transition, after the state has changed. */
  apply(creatureId: string | null, prev: string | null): void;
}

export interface Possession {
  /** The possessed creature, or null (pure spirit). */
  readonly creatureId: string | null;
  possess(creatureId: string): PossessionResult;
  dismiss(): PossessionResult;
}

export function createPossession(deps: PossessionDeps): Possession {
  let current: string | null = null;
  return {
    get creatureId() {
      return current;
    },
    possess(creatureId) {
      // Order: the standing body wins the explanation — "already-possessed"
      // (dismiss first) beats the mode gate.
      if (current !== null) return { ok: false, reason: "already-possessed" };
      if (!deps.isSpirit()) return { ok: false, reason: "not-spirit" };
      if (!deps.creatureExists(creatureId)) return { ok: false, reason: "no-creature" };
      current = creatureId;
      deps.apply(creatureId, null);
      return { ok: true };
    },
    dismiss() {
      if (current === null) return { ok: false, reason: "not-possessed" };
      const prev = current;
      current = null;
      deps.apply(null, prev);
      return { ok: true };
    },
  };
}
