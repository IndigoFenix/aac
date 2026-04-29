// src/features/custom-app/helpers.ts
//
// Pure helpers for the custom-app editor: id generation, default factories,
// reference scanning across the GameDefinition graph, and class-id rename
// cascade.

import type {
  ButtonDef,
  ButtonEffect,
  ClassDef,
  Effect,
  GameDefinition,
  Interaction,
  RoomDef,
} from "@shared/custom-app-types";

// ---------------------------------------------------------------------------
// Id generation
// ---------------------------------------------------------------------------

/** Slugify a free-form label into a valid id token (alphanumeric + underscore). */
function slugify(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (cleaned.length === 0) return "item";
  // Must start with a letter or underscore.
  return /^[a-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

/** Pick an id that doesn't collide with `existing`, appending _2, _3, etc. */
export function uniqueId(base: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  const seed = slugify(base);
  if (!taken.has(seed)) return seed;
  let n = 2;
  while (taken.has(`${seed}_${n}`)) n++;
  return `${seed}_${n}`;
}

// ---------------------------------------------------------------------------
// Default factories
// ---------------------------------------------------------------------------

export function defaultClass(existingIds: Iterable<string>): ClassDef {
  return {
    id: uniqueId("object", existingIds),
    label: "New Object",
    iconRef: "❓",
    layer: "entity",
  };
}

export function defaultRoom(existingIds: Iterable<string>): RoomDef {
  return {
    id: uniqueId("room", existingIds),
    label: "New Room",
    size: [8, 8],
  };
}

export function defaultButton(existingIds: Iterable<string>): ButtonDef {
  return {
    id: uniqueId("button", existingIds),
    label: "New Button",
    iconRef: "🔘",
    effects: [{ type: "endTurn" }],
  };
}

// ---------------------------------------------------------------------------
// Reference scanner
// ---------------------------------------------------------------------------

export interface ClassReference {
  /** Where the reference lives, for display in the delete-confirm dialog. */
  location: string;
  /** A short description of the reference itself. */
  detail: string;
}

function effectsReferToClass(
  effects: Array<Effect | ButtonEffect>,
  classId: string,
): boolean {
  for (const e of effects) {
    if (e.type === "transformSelf" && e.id === classId) return true;
    if (e.type === "transformOther" && e.id === classId) return true;
    if (e.type === "createEntity" && e.classId === classId) return true;
  }
  return false;
}

function interactionRefersToClass(i: Interaction, classId: string): boolean {
  if (i.triggers.other?.classId === classId) return true;
  return effectsReferToClass(i.effects, classId);
}

/** Find every place a classId is referenced in a definition. */
export function findClassReferences(
  def: GameDefinition,
  classId: string,
): ClassReference[] {
  const refs: ClassReference[] = [];

  for (const c of def.classes) {
    if (c.id === classId) continue;
    for (const rule of c.dropRules ?? []) {
      if (rule.classIds.includes(classId)) {
        refs.push({
          location: `class "${c.id}"`,
          detail: `dropRule (${rule.type})`,
        });
      }
    }
    for (const inter of c.interactions ?? []) {
      if (interactionRefersToClass(inter, classId)) {
        refs.push({ location: `class "${c.id}"`, detail: "interaction" });
      }
    }
  }

  for (const b of def.buttons) {
    if (effectsReferToClass(b.effects, classId)) {
      refs.push({ location: `button "${b.id}"`, detail: "effect" });
    }
  }

  for (const r of def.rooms) {
    let count = 0;
    for (const e of r.entities ?? []) if (e.classId === classId) count++;
    if (count > 0) {
      refs.push({
        location: `room "${r.id}"`,
        detail: `${count} placed instance${count === 1 ? "" : "s"}`,
      });
    }
  }

  return refs;
}

// ---------------------------------------------------------------------------
// Rename cascade
// ---------------------------------------------------------------------------

function renameInEffects<T extends Effect | ButtonEffect>(
  effects: T[],
  oldId: string,
  newId: string,
): T[] {
  return effects.map((e) => {
    if ((e.type === "transformSelf" || e.type === "transformOther") && e.id === oldId) {
      return { ...e, id: newId };
    }
    if (e.type === "createEntity" && e.classId === oldId) {
      return { ...e, classId: newId };
    }
    return e;
  });
}

/**
 * Return a new definition with every reference to `oldId` rewritten to `newId`.
 * Also rewrites the class's own id. The caller is responsible for ensuring
 * `newId` is unique before calling.
 */
export function applyClassRename(
  def: GameDefinition,
  oldId: string,
  newId: string,
): GameDefinition {
  if (oldId === newId) return def;

  const classes = def.classes.map((c) => {
    const next: ClassDef = {
      ...c,
      id: c.id === oldId ? newId : c.id,
      dropRules: c.dropRules?.map((r) => ({
        ...r,
        classIds: r.classIds.map((id) => (id === oldId ? newId : id)),
      })),
      interactions: c.interactions?.map((i) => ({
        ...i,
        triggers: {
          ...i.triggers,
          other: i.triggers.other?.classId === oldId
            ? { ...i.triggers.other, classId: newId }
            : i.triggers.other,
        },
        effects: renameInEffects(i.effects, oldId, newId),
      })),
    };
    return next;
  });

  const buttons = def.buttons.map((b) => ({
    ...b,
    effects: renameInEffects(b.effects, oldId, newId),
  }));

  const rooms = def.rooms.map((r) => ({
    ...r,
    entities: r.entities?.map((e) =>
      e.classId === oldId ? { ...e, classId: newId } : e,
    ),
  }));

  return { ...def, classes, buttons, rooms };
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Return entities clipped to the new room size after a shrink. */
export function clipEntitiesToSize(
  entities: RoomDef["entities"] | undefined,
  width: number,
  height: number,
): RoomDef["entities"] {
  if (!entities) return entities;
  return entities.filter((e) => e.position[0] < width && e.position[1] < height);
}
