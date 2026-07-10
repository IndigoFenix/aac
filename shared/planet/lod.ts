/**
 * Planet quadtree LOD — seagull-dream's celestial-body node machinery,
 * ported framework-free. Six face roots subdivide toward the camera by the
 * screen-ratio test (chunkSize / cameraDistance), with a merge/subdivide
 * hysteresis gap that kills LOD thrash when the camera hovers on a
 * boundary. The HOST owns mesh lifecycle (the world-host injected-display
 * pattern): this module only says which chunks exist and which are visible.
 *
 * Rules ported intact:
 *   - a subdivided node keeps its own chunk, hidden (cheap re-show on merge);
 *   - merging disposes the whole child subtree;
 *   - subdivision only deepens under the camera, so live chunk count stays
 *     bounded (~tens) at any depth.
 */
import type { PlanetSurface, Vec3 } from "./surface";
import { buildChunkGeometry, type ChunkGeometryData } from "./chunk";

export interface PlanetLodOpts {
  /** Vertices per side per chunk (default 33 — seagull's CHUNKS). */
  resolution?: number;
  /** Max subdivision depth per face (default 18: metre-scale on an
   *  Earth-radius body). */
  maxDepth?: number;
  /** Subdivide a leaf when size/distance exceeds this (default 1.2). */
  lodThreshold?: number;
  /** Merge a subdivided node when the ratio drops below this (default 0.8 —
   *  the gap is the anti-thrash dead zone). */
  lodMergeThreshold?: number;
  /** Skirt drop in render units (default radius/120_000 ≈ seagull's 50 m
   *  on Earth scale, floored at a sliver). */
  skirtDepth?: number;
  /** Ocean world: clamp the rendered surface up to sea level (flat water). */
  seaClamp?: boolean;
}

export interface PlanetLodHost {
  /** A chunk now exists — build its mesh (initially visible). */
  addChunk(id: number, geo: ChunkGeometryData): void;
  setChunkVisible(id: number, visible: boolean): void;
  /** The chunk is gone — dispose its mesh. */
  removeChunk(id: number): void;
}

interface Node {
  id: number;
  face: number;
  uMin: number; uMax: number;
  vMin: number; vMax: number;
  depth: number;
  center: Vec3;
  size: number;
  visible: boolean;
  children: Node[] | null;
}

export interface PlanetLod {
  /** Re-evaluate the tree for a PLANET-LOCAL camera position. */
  update(cameraLocal: Vec3): void;
  /** Live chunk count (built meshes, visible or hidden). */
  chunkCount(): number;
  /** Visible chunk ids (for hosts/tests that audit coverage). */
  visibleIds(): number[];
  dispose(): void;
}

export function createPlanetLod(surface: PlanetSurface, host: PlanetLodHost, opts: PlanetLodOpts = {}): PlanetLod {
  const resolution = opts.resolution ?? 33;
  const maxDepth = opts.maxDepth ?? 18;
  const lodThreshold = opts.lodThreshold ?? 1.2;
  const lodMergeThreshold = opts.lodMergeThreshold ?? 0.8;
  const skirtDepth = opts.skirtDepth ?? Math.max(surface.radius / 120_000, surface.radius * 1e-6);
  const seaClamp = opts.seaClamp ?? false;

  let nextId = 1;
  let live = 0;

  const makeNode = (face: number, uMin: number, uMax: number, vMin: number, vMax: number, depth: number): Node => {
    const geo = buildChunkGeometry({ face, uMin, uMax, vMin, vMax, resolution, surface, skirtDepth, seaClamp });
    const node: Node = {
      id: nextId++,
      face, uMin, uMax, vMin, vMax, depth,
      center: geo.center,
      size: geo.size,
      visible: true,
      children: null,
    };
    host.addChunk(node.id, geo);
    live++;
    return node;
  };

  const disposeNode = (node: Node): void => {
    host.removeChunk(node.id);
    live--;
    if (node.children) {
      for (const c of node.children) disposeNode(c);
      node.children = null;
    }
  };

  const setVisible = (node: Node, visible: boolean): void => {
    if (node.visible === visible) return;
    node.visible = visible;
    host.setChunkVisible(node.id, visible);
  };

  const subdivide = (node: Node): void => {
    const uMid = (node.uMin + node.uMax) / 2;
    const vMid = (node.vMin + node.vMax) / 2;
    node.children = [
      makeNode(node.face, node.uMin, uMid, node.vMin, vMid, node.depth + 1),
      makeNode(node.face, uMid, node.uMax, node.vMin, vMid, node.depth + 1),
      makeNode(node.face, node.uMin, uMid, vMid, node.vMax, node.depth + 1),
      makeNode(node.face, uMid, node.uMax, vMid, node.vMax, node.depth + 1),
    ];
  };

  const updateNode = (node: Node, cam: Vec3): void => {
    const dist = Math.hypot(cam[0] - node.center[0], cam[1] - node.center[1], cam[2] - node.center[2]);
    const ratio = node.size / dist;
    const canSubdivide = node.depth < maxDepth;
    const shouldSubdivide = canSubdivide && (
      node.children ? ratio > lodMergeThreshold : ratio > lodThreshold
    );
    if (shouldSubdivide) {
      if (!node.children) subdivide(node);
      setVisible(node, false);
      for (const c of node.children!) updateNode(c, cam);
    } else {
      setVisible(node, true);
      if (node.children) {
        for (const c of node.children) disposeNode(c);
        node.children = null;
      }
    }
  };

  const roots: Node[] = [];
  for (let f = 0; f < 6; f++) roots.push(makeNode(f, -1, 1, -1, 1, 0));

  const collectVisible = (node: Node, out: number[]): void => {
    if (node.visible) out.push(node.id);
    if (node.children) for (const c of node.children) collectVisible(c, out);
  };

  return {
    update(cameraLocal) {
      for (const r of roots) updateNode(r, cameraLocal);
    },
    chunkCount: () => live,
    visibleIds() {
      const out: number[] = [];
      for (const r of roots) collectVisible(r, out);
      return out;
    },
    dispose() {
      for (const r of roots) disposeNode(r);
      roots.length = 0;
    },
  };
}
