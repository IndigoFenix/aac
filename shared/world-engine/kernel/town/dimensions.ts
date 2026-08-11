/**
 * dimensions.ts — the town's PHYSICAL SCALE, in one place. Every
 * footprint, pitch and clearance the plan and street layers use reads
 * from here, so "how big is a house" is a documented knob, not a magic
 * literal scattered through growth code.
 *
 * DEFAULTS AIM AT ROUGH REALISM (decided 2026-07-09, after the first 3D
 * walk made the old 60%-scale footprints obvious — wall height 3 m and
 * walk speed 1.6 m/s were always real, which is exactly why small
 * footprints read as a miniature):
 *
 *   house      7–13 m frontage × 7–10 m deep (49–130 m²) — from a
 *              one-room studio cottage through 3-room (the norm) up to
 *              4-room burgher houses (kernel/town/rooms.ts splits the
 *              footprint; frontage picks the plan)
 *   lot pitch  15 m along the street (side gaps between houses, vs the
 *              old touching rowhouses at 8.5)
 *   street     ~11 m wall-to-wall between facing frontages
 *   plaza      Ø 60 m clearing at the town's busiest junction (a proper
 *              town square — a WIDENED JUNCTION, not a ring road)
 *   hall       20 × 15 m; market hall 20 × 12 m
 *   fields     ~70–110 × 55–80 m smallholdings
 *
 * Changing these changes every town deterministically (same seed ⇒ same
 * town at the new scale); prefix stability holds per configuration.
 * NOTE the coupled constants that deliberately did NOT move: walk speed
 * (real), wall height (real), door gaps (2 m — a gameplay affordance
 * for gaze steering), and the resident-streaming radii (tuned to the
 * camera, residents.ts).
 */

import { REAL_TOWN_EXTENT_M } from "../../scale";

export const TOWN_DIMS = {
  /** House footprint: depth (street-facing setback direction) and
   *  frontage width, each min + jitter. */
  houseDepthMin: 7,
  houseDepthJit: 3,
  houseWidthMin: 7,
  houseWidthJit: 6,

  /** PLAZA radius — the clearing a widened junction gets (growth-phase-B:
   *  the plaza is a node the market stands on, no longer a ring road at the
   *  origin). Also the scale of a STUB baseline (~2×, so a lone founder's
   *  town starts with a street rather than a point). */
  plazaR: 30,
  /** Street extension step per growth round. */
  streetStep: 16,
  /** THE DECLARED EXTENT — how far out the town's BUILT AREA may reach,
   *  leaving room for the works ring + margin inside the half-kilometer
   *  tile. Growth stops `builtMargin` short of it so `plan.radius` (an
   *  OUTPUT of what actually grew, phase B §1.5) can never exceed it.
   *  With realistic pitch a capped city holds FEWER houses than before
   *  (~650 lots ≈ 3,200 souls; want > built beyond that — the town-full
   *  governor, working as designed).
   *
   *  THE DECLARED extent only — what a town is ALLOWED. What a given world
   *  can actually hold is `scale.ts townExtentM(scale)`, which caps this by
   *  the clip law (a town may not swallow the road to its neighbour). Every
   *  extent consumer reads that; this is the anchor it caps. */
  townRMax: REAL_TOWN_EXTENT_M,
  /** Spacing between ATTACHMENT STATIONS on a street — where arterials
   *  root on the baseline (phase B §1.3). Must clear `streetMinGap` with
   *  room to spare: two arterials leaving the same side of a straight
   *  baseline never diverge, so anything at or under the gap kills the
   *  second one at its first step. */
  arterialSpacing: 64,
  /** BUILT MARGIN a street tip carries beyond its own centerline: a work
   *  caps the tip `workTipOut` past it, the plan pads a work by `workPad`
   *  and the whole plan by `planPad`. Street growth holds this back from
   *  the declared extent — that is what makes `plan.radius ≤ townRMax`
   *  true BY CONSTRUCTION (the 495 > 450 defect). */
  builtMargin: 46,
  /** Minimum clearance between unrelated street centerlines — must
   *  exceed two lot setbacks plus a back garden. */
  streetMinGap: 30,
  /** Lot center distance from its street's centerline. Street corridor
   *  wall-to-wall ≈ 2 × (setback − depth/2). */
  lotSetback: 10.5,
  /** Clear zone around junctions where no lot fronts. */
  lotClear: 6.5,
  /** Lot pitch along the street (center to center). */
  lotPitch: 15,
  /** No lots this close to a junction. */
  junctionKeep: 14,
  /** No branch ports this close to a junction... */
  portKeep: 15,
  /** ...and at least this far apart along a street. Tighter than the
   *  pitch ratio suggests — at realistic block spacing, lane DENSITY is
   *  what keeps a big town's capacity near its disc's potential. */
  portSpacing: 30,

  /** STRUCTURAL civic footprints (every town has these; economy
   *  buildings carry their own styles as content). */
  hallW: 20,
  hallH: 15,
  marketW: 20,
  marketH: 12,
  /** LEGACY: clearance the retired plaza BERTHS kept from the plaza's
   *  centre line. Nothing in the kernel reads it since growth-phase-B made
   *  the civic buildings ordinary frontage lots; kept only so the vendored
   *  dollhouse copy still compiles until stage 3 re-syncs it. */
  plazaClear: 8,

  /** Production works stand this far out past their street tip... */
  workTipOut: 18,
  /** ...and never closer than this to another work. */
  workMinSpacing: 30,
  /** Radius a placed WORK adds to the plan's built radius... */
  workPad: 18,
  /** ...a placed HOUSE likewise... */
  housePad: 12,
  /** ...and the final skirt the plan reports past its farthest building.
   *  `builtMargin` above = workTipOut + workPad + planPad. */
  planPad: 10,

  /** Ceiling on house storeys, however high the build-up knob goes
   *  (the world-engine caps a building at WORLD_MAX_FLOORS = 8; towns
   *  stay village-to-burgher scale below that). */
  maxHouseFloors: 4,

  /** Cultivated field patches (farmland biome). */
  fieldWMin: 70,
  fieldWJit: 40,
  fieldHMin: 55,
  fieldHJit: 25,
  fieldOutMin: 40,
  fieldOutJit: 80,
  fieldSideSpread: 130,
} as const;

export type TownDims = typeof TOWN_DIMS;
