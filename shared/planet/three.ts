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

export interface PlanetObjectOpts extends PlanetLodOpts {
  /** Has an ocean. Default on: the terrain renders a flat, depth-shaded
   *  sea-level surface (no separate shell). Pass false for dry worlds (the
   *  terrain then dips into its basins as bare seabed). The color/opacity
   *  fields are legacy no-ops kept for call-site compatibility. */
  ocean?: false | { color?: number; opacity?: number };
  /** Terrain material overrides (vertexColors stays on). */
  material?: Partial<Pick<THREE.MeshStandardMaterialParameters, "roughness" | "metalness" | "flatShading">>;
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

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: opts.material?.roughness ?? 0.95,
    metalness: opts.material?.metalness ?? 0,
    flatShading: opts.material?.flatShading ?? false,
  });

  const hasOcean = opts.ocean !== false;
  const meshes = new Map<number, THREE.Mesh>();
  const lod = createPlanetLod(surface, {
    addChunk(id, geo: ChunkGeometryData) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(geo.positions, 3));
      geometry.setAttribute("color", new THREE.BufferAttribute(geo.colors, 3));
      geometry.setAttribute("normal", new THREE.BufferAttribute(geo.normals, 3));
      geometry.setIndex(new THREE.BufferAttribute(geo.indices, 1));
      const mesh = new THREE.Mesh(geometry, material);
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
  // "flickering waves" dart artifact across the disc).

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
