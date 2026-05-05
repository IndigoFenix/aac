// Sandbox Game — React hook wrapping the game engine

import { useState, useCallback, useRef, useEffect } from 'react';
import type { GameState, ToolId } from './types';
import {
  createNewGame,
  updateGame,
  playerAction,
  canPlace,
  skipTime,
  flowTick,
  checkWeedSpawns,
  serializeState,
  deserializeState,
} from './engine';

const STORAGE_PREFIX = 'sandbox_game_';
const SAVE_INTERVAL = 5000; // Auto-save every 5s
const TICK_INTERVAL = 2000; // UI refresh every 2s
const FLOW_TICK_INTERVAL = 250; // Water flow animation: 4 ticks/sec
const WEED_CHECK_INTERVAL = 60000; // Check weed spawns every 60s

export function useGameEngine(studentId: string) {
  const [gameState, setGameState] = useState<GameState>(() => {
    const saved = localStorage.getItem(STORAGE_PREFIX + studentId);
    if (saved) {
      const loaded = deserializeState(saved);
      if (loaded) {
        // Catch up to current time
        updateGame(loaded, Date.now());
        return loaded;
      }
    }
    return createNewGame();
  });

  // Keep a ref that is updated IMMEDIATELY (not waiting for React render)
  const stateRef = useRef(gameState);

  /** Update both the ref and React state atomically */
  const commitState = useCallback((newState: GameState) => {
    stateRef.current = newState;
    setGameState(newState);
  }, []);

  // Periodic tick for UI refresh and energy regen
  useEffect(() => {
    const interval = setInterval(() => {
      const state = structuredClone(stateRef.current);
      updateGame(state, Date.now());
      commitState(state);
    }, TICK_INTERVAL);
    return () => clearInterval(interval);
  }, [commitState]);

  // Water flow animation tick (250ms = 4 per second)
  useEffect(() => {
    const interval = setInterval(() => {
      const cur = stateRef.current;
      if (cur.flowQueue.length === 0) return; // no work, skip clone
      const state = structuredClone(cur);
      flowTick(state, Date.now());
      commitState(state);
    }, FLOW_TICK_INTERVAL);
    return () => clearInterval(interval);
  }, [commitState]);

  // Periodic weed check
  useEffect(() => {
    const interval = setInterval(() => {
      const state = structuredClone(stateRef.current);
      checkWeedSpawns(state, Date.now());
      commitState(state);
    }, WEED_CHECK_INTERVAL);
    return () => clearInterval(interval);
  }, [commitState]);

  // Auto-save
  useEffect(() => {
    const interval = setInterval(() => {
      localStorage.setItem(STORAGE_PREFIX + studentId, serializeState(stateRef.current));
    }, SAVE_INTERVAL);
    return () => clearInterval(interval);
  }, [studentId]);

  // Save on unmount
  useEffect(() => {
    return () => {
      localStorage.setItem(STORAGE_PREFIX + studentId, serializeState(stateRef.current));
    };
  }, [studentId]);

  const doAction = useCallback((x: number, y: number, toolId: ToolId) => {
    const state = structuredClone(stateRef.current);
    const success = playerAction(state, x, y, toolId);
    if (success) {
      state.lastUpdateTime = Date.now();
      commitState(state);
    }
    return success;
  }, [commitState]);

  const checkCanPlace = useCallback((x: number, y: number, toolId: ToolId) => {
    return canPlace(stateRef.current, x, y, toolId);
  }, []);

  const doSkipTime = useCallback((ms: number) => {
    const state = structuredClone(stateRef.current);
    skipTime(state, ms);
    commitState(state);
  }, [commitState]);

  const resetGame = useCallback(() => {
    const state = createNewGame();
    commitState(state);
    localStorage.removeItem(STORAGE_PREFIX + studentId);
  }, [studentId, commitState]);

  return {
    gameState,
    doAction,
    canPlace: checkCanPlace,
    skipTime: doSkipTime,
    resetGame,
  };
}
