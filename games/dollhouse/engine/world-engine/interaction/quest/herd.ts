// TAMING → HERD (band-settlement-round.md B-⑥ — city-founding ④'s open
// tail, retired here).
//
// ⚖️ THE DECIDED HANDOFF LAW (city-founding.md, verbatim ruling):
// individual owned-animal containers are the physics ONLY at homestead
// scale; on promotion to a town the owned animals must be CONVERTED to
// the abstract domestic-herd count and the individual containers retired
// — never both accounts as physics at once. This module is that
// conversion: the "never both at once" clause IS the fold law (one form
// live at a time), which is why the herd row speaks `Band.mix`'s
// species→count vocabulary and joins the same conservation family
// (counts conserved beside goods, nothing evaporates, F-①).
//
// 🚨 THE DEFECT THIS ENDS (the "unwritten" F-① violation, surveyed
// 2026-08-23): a tamed animal survived every LOD fold — the wild codec
// deliberately does not fold creatures ("a cow you tamed is somebody's
// property") — and then evaporated ENTIRELY at the session boundary:
// FoundedSite/SerializedTownDeltas had no field for it, so the owner
// row, the production clocks and the animal itself were dropped at
// `disposeWilderness`, and the same animal came back WILD at the next
// mount ("Fauna reshuffles per mount"). The fold family cannot conserve
// what serialization never had a field for; `HerdRow` is the field.
//
// The herd row carries the animals' pooled LIVE stock beside the count —
// the wild codec's own "conserves the live stack, not the initial roll"
// law: a count-only row would either destroy the wool on the sheep at
// the bank or mint fresh wool at a re-embodiment, and both are the exact
// leak this round exists to close.
//
// The EXPAND half (herd rows → individual owned containers) has no
// shipped consumer: a promoted site re-mounts as a TOWN, and at town
// rung the abstract count IS the law's end state (rendered as scenery —
// quest-host's herd arm of seedTownFauna). Re-embodiment at homestead
// scale awaits a path that de-materializes a town back to a homestead;
// recorded in the round doc, not built speculatively.

import {
  containerEntries, deleteContainerRecord, type ContainerRegistry,
} from "../../kernel/town/containers.js";
import { parseScopeId } from "../../kernel/town/scope.js";
import { isPrivateOwner } from "../behavior/ownership.js";
import { mergeHerd, type HerdRow } from "../../kernel/town/construction.js";
import type { FoundedSite } from "../town/founding.js";
import { wildAnimalBodyId, type WildernessContent } from "./wilderness.js";

/** The session slice the conversion reads — structural, so tests need no
 *  quest-host boot: the container registry plus the scatter content. */
export interface HerdSession extends ContainerRegistry {
  wilderness?: WildernessContent | null;
}

/** One owned product animal, as the census answers it. */
export interface OwnedAnimal {
  /** Its container/body id (`fauna:<species>:<tag>`). */
  objId: string;
  species: string;
  /** Its LIVE stock — the container row's stack, aliased not copied. */
  stock: Record<string, number>;
}

/**
 * ⚖️ B-⑥ THE CENSUS — every OWNED product animal in the session. Two
 * predicates, both established: the id parses as a `fauna:` body
 * (scope.ts — a chest can never collide; town-scenery fauna have no
 * container row, so the registry walk excludes them structurally), and
 * the container row names a PRIVATE owner (ownership.ts — a wild
 * animal's owner is null, "nature is nobody's", until a tame writes the
 * claim).
 */
export function ownedAnimalsOf(session: HerdSession): OwnedAnimal[] {
  const out: OwnedAnimal[] = [];
  for (const [objId, rec] of containerEntries(session)) {
    const ref = parseScopeId(objId);
    if (ref.kind !== "wild" || ref.form !== "fauna") continue;
    if (!isPrivateOwner(rec.owner ?? null)) continue;
    out.push({ objId, species: ref.species, stock: rec.stock ?? {} });
  }
  return out;
}

/**
 * ⚖️ B-⑥ THE CONVERSION — owned animals become the site's domestic-herd
 * rows, and their individual containers RETIRE (the handoff law's
 * "never both accounts as physics at once", enforced here rather than
 * hoped for at the call site). Per animal: its count and its live stock
 * ride `site.herd` (pooled per species via the ONE merge shape), its
 * scatter entry leaves `wilderness.creatures`, its container row leaves
 * the registry, and `removeBody` — when the caller still has a live
 * world — removes the walking body (at the dispose seam the world dies
 * on the next line, so the callback may honestly be omitted; the
 * SESSION-side teardown never is).
 *
 * Idempotent: a second call finds no owned animals and changes nothing.
 * Returns what was banked (species → row), for the caller's disclosure.
 */
export function bankOwnedHerd(
  session: HerdSession,
  site: FoundedSite,
  opts: { removeBody?: (objId: string) => void } = {},
): Record<string, HerdRow> {
  const banked: Record<string, HerdRow> = {};
  for (const a of ownedAnimalsOf(session)) {
    mergeHerd(banked, { [a.species]: { n: 1, stock: { ...a.stock } } });
    const w = session.wilderness;
    if (w) {
      const ci = w.creatures.findIndex(c => c.species && wildAnimalBodyId(c) === a.objId);
      if (ci >= 0) w.creatures.splice(ci, 1);
    }
    opts.removeBody?.(a.objId);
    deleteContainerRecord(session, a.objId);
  }
  if (Object.keys(banked).length) {
    site.herd = mergeHerd(site.herd ?? {}, banked);
  }
  return banked;
}
