/**
 * Solar system generation — a compact, deterministic system model over the
 * migrated stellar physics (stellar.ts: Kroupa IMF, main-sequence
 * relations, remnants). This is the SCOPE-level model: star + planets as
 * DATA (orbits, kinds, radii, per-planet seeds) — the seam a system viewer
 * draws and the planet scope descends through (a rocky planet's `seed`
 * IS its geology seed).
 *
 * seagull-dream's fuller physics-system (nebula→present evolution,
 * BodyFeatures) stays game-side until its migration turn; this generator
 * follows its shape (snow-line kinds, Kepler periods, equilibrium
 * temperatures) at a fraction of the depth.
 */
import { mulberry32 } from "./galaxy";
import { sampleIMFMass, resolveStellarState, type StellarState } from "./stellar";

export type PlanetKind = "rocky" | "gas" | "ice";

export interface SystemPlanet {
  index: number;
  /** Deterministic per-planet seed — the geology seed on descent. */
  seed: number;
  kind: PlanetKind;
  /** Semi-major axis, AU. */
  orbitAU: number;
  /** Radius, Earth radii. */
  radiusRe: number;
  /** Orbital period, years (Kepler over the star's current mass). */
  periodYears: number;
  /** Equilibrium temperature, K (albedo-free blackbody estimate). */
  teqK: number;
}

export interface SolarSystemModel {
  seed: number;
  star: {
    massInit: number;
    age: number;
    feh: number;
    state: StellarState;
  };
  planets: SystemPlanet[];
}

/** The snow line: beyond it volatiles freeze and giants grow. */
const snowLineAU = (luminosity: number): number => 2.7 * Math.sqrt(Math.max(1e-4, luminosity));

export interface GenerateSystemOpts {
  /** Pin the star (a galaxy StarRecord's massInit/age/feh) instead of
   *  sampling one — how a system materializes FROM its star. */
  star?: { massInit: number; age: number; feh: number };
}

export function generateSystem(seed: number, opts: GenerateSystemOpts = {}): SolarSystemModel {
  const rng = mulberry32(seed >>> 0);

  const massInit = opts.star?.massInit ?? sampleIMFMass(rng);
  const age = opts.star?.age ?? 0.5 + rng() * 9.5;
  const feh = opts.star?.feh ?? (rng() - 0.5) * 0.8;
  const state = resolveStellarState(massInit, age, feh);

  const count = 3 + Math.floor(rng() * 7); // 3..9 — most systems are crowded
  const snow = snowLineAU(state.luminosity);
  const planets: SystemPlanet[] = [];
  let a = 0.25 + rng() * 0.3;
  for (let i = 0; i < count; i++) {
    const seedI = (Math.imul(seed ^ 0x9e3779b9, 2654435761) + i * 0x85ebca6b) >>> 0;
    const teq = 278 * Math.pow(Math.max(1e-4, state.luminosity), 0.25) / Math.sqrt(a);
    const beyondSnow = a > snow;
    const roll = rng();
    // Giants live beyond the snow line; the farthest of them run icy.
    const kind: PlanetKind = beyondSnow
      ? (roll < 0.45 ? "gas" : roll < 0.75 ? "ice" : "rocky")
      : (roll < 0.9 ? "rocky" : "gas"); // the occasional hot jupiter
    const radiusRe =
      kind === "gas" ? 8 + rng() * 5 :
      kind === "ice" ? 3 + rng() * 2 :
      0.4 + rng() * 1.5;
    planets.push({
      index: i,
      seed: seedI,
      kind,
      orbitAU: a,
      radiusRe,
      periodYears: Math.sqrt(Math.pow(a, 3) / Math.max(0.08, state.currentMass)),
      teqK: teq,
    });
    a *= 1.5 + rng() * 0.6; // Titius–Bode-ish spacing
  }

  return { seed, star: { massInit, age, feh, state }, planets };
}
