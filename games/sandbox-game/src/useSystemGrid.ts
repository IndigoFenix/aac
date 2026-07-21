// Sandbox Game — React hook driving a cell-system grid on the MAIN canvas.
//
// Mirrors useGameEngine (terrain): the CellGrid lives in a ref, the canvas renders
// straight from it, and a fixed-interval tick advances the simulation with
// real-time catch-up — so a settled world is cheap and an absence is resolved on
// return (the idle-game promise, now for a spec-defined system). Persistence is
// keyed by spec id, so each system keeps its own saved world.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SystemSpec } from '@shared/world-engine/kernel/cells';
import { createGrid, gridFastForward, serializeGrid, deserializeGrid, setGridWrap, type CellGrid } from '@shared/world-engine/kernel/cells';
import { GRID_COLS, GRID_ROWS } from './config';

/** One system step in real time. ~5 steps/s live; idle time is caught up on load. */
const SYSTEM_STEP_MS = 200;
const MAX_CATCHUP_STEPS = 20_000;
const SAVE_INTERVAL = 5000;

interface Saved { grid: string; savedAt: number; }

export function useSystemGrid(spec: SystemSpec, studentKey: string) {
  const key = `sandbox_system_${studentKey}_${spec.id}`;
  const gridRef = useRef<CellGrid | null>(null);
  const specIdRef = useRef<string>('');

  // (Re)build the grid whenever the spec changes — loading that spec's saved world
  // and catching it up across the time the player was away.
  if (specIdRef.current !== spec.id) {
    specIdRef.current = spec.id;
    let grid: CellGrid | null = null;
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    if (raw) {
      try {
        const saved = JSON.parse(raw) as Saved;
        grid = deserializeGrid(saved.grid);
        if (grid) {
          const steps = Math.min(MAX_CATCHUP_STEPS, Math.floor((Date.now() - saved.savedAt) / SYSTEM_STEP_MS));
          if (steps > 0) gridFastForward(grid, steps);
        }
      } catch { grid = null; }
    }
    gridRef.current = grid ?? createGrid(spec, GRID_COLS, GRID_ROWS);
  }

  const getGrid = useCallback(() => gridRef.current!, []);
  const [wrap, setWrapState] = useState(() => gridRef.current!.wrap);
  // Keep the React mirror in sync when the spec (and thus the grid) changes.
  useEffect(() => { setWrapState(gridRef.current!.wrap); }, [spec.id]);

  const save = useCallback(() => {
    const g = gridRef.current;
    if (!g) return;
    localStorage.setItem(key, JSON.stringify({ grid: serializeGrid(g), savedAt: Date.now() } satisfies Saved));
  }, [key]);

  // Simulation tick.
  useEffect(() => {
    const id = setInterval(() => { if (gridRef.current) gridFastForward(gridRef.current, 1); }, SYSTEM_STEP_MS);
    return () => clearInterval(id);
  }, []);

  // Persistence (and a final save on unmount).
  useEffect(() => {
    const id = setInterval(save, SAVE_INTERVAL);
    return () => { clearInterval(id); save(); };
  }, [save]);

  const resetGrid = useCallback(() => {
    gridRef.current = createGrid(spec, GRID_COLS, GRID_ROWS);
    localStorage.removeItem(key);
  }, [spec, key]);

  /** Debug: fast-forward `ms` of simulated time. */
  const skipTime = useCallback((ms: number) => {
    if (gridRef.current) gridFastForward(gridRef.current, Math.floor(ms / SYSTEM_STEP_MS));
  }, []);

  const toggleWrap = useCallback(() => {
    const g = gridRef.current;
    if (!g) return;
    setGridWrap(g, !g.wrap);
    setWrapState(g.wrap);
    save();
  }, [save]);

  return { getGrid, resetGrid, skipTime, save, wrap, toggleWrap };
}
