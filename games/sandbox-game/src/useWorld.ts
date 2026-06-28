// Sandbox Game — React hook driving the entity/relationship WORLD (Step 3) on the
// map. Mirrors useSystemGrid: the EntityWorld lives in a ref, ticks with real-time
// idle catch-up, and persists per spec id.

import { useCallback, useEffect, useRef } from 'react';
import {
  createWorld, worldFastForward, serializeWorld, deserializeWorld, worldDefault,
  type EntityWorld,
} from './cell-systems';

const STEP_MS = 200;
const MAX_CATCHUP_STEPS = 20_000;
const SAVE_INTERVAL = 5000;

/** Deterministic per-index pseudo-random in [0,1). */
function frac(i: number, salt: number): number {
  const s = Math.sin((i + 1) * 12.9898 + salt * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/** Build the default world: a scattered set of cities, a near-neighbour road
 *  graph, a few producer cities, and one simmering border conflict. */
export function makeDefaultWorld(): EntityWorld {
  const n = 7;
  // Scatter positions deterministically in the unit square.
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) pts.push([0.12 + 0.76 * frac(i, 1), 0.12 + 0.76 * frac(i, 2)]);
  // Connect each city to its 2 nearest neighbours (dedup) → a sparse road graph.
  const edgeSet = new Set<string>();
  const edges: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const order = [...Array(n).keys()].filter(j => j !== i)
      .sort((a, b) => Math.hypot(pts[a][0] - pts[i][0], pts[a][1] - pts[i][1]) - Math.hypot(pts[b][0] - pts[i][0], pts[b][1] - pts[i][1]));
    for (const j of order.slice(0, 2)) {
      const key = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (!edgeSet.has(key)) { edgeSet.add(key); edges.push([Math.min(i, j), Math.max(i, j)]); }
    }
  }
  const w = createWorld(worldDefault, n, edges);
  for (let i = 0; i < n; i++) { w.pos[2 * i] = pts[i][0]; w.pos[2 * i + 1] = pts[i][1]; }
  // A couple of producer cities (the rest consume).
  w.scalars.production[0] = 90;
  w.scalars.production[3 % n] = 70;
  // One hostile border to start.
  if (w.edges.length) w.edgeAttr.hostility[0] = 0.9;
  return w;
}

export function useWorld(studentKey: string) {
  const key = `sandbox_world_${studentKey}_${worldDefault.id}`;
  const ref = useRef<EntityWorld | null>(null);
  if (!ref.current) {
    let w: EntityWorld | null = null;
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    if (raw) {
      try {
        const saved = JSON.parse(raw) as { world: string; savedAt: number };
        w = deserializeWorld(saved.world);
        if (w) {
          const steps = Math.min(MAX_CATCHUP_STEPS, Math.floor((Date.now() - saved.savedAt) / STEP_MS));
          if (steps > 0) worldFastForward(w, steps);
        }
      } catch { w = null; }
    }
    ref.current = w ?? makeDefaultWorld();
  }

  const getWorld = useCallback(() => ref.current!, []);
  const save = useCallback(() => {
    if (ref.current) localStorage.setItem(key, JSON.stringify({ world: serializeWorld(ref.current), savedAt: Date.now() }));
  }, [key]);

  useEffect(() => {
    const id = setInterval(() => { if (ref.current) worldFastForward(ref.current, 1); }, STEP_MS);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    const id = setInterval(save, SAVE_INTERVAL);
    return () => { clearInterval(id); save(); };
  }, [save]);

  const resetWorld = useCallback(() => { ref.current = makeDefaultWorld(); localStorage.removeItem(key); }, [key]);
  const skipTime = useCallback((ms: number) => { if (ref.current) worldFastForward(ref.current, Math.floor(ms / STEP_MS)); }, []);

  return { getWorld, resetWorld, skipTime, save };
}
