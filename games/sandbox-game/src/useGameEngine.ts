// Sandbox Game — React hook wrapping the field engine.
//
// State lives in a mutable ref (the engine + sculpt brush mutate it in place;
// the canvas renders straight from the ref each frame). React state is only a
// tiny heartbeat so the debug panel refreshes. No per-frame cloning.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameState } from './types';
import {
  createNewGame, catchUp, serializeState, deserializeState,
} from './engine';
import { WORLD_STEP_MS } from './config';

const STORAGE_PREFIX = 'sandbox_terrain_';
const SAVE_INTERVAL = 5000;

export function useGameEngine(studentKey: string) {
  const storageKey = STORAGE_PREFIX + studentKey;

  const stateRef = useRef<GameState>(undefined as unknown as GameState);
  if (!stateRef.current) {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(storageKey) : null;
    const loaded = saved ? deserializeState(saved) : null;
    if (loaded) {
      catchUp(loaded, Date.now());
      stateRef.current = loaded;
    } else {
      stateRef.current = createNewGame();
    }
  }

  const [, setHeartbeat] = useState(0);

  const getState = useCallback(() => stateRef.current, []);

  // Ecology clock. catchUp() runs the right number of steps from real elapsed
  // time, so this self-corrects across throttled/backgrounded frames.
  useEffect(() => {
    const interval = setInterval(() => {
      catchUp(stateRef.current, Date.now());
      setHeartbeat(h => (h + 1) & 0xffff);
    }, WORLD_STEP_MS);
    return () => clearInterval(interval);
  }, []);

  // Persistence.
  useEffect(() => {
    const save = () => localStorage.setItem(storageKey, serializeState(stateRef.current));
    const interval = setInterval(save, SAVE_INTERVAL);
    return () => { clearInterval(interval); save(); };
  }, [storageKey]);

  /** Debug: fast-forward `ms` of simulated time. */
  const skipTime = useCallback((ms: number) => {
    stateRef.current.lastUpdateTime -= ms;
    catchUp(stateRef.current, Date.now());
    setHeartbeat(h => (h + 1) & 0xffff);
  }, []);

  const resetGame = useCallback(() => {
    stateRef.current = createNewGame();
    localStorage.removeItem(storageKey);
    setHeartbeat(h => (h + 1) & 0xffff);
  }, [storageKey]);

  return { getState, skipTime, resetGame };
}
