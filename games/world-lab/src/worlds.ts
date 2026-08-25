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
      //   resource_compression 7.5 → the food requirement lowered where it
      //                             belongs (`farmAreaPerPersonM2`): 6 474.97 m²
      //                             per person (1.6 acres) instead of 48 562.
      //                             STAGE β RE-SOLVE (food-scale-round.md
      //                             "# STAGE β" › β4): the dial derives from
      //                             the MEASURED village popCap 140 —
      //                             A_allowed = 6.25e6 × 0.25 × 0.70 /
      //                             (140 × 1.20) = 6 510 m²/person ⇒ dial =
      //                             12 × 4 046.8564 / 6 510 = 7.46 → 7.5.
      //                             The old 20 was the conservative
      //                             pre-Stage-β choice, made while fields
      //                             were still sized from RAW population;
      //                             β1-β3 made population follow capacity,
      //                             which is what the Phase A close said the
      //                             re-solve had to wait for. 7.5 sits 0.55%
      //                             above the 7.4592 cliff where the village
      //                             catchment (2 493 m) would out-grow this
      //                             lattice — pinned in food-scale.test.ts.
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
      session: { avatar: "spirit", scale: { gap_compression: 10, resource_compression: 7.5 } },
    },
  },
  {
    id: "home-planet",
    name: "Home Planet — a body in a vacuum",
    world: {
      // A single BODY as the root — a planet with no surrounding system (its
      // sun/stars come later). Watched from orbit as a spirit; gaze-zoom down.
      tree: { kind: "body", params: { geology: { seed: 7 }, radius: 6000, rain: 1.5 } },
      // ⚖️ THE SAME DIALS AS EARTHLIKE (food-scale-round.md ⑨, 2026-08-24).
      //
      // It used to declare `gap_compression: 30` — measured against the 844 m
      // gap this body's 393 m chart cell really founded at, back when the
      // extent was one undeclared 450 m for every settlement and the clip law
      // was the emergency being fixed (2·450 + 10 = 910 m of town straddling
      // an 844 m gap, 13 of 65 road ends portless). The tier anchors ended
      // that emergency: a village now declares its own 120 m body, so the gap
      // no longer has to be crushed to keep towns off each other's roads.
      //
      //   gap_compression 10      → the user's 1/10: a 2 500 m lattice (the
      //                             derived scan holds 6 chart cells,
      //                             realized 2 356 m), clearing the clip law
      //                             with room — 910 m of two town bodies
      //                             against a 2 500 m gap. A 6 km body holds
      //                             4π·6000²·0.29 / 2 500² ≈ 21 sites.
      //   resource_compression 7.5 → the food requirement lowered where it
      //                             belongs (`farmAreaPerPersonM2`): 6 474.97 m²
      //                             per person (1.6 acres), Stage β4's
      //                             re-solve from the measured village popCap
      //                             140, so a village's fields fit the
      //                             territory its lattice gives it — same
      //                             solve as Earthlike, same numbers (the
      //                             derivation and the 7.4592 cliff live on
      //                             that preset's block).
      session: { avatar: "spirit", scale: { gap_compression: 10, resource_compression: 7.5 } },
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
      // ⚖️ SMALL RADIUS IS THE BIOME COMPRESSION. Climate bands (climate.ts)
      // are latitude-driven and span the WHOLE sphere, so on a 5 km body the
      // walk from steppe to forest to ice is minutes, not months — that
      // compression is the point of a hike, and it is DECLARED here rather
      // than faked by painting biomes small.
      //
      // THE DIALS ARE EARTHLIKE'S (food-scale-round.md ⑨, 2026-08-24):
      // `gap_compression: 10` is the user's 1/10 settlement lattice and
      // `resource_compression: 7.5` the matching food solve (Stage β4's
      // re-solve from the measured village popCap 140 — the derivation lives
      // on the Earthlike block), replacing the old 30 that was measured
      // against the clip-law emergency the tier anchors ended (see Home
      // Planet). `locomotion: 2` doubles the gait so the compressed country
      // is crossed at a walker's patience — and doubles the day's walk with
      // it (townSpacingM), so settlements stand a 5 000 m lattice apart: a
      // hike crosses wilderness between a handful of far sites, not a suburb.
      // (The village catchment at 7.5 is 2 493 m — Earthlike's 2 500 m
      // lattice clears it by 7 m, this one by a mile.) The hike's OWN spec,
      // games/nature-hike/src/game.spec.json, declares these same dials and
      // is pinned in lockstep (food-scale.test.ts, Stage β4) — flip both or
      // neither. `world.founding` is deliberately OMITTED: an
      // authored `founding` literal outranks derivation, and the derived scan
      // must read exactly the gap declared above (planetFoundingOpts) —
      // declaring both is how the two came to disagree on the older presets.
      session: {
        avatar: true, avatar_species: "human_cute",
        scale: { rotation: 360, sleep_fraction: 0.05, gap_compression: 10, resource_compression: 7.5, locomotion: 2 },
      },
    },
  },
];

/** The dropdown's default selection. */
export const DEFAULT_WORLD_ID = "spirit-dollhouse";
