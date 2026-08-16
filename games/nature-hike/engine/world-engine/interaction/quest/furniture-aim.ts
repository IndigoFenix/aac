// shared/world-engine/interaction/quest/furniture-aim.ts
//
// WHAT THE GAZE IS AIMED AT — the one rule every hover gesture resolves its
// target through, so nothing can ever act on a thing the player isn't looking
// at. Furniture (`resolveFurnitureAim` — the board's object popup, the
// put-a-stack-away gesture) and PEOPLE (`gazeOnCreature` — the dwell-to-talk)
// both live here, deliberately: they are ONE mechanism and must not drift.
//
// THE HOVER IS THE AIM. The screen pick under the pixel names the thing;
// proximity to the fixation point does NOT. In a furnished room a 2.2 m
// fixation radius reaches two or three pieces at once, and picking the nearest
// of those is how looking at an EMPTY chest spilled a NEIGHBOUR's contents onto
// the board, how looking at a chair beside a cupboard opened the cupboard, and
// — once the talk gesture grew its own proximity test — how looking at a chair
// beside a PERSON started a conversation instead of selecting the chair.
//
// The hovered thing is the thing that gets interacted with. One pick names one
// thing: an item, a piece of furniture, or a creature. Never two at once.
//
// WANT: the OPEN gesture accepts any furniture (a piece with no stock still
// names itself on the board); PUT accepts only a real container — you can't
// stow an apple in a chair.
//
// Kept pure (no world state, no THREE, no session) so the rule is testable on
// its own — quest-host binds it to the live world through `FurnitureLookup`.

export interface FurnitureAimGaze {
  /** What the settled gaze rests on, from the view's screen pick. */
  hover: { kind: "avatar" | "object"; id: string } | null;
  /** The effective fixation point (the hovered entity's spot, else the ground). */
  committedWorld: { x: number; y: number } | null;
  /** Does this view resolve a screen pick at all? The 2D top-down omits it, and
   *  only there does a null `hover` fail to mean "the gaze is on nothing". */
  picks: boolean;
}

/** The live world, reduced to the five questions this rule asks of it. */
export interface FurnitureLookup {
  /** Is this id a REGISTERED container (chest, table, market shelf, a wild
   *  source, or the body of a walking product animal)? Stock can go in it. */
  isContainer(id: string): boolean;
  /** Is this id a FIXTURE — furniture standing in a room, container or not (a
   *  chair, a bed, a bath). Never a loose prop: those are CARRIED, and a board
   *  popup would fight the carry dwell for them. */
  isFurniture(id: string): boolean;
  /** The container this object sits IN, if any — a laden surface hides its own
   *  mesh behind its contents, so the apple on the table IS the table. */
  containedIn(id: string): string | undefined;
  /** Where it stands THIS frame (undefined once it streams out); a walking
   *  container's spot follows its body. */
  standpoint(id: string): { x: number; y: number } | undefined;
  /** Every registered container id. Walked ONLY by the no-pick fallback. */
  ids(): Iterable<string>;
}

export interface FurnitureAimOpts {
  /** Any furniture (the board popup) vs. only a container (a put target). */
  want: "furniture" | "container";
  /** Where the player's body is (undefined for a formless spirit). */
  me?: { x: number; y: number };
  /** A formless SPIRIT looks in from anywhere; a BODY has to be within `reach`. */
  spirit: boolean;
  /** How close a BODY must stand (CONVO_RADIUS). */
  reach: number;
  /** Fixation radius for the no-pick fallback only (CONVO_FIG_RADIUS). */
  fixRadius: number;
}

/** The furniture the gaze aims at, or null. Its live standpoint rides along so
 *  a caller can dwell on it without asking the world twice. */
export function resolveFurnitureAim(
  world: FurnitureLookup,
  gz: FurnitureAimGaze,
  opts: FurnitureAimOpts,
): { id: string; x: number; y: number } | null {
  const wanted = (id: string): boolean =>
    world.isContainer(id) || (opts.want === "furniture" && world.isFurniture(id));
  const resolve = (id: string | undefined): string | null => {
    if (!id) return null;
    if (wanted(id)) return id;
    const within = world.containedIn(id);
    return within && wanted(within) ? within : null;
  };
  // The hover IS the aim: a hovered non-target means NOTHING (looking near a
  // chest is not looking at it), never a search for something nearby.
  let id = resolve(gz.hover?.id);
  if (!id && !gz.picks) id = nearestToFixation(world, gz.committedWorld, opts, wanted);
  if (!id) return null;
  const at = world.standpoint(id);
  if (!at) return null;
  if (!opts.spirit && (!opts.me || Math.hypot(opts.me.x - at.x, opts.me.y - at.y) > opts.reach)) return null;
  return { id, x: at.x, y: at.y };
}

/**
 * Is the gaze aimed at THIS creature? The same rule `resolveFurnitureAim`
 * applies to a chest, applied to a body — so a hover names a person or a piece
 * of furniture, never both. A creature standing beside a chair used to win the
 * talk gesture on fixation proximity alone, which made the chair unselectable:
 * the conversation opened instead.
 *
 * `ids` = every id this creature answers to; a goal-tree poser is hovered as
 * its `npc_`-prefixed body, an off-tree local as its bare node id.
 *
 * `at` + `fixRadius` serve the no-pick fallback ONLY (a view whose null hover
 * doesn't mean "on nothing"), exactly like `nearestToFixation` below.
 */
export function gazeOnCreature(
  gz: FurnitureAimGaze,
  ids: readonly string[],
  at: { x: number; y: number },
  fixRadius: number,
): boolean {
  if (gz.picks) return gz.hover?.kind === "avatar" && ids.includes(gz.hover.id);
  const fix = gz.committedWorld;
  return !!fix && Math.hypot(fix.x - at.x, fix.y - at.y) <= fixRadius;
}

/** LAST RESORT, for a view with no screen pick at all (the 2D top-down, whose
 *  steep camera makes ground-point proximity exact): the nearest wanted thing
 *  to the fixation, within `fixRadius`. Only containers are enumerable, so this
 *  fallback can't reach a stock-less chair — an acceptable floor for a view the
 *  live game doesn't use. */
function nearestToFixation(
  world: FurnitureLookup,
  fix: { x: number; y: number } | null,
  opts: FurnitureAimOpts,
  wanted: (id: string) => boolean,
): string | null {
  if (!fix) return null;
  let best = opts.fixRadius;
  let found: string | null = null;
  for (const id of world.ids()) {
    if (!wanted(id)) continue;
    const at = world.standpoint(id);
    if (!at) continue;
    const d = Math.hypot(fix.x - at.x, fix.y - at.y);
    if (d <= best) { best = d; found = id; }
  }
  return found;
}
