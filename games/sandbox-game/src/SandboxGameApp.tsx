// Sandbox Game — main app shell.
// A literal sandbox: push sand with your gaze to dig valleys and pile hills;
// pour water; then leave the terrain alone and watch springs, rivers and plants
// emerge from its shape.

import { useCallback, useEffect, useRef, useState } from 'react';
import { X, FastForward, RotateCcw, ChevronDown, ChevronUp, Globe, SlidersHorizontal } from 'lucide-react';
import { onPlatformMessage, sendToParent } from '@shared/games-bridge';
import { useGameEngine } from './useGameEngine';
import TerrainCanvas, { type GazeState } from './TerrainCanvas';
import GameToolbar from './GameToolbar';
import DebugPanel from './DebugPanel';
import { applyOverrides, resetOverrides } from './debug-config';
import type { ToolId } from './types';

const GAME_ID = 'sandbox-game';
const DEFAULT_DWELL_MS = 800;

const SKIP_OPTIONS = [
  { label: '30s', ms: 30 * 1000 },
  { label: '2m', ms: 2 * 60 * 1000 },
  { label: '10m', ms: 10 * 60 * 1000 },
  { label: '1h', ms: 60 * 60 * 1000 },
];

export default function SandboxGameApp() {
  const [studentKey, setStudentKey] = useState('default');
  const { getState, skipTime, resetGame, wrap, toggleWrap, rewake } = useGameEngine(studentKey);

  const [selectedTool, setSelectedTool] = useState<ToolId | null>('sculpt');
  const toolRef = useRef<ToolId | null>('sculpt');
  useEffect(() => { toolRef.current = selectedTool; }, [selectedTool]);

  const gazeRef = useRef<GazeState>({ x: -1, y: -1, mode: 'off' });
  const [dwellMs, setDwellMs] = useState(DEFAULT_DWELL_MS);

  const [showDebug, setShowDebug] = useState(false);
  const [showParams, setShowParams] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showActive, setShowActive] = useState(false);
  const showActiveRef = useRef(false);
  useEffect(() => { showActiveRef.current = showActive; }, [showActive]);

  const applyParams = useCallback((draft: Record<string, number>) => {
    applyOverrides(draft);
    rewake(); // re-settle the world under the new tuning
  }, [rewake]);
  const resetParams = useCallback(() => {
    resetOverrides();
    rewake();
  }, [rewake]);
  const isEmbedded = typeof window !== 'undefined' && window.parent !== window;

  // ── Bridge: announce ready, take init config, receive gaze, handle close ────
  useEffect(() => {
    sendToParent({ type: 'ready', gameId: GAME_ID });
    const off = onPlatformMessage(msg => {
      if (msg.type === 'init') {
        if (msg.studentDisplayName) setStudentKey(msg.studentDisplayName);
        if (typeof msg.dwellMs === 'number' && msg.dwellMs > 0) setDwellMs(msg.dwellMs);
      }
      if (msg.type === 'gaze') {
        gazeRef.current = { x: msg.x, y: msg.y, mode: msg.mode };
      }
      if (msg.type === 'request_close') {
        sendToParent({ type: 'session_end', reason: 'quit' });
      }
    });
    return () => off();
  }, []);

  // ── Mouse fallback (standalone / no eye tracker): feed the same gaze ref ────
  // Real eyegaze (mode 'eyegaze') always wins; mouse never overrides it.
  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (gazeRef.current.mode === 'eyegaze') return;
    gazeRef.current = { x: e.clientX, y: e.clientY, mode: 'mouse' };
  }, []);
  const onMouseLeave = useCallback(() => {
    if (gazeRef.current.mode === 'eyegaze') return;
    gazeRef.current = { x: -1, y: -1, mode: 'off' };
  }, []);

  const handleReset = useCallback(() => {
    if (showResetConfirm) {
      resetGame();
      setShowResetConfirm(false);
    } else {
      setShowResetConfirm(true);
      setTimeout(() => setShowResetConfirm(false), 3000);
    }
  }, [showResetConfirm, resetGame]);

  return (
    <div className="h-full w-full flex flex-col overflow-hidden bg-gradient-to-br from-amber-200 to-orange-300">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-amber-950/80 border-b border-amber-800 shrink-0">
        <h1 className="text-lg font-bold text-amber-100">🏜️ Sandbox</h1>
        <div className="flex items-center gap-2">
          <button
            data-dwell
            onClick={() => setShowParams(s => !s)}
            className={`p-1.5 rounded-lg text-xs ${showParams ? 'bg-emerald-600 text-white' : 'bg-amber-800 text-amber-100 hover:bg-amber-700'}`}
            aria-label="Toggle tuning panel"
            title="Adjust simulation parameters"
          >
            <SlidersHorizontal size={16} />
          </button>
          <button
            data-dwell
            onClick={() => setShowDebug(!showDebug)}
            className="p-1.5 rounded-lg bg-amber-800 text-amber-100 hover:bg-amber-700 text-xs"
            aria-label="Toggle debug panel"
          >
            {showDebug ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
          {isEmbedded && (
            <button
              data-dwell
              onClick={() => sendToParent({ type: 'request_close' })}
              className="p-1.5 rounded-lg bg-red-600 text-white hover:bg-red-700 active:scale-95 transition-transform"
              aria-label="Close game"
            >
              <X size={20} />
            </button>
          )}
        </div>
      </div>

      {/* Debug panel */}
      {showDebug && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-950/70 border-b border-amber-800 text-xs text-amber-200 shrink-0 flex-wrap">
          <span className="border-r border-amber-700 pr-2">Fast-forward:</span>
          {SKIP_OPTIONS.map(opt => (
            <button
              key={opt.label}
              data-dwell
              onClick={() => skipTime(opt.ms)}
              className="px-2 py-0.5 rounded bg-amber-800 hover:bg-amber-700 active:scale-95 transition-transform"
            >
              <FastForward size={10} className="inline mr-1" />
              {opt.label}
            </button>
          ))}
          <button
            data-dwell
            onClick={handleReset}
            className={`px-2 py-0.5 rounded active:scale-95 transition-transform ${
              showResetConfirm ? 'bg-red-600 hover:bg-red-500 text-white' : 'bg-amber-800 hover:bg-amber-700'
            }`}
          >
            <RotateCcw size={10} className="inline mr-1" />
            {showResetConfirm ? 'Confirm?' : 'Reset'}
          </button>
          <button
            data-dwell
            onClick={toggleWrap}
            title="Toroidal geometry: the map edges wrap around. Water can only leave by evaporating (no off-map drainage)."
            aria-label={`Wrap-around edges: ${wrap ? 'on' : 'off'}`}
            className={`px-2 py-0.5 rounded active:scale-95 transition-transform ${
              wrap ? 'bg-emerald-600 hover:bg-emerald-500 text-white' : 'bg-amber-800 hover:bg-amber-700'
            }`}
          >
            <Globe size={10} className="inline mr-1" />
            Wrap: {wrap ? 'on' : 'off'}
          </button>
          <button
            data-dwell
            onClick={() => setShowActive(a => !a)}
            title="Tint cells the simulation currently has awake (red). Shows exactly what a brush touch wakes."
            className={`px-2 py-0.5 rounded active:scale-95 transition-transform ${
              showActive ? 'bg-red-600 hover:bg-red-500 text-white' : 'bg-amber-800 hover:bg-amber-700'
            }`}
          >
            Active cells: {showActive ? 'on' : 'off'}
          </button>
        </div>
      )}

      {/* Main area: toolbar + terrain (+ tuning drawer) */}
      <div className="flex-1 flex overflow-hidden min-h-0 relative">
        <div className="w-16 sm:w-20 bg-amber-950/40 border-r border-amber-800 shrink-0 overflow-y-auto">
          <GameToolbar
            selectedTool={selectedTool}
            onSelectTool={setSelectedTool}
            gazeRef={gazeRef}
            dwellMs={dwellMs}
          />
        </div>

        <div
          className="flex-1 flex items-center justify-center p-2 sm:p-4 min-h-0 min-w-0"
          onMouseMove={onMouseMove}
          onMouseLeave={onMouseLeave}
        >
          <div className="w-full h-full max-w-[min(100%,calc(100vh-8rem))] max-h-[min(100%,calc(100vw-5rem))] aspect-square rounded-lg overflow-hidden shadow-xl">
            <TerrainCanvas getState={getState} gazeRef={gazeRef} toolRef={toolRef} showActiveRef={showActiveRef} />
          </div>
        </div>

        {showParams && (
          <DebugPanel onApply={applyParams} onReset={resetParams} onClose={() => setShowParams(false)} />
        )}
      </div>
    </div>
  );
}
