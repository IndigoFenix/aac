/**
 * THREE adapter for the planet renderer — the only file in shared/planet
 * that imports a graphics library. Everything real (surface sampling,
 * chunk geometry, LOD) is framework-free; this wraps it in meshes so a
 * game does:
 *
 *   const surface = substrateSurface({ substrate: grid, radius });
 *   const planet = createPlanetObject(surface);
 *   scene.add(planet.group);
 *   // per frame, with the camera in PLANET-LOCAL coordinates:
 *   planet.update(cameraLocal);
 */
import * as THREE from "three";
import type { PlanetSurface } from "./surface";
import { createPlanetLod, type PlanetLod, type PlanetLodOpts } from "./lod";
import type { ChunkGeometryData } from "./chunk";
import { terrainMaterial } from "../materials";
import { applyTerrainShading, type GrassShadingOpts, type RockShadingOpts, type SandShadingOpts, type WaterShadingOpts } from "./terrain-shading";
import type { PlanetTerminatorOpts } from "./day-night";

export interface PlanetObjectOpts extends PlanetLodOpts {
  /** Has an ocean. Default on: the terrain renders a flat, depth-shaded
   *  sea-level surface (no separate shell). Pass false for dry worlds (the
   *  terrain then dips into its basins as bare seabed). The color/opacity
   *  fields are legacy no-ops kept for call-site compatibility. */
  ocean?: false | { color?: number; opacity?: number };
  /** Terrain material overrides (vertexColors stays on). */
  material?: Partial<Pick<THREE.MeshStandardMaterialParameters, "roughness" | "metalness" | "flatShading">>;
  /** Water shading tuning — see terrain-shading.ts, including its SEIZURE
   *  SAFETY note before touching roughness/metalness/waveStrength. Pass `false`
   *  for flat blue. Forced off on `ocean: false` worlds, which have no water
   *  vertices to shade. */
  water?: false | WaterShadingOpts;
  /** Ground detail tuning — see terrain-shading.ts. Pass `false` for flat
   *  vertex-colour ground. Has no effect on a surface that doesn't implement
   *  `materialAt`: its material weights are all zero, so the detail has nothing
   *  to draw on. */
  grass?: false | GrassShadingOpts;
  /** Sand detail tuning — see terrain-shading.ts. Pass `false` for flat
   *  vertex-colour ground. Its fine/coarse grain regime comes from
   *  `surface.regimeAt`; a surface without one reads as fine sand throughout. */
  sand?: false | SandShadingOpts;
  /** Rock detail tuning — see terrain-shading.ts. Pass `false` for flat
   *  vertex-colour ground. Rock is the one material that projects TRIPLANAR,
   *  because it is the one that lives on cliffs. Its strata come from
   *  `surface.valleyField` exposing bedrock; without that field rock appears
   *  only above the treeline, as it always did. */
  rock?: false | RockShadingOpts;
  /** Planet-scale day/night terminator (toon only) — see day-night.ts. Set it
   *  when this planet is viewed from space so its disc doesn't shade through the
   *  shared cel ramp's disc-wide bands; leave unset for a ground/local scope. */
  terminator?: PlanetTerminatorOpts;
}

export interface PlanetObject {
  group: THREE.Group;
  /** Re-evaluate LOD for a planet-local camera position. */
  update(cameraLocal: THREE.Vector3): void;
  lod: PlanetLod;
  dispose(): void;
}

export function createPlanetObject(surface: PlanetSurface, opts: PlanetObjectOpts = {}): PlanetObject {
  const group = new THREE.Group();
  group.name = "planet";

  const material = terrainMaterial({
    vertexColors: true,
    roughness: opts.material?.roughness ?? 0.95,
    metalness: opts.material?.metalness ?? 0,
    flatShading: opts.material?.flatShading ?? false,
  });

  const hasOcean = opts.ocean !== false;
  // ONE patch for both — a material has a single onBeforeCompile slot, so these
  // cannot be two calls (see terrain-shading.ts).
  applyTerrainShading(material, {
    water: hasOcean ? (opts.water ?? {}) : false,
    grass: opts.grass ?? {},
    sand: opts.sand ?? {},
    rock: opts.rock ?? {},
    terminator: opts.terminator,
  });

  const meshes = new Map<number, THREE.Mesh>();
  const lod = createPlanetLod(surface, {
    addChunk(id, geo: ChunkGeometryData) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(geo.positions, 3));
      geometry.setAttribute("color", new THREE.BufferAttribute(geo.colors, 3));
      geometry.setAttribute("normal", new THREE.BufferAttribute(geo.normals, 3));
      geometry.setAttribute("water", new THREE.BufferAttribute(geo.water, 1));
      geometry.setAttribute("flow", new THREE.BufferAttribute(geo.flow, 2));
      geometry.setAttribute("terrain", new THREE.BufferAttribute(geo.terrain, 3));
      geometry.setAttribute("regime", new THREE.BufferAttribute(geo.regime, 3));
      geometry.setAttribute("detailUv", new THREE.BufferAttribute(geo.detailUv, 2));
      geometry.setAttribute("detailW", new THREE.BufferAttribute(geo.detailW, 1));
      geometry.setAttribute("triN", new THREE.BufferAttribute(geo.triN, 3));
      geometry.setIndex(new THREE.BufferAttribute(geo.indices, 1));
      const mesh = new THREE.Mesh(geometry, material);
      // Vertices are CENTER-RELATIVE (float32 planet-local at Earth radius
      // quantizes to ~0.5 m — random ground ripple); the mesh carries the
      // planet-local center, and the CPU composes (center − camera) in
      // doubles before anything hits float32.
      mesh.position.set(geo.center[0], geo.center[1], geo.center[2]);
      mesh.name = `chunk_${id}`;
      meshes.set(id, mesh);
      group.add(mesh);
    },
    setChunkVisible(id, visible) {
      const mesh = meshes.get(id);
      if (mesh) mesh.visible = visible;
    },
    removeChunk(id) {
      const mesh = meshes.get(id);
      if (!mesh) return;
      group.remove(mesh);
      mesh.geometry.dispose();
      meshes.delete(id);
    },
  }, { ...opts, seaClamp: hasOcean });

  // No separate ocean shell: on ocean worlds the terrain itself renders a flat
  // sea-level surface (seaClamp) depth-shaded by the palette's ocean colours,
  // so there's no coincident translucent sphere to z-fight the seabed (the old
  // "flickering waves" dart artifact across the disc). Water still SHADES as
  // water — a drifting sheen under standard shading, flat foam bands under
  // toon — on the sea vertices of this same mesh, via the material patch in
  // terrain-shading.ts. That is deliberately a patch and not a shell; don't
  // "fix" it back into one.

  return {
    group,
    lod,
    update(cameraLocal) {
      lod.update([cameraLocal.x, cameraLocal.y, cameraLocal.z]);
    },
    dispose() {
      lod.dispose();
      material.dispose();
    },
  };
}
