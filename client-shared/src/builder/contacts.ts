// client-shared/src/builder/contacts.ts
//
// SHARED BY THE AAC STUDENT BUILDER (SentenceConstructorBoard) AND THE
// CLINICIAN "EDIT VISUAL" BUILDER. Change it for both, or for neither.
//
// THE CONTACTS CHIP'S CONTENT — the [individuals] group of the engine's WHO
// tab, which is the one chip whose membership NO engine can answer on its own.
//
// The engine's `individuals` cluster carries the specific people a SCENE knows
// (a game's named characters, standing in for the child's real ones). The
// child's actual contacts live in the platform's people directory, which the
// engine deliberately never queries — the surfacer is pure, and a directory
// lookup would make the same sentence produce two different boards. So the
// HOST joins the two halves, and this module is that join, written once:
// before it, the two builders each had their own copy of an almost-identical
// merge and they had already drifted (the AAC ordered by camera presence, the
// clinician did not; only one of them de-duplicated anything).
//
// ⚖️ ORDERING LAW (inherited from the AAC's people list, unchanged):
//   1. engine individuals the scene reports PRESENT
//   2. directory people seen on camera this session
//   3. the remaining engine individuals
//   4. the rest of the directory, alphabetical
// Presence leads because "who is here" is what a child most often wants to
// name; alphabetical is the tiebreak because a list that reorders itself under
// an eyegaze pointer is unusable.
//
// What this module is NOT: it does not decide WHICH chip is showing (the engine
// advertises that) and it does not draw anything (BuilderGrid + PersonButton /
// EngineWordButton do). It is pure data, so it is unit-tested next door.

/**
 * The engine group id whose grid the host fills from its people directory
 * (`GROUP_LABEL_HEAD.individuals` — the chip that reads "contacts"). The
 * surfacer advertises it on the person tab even when its ENGINE half is empty,
 * precisely so a host with a directory always has somewhere to put it.
 */
export const ENGINE_CONTACTS_CHIP = "individuals";

/** What the contacts chip wears when there is no art at all — no directory
 *  photo and no engine exemplar. Not the generic 📂 every other empty chip
 *  falls back to: this one is a fixed affordance on the WHO tab and has to be
 *  recognisable before the directory has loaded. */
export const CONTACTS_CHIP_ICON = "📇";

/** The minimum a host's directory row has to say. Both hosts' person types
 *  (AAC `ConstructionPerson`, clinician `DirectoryPerson`) satisfy it. */
export interface ContactDirectoryPerson {
  id: string;
  name: string;
  /** A stored photo exists — the chip's face prefers people who have one. */
  hasPhoto?: boolean;
}

/** The minimum an engine `individuals` member has to say (a `BuilderWord`). */
export interface ContactEngineWord {
  key: string;
  label?: string;
  present?: boolean;
}

/** One cell of the merged contacts grid. */
export type ContactTile<P extends ContactDirectoryPerson, W extends ContactEngineWord> =
  | { type: "person"; person: P }
  | { type: "engine"; word: W };

export interface MergeContactTilesInput<
  P extends ContactDirectoryPerson,
  W extends ContactEngineWord,
> {
  /** The platform's people directory, in any order. */
  people: readonly P[];
  /** The engine's `individuals` members for the current surface. */
  engine: readonly W[];
  /** People seen on camera this session (AAC only; the clinician has no
   *  camera and passes nothing). */
  presentPersonIds?: readonly string[];
}

/**
 * THE SAME PERSON TWICE IS WORSE THAN A MISSING ONE — a child pressing the
 * second copy composes a word the sentence already carries, and on a face grid
 * the two cells look identical.
 *
 * An engine member is dropped when the directory already answers for it: the
 * member's key IS that person's face slot (`face:<id>` — how a game pushes a
 * real contact in as a character), or its spoken label matches a directory
 * name. Case- and space-insensitive, because a game's label is authored text.
 * The DIRECTORY wins, always: it has the photo.
 */
function directoryAnswersFor(
  word: ContactEngineWord,
  faceKeys: ReadonlySet<string>,
  names: ReadonlySet<string>,
): boolean {
  if (faceKeys.has(word.key)) return true;
  const label = (word.label ?? "").trim().toLowerCase();
  return label.length > 0 && names.has(label);
}

/**
 * The contacts grid: the child's directory joined with the engine's named
 * characters, presence first, de-duplicated. Deterministic — same inputs, same
 * order, which is what an eyegaze user needs and what the call mirror
 * publishes.
 */
export function mergeContactTiles<
  P extends ContactDirectoryPerson,
  W extends ContactEngineWord,
>(input: MergeContactTilesInput<P, W>): Array<ContactTile<P, W>> {
  const ordered = orderDirectoryPeople(input.people, input.presentPersonIds);
  const faceKeys = new Set(ordered.map((p) => `face:${p.id}`));
  const names = new Set(ordered.map((p) => p.name.trim().toLowerCase()).filter(Boolean));
  const engine = input.engine.filter((w) => !directoryAnswersFor(w, faceKeys, names));

  const present = new Set(input.presentPersonIds ?? []);
  const tiles: Array<ContactTile<P, W>> = [];
  for (const w of engine) if (w.present) tiles.push({ type: "engine", word: w });
  for (const p of ordered) if (present.has(p.id)) tiles.push({ type: "person", person: p });
  for (const w of engine) if (!w.present) tiles.push({ type: "engine", word: w });
  for (const p of ordered) if (!present.has(p.id)) tiles.push({ type: "person", person: p });
  return tiles;
}

/** The directory in the order the grid shows it: camera-present first, then
 *  alphabetical. Exported because the legacy (non-engine) people list draws
 *  from the same law. */
export function orderDirectoryPeople<P extends ContactDirectoryPerson>(
  people: readonly P[],
  presentPersonIds?: readonly string[],
): P[] {
  const present = new Set(presentPersonIds ?? []);
  return [...people].sort((a, b) => {
    const ap = present.has(a.id) ? 0 : 1;
    const bp = present.has(b.id) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return a.name.localeCompare(b.name);
  });
}

/** How many faces the contacts chip wears — the sidebar's GlyphTriad draws at
 *  most three, and the engine's own GROUP_EXEMPLARS is the same number. */
export const CONTACT_CHIP_FACES = 3;

/**
 * THE CHIP'S OWN FACE: up to three of the child's real contacts, as `face:<id>`
 * glyphs, so [contacts] is recognisably the people themselves rather than a
 * generic pictogram (user, 2026-09-04: "the chip itself should show the first
 * few contacts' faces, if possible").
 *
 * Only people with a STORED PHOTO are used: a `face:<id>` with no image falls
 * back to the 👤 silhouette in both clients, and three silhouettes say less
 * than the engine's own exemplars would. Empty ⇒ the host leaves the engine's
 * `glyphs` (or its icon) alone.
 */
export function contactChipGlyphs<P extends ContactDirectoryPerson>(
  people: readonly P[],
  presentPersonIds?: readonly string[],
): string[] {
  return orderDirectoryPeople(people, presentPersonIds)
    .filter((p) => p.hasPhoto)
    .slice(0, CONTACT_CHIP_FACES)
    .map((p) => `face:${p.id}`);
}
