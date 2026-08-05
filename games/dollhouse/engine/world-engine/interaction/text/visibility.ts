// shared/world-engine/interaction/text/visibility.ts
//
// THE §3 FILTER — "is this in view?", answered exactly four ways and no fifth:
//
//   1. EMBODIED   — it has a record in `state.avatars` / `state.objects`.
//                   Abstracted residents and cohort pools are *not there*; law ①
//                   forbids materializing them for the narrator.
//   2. SAME SPACE — `spaceOf(subject) === spaceOf(me)`, or the subject's building
//                   is in `visibleBuildings(state, me)` (engine.ts — the SAME set
//                   the GL cutaway and the resident streamer use, so doorway
//                   flood-through comes free and text can't see a different world).
//   3. IN RANGE   — `dist ≤ DEFAULT_DIRECTIONS_TUNING.visibleR` (dialogue/
//                   directions.ts). ONE constant, two consumers: "I can see it"
//                   and a townsperson's "it's *there*" can never disagree.
//   4. SAME STOREY— `round(subject.floor) === round(me.floor)`.
//
// PLACES ARE LANDMARKS (§3): buildings report out to `closeR` with directions.ts'
// own band + cardinal vocabulary — outline only (kind, colour, revealed). A
// building's CONTENTS appear only when it is in `visibleBuildings`.
//
// ── Deviations, stated ──────────────────────────────────────────────────────
// • BANDS WITHOUT A STREET NETWORK. `directionsTo` resolves its "street" band by
//   projecting onto a `TownStreets` topology, which the RENDERER is never handed
//   (law ①: we may read only what a GL frame consumes). So `bandOf` below applies
//   directionsTo's own thresholds and priority — here → there → close → far —
//   minus the topology test. Every subject that survives the filter is inside
//   `visibleR`, i.e. `here` or `there`, so the divergence can only ever affect a
//   LANDMARK's word (`close` where a resident would have said `street`).
// • SPEECH FROM A SEALED ROOM IS NOT NARRATED. GL draws every live bubble
//   regardless of `visibleBuildings` (render3d.ts) — you can read a conversation
//   inside a sealed house across town. Text mode gates speech on this filter.
//   That is a standing finding against GL, recorded in §3, not a text-mode bug.

import {
  buildingAt,
  visibleBuildings,
  WORLD_ENGINE_DEFAULTS,
  type ObjectState,
  type WorldState,
} from "../../engine.js";
import {
  DEFAULT_DIRECTIONS_TUNING,
  cardinalOf,
  nearestColorSymbol,
  type Cardinal,
  type DirectionsTuning,
  type Proximity,
} from "../dialogue/directions.js";
import { baseWord } from "../lang/core.js";
import { languageFor } from "../lang/index.js";
import type { GlyphLanguage } from "../lang/core.js";
import type { VisibleScene, VisibleSubject } from "./types.js";

/** How near a POINT-anchored bubble a body must stand to own it (speech.ts).
 *  A creature's poser point sits at its own feet, so this is a body's width of
 *  slack and no more — never a "nearest speaker in the room" guess. */
export const POINT_ATTRIBUTION_R = 2.5;

/** Species ids the lexicon words differently from their registry id. Kept tiny
 *  and additive: an unmapped species falls through to `baseWord`, which itself
 *  falls back to the id with underscores opened out. */
const SPECIES_WORD_HEAD: Readonly<Record<string, string>> = {
  human: "person",
  human_cute: "person",
  spark: "spark",
};

export interface VisibilityOpts {
  locale?: string;
  tuning?: DirectionsTuning;
  /** "What is X doing" — the host's `creatureActivity`, injected structurally. */
  activityOf?: (cid: string) => { verb: string; object?: string } | undefined;
  /** A body's known proper name (§4: a known name beats an ordinal id). */
  nameOf?: (cid: string) => string | undefined;
}

/** THE SPACE a point is in: the building whose footprint contains it, or null
 *  for outdoors. Derived from the engine's own containment helper (`buildingAt`)
 *  — the one `visibleBuildings`, the indoor cull and door connectivity all use. */
export function spaceOf(state: WorldState, p: { x: number; y: number }): string | null {
  return buildingAt(state, p.x, p.y)?.id ?? null;
}

/**
 * directions.ts' proximity vocabulary by straight-line metres. See the deviation
 * note at the top of the file: the `street` band needs a topology this layer is
 * not given, so it is never produced here.
 */
export function bandOf(dist: number, tuning: DirectionsTuning = DEFAULT_DIRECTIONS_TUNING): Proximity {
  if (dist <= tuning.hereR) return "here";
  if (dist <= tuning.visibleR) return "there";
  return dist <= tuning.closeR ? "close" : "far";
}

/** The LEXICON HEAD a species is named by ("human" → "person"). */
export function speciesHead(species: string | undefined): string {
  return species ? (SPECIES_WORD_HEAD[species] ?? species) : "person";
}

/** The word a species is COUNTED by in a crowd line (§6). */
export function speciesWord(lang: GlyphLanguage, species: string | undefined): string {
  return baseWord(lang, speciesHead(species));
}

/** The glyph head places are named by. `house` rather than `home` on purpose:
 *  both word to "house"/"casa"/"בית", but only `house` carries a PLURAL in the
 *  lexicons, and a place line is far more often a count than a singleton. */
export const PLACE_HEAD = "house";

/**
 * A lexicon word at a COUNT. The lang layer owns plurals: `plw` when the ruleset
 * authored one, otherwise the singular unchanged — this never appends an "s",
 * which would be English grammar leaking into every locale.
 */
export function wordFor(lang: GlyphLanguage, head: string, count: number): string {
  const lex = lang.lexicon[head];
  if (count === 1 || !lex) return baseWord(lang, head);
  return lex.plw ?? lex.w;
}

/** The INDEFINITE article for a singleton bucket ("a chair"), or "" where the
 *  ruleset doesn't front one (Hebrew has no indefinite article at all). English
 *  picks a/an off the word itself; the romance rulesets article by gender. */
export function indefiniteArticle(lang: GlyphLanguage, head: string): string {
  const lex = lang.lexicon[head];
  if (lex?.mass) return "";
  const word = baseWord(lang, head);
  switch (lang.id) {
    case "en":
      return /^[aeiou]/i.test(word) ? "an" : "a";
    case "es":
      return lex?.g === "f" ? "una" : "un";
    case "pt":
      return lex?.g === "f" ? "uma" : "um";
    default:
      return ""; // he and any ruleset without one: the bare noun IS indefinite
  }
}

/** Which buildings have a door standing PHYSICALLY OPEN (swung clear, unlocked)
 *  — read off the same `state.doors` swing the engine's own connectivity uses,
 *  sampled a hair past each leaf along its normal exactly as `doorConnectivity`
 *  does. An open door is one of the four things that earn a place its own line. */
export function buildingsWithOpenDoor(
  state: WorldState,
  passThreshold: number = WORLD_ENGINE_DEFAULTS.doorPassThreshold,
): Set<string> {
  const open = new Set<string>();
  for (const s of state.spec.structures ?? []) {
    if (s.kind !== "door") continue;
    const door = state.doors[s.id];
    if (!door || door.locked || door.open < passThreshold) continue;
    const mid = { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 };
    let nx = -(s.b.y - s.a.y);
    let ny = s.b.x - s.a.x;
    const len = Math.hypot(nx, ny) || 1;
    nx /= len;
    ny /= len;
    const eps = s.thickness / 2 + 0.3;
    const a = buildingAt(state, mid.x + nx * eps, mid.y + ny * eps)?.id;
    const b = buildingAt(state, mid.x - nx * eps, mid.y - ny * eps)?.id;
    if (a) open.add(a);
    if (b) open.add(b);
  }
  return open;
}

/** The glyph head an object is NAMED by: its own glyph, else its fixture kind. */
export function objectHead(glyph: string | undefined, fixture: string | undefined): string {
  if (glyph) return glyph.split(".")[0]!;
  if (fixture) return fixture;
  return "thing";
}

/** Sim ids of the objects a body is carrying — `carriedBy` and nothing else.
 *  (§6: never `carryOf()`, which merges bag contents the eye cannot see.) */
export function carriedBy(state: WorldState, avatarId: string): string[] {
  const out: string[] = [];
  for (const o of Object.values(state.objects)) if (o.carriedBy === avatarId) out.push(o.id);
  return out.sort();
}

/** An object is HIDDEN when it sits inside a closed container — the lid is what
 *  the eye reads, so an `in` relation under a shut lid is not in view. */
function containerHides(state: WorldState, obj: ObjectState): boolean {
  const held = obj.containedIn;
  if (!held || held.relation !== "in") return false;
  const box = state.objects[held.objectId];
  if (!box) return false;
  return !box.heldOpen && box.open < 0.5;
}

/**
 * THE FILTER. Everything the local viewer can see this frame, plus the landmark
 * outlines around them. `localId` is whose eyes we render from (the driven body
 * — the same id the reveal rule keys on).
 */
export function visibleSubjects(
  state: WorldState,
  localId: string,
  opts: VisibilityOpts = {},
): VisibleScene {
  const lang = languageFor(opts.locale);
  const tuning = opts.tuning ?? DEFAULT_DIRECTIONS_TUNING;
  const me = state.avatars[localId];
  if (!me) return { me: null, subjects: [], places: [], revealed: new Set<string>() };

  const from = { x: me.x, y: me.y };
  const myFloor = Math.round(me.floor);
  const mySpace = spaceOf(state, from);
  const revealed = visibleBuildings(state, from);

  const npcById = new Map((state.spec.npcs ?? []).map((n) => [n.id, n]));
  const objSpecById = new Map((state.spec.objects ?? []).map((o) => [o.id, o]));

  const inView = (x: number, y: number, floor: number): { ok: boolean; space: string | null; dist: number } => {
    const dist = Math.hypot(x - from.x, y - from.y);
    const space = spaceOf(state, { x, y });
    const sameSpace = space === mySpace || (space !== null && revealed.has(space));
    const ok = sameSpace && dist <= tuning.visibleR && Math.round(floor) === myFloor;
    return { ok, space, dist };
  };

  const subjects: VisibleSubject[] = [];

  // YOU ARE NOT A BYSTANDER. Both the spark's own body and the body it DRIVES
  // are "you" — a possessed creature must not also be narrated as a stranger
  // standing here (that is what `self` is for). These are the same id until a
  // claim points `drivenId` elsewhere, so the ordinary case is unchanged.
  const isMe = (id: string): boolean => id === localId || id === state.drivenId;

  // ── bodies ────────────────────────────────────────────────────────────────
  for (const a of Object.values(state.avatars)) {
    if (isMe(a.id)) continue;
    const { ok, space, dist } = inView(a.x, a.y, a.floor);
    if (!ok) continue;
    const spec = npcById.get(a.id);
    const species = spec?.species;
    const known = opts.nameOf?.(a.id) ?? spec?.name;
    subjects.push({
      id: a.id,
      kind: "creature",
      textId: "", // stamped by scene-index.ts
      ...(known ? { name: known } : {}),
      ...(species ? { species } : {}),
      head: speciesHead(species),
      word: speciesWord(lang, species),
      band: bandOf(dist, tuning),
      cardinal: cardinalOf(from, { x: a.x, y: a.y }),
      distance: dist,
      space,
      floor: Math.round(a.floor),
      // §6 APPEARANCE SIGNATURE — the fields the renderer actually dresses the
      // body from and no others: its species body plan and its outfit index.
      appearance: [`species:${species ?? "?"}`, `outfit:${a.wearing ?? "default"}`],
      ...(opts.activityOf?.(a.id) ? { activity: opts.activityOf(a.id) } : {}),
      holding: carriedBy(state, a.id),
    });
  }

  // ── objects ───────────────────────────────────────────────────────────────
  for (const o of Object.values(state.objects)) {
    if (o.carriedBy) continue; // carried things report through their holder
    if (containerHides(state, o)) continue;
    const { ok, space, dist } = inView(o.x, o.y, o.floor);
    if (!ok) continue;
    const spec = objSpecById.get(o.id);
    const head = objectHead(spec?.glyph, spec?.fixture);
    subjects.push({
      id: o.id,
      kind: "object",
      textId: "",
      ...(spec?.glyph ? { species: spec.glyph } : {}),
      head,
      word: baseWord(lang, head),
      band: bandOf(dist, tuning),
      cardinal: cardinalOf(from, { x: o.x, y: o.y }),
      distance: dist,
      space,
      floor: Math.round(o.floor),
      appearance: [`glyph:${spec?.glyph ?? head}`],
      holding: [],
    });
  }

  // ── places (landmarks, out to closeR) ─────────────────────────────────────
  const places: VisibleSubject[] = [];
  const buildings = state.spec.buildings ?? [];
  // Only worth walking the door list when there are places to attribute to.
  const openDoors = buildings.length ? buildingsWithOpenDoor(state) : new Set<string>();
  for (const b of buildings) {
    const cx = b.footprint.x + b.footprint.w / 2;
    const cy = b.footprint.y + b.footprint.h / 2;
    const dist = Math.hypot(cx - from.x, cy - from.y);
    if (dist > tuning.closeR) continue;
    const colour = b.color ? baseWord(lang, nearestColorSymbol(b.color)) : undefined;
    places.push({
      id: b.id,
      kind: "place",
      textId: "",
      head: PLACE_HEAD,
      word: baseWord(lang, PLACE_HEAD),
      band: bandOf(dist, tuning),
      cardinal: cardinalOf(from, { x: cx, y: cy }),
      distance: dist,
      space: b.id,
      floor: myFloor,
      appearance: colour ? [`color:${colour}`] : [],
      holding: [],
      ...(colour ? { color: colour } : {}),
      revealed: revealed.has(b.id),
      doorOpen: openDoors.has(b.id),
    });
  }

  const byDistance = (a: VisibleSubject, b: VisibleSubject): number =>
    a.distance - b.distance || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  subjects.sort(byDistance);
  places.sort(byDistance);

  return {
    me: { id: localId, x: me.x, y: me.y, floor: myFloor, space: mySpace },
    subjects,
    places,
    revealed,
  };
}

/** The SIM IDS in view — the gate speech.ts narrates through (§3). */
export function inViewSet(scene: VisibleScene): Set<string> {
  const set = new Set<string>();
  for (const s of scene.subjects) set.add(s.id);
  if (scene.me) set.add(scene.me.id);
  return set;
}

/** The cardinal of a point from the viewer — exported so callers describing a
 *  transit ("went out the north door") share directions.ts' vocabulary. */
export function cardinalFrom(
  from: { x: number; y: number },
  to: { x: number; y: number },
): Cardinal {
  return cardinalOf(from, to);
}
