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

/** Street-clock physics — the planet spins 360× (a 240 s day) so needs and
 *  building move at demo pace. Compression is declared as a MULTIPLIER over
 *  the real anchor, never as an absolute (scale.ts `WorldScale.rotation`). */
const STREET_CLOCK = { rotation: 360, sleep_fraction: 0.05, construction: 180 };

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
        params: { seed: 12, days: 220, syntax: "b", locale: "en" },
        contains: [{
          kind: "structure",
          focus: true,
          exhaustive: ["creature"],
          contains: [
            { kind: "creature", params: { name: "Mara", outfit: 16, likes: ["apple"] } },
            { kind: "creature", params: { name: "Orrin", outfit: 1, likes: ["banana"] } },
            { kind: "creature", params: { name: "Pip", species: "frog_person", outfit: 0, likes: ["grape"] } },
            { kind: "creature", params: { name: "Biscuit", pet: true, species: "dog", likes: ["apple"] } },
            { kind: "item", params: { glyph: "ball", at: "floor" } },
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
    id: "sunset-town",
    name: "Sunset Town — a culture's dress palette",
    world: {
      // The SAME town, but its CULTURE declares a warm dress palette
      // (`game.culture.dress`): every resident wears reds/oranges/pinks/purples
      // and the tailor stocks only those, so the whole street reads as one
      // culture. Walk it and compare to Riverside's default palette.
      tree: { kind: "town", params: { seed: 7, days: 220 } },
      session: {
        avatar: true,
        scale: STREET_CLOCK,
        culture: {
          dress: { palette: ["color_red", "color_orange", "color_pink", "color_purple"] },
        },
      },
    },
  },
  {
    id: "frontier-homestead",
    name: "Frontier Homestead — found a town from nothing",
    world: {
      // CITY-FOUNDING (city-founding.md): a TOWN at age 0 — a site with a
      // population and a supply box but NO buildings. Wilderness surroundings
      // come by default at age 0 (trees hold wood, rocks hold stone). The
      // spirit orders builds ("build farm" founds it by ACT on a street lot —
      // areas come from the world's own partitioning, never a painted disc;
      // nations-and-empires §3c) and the day-tick growth loops run on the
      // town machinery from day one.
      tree: {
        kind: "town",
        params: { seed: 11, days: 0, population: 5, stock: { wood: 14, stone: 6 } },
      },
      // Construction 720 (vs the street clock's 180): a house rises in ~60 s
      // real time — founding is WATCHED, so builds must finish while the
      // player's attention holds.
      session: { avatar: "spirit", scale: { ...STREET_CLOCK, construction: 720 } },
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
      // ⚖️ A 2 km PLANET DECLARES ITS SETTLEMENT GAP (growth phase C §1.1/§3.1).
      // Earth's day's walk is 25 km; a body this size has a 131 m chart cell
      // and founds its cities ~790 m apart, so its towns really do stand 1/32
      // of a real gap from one another. Declaring it is what lets
      // `townSpacingM`/`townExtentM` derive: the founding spacing comes back as
      // the same 6 cells the map already used, and the town extent falls from
      // 450 m to 195 m — at which the interstate roads END AT PORTS instead of
      // running through the buildings (measured on this exact planet: 18 of 34
      // road ends unclipped → 0).
      session: { avatar: "spirit", scale: { gap_compression: 32 } },
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
