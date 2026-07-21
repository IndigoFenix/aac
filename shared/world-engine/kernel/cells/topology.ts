// Cell Systems — grid topology (the lattice seam).
//
// Everything the grid engine knows about SHAPE lives behind GridTopology:
// adjacency, off-map sides, radius-r neighbourhoods, center distances. The
// engine's dynamics (transport, flow accumulation, sensors, scheduler) are
// topology-blind — they see cell indices and neighbour lists only. That is
// what makes the lattice a WORLD-LEVEL CHOICE for the game maker:
//
//   - flat cols×rows (bounded or torus)   — regional-scope worlds, SHIPPED
//   - cube-sphere (6 quad faces, N×N)     — planetary worlds, PLANNED
//   - icosahedral hex (10 rhombi, 12 pentagons) — planetary worlds, PLANNED
//
// BOTH sphere lattices are wanted (decided 2026-07: a game picks) — quads
// for octree/voxel digging and exact window-nesting, hexes for isotropic
// field dynamics (rivers, erosion, climate). `maxDegree` exists so scratch
// buffers size to the lattice (4 flat/cube, 6 hex — pentagons ride under it).
//
// Reserved for the curved lattices, deliberately NOT in the contract yet:
// per-cell areas and per-edge weights — the finite-volume upgrade that
// makes transport metric-honest on distorted cells. Flat grids are
// unit-metric, so the engine treats every cell and edge as 1; when the
// first curved topology lands, transport gains the weighting and flat
// worlds stay bit-identical (all weights 1).

export interface GridTopology {
  /** Total cell count. */
  readonly n: number;
  /** Largest neighbour count any cell can have — sizes scratch buffers. */
  readonly maxDegree: number;
  /** Edge-adjacent neighbours of cell `i` into `out`; returns the count. */
  neighbours(i: number, out: number[]): number;
  /** Sides of cell `i` open to off-map — the drainEdge outlet count.
   *  0 everywhere on closed surfaces (torus, sphere). */
  openSides(i: number): number;
  /** Visit the lattice-defined radius-`r` neighbourhood of cell `i`
   *  (center included), passing each cell and its center distance in cell
   *  units. Visit order is fixed and deterministic — aggregation sums must
   *  replay bit-identically. On the flat lattice this is the (2r+1)² box. */
  disk(i: number, r: number, visit: (cell: number, d: number) => void): void;
  /** Squared center distance between two cells, in cell units (wrap-aware
   *  on a torus; geodesic on spheres). */
  dist2(a: number, b: number): number;
  /** Curved lattices only: the cell center as a unit-sphere direction —
   *  the seam a planet renderer samples fields through. Flat grids omit it. */
  pos3?(i: number): readonly [number, number, number];
  /** Curved lattices only: the inverse of pos3 — the cell containing a
   *  direction (need not be normalized). cellAt(pos3(i)) === i. This is the
   *  gather primitive: sphere tectonics resamples plate-frame rasters with
   *  it, and a planet renderer looks fields up by surface direction. */
  cellAt?(dir: readonly [number, number, number]): number;
  /** Curved lattices only: the cell's BOUNDARY as unit-sphere directions,
   *  wound CCW seen from outside. The scatter counterpart of `cellAt`: it
   *  is what lets a renderer paint a per-cell FIELD as area rather than
   *  sampling it at a point (territory claims, plate ids, biome washes).
   *
   *  Corners are shared EXACTLY with the neighbouring cells that meet
   *  there — including across a face seam — so a whole-lattice paint tiles
   *  the sphere with no cracks and no double-covered slivers. */
  cellPolygon?(i: number): Array<readonly [number, number, number]>;
}

/** Serializable lattice descriptor — what a world document (and a saved
 *  grid) records; `makeTopology` rebuilds the lattice from it. The
 *  icosahedral-hex kind joins this union when it ships. */
export type TopologySpec =
  | { kind: "flat"; cols: number; rows: number; wrap?: boolean }
  | { kind: "cube-sphere"; faceN: number };

export function makeTopology(spec: TopologySpec): GridTopology {
  return spec.kind === "flat"
    ? makeFlatTopology(spec.cols, spec.rows, !!spec.wrap)
    : makeCubeSphereTopology(spec.faceN);
}

/** The flat cols×rows lattice (bounded, or toroidal when `wrap`) — a
 *  verbatim extraction of the grid engine's original topology. */
export function makeFlatTopology(cols: number, rows: number, wrap: boolean): GridTopology {
  return {
    n: cols * rows,
    maxDegree: 4,
    neighbours(i, out) {
      const x = i % cols, y = (i / cols) | 0;
      if (wrap) {
        out[0] = y * cols + (x === 0 ? cols - 1 : x - 1);
        out[1] = y * cols + (x === cols - 1 ? 0 : x + 1);
        out[2] = (y === 0 ? rows - 1 : y - 1) * cols + x;
        out[3] = (y === rows - 1 ? 0 : y + 1) * cols + x;
        return 4;
      }
      let k = 0;
      if (x > 0) out[k++] = i - 1;
      if (x < cols - 1) out[k++] = i + 1;
      if (y > 0) out[k++] = i - cols;
      if (y < rows - 1) out[k++] = i + cols;
      return k;
    },
    openSides(i) {
      if (wrap) return 0;
      const x = i % cols, y = (i / cols) | 0;
      return (x === 0 ? 1 : 0) + (x === cols - 1 ? 1 : 0) + (y === 0 ? 1 : 0) + (y === rows - 1 ? 1 : 0);
    },
    disk(i, r, visit) {
      const cx = i % cols, cy = (i / cols) | 0;
      for (let dy = -r; dy <= r; dy++) {
        let yy = cy + dy;
        if (wrap) yy = ((yy % rows) + rows) % rows;
        else if (yy < 0 || yy >= rows) continue;
        for (let dx = -r; dx <= r; dx++) {
          let xx = cx + dx;
          if (wrap) xx = ((xx % cols) + cols) % cols;
          else if (xx < 0 || xx >= cols) continue;
          visit(yy * cols + xx, Math.hypot(dx, dy));
        }
      }
    },
    dist2(a, b) {
      let dx = Math.abs((a % cols) - (b % cols));
      let dy = Math.abs(((a / cols) | 0) - ((b / cols) | 0));
      if (wrap) {
        if (dx > cols / 2) dx = cols - dx;
        if (dy > rows / 2) dy = rows - dy;
      }
      return dx * dx + dy * dy;
    },
  };
}

// --- Cube-sphere ---------------------------------------------------------------

type V3 = readonly [number, number, number];

/** Face frames, all RIGHT-HANDED as seen from outside (u × v = outward
 *  normal) — this orientability is what makes cross-face frame carries in
 *  disk() pure rotations, never reflections. */
const CUBE_FACES: ReadonlyArray<{ n: V3; u: V3; v: V3 }> = [
  { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },   // +X
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },   // -X
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },   // +Y
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },   // -Y
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },    // +Z
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },  // -Z
];

function dot3(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * The cube-sphere lattice: 6 faces × N×N quad cells, a closed surface
 * (openSides = 0 everywhere — a sphere drains nowhere; its seas are wherever
 * water pools). Every cell has exactly 4 edge-neighbours; the 8 cube-corner
 * VERTICES are the only singularities (3 cells meet instead of 4), which
 * edge-based transport never notices and disk() handles by first-arrival.
 *
 * Adjacency is built by the GEOMETRIC FOLD: a step off a face projects the
 * out-of-bounds cell center onto the adjacent face (gnomonic), which lands
 * exactly in the edge-adjacent cell — no hand-written 24-entry seam table
 * to get wrong. Cell centers for pos3/dist2 use the EQUAL-ANGLE mapping
 * (tan(a·π/4)), pulling the raw gnomonic ~5× area spread down to ~1.3×.
 *
 * disk(i, r) walks the locally-UNFOLDED chart: BFS carrying (dx, dy) in the
 * start cell's frame plus the rotation picked up at each seam crossing, so
 * a radius-r "box" continues across faces exactly as if the cube were
 * unfolded flat at i. Around a corner vertex the chart overlaps itself (the
 * 90° wedge deficit); first arrival wins, deterministically (FIFO order,
 * fixed direction order) — a corner disk holds slightly fewer cells, which
 * is the true geometry: there IS less surface around a cube corner.
 */
export function makeCubeSphereTopology(faceN: number): GridTopology {
  const N = Math.max(1, Math.floor(faceN));
  const n = 6 * N * N;
  const cellOf = (f: number, ui: number, vi: number): number => (f * N + vi) * N + ui;
  const DU = [1, 0, -1, 0]; // slot order: +u, +v, -u, -v (CCW — matches the frames)
  const DV = [0, 1, 0, -1];

  // --- adjacency (nbTable[i*4 + slot], slots in the cell's own face frame) ---
  const nbTable = new Int32Array(n * 4);
  for (let f = 0; f < 6; f++) {
    const F = CUBE_FACES[f];
    for (let vi = 0; vi < N; vi++) {
      for (let ui = 0; ui < N; ui++) {
        const i = cellOf(f, ui, vi);
        for (let s = 0; s < 4; s++) {
          const u2 = ui + DU[s];
          const v2 = vi + DV[s];
          if (u2 >= 0 && u2 < N && v2 >= 0 && v2 < N) {
            nbTable[i * 4 + s] = cellOf(f, u2, v2);
            continue;
          }
          // The fold: project the out-of-bounds center onto the face it
          // actually belongs to. Exact for half-cell overhangs (the
          // projected point always bins to the edge-adjacent cell).
          const a = (2 * (u2 + 0.5)) / N - 1;
          const b = (2 * (v2 + 0.5)) / N - 1;
          const q: V3 = [
            F.n[0] + a * F.u[0] + b * F.v[0],
            F.n[1] + a * F.u[1] + b * F.v[1],
            F.n[2] + a * F.u[2] + b * F.v[2],
          ];
          let g = 0;
          let best = -Infinity;
          for (let ff = 0; ff < 6; ff++) {
            const d = dot3(q, CUBE_FACES[ff].n);
            if (d > best) { best = d; g = ff; }
          }
          const G = CUBE_FACES[g];
          const w = dot3(q, G.n);
          const ug = dot3(q, G.u) / w;
          const vg = dot3(q, G.v) / w;
          const ui2 = Math.min(N - 1, Math.max(0, Math.floor(((ug + 1) / 2) * N)));
          const vi2 = Math.min(N - 1, Math.max(0, Math.floor(((vg + 1) / 2) * N)));
          nbTable[i * 4 + s] = cellOf(g, ui2, vi2);
        }
      }
    }
  }

  // --- cell centers on the unit sphere (equal-angle mapping) ---
  const pos = new Float64Array(n * 3);
  for (let f = 0; f < 6; f++) {
    const F = CUBE_FACES[f];
    for (let vi = 0; vi < N; vi++) {
      for (let ui = 0; ui < N; ui++) {
        const ta = Math.tan(((2 * (ui + 0.5)) / N - 1) * (Math.PI / 4));
        const tb = Math.tan(((2 * (vi + 0.5)) / N - 1) * (Math.PI / 4));
        const x = F.n[0] + ta * F.u[0] + tb * F.v[0];
        const y = F.n[1] + ta * F.u[1] + tb * F.v[1];
        const z = F.n[2] + ta * F.u[2] + tb * F.v[2];
        const m = Math.hypot(x, y, z);
        const i = cellOf(f, ui, vi);
        pos[i * 3] = x / m;
        pos[i * 3 + 1] = y / m;
        pos[i * 3 + 2] = z / m;
      }
    }
  }
  const pitch = Math.PI / 2 / N; // one cell's angular size along a face equator

  return {
    n,
    maxDegree: 4,
    neighbours(i, out) {
      out[0] = nbTable[i * 4];
      out[1] = nbTable[i * 4 + 1];
      out[2] = nbTable[i * 4 + 2];
      out[3] = nbTable[i * 4 + 3];
      return 4;
    },
    openSides() {
      return 0; // closed surface — drainEdge never fires
    },
    disk(i, r, visit) {
      // BFS over the locally-unfolded chart. Entry: cell, (dx, dy) in the
      // START frame, rot = how many CCW slot-steps the current face's frame
      // is turned from the start frame.
      const seen = new Set<number>([i]);
      const qCell = [i];
      const qDx = [0];
      const qDy = [0];
      const qRot = [0];
      visit(i, 0);
      for (let head = 0; head < qCell.length; head++) {
        const c = qCell[head];
        const dx = qDx[head];
        const dy = qDy[head];
        const rot = qRot[head];
        for (let d = 0; d < 4; d++) {
          const ndx = dx + DU[d];
          const ndy = dy + DV[d];
          if (Math.abs(ndx) > r || Math.abs(ndy) > r) continue;
          const nc = nbTable[c * 4 + ((d + rot) & 3)];
          if (seen.has(nc)) continue;
          // The slot of nc pointing back at c fixes the new frame rotation
          // (orientable surface ⇒ the carry is a pure rotation).
          let sBack = 0;
          for (let s = 0; s < 4; s++) if (nbTable[nc * 4 + s] === c) { sBack = s; break; }
          seen.add(nc);
          visit(nc, Math.hypot(ndx, ndy));
          qCell.push(nc);
          qDx.push(ndx);
          qDy.push(ndy);
          qRot.push((sBack - d - 2) & 3);
        }
      }
    },
    dist2(a, b) {
      const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
      const bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2];
      const dp = Math.max(-1, Math.min(1, ax * bx + ay * by + az * bz));
      const cellsApart = Math.acos(dp) / pitch;
      return cellsApart * cellsApart;
    },
    pos3(i) {
      return [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]] as const;
    },
    cellAt(dir) {
      let f = 0;
      let best = -Infinity;
      for (let ff = 0; ff < 6; ff++) {
        const d = dot3(dir, CUBE_FACES[ff].n);
        if (d > best) { best = d; f = ff; }
      }
      const F = CUBE_FACES[f];
      const w = dot3(dir, F.n);
      // Invert the equal-angle mapping: chart coord a = atan(t)·4/π.
      const a = Math.atan(dot3(dir, F.u) / w) * (4 / Math.PI);
      const b = Math.atan(dot3(dir, F.v) / w) * (4 / Math.PI);
      const ui = Math.min(N - 1, Math.max(0, Math.floor(((a + 1) / 2) * N)));
      const vi = Math.min(N - 1, Math.max(0, Math.floor(((b + 1) / 2) * N)));
      return cellOf(f, ui, vi);
    },
    cellPolygon(i) {
      // The same equal-angle mapping `pos` uses, evaluated at the cell's
      // four INTEGER chart corners instead of its (+0.5, +0.5) center. A
      // corner's chart coordinate is shared exactly by every cell touching
      // it, and at a face seam (u or v = 0 or N) the tangent is ∓1 — the
      // cube edge itself — so the adjacent face lands on the identical
      // direction. That exactness is the no-crack guarantee.
      const f = (i / (N * N)) | 0;
      const rem = i - f * N * N;
      const vi = (rem / N) | 0;
      const ui = rem - vi * N;
      const F = CUBE_FACES[f];
      const corner = (u: number, v: number): readonly [number, number, number] => {
        const ta = Math.tan(((2 * u) / N - 1) * (Math.PI / 4));
        const tb = Math.tan(((2 * v) / N - 1) * (Math.PI / 4));
        const x = F.n[0] + ta * F.u[0] + tb * F.v[0];
        const y = F.n[1] + ta * F.u[1] + tb * F.v[1];
        const z = F.n[2] + ta * F.u[2] + tb * F.v[2];
        const m = Math.hypot(x, y, z);
        return [x / m, y / m, z / m] as const;
      };
      // CCW from outside: u × v is the outward normal on every face frame.
      return [
        corner(ui, vi),
        corner(ui + 1, vi),
        corner(ui + 1, vi + 1),
        corner(ui, vi + 1),
      ];
    },
  };
}
