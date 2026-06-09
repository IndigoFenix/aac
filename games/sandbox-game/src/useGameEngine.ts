// Sandbox Game — React hook wrapping the field engine.
//
// State lives in a mutable ref (the engine + sculpt brush mutate it in place;
// the canvas renders straight from the ref each frame). React state is only a
// tiny heartbeat so the debug panel refreshes. No per-frame cloning.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameState } from './types';
import {
  createNewGame, catchUp, serializeState, deserializeState, setWrap, wakeAll,
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
  // Mirror the world's geometry flag into React state so the toggle button can
  // reflect it. Source of truth stays on the (serialized) GameState.
  const [wrap, setWrapState] = useState(() => stateRef.current.wrap);

  const getState = useCallback(() => stateRef.current, []);

  /** Flip bounded ↔ toroidal geometry (a per-world system setting). */
  const toggleWrap = useCallback(() => {
    const s = stateRef.current;
    setWrap(s, !s.wrap);
    setWrapState(s.wrap);
    localStorage.setItem(storageKey, serializeState(s));
    setHeartbeat(h => (h + 1) & 0xffff);
  }, [storageKey]);

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

  /** Re-settle the whole world under the current config (used after the debug
   *  panel changes tuning values). Safe — it just re-wakes every cell; the
   *  scheduler re-converges and settled cells sleep again. */
  const rewake = useCallback(() => {
    wakeAll(stateRef.current);
    // Persist the pending re-settle immediately so a reload right after a tuning
    // change still re-evaluates under the new values (the schedule is serialized).
    localStorage.setItem(storageKey, serializeState(stateRef.current));
    setHeartbeat(h => (h + 1) & 0xffff);
  }, [storageKey]);

  /** Debug: fast-forward `ms` of simulated time. */
  const skipTime = useCallback((ms: number) => {
    stateRef.current.lastUpdateTime -= ms;
    catchUp(stateRef.current, Date.now());
    setHeartbeat(h => (h + 1) & 0xffff);
  }, []);

  const resetGame = useCallback(() => {
    stateRef.current = createNewGame();
    setWrapState(stateRef.current.wrap);
    localStorage.removeItem(storageKey);
    setHeartbeat(h => (h + 1) & 0xffff);
  }, [storageKey]);

  return { getState, skipTime, resetGame, wrap, toggleWrap, rewake };
}
