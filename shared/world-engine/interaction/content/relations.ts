// shared/world-engine/interaction/content/relations.ts
//
// WHAT A NOUN HAS TO DO WITH A VERB — derived from the spec, never flagged.
//
// THE GAP THIS EXISTS FOR (user, 2026-08-25): a board that knows only "what can
// be the OBJECT of `eat`" answers a hungry child with the fruit bowl and then,
// underneath it, with everything else the world contains — a puzzle, a frog, a
// person. But some of those nouns are not noise: a table, a dining room and a
// restaurant all have something to do with eating. They are simply not what you
// eat. They are WHERE you eat, and the sentence that names them needs a link.
//
// The relation is already in the spec, three hops deep, so nothing here is
// authored twice:
//
//   0 — THE STATION ITSELF. `STATION_ACTS` (stations.ts) says what a piece of
//       furniture is for: a table is for eating, a bed for sleeping, a bath for
//       washing. That table IS the relation, read straight.
//   1 — A ROOM THAT REQUIRES ONE. A room program's `requires` names the stations
//       that make it that room (`kitchen[oven]`, `living[table, chair]`), so a
//       kitchen relates to cooking and a living room to eating — because of what
//       stands in it, not because anyone said so.
//   2 — A BUILDING THAT CONTAINS ONE. A structure program's `rooms` does the
//       same one level up: `restaurant[dining]` relates to eating through the
//       food room inside it.
//
// A clinician adding a station with `acts: ["eat"]` gets every one of these
// relations for free, which is the point of reading the spec rather than
// carrying a list.
//
// THE WALK STOPS AT TWO HOPS. A house contains a living room, so a house relates
// to eating — true, and thin: "eat in the house" is not a sentence anyone
// reaches for. Distance is returned so a caller can rank by it and cut where it
// stops being useful.
//
// Pure and deterministic: fixed registries, fixed walk, never the scene.

import {
  DEFAULT_ROOM_PROGRAMS,
  DEFAULT_STRUCTURE_PROGRAMS,
  type RoomProgramDef,
  type StructureProgramDef,
} from "../../kernel/town/programs.js";
import { STATION_ACTS, type StationKind } from "../../kernel/town/stations.js";
import { fixtureWord } from "../../types.js";
import { canonicalVerb } from "../intent/parse-intent.js";
import { headOf } from "../../variations.js";

/** head → verb → hops (0 station · 1 room · 2 building). Built once. */
type RelationIndex = ReadonlyMap<string, ReadonlyMap<string, number>>;

function buildIndex(
  rooms: ReadonlyArray<RoomProgramDef>,
  buildings: ReadonlyArray<StructureProgramDef>,
): RelationIndex {
  const index = new Map<string, Map<string, number>>();
  const link = (head: string, verb: string, hops: number) => {
    const h = headOf(head);
    const v = canonicalVerb(verb);
    if (!h || !v) return;
    const row = index.get(h) ?? new Map<string, number>();
    const had = row.get(v);
    if (had === undefined || hops < had) row.set(v, hops);
    index.set(h, row);
  };

  // 0 — the stations themselves, spoken as the word the board uses.
  const actsOfKind = new Map<string, readonly string[]>();
  for (const [kind, acts] of Object.entries(STATION_ACTS)) {
    if (!acts?.length) continue;
    actsOfKind.set(kind, acts);
    for (const verb of acts) link(fixtureWord(kind as StationKind), verb, 0);
  }

  // 1 — the rooms those stations make.
  const roomVerbs = new Map<string, Set<string>>();
  for (const r of rooms) {
    const verbs = new Set<string>();
    for (const kind of r.requires ?? []) {
      for (const verb of actsOfKind.get(kind) ?? []) verbs.add(canonicalVerb(verb));
    }
    if (!verbs.size) continue;
    roomVerbs.set(r.kind, verbs);
    for (const verb of verbs) link(r.word ?? r.kind, verb, 1);
  }

  // 2 — the buildings those rooms fill.
  for (const b of buildings) {
    for (const kind of b.rooms) {
      for (const verb of roomVerbs.get(kind) ?? []) link(b.word ?? b.type, verb, 2);
    }
  }

  return index;
}

const INDEX: RelationIndex = buildIndex(DEFAULT_ROOM_PROGRAMS, DEFAULT_STRUCTURE_PROGRAMS);

/**
 * How far `noun` stands from `verb`: 0 when the thing itself is for it, 1 for a
 * room that holds such a thing, 2 for a building that holds such a room, and
 * `null` when they have nothing to do with each other.
 */
export function verbDistance(noun: string, verb: string): number | null {
  return INDEX.get(headOf(noun))?.get(canonicalVerb(verb)) ?? null;
}

/** Is this noun any part of doing that verb? (The board's predicate.) */
export const relatesToVerb = (noun: string, verb: string): boolean =>
  verbDistance(noun, verb) !== null;

/** Every noun related to a verb, nearest first then by registry order — the
 *  report the surfacer's link bands and the doc's examples both read. */
export function nounsRelatedTo(verb: string): { symbol: string; hops: number }[] {
  const out: { symbol: string; hops: number }[] = [];
  for (const [head, verbs] of INDEX) {
    const hops = verbs.get(canonicalVerb(verb));
    if (hops !== undefined) out.push({ symbol: head, hops });
  }
  return out.sort((a, b) => a.hops - b.hops);
}
