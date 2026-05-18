import * as THREE from "three";
import type { CelestialBody, BodyOrbit } from "./body";
import { createCelestialBody } from "./celestial-body";
import { materializeSystem, resolveSystem } from "./physics-system/system";
import type { ResolvedBody } from "./physics-system/system";
import type { StarRecord, GalaxyParams } from "./galaxy";
import { GALAXY } from "./config";
import { buildHomeBlueprint } from "./home-system";
import {
  EARTHLIKE_BLUE,
  BARREN_MARS,
  BARREN_YELLOW,
  ICE_WORLD,
  MOON_PALETTE,
  type RockyPalette,
} from "./palettes";

// Pinned rocky palettes for the home Sol system. Composition, mass,
// orbit, axial tilt and atmosphere all come deterministically from
// SOL_SPECS, but the rocky-palette picker (selectRockyPalette) still
// chooses VARIANTS within each category via `bodyHash(id) % N` — so
// Earth could end up teal-skied or violet-grassed depending on its
// id hash. That's appropriate for a procgen Earth-class world; less
// so for THE Earth the player remembers. We pin the recognisable
// bodies here.
//
// Things deliberately NOT in this map:
//   - Gas giants (Jupiter/Saturn/Uranus/Neptune): colorA/colorB come
//     from `state.color` which is physics-derived. Same SOL_SPECS
//     composition → same color every run.
//   - The Sun: stellar physics drives everything.
//   - Atmosphere composition, cloud type, sky color physics: all
//     deterministic functions of fixed SOL_SPECS inputs.
//   - Terrain shape: noise seeded by bodyHash(id), deterministic but
//     left "geographically random" per spec.
const HOME_FORCED_PALETTES: Record<string, RockyPalette> = {
  Ap0:    MOON_PALETTE,    // Mercury — mass < 0.1 picks MOON anyway, pinned for clarity
  Ap1:    BARREN_YELLOW,   // Venus — thick CO2 + sulfuric clouds
  Ap2:    EARTHLIKE_BLUE,  // Earth — the canonical blue marble
  Ap3:    BARREN_MARS,     // Mars
  Ap2gim: MOON_PALETTE,    // Luna
  Ap4m0:  BARREN_YELLOW,   // Io — sulfur-yellow; picker would default it to MOON
  Ap4m1:  ICE_WORLD,       // Europa — ice shell; picker would default it to MOON
  // Ganymede (Ap4m2), Callisto (Ap4m3), Titan (Ap5m0): no good
  // dedicated palette in the catalog yet — fall through to the
  // procedural choice (MOON_PALETTE for all three at their masses).
};

// Active solar system — the bundle of CelestialBodies materialized in the
// scene for the star the player is currently near. Built lazily on system
// entry, torn down on exit.
//
// Generation flow:
//   1. materializeSystem(star, galaxyParams)  → SystemBlueprint (data)
//   2. resolveSystem(blueprint, galaxyAgeNow)    → ResolvedBody[]
//   3. for each ResolvedBody in parent-before-child order:
//        createCelestialBody(...) → CelestialBody (scene)
//
// Step 1 is deterministic from `star.systemSeed`. Step 2 evolves every
// body to its current observable state at the galaxy's present age. Step 3
// dispatches by physical state to the appropriate scene representation
// (luminous disc / banded sphere / terrain quadtree).
//
// The home system bypasses the procedural physics pipeline — see
// home-system.ts for the hand-rolled Sol blueprint, gated on
// star.systemSeed === GALAXY.homeSystemSeed.
//
// TODO(streaming): generation is currently one synchronous pass. The
// physics steps (build + resolve) are cheap; the expensive part is body
// creation (terrain quadtree, scatter, shaders). If wall-clock time gets
// noticeable we can spread step 3 across frames during the player's
// approach — primary first, then bodies along the approach trajectory,
// then the rest.

const AU_M = 1.495978707e11;

export interface SolarSystem {
  /** System primary (always the body whose parentId === null in the
   *  blueprint). For Kroupa-sampled systems this is always luminous. */
  star: CelestialBody;
  /** Star directional light if the primary is luminous. Null for
   *  non-luminous primaries (a TODO edge case — current generation
   *  pipeline always produces a luminous primary). */
  starLight: THREE.DirectionalLight | null;
  /** All bodies in update order: parents strictly before children, so
   *  advanceBodyTransform can derive each child's worldPosition from its
   *  parent's already-updated worldPosition. */
  bodies: CelestialBody[];
}

export interface GenerateSolarSystemOpts {
  star: StarRecord;
  galaxyParams: GalaxyParams;
  /** World-space position the system primary spawns at. */
  centerPosition: THREE.Vector3;
  scene: THREE.Scene;
}

export function generateSolarSystem(opts: GenerateSolarSystemOpts): SolarSystem {
  const { star, galaxyParams, centerPosition, scene } = opts;

  const isHomeSystem = star.systemSeed === GALAXY.homeSystemSeed;
  const blueprint = isHomeSystem
    ? buildHomeBlueprint(star, galaxyParams)
    : materializeSystem(star, galaxyParams);
  const resolved = resolveSystem(blueprint, galaxyParams.galaxyAgeGyr);
  const ordered = topoSortByParent(resolved);

  const built = new Map<string, CelestialBody>();
  const bodies: CelestialBody[] = [];
  let primary: CelestialBody | null = null;
  let primaryLight: THREE.DirectionalLight | null = null;

  for (const rb of ordered) {
    const physBody = rb.body;
    const parentCB = physBody.parentId !== null
      ? built.get(physBody.parentId) ?? null
      : null;

    let initialPosition: THREE.Vector3;
    let orbit: BodyOrbit | null = null;
    if (parentCB) {
      const aMeters = physBody.formationSemiMajor * AU_M;
      // Placeholder spawn — advanceBodyTransform overwrites worldPosition
      // from the orbit + phase on the first call, so this single-frame
      // value just keeps the body off the parent until then.
      initialPosition = parentCB.worldPosition.clone()
        .add(new THREE.Vector3(aMeters, 0, 0));
      const periodSeconds = 2 * Math.PI * Math.sqrt((aMeters ** 3) / Math.max(1, parentCB.gm));
      orbit = {
        parent: parentCB,
        semiMajorAxis: aMeters,
        period: periodSeconds,
        phase: phaseFromId(physBody.id),
        inclination: physBody.formationInclination,
      };
    } else {
      initialPosition = centerPosition.clone();
    }

    const forcedPalette = isHomeSystem ? HOME_FORCED_PALETTES[physBody.id] : undefined;
    const created = createCelestialBody({
      resolved: rb,
      initialPosition,
      orbit,
      scene,
      forcedPalette,
    });
    scene.add(created.body.group);
    built.set(physBody.id, created.body);
    bodies.push(created.body);

    if (!primary && physBody.parentId === null) {
      primary = created.body;
      primaryLight = created.light;
    }
  }

  if (!primary) {
    throw new Error(
      `generateSolarSystem: blueprint for ${star.id} produced no root body`,
    );
  }

  return { star: primary, starLight: primaryLight, bodies };
}

/** Deterministic 0..2π phase from a body id. Keeps adjacent siblings from
 *  all spawning at angle 0 on the same axis. */
function phaseFromId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h = (h ^ id.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return ((h >>> 0) % 6283) / 1000;
}

/** Sort ResolvedBody[] so every body appears after its parent. The
 *  blueprint constructor already produces a roughly-hierarchical order;
 *  this just guarantees correctness for any future generator changes. */
function topoSortByParent(resolved: ResolvedBody[]): ResolvedBody[] {
  const byId = new Map<string, ResolvedBody>();
  for (const rb of resolved) byId.set(rb.body.id, rb);
  const sorted: ResolvedBody[] = [];
  const seen = new Set<string>();
  function visit(rb: ResolvedBody): void {
    if (seen.has(rb.body.id)) return;
    if (rb.body.parentId !== null) {
      const parent = byId.get(rb.body.parentId);
      if (parent) visit(parent);
    }
    seen.add(rb.body.id);
    sorted.push(rb);
  }
  for (const rb of resolved) visit(rb);
  return sorted;
}
