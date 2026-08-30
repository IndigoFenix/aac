/**
 * ONE FOLD from a lab preset to a runnable `aivota-world` document.
 *
 * The tree lowers itself (`lowerObjectDef`); the SESSION settings — how the
 * player inhabits it, which species, which creature mods, the clocks — are a
 * flat bag that has to be folded onto `doc.game` afterwards. Two callers need
 * that fold and they must not disagree:
 *
 *   • the world-lab's spec form (`getDocument()`), which is what a person sees
 *     when they press "run" in the lab;
 *   • `scripts/sync-game-engine.ts`, which GENERATES a shipped game's
 *     `game.spec.json` from the same preset.
 *
 * It used to be written out twice, with a comment on the second copy saying it
 * matched the first. It didn't: a session field added to the form was silently
 * dropped from every generated spec, so the lab showed one world and the
 * shipped game booted another. One function now, deliberately DOM-free so the
 * sync script can import it under tsx.
 */
import { lowerObjectDef, type ObjectDef } from "@shared/world-engine/object-def";

type Dict = Record<string, unknown>;

/** A loadable preset: an ObjectDef tree + its session settings. */
export interface TreeWorld {
  tree: ObjectDef;
  /** avatar / can_fly / avatar_species / mods / scale / culture */
  session?: Dict;
}

const isObj = (v: unknown): v is Dict => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Lower a preset to the `aivota-world` document it runs as.
 *
 * ⚠️ EVERY session field a preset may carry belongs here. A field the form can
 * author but this doesn't fold is a field the shipped game never sees.
 */
export function lowerTreeWorld(world: TreeWorld): Dict {
  const doc = lowerObjectDef(world.tree) as Dict;
  const g = doc.game as Dict;
  const session: Dict = world.session ?? {};
  if (session.avatar !== undefined) g.avatar = session.avatar;
  if (session.can_fly) g.can_fly = true;
  if (typeof session.avatar_species === "string") g.avatar_species = session.avatar_species;
  if (Array.isArray(session.mods) && session.mods.length) g.mods = session.mods;
  if (isObj(session.scale)) g.scale = session.scale;
  if (isObj(session.culture)) g.culture = session.culture;
  return doc;
}
