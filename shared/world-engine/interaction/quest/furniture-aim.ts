// shared/world-engine/interaction/quest/furniture-aim.ts
//
// WHICH PIECE OF FURNITURE THE GAZE IS AIMED AT — the one rule the board's
// object popup (and the put-a-stack-away gesture) resolves its target through,
// so the board can never name a thing the player isn't looking at.
//
// THE HOVER IS THE AIM. The screen pick under the pixel names the thing;
// proximity to the fixation point does NOT. In a furnished room a 2.2 m
// fixation radius reaches two or three pieces at once, and picking the nearest
// of those is how looking at an EMPTY chest spilled a NEIGHBOUR's contents onto
// the board, and how looking at a chair beside a cupboard opened the cupboard.
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
