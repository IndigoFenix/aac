/**
 * The lab's preset registry — every entry is an `ObjectDef` TREE plus its
 * session settings (project_scope_object_vacuum_law: sub-entity-first). The
 * dropdown loads a tree into the form; editing the tree (add bodies, add a
 * family, toggle exhaustive) is the whole modding loop. `getDocument()` lowers
 * the tree to the runnable `aivota-world` document.
 *
 * Data only. Kept deliberately small: Spirit Dollhouse is the one demo still in
 * active use; the rest showcase what the tree editor can now author.
 */
import type { TreeWorld } from "./spec-form";

export interface NamedWorld {
  id: string;
  name: string;
  world: TreeWorld;
}

/** Street-clock physics — a compressed day so needs/building move at demo pace. */
const STREET_CLOCK = { day_length_s: 240, sleep_fraction: 0.05, construction: 180 };

export const TEST_WORLDS: NamedWorld[] = [
  {
    id: "spirit-dollhouse",
    name: "Spirit Dollhouse — a hand-authored family",
    world: {
      // A TOWN whose focused house holds EXACTLY these four souls (creatures
      // exhaustive) — watched as a spirit: the cutaway camera, dwell to
      // talk/gift, chips + Speak to command. The item list seeds their floor
      // and box. This is the town → structure → creature/item tree.
      tree: {
        kind: "town",
        params: { seed: 7, days: 220, syntax: "b", locale: "en" },
        contains: [{
          kind: "structure",
          focus: true,
          exhaustive: ["creature"],
          contains: [
            { kind: "creature", params: { name: "Mara", outfit: 4, likes: ["apple"] } },
            { kind: "creature", params: { name: "Orrin", outfit: 1, likes: ["banana"] } },
            { kind: "creature", params: { name: "Pip", species: "frog_person", outfit: 0, likes: ["grape"] } },
            { kind: "creature", params: { name: "Biscuit", pet: true, likes: ["apple"] } },
            { kind: "item", params: { glyph: "apple", at: "floor" } },
            { kind: "item", params: { glyph: "ball", at: "floor" } },
            { kind: "item", params: { glyph: "teddy", at: "box" } },
            { kind: "item", params: { glyph: "shirt.dirty", at: "floor" } },
          ],
        }],
      },
      session: { avatar: "spirit", scale: STREET_CLOCK },
    },
  },
  {
    id: "riverside-town",
    name: "Riverside Town — walk it",
    world: {
      // A plain living town, entered on foot. No family defined — the town
      // generates its own residents.
      tree: { kind: "town", params: { seed: 7, days: 220 } },
      session: { avatar: true, scale: STREET_CLOCK },
    },
  },
  {
    id: "earthlike-system",
    name: "Earthlike System — a defined star + planets",
    world: {
      // A SOLAR SYSTEM authored body by body: a sun-mass star and two planets
      // orbiting it (one earthlike, one small). The tree editor authors every
      // body; building the defined system from the tree is the paused
      // render-from-tree work, so it currently boots the seed's home system.
      tree: {
        kind: "solar_system",
        params: { seed: 1337 },
        exhaustive: ["body"],
        contains: [
          { kind: "body", params: { mass: 333000, age: 4.6 } },
          { kind: "body", params: { orbitAU: 1, mass: 1, radius: 2000, geology: { seed: 42 } } },
          { kind: "body", params: { orbitAU: 1.6, mass: 0.3, radius: 1400, geology: { seed: 7 } } },
        ],
      },
      session: { avatar: "spirit" },
    },
  },
  {
    id: "home-planet",
    name: "Home Planet — a body in a vacuum",
    world: {
      // A single BODY as the root — a planet with no surrounding system (its
      // sun/stars come later). Watched from orbit as a spirit; gaze-zoom down.
      tree: { kind: "body", params: { geology: { seed: 7 }, radius: 6000, rain: 1.5 } },
      session: { avatar: "spirit" },
    },
  },
];

/** The dropdown's default selection. */
export const DEFAULT_WORLD_ID = "spirit-dollhouse";
