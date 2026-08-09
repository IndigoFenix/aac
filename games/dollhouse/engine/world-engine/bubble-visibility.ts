// shared/world-engine/bubble-visibility.ts
//
// WHEN A SPEECH BUBBLE MAY BE READ — one pure predicate, no THREE, no DOM, no
// WorldState. The 3D view (`render3d.ts` syncBubbles) is its only caller today;
// it hands over what it already computed for the frame (the reveal set, the
// camera subject's space, the anchor's space) and gets back a boolean.
//
// WHY IT EXISTS. GL used to draw EVERY live bubble in `state.bubbles`, and a
// bubble sprite is `depthTest:false` — so a line spoken inside a sealed house on
// the far side of town rendered over the roofs as a disembodied voice ("I will
// carry the door…" with nobody in sight). Text mode never had the bug: it gates
// speech on its §3 filter (`interaction/text/visibility.ts`), and the gap was
// recorded as a standing finding against GL in text-mode.md §3. This closes it.
//
// THE RULE, in the order it is asked:
//
//   0. EXEMPT — the bubble belongs to a body whose lines are never gated: the
//      viewer's own body (spark + the body it drives) or a member of the
//      player's OWN open conversation. Their words must never vanish, wherever
//      the camera happens to be standing. An AMBIENT circle earns no exemption
//      (see `exemptSpeakers`): `RenderIntent.conversation` publishes townsfolk
//      chatter too, and exempting that would hand the through-walls voice
//      straight back.
//   1. OUTDOORS — an anchor in no building draws. This is GL's OWN body cull
//      (`syncAvatars`: `visible = !inBuilding || revealed.has(inBuilding.id)`),
//      and the two must agree: a bubble is only ever a voice for the body under
//      it, so gating one where the other draws invents either a mute body in
//      plain view or a voice with nobody there.
//   2. REVEALED — the anchor's building is on show this frame (`revealedInteriors`
//      — the cutaway, the dollhouse focus frame, doorway flood-through). This is
//      the clause that keeps the focus family talking under the dollhouse
//      cutaway, and the one that seals the house across town.
//   3. SAME SPACE as the camera's SUBJECT. Redundant wherever interior reveal is
//      on (the subject's own building is always in the reveal set), and load-
//      bearing where it is off (the spirit GROUND rung reveals nothing): you can
//      always hear whoever shares the room you are standing in.
//
// DELIBERATELY NOT COPIED FROM TEXT MODE: the §3 filter's RANGE clause
// (`visibleR`, 45 m) and STOREY clause. A bubble is a world-scaled sprite — it
// shrinks with distance on its own — and the anchors that leaked through walls
// are exactly the ones clauses 1–3 now catch, so a distance cap would only cost
// legibility (a townsperson answering you from across the square) for nothing.
// If a same-space-but-across-town leak ever does show up on device, the cap to
// reuse is `DEFAULT_DIRECTIONS_TUNING.visibleR` (dialogue/directions.ts) — the
// same one constant text mode gates on — never a fresh literal.

/** A body whose lines are never gated, and where it stands (a POINT-anchored
 *  line is matched to it by proximity — see `EXEMPT_ANCHOR_R`). */
export interface ExemptBody {
  id: string;
  x: number;
  y: number;
}

/** One bubble's anchor, as the renderer already resolved it for the frame. */
export interface BubbleAnchorAt {
  /** Where the bubble floats (an avatar anchor resolves to its body's spot). */
  x: number;
  y: number;
  /** The body the bubble NAMES — set only for an `{kind:"avatar"}` anchor. A
   *  point anchor (what `sayNpcLine` writes for most creature lines) leaves it
   *  null and is attributed by proximity instead. */
  bodyId?: string | null;
  /** The building containing (x, y), or null outdoors — `buildingAt()` on the
   *  caller's side, so this module stays free of the engine. */
  space: string | null;
}

/** The viewer's half of the gate — computed ONCE per frame, not per bubble. */
export interface BubbleViewpoint {
  /** The building the camera's SUBJECT stands in (the same body the reveal rule
   *  keys on), or null when it is outdoors or has no body at all. */
  subjectSpace: string | null;
  /** Interiors on show this frame — `revealedInteriors()`, the ONE reveal rule. */
  revealed: ReadonlySet<string>;
  /** Bodies clause 0 exempts. Empty/absent is the ordinary case. */
  exempt?: readonly ExemptBody[];
}

/**
 * How near an exempt body a POINT-anchored line must hang to be counted as
 * theirs. A creature's line is anchored at its own feet, so this is a body's
 * width of slack and no more — never a "nearest speaker in the room" guess.
 *
 * TWIN, deliberately: `POINT_ATTRIBUTION_R` in `interaction/text/visibility.ts`
 * is the same number for the same reason (text mode attributes point anchors
 * the same way). They are separate because the renderer must not import the
 * text projection — that would drag the whole lang layer into the GL bundle.
 * Whoever next owns text/visibility.ts should make one re-export the other.
 */
export const EXEMPT_ANCHOR_R = 2.5;

/** Is this anchor one of the exempt bodies' lines? An avatar anchor names its
 *  speaker outright (id match, nothing else); a point anchor is attributed to
 *  an exempt body standing within `EXEMPT_ANCHOR_R` of it. */
export function isExemptAnchor(anchor: BubbleAnchorAt, exempt?: readonly ExemptBody[]): boolean {
  if (!exempt || exempt.length === 0) return false;
  if (anchor.bodyId) return exempt.some((b) => b.id === anchor.bodyId);
  const r2 = EXEMPT_ANCHOR_R * EXEMPT_ANCHOR_R;
  for (const b of exempt) {
    const dx = b.x - anchor.x;
    const dy = b.y - anchor.y;
    if (dx * dx + dy * dy <= r2) return true;
  }
  return false;
}

/** THE GATE. See the header for the four clauses and why each is there. */
export function bubbleAnchorDraws(anchor: BubbleAnchorAt, view: BubbleViewpoint): boolean {
  if (isExemptAnchor(anchor, view.exempt)) return true; // 0
  if (anchor.space === null) return true; // 1
  if (view.revealed.has(anchor.space)) return true; // 2
  return anchor.space === view.subjectSpace; // 3
}

/**
 * WHOSE LINES ARE NEVER GATED this frame.
 *
 * The viewer's own body always (`localId`) and the body it DRIVES (`drivenId`,
 * a claimed creature — a follow/town camera rides that body, and the reveal
 * rule still keys on the parked spark, so without this the possessed body's own
 * words could be gated out of its own camera).
 *
 * Plus, when the published conversation is the PLAYER'S OWN — its roster names
 * one of those two ids — every member of it. A roster that does NOT name the
 * player is an ambient town circle: the camera may be framing it, but it earns
 * no exemption, because "the camera dollied there" is not "you are in it".
 *
 * Members with no body in this world (a formless spirit, someone streamed out)
 * are dropped: there is nowhere for their bubble to hang.
 */
export function exemptSpeakers(opts: {
  localId: string;
  /** `state.drivenId` — the same id when nothing is claimed. */
  drivenId?: string | null;
  /** `RenderIntent.conversation` verbatim. */
  conversation?: { members: readonly string[] } | null;
  /** Where a body stands, or undefined when it has none (`state.avatars[id]`). */
  bodyAt: (id: string) => { x: number; y: number } | undefined;
}): ExemptBody[] {
  const selfIds = [opts.localId, opts.drivenId ?? null].filter((id): id is string => !!id);
  const members = opts.conversation?.members ?? [];
  const mine = members.some((id) => selfIds.includes(id));
  const out: ExemptBody[] = [];
  const seen = new Set<string>();
  for (const id of mine ? [...selfIds, ...members] : selfIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const body = opts.bodyAt(id);
    if (body) out.push({ id, x: body.x, y: body.y });
  }
  return out;
}
