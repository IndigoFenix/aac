// shared/world-engine/interaction/text/scene-index.ts
//
// TEXT IDS LATCH (§4). `mara` when the session knows a name, else
// `person-2` / `chair-3` — the species/glyph-head word plus a FIRST-SIGHTING
// ordinal, distance-sorted within the frame it was first seen. The map lives for
// the session, so bodies never renumber: a townsperson who walks away and comes
// back is the same `person-2` they were, which is the whole point (a driver's
// notes about who is who must stay true).
//
// AMBIGUITY IS ASKED, NEVER GUESSED (§4). `resolve` reports the candidate LIST
// when a bare prefix matches more than one body; the session turns that into an
// `ASK` with band/cardinal discriminators. Phase 1 keeps the discriminator set
// minimal — TODO step ⑦ adds the full priority order (proximity band → cardinal
// → containing room → distinguishing appearance → activity).

import type { VisibleSubject } from "./types.js";

/** A text id is lowercase ASCII with `-` joins — what a driver can type. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export type SceneResolution =
  | { kind: "one"; id: string; textId: string }
  | { kind: "none" }
  | { kind: "many"; ids: string[] };

export interface SceneIndexDeps {
  /** A body's known proper name, when the session knows one. */
  nameOf?: (simId: string) => string | undefined;
  /** The SINGULAR behind a printed plural ("people" → "person"), from the
   *  ruleset that printed it. Lets a driver type back the word the crowd line
   *  used; absent = only the singular stem resolves. */
  singularOf?: (word: string) => string | undefined;
}

export interface SceneIndex {
  /** Stamp `textId` on each subject, latching new ones. Returns the SAME array
   *  objects, mutated in place (the caller owns them; they were built this frame). */
  assign(subjects: VisibleSubject[]): VisibleSubject[];
  textIdOf(simId: string): string | undefined;
  simIdOf(textId: string): string | undefined;
  /** Resolve driver input to one sim id, nothing, or an ambiguous candidate set. */
  resolve(query: string): SceneResolution;
  /** THE DRIVER NAMED THIS ONE. Latched for the session: a thing the player has
   *  already picked out of the world stays worth its own line afterwards, even
   *  when the crowd pass would otherwise bucket it (law ⑤ "watched"-adjacent —
   *  you asked about that house, so it is no longer part of the skyline). */
  markReferenced(simId: string): void;
  isReferenced(simId: string): boolean;
  /** Every id latched so far (debug / the CLI's completion list). */
  entries(): { simId: string; textId: string }[];
}

/** The stem a body's id is built from: its known name, else its word. `named`
 *  decides whether the stem stands alone (`mara`) or takes an ordinal
 *  (`person-2`) — §4: a known name is the id, an anonymous body is a count. */
function stemOf(
  s: VisibleSubject,
  nameOf?: (id: string) => string | undefined,
): { stem: string; named: boolean } {
  const name = nameOf?.(s.id) ?? s.name;
  if (name) return { stem: slug(name), named: true };
  return { stem: slug(s.word) || slug(s.kind), named: false };
}

export function createSceneIndex(deps: SceneIndexDeps = {}): SceneIndex {
  /** THE LATCH — sim id → text id, for the life of the session. */
  const bySim = new Map<string, string>();
  const bySlug = new Map<string, string>();
  /** How many bodies have ever taken an ordinal under each stem. */
  const counts = new Map<string, number>();
  /** Sim ids the driver has named. Never cleared — see `markReferenced`. */
  const referenced = new Set<string>();

  const claim = (textId: string, simId: string): string => {
    bySim.set(simId, textId);
    bySlug.set(textId, simId);
    return textId;
  };

  const take = (stem: string, named: boolean, simId: string): string => {
    // A KNOWN NAME is the id, bare — `mara`, not `mara-1`. (A second body
    // answering to the same name falls through to the ordinal path below, so
    // ids stay unique without inventing a surname.)
    if (named && !bySlug.has(stem)) return claim(stem, simId);
    let n = counts.get(stem) ?? 0;
    let candidate = `${stem}-${++n}`;
    while (bySlug.has(candidate)) candidate = `${stem}-${++n}`;
    counts.set(stem, n);
    return claim(candidate, simId);
  };

  return {
    assign(subjects) {
      // FIRST SIGHTING IS DISTANCE-SORTED: within one frame the nearest unlatched
      // body takes the lower ordinal, so `person-2` is nearer than `person-3` the
      // moment they were both first seen — and never again re-sorted.
      const fresh = subjects
        .filter((s) => !bySim.has(s.id))
        .slice()
        .sort((a, b) => a.distance - b.distance || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      for (const s of fresh) {
        const { stem, named } = stemOf(s, deps.nameOf);
        take(stem, named, s.id);
      }
      for (const s of subjects) s.textId = bySim.get(s.id) ?? s.id;
      return subjects;
    },
    textIdOf(simId) {
      return bySim.get(simId);
    },
    simIdOf(textId) {
      return bySlug.get(textId);
    },
    resolve(query) {
      const q = slug(query);
      if (!q) return { kind: "none" };
      const exact = bySlug.get(q);
      if (exact) return { kind: "one", id: exact, textId: q };
      // A BARE STEM ("chair") matches every ordinal under it. One match resolves;
      // several are ASKED about.
      const hits: string[] = [];
      for (const [textId, simId] of bySlug) {
        if (textId === q || textId.startsWith(`${q}-`)) hits.push(simId);
      }
      // THE WORD A CROWD LINE PRINTED IS A HANDLE. The scene says "3 people,
      // here west" and a driver naturally types `look people` — which matched
      // nothing, because the ids are latched under the SINGULAR stem. The
      // printed word must resolve, or the scene is naming things the driver
      // cannot ask about. (Consulted only after the exact/stem passes miss, so
      // an id always wins over a plural that happens to look like one.)
      if (!hits.length) {
        const singular = deps.singularOf?.(q);
        if (singular && singular !== q) {
          for (const [textId, simId] of bySlug) {
            if (textId === singular || textId.startsWith(`${singular}-`)) hits.push(simId);
          }
        }
      }
      if (hits.length === 1) return { kind: "one", id: hits[0]!, textId: bySim.get(hits[0]!)! };
      if (hits.length > 1) return { kind: "many", ids: hits };
      return { kind: "none" };
    },
    markReferenced(simId) {
      referenced.add(simId);
    },
    isReferenced(simId) {
      return referenced.has(simId);
    },
    entries() {
      return [...bySim].map(([simId, textId]) => ({ simId, textId }));
    },
  };
}
