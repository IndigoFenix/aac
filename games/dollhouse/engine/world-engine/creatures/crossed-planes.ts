// Crossed-planes billboard geometry — extracted verbatim from seagull-dream's
// scatter.ts (the ONLY external dependency the creature builder had). Used by
// plant-lod.ts to bake far-LOD impostors of plants/trees.
//
// PURE THREE geometry, no other deps — kept local to the creatures module so the
// port stays self-contained.

import * as THREE from "three";

// 3 vertical planes at 0°/60°/120° around Y, each `width` wide and `height`
// tall, base buried `bury` metres below local origin (to mask LOD
// interpolation mismatches at the footprint). All-up normals so lighting
// stays consistent as the player walks around — perpendicular per-plane
// normals would flip the shading from "front-lit" to "edge-on" every 30°
// and look terrible.
export function makeCrossedPlanesGeometry(width: number, height: number, bury: number): THREE.BufferGeometry {
  const halfW = width / 2;
  const yBase = -bury;
  const yTop = height - bury;
  const positions: number[] = [];
  const uvs: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < 3; i++) {
    const angle = (Math.PI / 3) * i;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const baseIdx = i * 4;
    // 4 corners: BL, BR, TL, TR. Rotate (x, ·, 0) around Y by `angle`.
    const corners: ReadonlyArray<[number, number]> = [
      [-halfW, yBase], [halfW, yBase], [-halfW, yTop], [halfW, yTop],
    ];
    const cornerUVs: ReadonlyArray<[number, number]> = [
      [0, 0], [1, 0], [0, 1], [1, 1],
    ];
    for (let j = 0; j < 4; j++) {
      const [x, y] = corners[j];
      positions.push(x * c, y, x * s);
      uvs.push(cornerUVs[j][0], cornerUVs[j][1]);
      normals.push(0, 1, 0);
    }
    indices.push(baseIdx, baseIdx + 1, baseIdx + 2);
    indices.push(baseIdx + 1, baseIdx + 3, baseIdx + 2);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geom.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geom.setIndex(indices);
  return geom;
}
