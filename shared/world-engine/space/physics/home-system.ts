// Hand-rolled SystemBlueprint for the player's starting system.
//
// The procedural physics pipeline in physics-system/ would happily roll
// SOMETHING for the home seed, but there's no guarantee it would produce
// a Sol-like layout — and the player needs to spawn on an Earth-class
// world. So we build a Body[] by hand, calibrated to the real solar
// system, and gate it on `star.systemSeed === GALAXY.homeSystemSeed`
// inside generateSolarSystem.
//
// Body composition values (refractory / ice / H-He, M_earth), formation
// orbits, rotation, and axial tilt come from a separate calibration pass
// against the procedural-physics layer — see solar-system.txt in
// physics-system-updated/ for the source values and derivation. The
// home-system Sun masses (refractory 1865, ice 2797, H-He 328338) sum to
// 333000 M_earth = 1 M_sun.
//
// Birth time: galaxyParams.galaxyAgeGyr can vary from one galaxy roll to
// another (5–13 Gyr), so we anchor the bodies relative to it — birthTime
// = galaxyAgeNow − 4.6 Gyr — so the Sol system always presents at its
// real 4.6 Gyr age regardless of which galaxy we're in.

import type { Body } from "./body";
import type { SystemBlueprint } from "./system";
import type { StarRecord, GalaxyParams } from "../galaxy";

const SOL_AGE_GYR = 4.6;

interface BodySpec {
  id: string;
  parentId: string | null;
  refractory: number;
  ice: number;
  hhe: number;
  semiMajorAU: number;
  eccentricity: number;
  inclination: number;       // radians
  rotationHours: number;     // negative = retrograde at formation
  axialTilt: number;         // radians
  densityFactor?: number;    // default 1.0
}

const SOL_SPECS: ReadonlyArray<BodySpec> = [
  // Sun.
  { id: "A", parentId: null,
    refractory: 1865, ice: 2797, hhe: 328338,
    semiMajorAU: 0, eccentricity: 0, inclination: 0,
    rotationHours: 600, axialTilt: 0.122 },

  // Inner rocky planets.
  { id: "Ap0", parentId: "A",                                  // Mercury
    refractory: 0.055, ice: 0, hhe: 0,
    semiMajorAU: 0.387, eccentricity: 0.21, inclination: 0.122,
    rotationHours: 15, axialTilt: 0, densityFactor: 1.7 },
  { id: "Ap1", parentId: "A",                                  // Venus
    refractory: 0.815, ice: 0, hhe: 0,
    semiMajorAU: 0.723, eccentricity: 0.007, inclination: 0.06,
    rotationHours: 5832, axialTilt: 3.09 },                    // 177° flip via tilt
  { id: "Ap2", parentId: "A",                                  // Earth
    refractory: 0.997, ice: 0.003, hhe: 0,
    semiMajorAU: 1.0, eccentricity: 0.017, inclination: 0,
    rotationHours: 24, axialTilt: 0.41 },
  { id: "Ap3", parentId: "A",                                  // Mars
    refractory: 0.106, ice: 0.0014, hhe: 0,
    semiMajorAU: 1.524, eccentricity: 0.093, inclination: 0.032,
    rotationHours: 24.6, axialTilt: 0.44 },

  // Outer giants.
  { id: "Ap4", parentId: "A",                                  // Jupiter
    refractory: 5, ice: 10, hhe: 303,
    semiMajorAU: 5.20, eccentricity: 0.048, inclination: 0.023,
    rotationHours: 9.93, axialTilt: 0.05 },
  { id: "Ap5", parentId: "A",                                  // Saturn
    refractory: 3, ice: 15, hhe: 77,
    semiMajorAU: 9.58, eccentricity: 0.056, inclination: 0.043,
    rotationHours: 10.7, axialTilt: 0.47 },
  { id: "Ap6", parentId: "A",                                  // Uranus
    refractory: 1, ice: 12, hhe: 1.5,
    semiMajorAU: 19.2, eccentricity: 0.046, inclination: 0.013,
    rotationHours: 17.2, axialTilt: 1.71 },                    // ~98°, sideways
  { id: "Ap7", parentId: "A",                                  // Neptune
    refractory: 1, ice: 14, hhe: 2.1,
    semiMajorAU: 30.1, eccentricity: 0.009, inclination: 0.031,
    rotationHours: 16.1, axialTilt: 0.49 },

  // Major moons. Semi-major axes are around the parent planet, in AU.
  { id: "Ap2gim", parentId: "Ap2",                             // Earth's Moon
    refractory: 0.0114, ice: 0.0006, hhe: 0,
    semiMajorAU: 0.00257, eccentricity: 0.055, inclination: 0.09,  // 384,400 km
    rotationHours: 100, axialTilt: 0 },                        // locked early — value irrelevant

  { id: "Ap4m0", parentId: "Ap4",                              // Io
    refractory: 0.015, ice: 0, hhe: 0,
    semiMajorAU: 0.00282, eccentricity: 0.004, inclination: 0.0007,
    rotationHours: 100, axialTilt: 0 },
  { id: "Ap4m1", parentId: "Ap4",                              // Europa
    refractory: 0.007, ice: 0.001, hhe: 0,
    semiMajorAU: 0.00449, eccentricity: 0.009, inclination: 0.008,
    rotationHours: 100, axialTilt: 0 },
  { id: "Ap4m2", parentId: "Ap4",                              // Ganymede
    refractory: 0.012, ice: 0.013, hhe: 0,
    semiMajorAU: 0.00716, eccentricity: 0.001, inclination: 0.003,
    rotationHours: 100, axialTilt: 0 },
  { id: "Ap4m3", parentId: "Ap4",                              // Callisto
    refractory: 0.009, ice: 0.009, hhe: 0,
    semiMajorAU: 0.0126, eccentricity: 0.007, inclination: 0.003,
    rotationHours: 100, axialTilt: 0 },

  { id: "Ap5m0", parentId: "Ap5",                              // Titan
    refractory: 0.011, ice: 0.011, hhe: 0,
    semiMajorAU: 0.00817, eccentricity: 0.029, inclination: 0.006,
    rotationHours: 100, axialTilt: 0 },
];

/** Build the hand-rolled Sol blueprint, anchored to the galaxy's current
 *  age so the system always presents at a 4.6 Gyr age regardless of the
 *  surrounding galaxy parameters. */
export function buildHomeBlueprint(
  star: StarRecord,
  galaxyParams: GalaxyParams,
): SystemBlueprint {
  const birthTimeGyr = Math.max(0, galaxyParams.galaxyAgeGyr - SOL_AGE_GYR);
  const feh = star.feh;

  const bodies: Body[] = SOL_SPECS.map((s) => ({
    id: s.id,
    parentId: s.parentId,
    formationRefractory: s.refractory,
    formationIce: s.ice,
    formationHHe: s.hhe,
    formationSemiMajor: s.semiMajorAU,
    formationEccentricity: s.eccentricity,
    formationInclination: s.inclination,
    formationRotationHours: s.rotationHours,
    formationAxialTilt: s.axialTilt,
    birthTimeGyr,
    feh,
    refractoryDensityFactor: s.densityFactor ?? 1.0,
  }));

  return {
    starId: star.id,
    systemSeed: star.systemSeed,
    bodies,
  };
}
