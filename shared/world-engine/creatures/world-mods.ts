// shared/world-engine/creatures/world-mods.ts
//
// INSTALLING a world's creature mods — the one call that turns the `mods`
// field of a world document into a live registry.
//
// Kept out of species.ts (which stays a pure catalogue that knows nothing
// about mods) and out of mods.ts (which stays a pure transform that installs
// nothing). This module is the only place the two meet, so there is exactly
// one answer to "what does declaring a mod actually do":
//
//   1. resolve the ids, refusing an unknown one by name;
//   2. register every DERIVED species — never over an authored row, so the
//      hand-drawn `dog_person` keeps its authored geometry and only the
//      species nobody drew are generated;
//   3. set the APPEARANCE mods active, so every body built from here on is
//      built through them.
//
// Idempotent: calling it again with the same ids re-derives the same rows.

import { listSpecies, registerSpecies, unregisterSpecies, type Species } from "./species";
import { resolveCreatureMods } from "./mod-library";
import { deriveModSpecies, setActiveCreatureMods, type CreatureMod, type DerivedSpecies } from "./mods";

export interface InstalledCreatureMods {
  mods: CreatureMod[];
  /** The rows that were added to the registry. */
  derived: DerivedSpecies[];
}

/** Ids THIS module installed, so switching a mod off can retract exactly
 *  those rows and nothing else. An authored species is never in here. */
let INSTALLED: string[] = [];

/**
 * Apply a world's declared creature mods to the species registry.
 *
 * `[]` (or omitted) still runs, and is the way BACK: it retracts every row a
 * previous call derived and clears the active appearance mods, so a world
 * with no mods is the authored registry again. (The creature lab flips them
 * constantly; a game calls this once at load.)
 */
export function applyWorldCreatureMods(ids: readonly string[] = []): InstalledCreatureMods {
  const mods = resolveCreatureMods(ids);
  // Retract FIRST, and derive from what is left: a stale derived row would
  // otherwise be its own base's competitor (`deriveModSpecies` skips an id the
  // registry already holds, so a second call would derive nothing at all).
  for (const id of INSTALLED) unregisterSpecies(id);
  INSTALLED = [];
  const derived = deriveModSpecies(mods, listSpecies());
  for (const sp of derived) {
    registerSpecies(sp as Species);
    INSTALLED.push(sp.id);
  }
  setActiveCreatureMods(mods);
  return { mods, derived };
}

/**
 * The species a mod set WOULD derive, without installing anything — the
 * creature lab's preview list, and the way a test asks what a mod does
 * without mutating the registry the next test reads.
 */
export function previewModSpecies(ids: readonly string[]): DerivedSpecies[] {
  return deriveModSpecies(resolveCreatureMods(ids), listSpecies());
}
