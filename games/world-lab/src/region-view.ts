/**
 * 3D region viewer — the canvas substrate map (grand-dream's region
 * painter) as a heightfield: one vertex per cell, y from the height
 * field, per-vertex colors from the same reads the canvas view makes —
 * sea below the sea line, rivers where the flow accumulated, sand→green
 * by fertility, rock and snow up the mountains. A translucent water
 * plane sits at sea level so basins read as lakes and coasts as shelves.
 *
 * Pure view over the settled grid; render units are substrate tiles.
 */
import * as THREE from "three";
import type { CellGrid } from "@shared/engine/cells/index";

const SEA = 3;
const TREELINE = 40;
const SNOWLINE = 55;
const RIVER_MIN = 40; // flow accumulation that reads as a watercourse

export interface RegionView {
  group: THREE.Group;
  /** Orbit scale, tiles. */
  radius: number;
  /** World position of a cell's surface (markers stand here). */
  cellPos(cell: number): [number, number, number];
  dispose(): void;
}

export function createRegionView(grid: CellGrid, hScale = 0.12): RegionView {
  const { cols, rows } = grid;
  const height = grid.fields.height;
  const fertility = grid.fields.fertility;
  const river = grid.fields.river;
  const disposables: Array<{ dispose(): void }> = [];
  const group = new THREE.Group();
  group.name = "region";

  const xOf = (cx: number): number => cx - cols / 2 + 0.5;
  const zOf = (cy: number): number => cy - rows / 2 + 0.5;

  // ── Terrain heightfield: a vertex per cell ────────────────────────────────
  const positions = new Float32Array(cols * rows * 3);
  const colors = new Float32Array(cols * rows * 3);
  const set3 = (i: number, r: number, g: number, b: number): void => {
    colors[i * 3] = r; colors[i * 3 + 1] = g; colors[i * 3 + 2] = b;
  };
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const c = cy * cols + cx;
      const h = height[c];
      positions[c * 3] = xOf(cx);
      positions[c * 3 + 1] = h * hScale;
      positions[c * 3 + 2] = zOf(cy);
      if (h < SEA) {
        const t = Math.max(0, h / SEA);
        set3(c, 0.09 + 0.1 * t, 0.19 + 0.12 * t, 0.30 + 0.1 * t); // sea floor shelving up
      } else if (river && river[c] >= RIVER_MIN) {
        set3(c, 0.16, 0.34, 0.52); // a watercourse
      } else if (h >= SNOWLINE) {
        set3(c, 0.93, 0.94, 0.96);
      } else if (h >= TREELINE) {
        const t = (h - TREELINE) / (SNOWLINE - TREELINE);
        set3(c, 0.45 + 0.2 * t, 0.41 + 0.22 * t, 0.38 + 0.25 * t); // rock toward snow
      } else {
        const fert = fertility ? Math.min(1, fertility[c] / 8) : 0;
        set3(c, 0.78 - 0.5 * fert, 0.70 - 0.18 * fert, 0.52 - 0.27 * fert); // sand → green
      }
    }
  }
  const indices: number[] = [];
  for (let cy = 0; cy + 1 < rows; cy++) {
    for (let cx = 0; cx + 1 < cols; cx++) {
      const a = cy * cols + cx;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const terrainGeo = new THREE.BufferGeometry();
  terrainGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  terrainGeo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  terrainGeo.setIndex(indices);
  terrainGeo.computeVertexNormals();
  const terrainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  disposables.push(terrainGeo, terrainMat);
  group.add(new THREE.Mesh(terrainGeo, terrainMat));

  // ── Water plane at sea level ──────────────────────────────────────────────
  const waterGeo = new THREE.PlaneGeometry(cols, rows);
  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x1a4f7a, transparent: true, opacity: 0.82, roughness: 0.55, metalness: 0,
  });
  disposables.push(waterGeo, waterMat);
  const water = new THREE.Mesh(waterGeo, waterMat);
  water.rotation.x = -Math.PI / 2;
  water.position.y = SEA * hScale;
  group.add(water);

  return {
    group,
    radius: Math.max(cols, rows) / 2,
    cellPos(cell) {
      const cx = cell % cols;
      const cy = (cell / cols) | 0;
      return [xOf(cx), Math.max(height[cell], SEA) * hScale, zOf(cy)];
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
