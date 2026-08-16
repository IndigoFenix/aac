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
          { kind: "body", params: { orbitAU: 1, mass: 1, radius: 10000, geology: { seed: 42 } } },
          { kind: "body", params: { orbitAU: 1.6, mass: 0.3, radius: 7000, geology: { seed: 7 } } },
        ],
      },
      // ⚖️ THE PLANET GREW TO FIT ITS TOWNS (food-scale-round.md Q3, 2026-08-15).
      //
      // It used to declare `gap_compression: 88` — honestly measured (25 km ÷
      // the 284 m gap these 2 km bodies really founded at) and, precisely
      // because it was honest, ruinous: `townExtentM` fell to 71 m, the street
      // tree's growth gate hit its 32 m floor, and a town whose assigned
      // population was 973 got 2-4 frontage lots. Measured headless: 0-1
      // houses, 11 workplaces around them, and (3 seeds of 6) no fields at all,
      // with weavers standing INSIDE farms — `earthlike-city-regression.md`.
      //
      // The user's ruling replaced the dial rather than the symptom: a village
      // is 100-300 m across, about 1/10 of realistic size, not 1/88. So:
      //
      //   gap_compression 10      → 25 000 / 10 = 2 500 m between villages,
      //                             extent 450 m (the clip ceiling is 625, so
      //                             the declared town body binds), 210-233 lots
      //                             and 195 houses MEASURED at 4 seeds.
      //   resource_compression 20 → the food requirement lowered where it
      //                             belongs (`farmAreaPerPersonM2`): 2 428 m²
      //                             per person instead of 48 562, so a village's
      //                             fields fit inside the territory its lattice
      //                             gives it with lean-season slack to spare.
      //   radius 2000 → 10000     → and THAT is what a 2 500 m lattice costs.
      //                             A 2 km body holds 4π·2000²·0.29 / 2 500² =
      //                             2.3 sites — a two-hamlet world. 50 sites
      //                             wants R = sqrt(50 · 2500² / (4π · 0.29)) =
      //                             9 262 m. The companion body keeps the ratio
      //                             (1400 → 7000).
      //
      // ⚖️ THE RADIUS IS THE ONE-LINE REVERT. If the small two-body toy is wanted
      // back, put `radius` at 2000/1400 and leave the two dials alone: the
      // preset then declares itself a TWO-HAMLET world (which is true) instead
      // of an 88× city world (which was not).
      session: { avatar: "spirit", scale: { gap_compression: 10, resource_compression: 20 } },
    },
  },
  {
    id: "home-planet",
    name: "Home Planet — a body in a vacuum",
    world: {
      // A single BODY as the root — a planet with no surrounding system (its
      // sun/stars come later). Watched from orbit as a spirit; gaze-zoom down.
      tree: { kind: "body", params: { geology: { seed: 7 }, radius: 6000, rain: 1.5 } },
      // A 6 km BODY DECLARES ITS GAP TOO (GL fix round, R3). Declaring nothing
      // does not mean "no compression" — it means EARTH, and this planet is
      // not Earth: its 393 m chart cell founded cities 844 m apart while the
      // undeclared extent stayed at Earth's 450 m, so 2·450 + 10 = 910 m of
      // town straddled an 844 m gap and 13 of 65 road ends had no open country
      // to port in (measured). 30 is 25 km ÷ the 844 m gap it really founds
      // at; the derived scan holds that lattice (2 cells = 785 m, realized p50
      // 844 m) and the extent falls to 208 m, clearing the clip law at 427 m.
      session: { avatar: "spirit", scale: { gap_compression: 30 } },
    },
  },
  {
    id: "nature-hike",
    name: "Nature Hike — an Earthlike planet on foot",
    world: {
      // The same lone BODY as Home Planet, but INHABITED: `avatar: true` is the
      // WALKER (manifest.ts `avatarKind`) — the hike is played on the ground,
      // from a wilderness chunk anchored at a deterministic founding site,
      // with the planet itself rendered around and under it.
      tree: { kind: "body", params: { geology: { seed: 11 }, radius: 5000, rain: 1.5 } },
      // ⚖️ SMALL RADIUS + gap_compression IS THE BIOME COMPRESSION. Climate
      // bands (climate.ts) are latitude-driven and span the WHOLE sphere, so on
      // a 5 km body the walk from steppe to forest to ice is minutes, not
      // months — that compression is the point of a hike, and it is DECLARED
      // here rather than faked by painting biomes small. `gap_compression: 30`
      // is Home Planet's measured value (25 km ÷ the ~844 m gap a body this
      // size really founds at), carried over so the settlement lattice this
      // planet derives stays the one that satisfies the clip law. `world
      // .founding` is deliberately OMITTED: an authored `founding` literal
      // outranks derivation, and the derived scan reads exactly the gap
      // declared above (planetFoundingOpts) — declaring both is how the two
      // came to disagree on the older presets. `locomotion: 2` doubles the
      // gait so the compressed country is crossed at a walker's patience.
      session: {
        avatar: true, avatar_species: "human_cute",
        scale: { rotation: 360, sleep_fraction: 0.05, gap_compression: 30, locomotion: 2 },
      },
    },
  },
];

/** The dropdown's default selection. */
export const DEFAULT_WORLD_ID = "spirit-dollhouse";
