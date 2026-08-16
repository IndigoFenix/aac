/**
 * One terrain patch — seagull-dream's chunk.ts, ported framework-free (the
 * client-as-display-engine rule: geometry is plain typed arrays; the THREE
 * adapters — three.ts, and the terrain-shading.ts / water-normals.ts /
 * land-textures.ts it pulls in — are the only files here that touch a
 * renderer).
 *
 * A sub-region (uMin..uMax) × (vMin..vMax) of one cube face, triangulated at
 * fixed resolution and projected onto the sphere with the surface's height
 * applied at each vertex.
 *
 * Includes "skirts": each perimeter vertex is duplicated and pushed radially
 * inward by `skirtDepth`, with the inner ring connected to the outer ring as
 * vertical walls — hiding the cracks where neighbouring chunks render at
 * different LOD levels. Normals are computed from MAIN-GRID triangles only,
 * and skirt vertices copy their perimeter vertex's normal, so walls shade
 * like an extension of the surface instead of a cliff (averaging in the
 * skirt walls would tilt perimeter normals and draw dark seam bands).
 *
 * PRECISION: vertex positions are CENTER-RELATIVE — planet-local minus
 * `center` (returned) — and the render adapter places each chunk mesh AT its
 * center. Planet-local float32 at an Earth radius (6.4e6 m) quantizes to
 * ~0.5 m, which rippled every fine chunk's surface at random against roads
 * and building bases; center-relative residuals are chunk-sized, so they
 * keep full float32 precision, and the model-view translation (center −
 * camera) is composed on the CPU in doubles.
 *
 * DETAIL COORD: `detailUv` carries the same precision problem and the same
 * shape of answer. Surface detail needs a coordinate that is CONTINUOUS ACROSS
 * CHUNKS (a per-chunk 0..1 parameterization would seam at every LOD boundary,
 * where the skirts are already fighting cracks), but an absolute metre
 * coordinate at planet scale is exactly the 0.5 m-quantized number the note
 * above forbids. So it is computed in doubles and then reduced by a WHOLE
 * MULTIPLE of DETAIL_TILE_M per chunk: every detail texture repeats with that
 * period, so the subtraction cannot be seen, neighbours agree, and float32 only
 * ever holds a chunk-sized residual.
 */
import type { MaterialRegime, MaterialWeights, PlanetSurface, Vec3 } from "./surface";

/** The wrap period of `detailUv`, in metres — the ONE number every surface
 *  detail pattern is pinned to.
 *
 *  A detail texture is seamless across chunks iff its own tile size DIVIDES
 *  this evenly, because that is the only way the per-chunk offset lands on a
 *  whole number of its repeats. 64 m is chosen to be divisible: it gives water
 *  64 and grass 8/32 with room left for sand and rock. A tile of, say, 10 m
 *  would look fine in isolation and seam at every chunk border.
 *
 *  Paired with BASE_FREQ in water-normals.ts: longest wave ≈ DETAIL_TILE_M /
 *  BASE_FREQ metres. The frequency has to stay high so wave directions have
 *  somewhere to land on the integer lattice (see the note there), so the tile
 *  is scaled up to keep that longest wave at a plausible ~16 m. Moving one
 *  without the other silently resizes every wave. */
export const DETAIL_TILE_M = 64;

/** The 6 cube-face frames, right-handed (u × v = outward normal) so main
 *  triangles wind CCW seen from outside the planet. */
export const PLANET_FACES: ReadonlyArray<{ n: Vec3; u: Vec3; v: Vec3 }> = [
  { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
];

export interface ChunkParams {
  face: number; // index into PLANET_FACES
  uMin: number; uMax: number;
  vMin: number; vMax: number;
  /** Vertices per side of the main grid. */
  resolution: number;
  surface: PlanetSurface;
  /** How far below the surface to drop the skirt's bottom ring. */
  skirtDepth: number;
  /** Ocean worlds: clamp the rendered surface UP to sea level (a flat water
   *  surface) instead of dipping into basins. Color still uses the real
   *  (negative) height, so water is depth-shaded — and there's no separate
   *  translucent sphere to z-fight the seabed. */
  seaClamp?: boolean;
}

export interface ChunkGeometryData {
  /** CENTER-RELATIVE vertex positions (planet-local minus `center`) — the
   *  render adapter must place the chunk mesh AT `center`. See the PRECISION
   *  note in the module doc. */
  positions: Float32Array;
  colors: Float32Array;
  normals: Float32Array;
  /** 0..1 water at this vertex: 1 on sea (clamped up to sea level) and inside
   *  a river channel, 0 everywhere else. A SHADING flag, not geometry — the
   *  vertex already sits at its own water surface (rivers.ts folds bed + water
   *  into `surface.heightAt`; the sea is `seaClamp`). Lets the render adapter
   *  shade both without a second mesh — see three.ts. */
  water: Float32Array;
  /** CURRENT direction per vertex (2 per vertex), in the same detail-UV metres
   *  `detailUv` is in — the shader scrolls the wave field along it. Currently
   *  ALL-ZERO (the ocean has no current; zero = "still, use the ocean's own
   *  drift"). Kept because the shader's clamped flow path is the seam the
   *  river ribbon material will feed. */
  flow: Float32Array;
  /** Ground-material mix per vertex (3 per vertex: sand, grass, rock), from
   *  `surface.materialAt`. All-zero on surfaces that don't implement it, which
   *  reads as the plain vertex colour. Lets one terrain material draw a
   *  different detail texture per material without splitting the mesh. */
  terrain: Float32Array;
  /** Per-material SHAPE per vertex (3 per vertex), index-aligned with `terrain`
   *  — from `surface.regimeAt`. Only the sand slot is live (grain: fine→coarse).
   *  All-zero on surfaces that don't implement it, which reads as every material
   *  at its 0 end. */
  regime: Float32Array;
  /** Surface coordinate in METRES, for tiling detail textures (water waves,
   *  grass, sand, rock).
   *
   *  TILE-WRAPPED (see DETAIL COORD in the module doc): computed in doubles
   *  from the cube-face parameters, then offset by a per-chunk whole number of
   *  DETAIL_TILE_M. The offset is invisible because every detail texture repeats
   *  with a period that divides it, so chunks match across LOD depths — while
   *  the stored float32 stays chunk-sized and keeps its precision. */
  detailUv: Float32Array;
  /** Elevation above sea level in METRES, per vertex — `detailUv`'s third axis.
   *
   *  NOT wrapped, unlike detailUv, and it doesn't need to be: elevation is
   *  bounded by the planet's relief (tens of km, not millions), so float32 holds
   *  it to sub-millimetre. It is therefore free to be an ABSOLUTE coordinate,
   *  which is what strata need — layers are surfaces of constant elevation, and
   *  a wrapped w would step them at every chunk. */
  detailW: Float32Array;
  /** The vertex normal expressed in the (uHat, vHat, radial) frame — the three
   *  axes of (detailUv.x, detailUv.y, detailW).
   *
   *  This is what triplanar projection weights read: |n·radial| says how much of
   *  the flat-ground projection to use, and the tangential components say which
   *  wall projection. It has to be computed HERE because the fragment shader
   *  can't get it: the screen-space TBN built from detailUv derivatives
   *  degenerates on exactly the near-vertical faces where rock lives, which is
   *  the whole reason rock needs triplanar in the first place. */
  triN: Float32Array;
  indices: Uint32Array;
  /** Planet-local position of the chunk's approximate center (LOD checks +
   *  the mesh's transform). */
  center: Vec3;
  /** Half-diagonal in planet-local space — the LOD test's numerator. */
  size: number;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export function buildChunkGeometry(params: ChunkParams): ChunkGeometryData {
  const N = params.resolution;
  const F = PLANET_FACES[params.face];
  const { surface } = params;
  const radius = surface.radius;
  const mainVertCount = N * N;
  const perimVertCount = 4 * (N - 1);
  const totalVertCount = mainVertCount + perimVertCount;

  // Absolute planet-local positions in DOUBLES; the exported Float32Array is
  // written center-relative at the end (see the PRECISION module note).
  const abs = new Float64Array(totalVertCount * 3);
  const positions = new Float32Array(totalVertCount * 3);
  const colors = new Float32Array(totalVertCount * 3);
  const normals = new Float32Array(totalVertCount * 3);
  const water = new Float32Array(totalVertCount);
  const flow = new Float32Array(totalVertCount * 2);
  const terrain = new Float32Array(totalVertCount * 3);
  const regime = new Float32Array(totalVertCount * 3);
  const detailUv = new Float32Array(totalVertCount * 2);
  const detailW = new Float32Array(totalVertCount);
  const triN = new Float32Array(totalVertCount * 3);
  const indices: number[] = [];

  // Detail-coord origin: the chunk's own (u,v) corner in metres, snapped DOWN
  // to a whole tile. Doubles throughout — the snap is what keeps the float32
  // residual small, so it has to happen before anything is stored. See the
  // DETAIL COORD module note.
  const detailOriginS = Math.floor((params.uMin * radius) / DETAIL_TILE_M) * DETAIL_TILE_M;
  const detailOriginT = Math.floor((params.vMin * radius) / DETAIL_TILE_M) * DETAIL_TILE_M;

  // This chunk's vertex spacing in surface metres (gnomonic stretch ≤ √3 —
  // near enough for a coverage estimate). The river/road paint FADES bands
  // narrower than this by coverage — true width at every LOD, never widened.
  const vertSpanM = (Math.max(params.uMax - params.uMin, params.vMax - params.vMin) / (N - 1)) * radius;

  const dir: [number, number, number] = [0, 0, 0];
  const rgb: [number, number, number] = [0, 0, 0];
  const mat: MaterialWeights = [0, 0, 0];
  const reg: MaterialRegime = [0, 0, 0];
  const flowT: [number, number, number] = [0, 0, 0];

  let cx = 0;
  let cy = 0;
  let cz = 0;

  // ── Main grid ────────────────────────────────────────────────────────────
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const uu = lerp(params.uMin, params.uMax, i / (N - 1));
      const vv = lerp(params.vMin, params.vMax, j / (N - 1));
      let dx = F.n[0] + F.u[0] * uu + F.v[0] * vv;
      let dy = F.n[1] + F.u[1] * uu + F.v[1] * vv;
      let dz = F.n[2] + F.u[2] * uu + F.v[2] * vv;
      const m = Math.hypot(dx, dy, dz);
      dx /= m; dy /= m; dz /= m;
      dir[0] = dx; dir[1] = dy; dir[2] = dz;
      const h = surface.heightAt(dir);
      // OCEAN renders as a flat sea-level surface (clamp up); color still uses
      // the real height below, so oceans are depth-shaded without a z-fighting
      // shell.
      const isOcean = !!params.seaClamp && h < 0;
      surface.colorAt(h, dir, rgb);
      // RIVERS: paint + the wetness/current signal, one relief lookup. Both are
      // the channel's TRUE width — a band narrower than this chunk's vertex
      // spacing FADES by coverage instead of widening (width glyphs washed
      // whole regions blue from orbit). (Cell-field wetness was tried and pulled: a
      // substrate cell is ~15 km at the flight tier, and marking riverine
      // CELLS wet turned every watercourse into a region-sized sheet of
      // animated "sea" with trees standing in it. The relief index knows the
      // channel as a curve, so this water is a river-shaped band.) The
      // downstream direction feeds the water shader's clamped current path
      // (terrain-shading.ts), so the flow logic is VISIBLE: the wave pattern
      // drifts the way the solver routed the water.
      //
      // THE DEPTH IS NOT A LIFT. `heightAt` already placed this vertex at the
      // river's water surface (rivers.ts attachRiverRelief folds bed + water
      // into the one datum every ground consumer reads). Adding it to `r` here
      // as well is a DOUBLE LIFT, and it was: the mesh drew river vertices up
      // to 58 m above the walk chart on a planet whose entire relief budget is
      // 25 m. Read it for `isRiver` and the flow frame, never for radius.
      let riverDepth = 0;
      flowT[0] = 0; flowT[1] = 0; flowT[2] = 0;
      if (!isOcean) {
        if (surface.riverSampleAt) {
          riverDepth = surface.riverSampleAt(dir, vertSpanM, rgb, flowT);
        } else if (surface.riverTintAt) {
          surface.riverTintAt(dir, vertSpanM, rgb);
        }
        // Roads paint AFTER rivers so a lane crossing a channel reads as the
        // crossing (the bridge's colour claim); same true-width + fade law.
        if (surface.roadTintAt) surface.roadTintAt(dir, vertSpanM, rgb);
      }
      const isRiver = riverDepth > 0.05; // ankle-deep floor keeps damp banks dry
      const wet = isOcean || isRiver ? 1 : 0;
      // ONE DATUM: the drawn radius is the walk datum, full stop. Ocean is the
      // single exception and an explicit one (seaClamp draws a flat sea over
      // the basin the datum still reports); land — river beds and river water
      // included — draws at exactly `surface.heightAt`.
      const r = radius + (isOcean ? 0 : h);
      const idx = (j * N + i) * 3;
      abs[idx + 0] = dx * r;
      abs[idx + 1] = dy * r;
      abs[idx + 2] = dz * r;
      colors[idx + 0] = rgb[0];
      colors[idx + 1] = rgb[1];
      colors[idx + 2] = rgb[2];
      water[j * N + i] = wet;
      if (isRiver) {
        // The flow attribute is 2D in detailUv's own axes (the face's u/v
        // projected into the tangent plane at this vertex — the same frame the
        // triplanar pass derives). Unit length: the shader scales by speed.
        const du = F.u[0] * dx + F.u[1] * dy + F.u[2] * dz;
        let ux = F.u[0] - dx * du, uy = F.u[1] - dy * du, uz = F.u[2] - dz * du;
        const ul = Math.hypot(ux, uy, uz) || 1;
        ux /= ul; uy /= ul; uz /= ul;
        const dv = F.v[0] * dx + F.v[1] * dy + F.v[2] * dz;
        let vx = F.v[0] - dx * dv, vy = F.v[1] - dy * dv, vz = F.v[2] - dz * dv;
        const vl = Math.hypot(vx, vy, vz) || 1;
        vx /= vl; vy /= vl; vz /= vl;
        const fu = flowT[0] * ux + flowT[1] * uy + flowT[2] * uz;
        const fv = flowT[0] * vx + flowT[1] * vy + flowT[2] * vz;
        const fl = Math.hypot(fu, fv);
        if (fl > 1e-9) {
          flow[(j * N + i) * 2] = fu / fl;
          flow[(j * N + i) * 2 + 1] = fv / fl;
        }
      }
      if (surface.materialAt) {
        surface.materialAt(h, dir, mat);
        terrain[idx + 0] = mat[0];
        terrain[idx + 1] = mat[1];
        terrain[idx + 2] = mat[2];
      }
      if (surface.regimeAt) {
        surface.regimeAt(h, dir, reg);
        regime[idx + 0] = reg[0];
        regime[idx + 1] = reg[1];
        regime[idx + 2] = reg[2];
      }
      // Cube-face (u,v) scaled to metres — near enough to arc length for a
      // detail pattern, and continuous across chunks within a face. Only the
      // 6 face boundaries seam, and those are fixed lines on open ocean.
      //
      // The gnomonic projection stretches this up to √3 toward a face corner,
      // so detail is up to ~73% coarser there than at a face centre. Invisible
      // for a pattern with no true scale (nobody knows how big a grass clump
      // "should" be), and the price of a coordinate that costs no extra
      // sampling — but it is why this must not carry anything measured.
      const wOff = (j * N + i) * 2;
      detailUv[wOff + 0] = uu * radius - detailOriginS;
      detailUv[wOff + 1] = vv * radius - detailOriginT;
      // The rendered elevation, so strata band the surface you can actually see:
      // a sea-clamped vertex sits AT sea level whatever the seabed below says.
      // `isOcean`, not `wet`: a river is water but is not SEA — it runs at
      // whatever altitude its valley sits at (`h` is already that altitude),
      // so its strata band there and not at the sea line.
      detailW[j * N + i] = isOcean ? 0 : h;
      cx += abs[idx + 0];
      cy += abs[idx + 1];
      cz += abs[idx + 2];
    }
  }

  const center: Vec3 = [cx / mainVertCount, cy / mainVertCount, cz / mainVertCount];

  // Rough size: distance from center to corner.
  const cornerOff = ((N - 1) * N + (N - 1)) * 3;
  const size = Math.hypot(
    abs[cornerOff + 0] - center[0],
    abs[cornerOff + 1] - center[1],
    abs[cornerOff + 2] - center[2],
  );

  for (let j = 0; j < N - 1; j++) {
    for (let i = 0; i < N - 1; i++) {
      const a = j * N + i;
      const b = j * N + i + 1;
      const c = (j + 1) * N + i;
      const d = (j + 1) * N + i + 1;
      // CCW winding from outside (u × v = +faceNormal).
      indices.push(a, b, c, b, d, c);
    }
  }
  const mainIndexCount = indices.length;

  // ── Normals from main-grid triangles only ────────────────────────────────
  // Edge differences in DOUBLES (abs) — translation-invariant, so they equal
  // the center-relative edges without the float32 rounding.
  for (let t = 0; t < mainIndexCount; t += 3) {
    const i0 = indices[t] * 3;
    const i1 = indices[t + 1] * 3;
    const i2 = indices[t + 2] * 3;
    const e1x = abs[i1] - abs[i0];
    const e1y = abs[i1 + 1] - abs[i0 + 1];
    const e1z = abs[i1 + 2] - abs[i0 + 2];
    const e2x = abs[i2] - abs[i0];
    const e2y = abs[i2 + 1] - abs[i0 + 1];
    const e2z = abs[i2 + 2] - abs[i0 + 2];
    // Un-normalized cross — magnitude = 2 × area (area-weighted accumulate).
    const fx = e1y * e2z - e1z * e2y;
    const fy = e1z * e2x - e1x * e2z;
    const fz = e1x * e2y - e1y * e2x;
    normals[i0] += fx; normals[i0 + 1] += fy; normals[i0 + 2] += fz;
    normals[i1] += fx; normals[i1 + 1] += fy; normals[i1 + 2] += fz;
    normals[i2] += fx; normals[i2 + 1] += fy; normals[i2 + 2] += fz;
  }
  for (let v = 0; v < mainVertCount; v++) {
    const o = v * 3;
    const len = Math.hypot(normals[o], normals[o + 1], normals[o + 2]) || 1;
    normals[o] /= len;
    normals[o + 1] /= len;
    normals[o + 2] /= len;
  }

  // ── Triplanar frame ──────────────────────────────────────────────────────
  // The normal in the (uHat, vHat, radial) frame — the axes detailUv/detailW
  // measure along. Must run AFTER the normals are finalized above.
  //
  // uHat is the direction detailUv.x actually increases in: the face's u axis
  // with its radial part removed. (The sphere projection is what makes that
  // necessary — the raw cube-face axis tilts away from the tangent plane
  // everywhere except the face centre, and using it directly would skew the
  // triplanar weights worst at the face corners.) uHat and vHat are not exactly
  // perpendicular to each other under the gnomonic stretch; that costs a few
  // degrees in the blend weights and nothing visible.
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const v = j * N + i;
      const o = v * 3;
      const px = abs[o];
      const py = abs[o + 1];
      const pz = abs[o + 2];
      const pl = Math.hypot(px, py, pz) || 1;
      const rx = px / pl;
      const ry = py / pl;
      const rz = pz / pl;
      const du = F.u[0] * rx + F.u[1] * ry + F.u[2] * rz;
      let ux = F.u[0] - rx * du;
      let uy = F.u[1] - ry * du;
      let uz = F.u[2] - rz * du;
      const ul = Math.hypot(ux, uy, uz) || 1;
      ux /= ul; uy /= ul; uz /= ul;
      const dv = F.v[0] * rx + F.v[1] * ry + F.v[2] * rz;
      let vx = F.v[0] - rx * dv;
      let vy = F.v[1] - ry * dv;
      let vz = F.v[2] - rz * dv;
      const vl = Math.hypot(vx, vy, vz) || 1;
      vx /= vl; vy /= vl; vz /= vl;
      const nx = normals[o];
      const ny = normals[o + 1];
      const nz = normals[o + 2];
      triN[o + 0] = nx * ux + ny * uy + nz * uz;
      triN[o + 1] = nx * vx + ny * vy + nz * vz;
      triN[o + 2] = nx * rx + ny * ry + nz * rz;
    }
  }

  // ── Skirt ────────────────────────────────────────────────────────────────
  // Perimeter of the main grid in CCW order (viewed from outside), each
  // vertex duplicated and dropped radially inward by skirtDepth.
  const perim: number[] = [];
  for (let i = 0; i < N - 1; i++) perim.push(0 * N + i);
  for (let j = 0; j < N - 1; j++) perim.push(j * N + (N - 1));
  for (let i = N - 1; i > 0; i--) perim.push((N - 1) * N + i);
  for (let j = N - 1; j > 0; j--) perim.push(j * N + 0);

  for (let k = 0; k < perim.length; k++) {
    const mOff = perim[k] * 3;
    const sOff = (mainVertCount + k) * 3;
    const px = abs[mOff];
    const py = abs[mOff + 1];
    const pz = abs[mOff + 2];
    const r = Math.hypot(px, py, pz);
    const scale = (r - params.skirtDepth) / r;
    // OUTWARD LEAN (T-junction hairline): a perfectly vertical wall meets the
    // neighbour's near-coincident edge in the same pixel column, so a
    // sub-centimetre LOD crack still rasterizes as a 1-px see-through line at
    // grazing angles. Leaning the BOTTOM ring away from the chunk center
    // tucks the wall UNDER the neighbour's edge — the crack is backed by
    // wall from every direction. The TOP ring stays exactly on the perimeter,
    // so the lean only ever spreads below the surface, never through it.
    const cOff = perim[k] * 3; // tangential outward = vert − chunk center, radial part removed
    let ox = abs[cOff] - center[0];
    let oy = abs[cOff + 1] - center[1];
    let oz = abs[cOff + 2] - center[2];
    const radial = (ox * px + oy * py + oz * pz) / (r * r);
    ox -= px * radial;
    oy -= py * radial;
    oz -= pz * radial;
    const ol = Math.hypot(ox, oy, oz) || 1;
    const lean = params.skirtDepth * 0.35;
    abs[sOff] = px * scale + (ox / ol) * lean;
    abs[sOff + 1] = py * scale + (oy / ol) * lean;
    abs[sOff + 2] = pz * scale + (oz / ol) * lean;
    colors[sOff] = colors[mOff];
    colors[sOff + 1] = colors[mOff + 1];
    colors[sOff + 2] = colors[mOff + 2];
    normals[sOff] = normals[mOff];
    normals[sOff + 1] = normals[mOff + 1];
    normals[sOff + 2] = normals[mOff + 2];
    water[mainVertCount + k] = water[perim[k]];
    flow[(mainVertCount + k) * 2] = flow[perim[k] * 2];
    flow[(mainVertCount + k) * 2 + 1] = flow[perim[k] * 2 + 1];
    terrain[sOff] = terrain[mOff];
    terrain[sOff + 1] = terrain[mOff + 1];
    terrain[sOff + 2] = terrain[mOff + 2];
    regime[sOff] = regime[mOff];
    regime[sOff + 1] = regime[mOff + 1];
    regime[sOff + 2] = regime[mOff + 2];
    detailUv[(mainVertCount + k) * 2] = detailUv[perim[k] * 2];
    detailUv[(mainVertCount + k) * 2 + 1] = detailUv[perim[k] * 2 + 1];
    detailW[mainVertCount + k] = detailW[perim[k]];
    triN[sOff] = triN[mOff];
    triN[sOff + 1] = triN[mOff + 1];
    triN[sOff + 2] = triN[mOff + 2];
  }

  for (let k = 0; k < perim.length; k++) {
    const k1 = (k + 1) % perim.length;
    indices.push(perim[k], perim[k1], mainVertCount + k, perim[k1], mainVertCount + k1, mainVertCount + k);
  }

  // CENTER-RELATIVE export: subtract in doubles, round once into float32 —
  // residuals are chunk-sized, so metre-scale terrain keeps sub-mm precision.
  for (let v = 0; v < totalVertCount; v++) {
    const o = v * 3;
    positions[o] = abs[o] - center[0];
    positions[o + 1] = abs[o + 1] - center[1];
    positions[o + 2] = abs[o + 2] - center[2];
  }

  return {
    positions, colors, normals, water, flow, terrain, regime, detailUv, detailW, triN,
    indices: Uint32Array.from(indices),
    center, size,
  };
}
