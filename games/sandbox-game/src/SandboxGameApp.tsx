// Sandbox Game — main app shell.
// A literal sandbox: push sand with your gaze to dig valleys and pile hills;
// pour water; then leave the terrain alone and watch springs, rivers and plants
// emerge from its shape.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, FastForward, RotateCcw, ChevronDown, ChevronUp, Globe, SlidersHorizontal, FlaskConical, Mountain, Grid3x3, Network } from 'lucide-react';
import { onPlatformMessage, sendToParent } from '@shared/games-bridge';
import { useGameEngine } from './useGameEngine';
import { useSystemGrid } from './useSystemGrid';
import { useWorld } from './useWorld';
import TerrainCanvas, { type GazeState } from './TerrainCanvas';
import SystemCanvas from './SystemCanvas';
import WorldMap from './WorldMap';
import GameToolbar from './GameToolbar';
import SystemToolbar from './SystemToolbar';
import DebugPanel from './DebugPanel';
import CellSystemEditor from './CellSystemEditor';
import { applyOverrides, resetOverrides } from './debug-config';
import { intTerrain, type SystemSpec, type ToolSpec } from '@shared/world-engine/kernel/cells';
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

  // ── Cell-system main grid (Step 2): a spec-driven world on the main canvas,
  // alongside the hand-coded terrain. `activeSpec` defaults to the terrain spec
  // and can be replaced from the Cell System Lab.
  const [mode, setMode] = useState<'terrain' | 'systems' | 'world'>('terrain');
  const [activeSpec, setActiveSpec] = useState<SystemSpec>(intTerrain);
  const { getGrid, resetGrid, skipTime: skipSystem, wrap: sysWrap, toggleWrap: toggleSysWrap } = useSystemGrid(activeSpec, studentKey);
  const { getWorld, resetWorld, skipTime: skipWorld } = useWorld(studentKey);
  const [selectedSysTool, setSelectedSysTool] = useState<string | null>(activeSpec.tools?.[0]?.id ?? null);
  const sysToolRef = useRef<ToolSpec | null>(activeSpec.tools?.[0] ?? null);
  const sysTools = useMemo(() => activeSpec.tools ?? [], [activeSpec]);
  useEffect(() => {
    // When the spec changes, default to its first tool.
    setSelectedSysTool(activeSpec.tools?.[0]?.id ?? null);
  }, [activeSpec]);
  useEffect(() => {
    sysToolRef.current = sysTools.find(t => t.id === selectedSysTool) ?? null;
  }, [selectedSysTool, sysTools]);

  const gazeRef = useRef<GazeState>({ x: -1, y: -1, mode: 'off' });
  const [dwellMs, setDwellMs] = useState(DEFAULT_DWELL_MS);
  // Whether the platform has a dwell control enabled (the student's eyegaze /
  // cursor-control SETTINGS). The host encodes it in the gaze `mode`: 'off' means
  // those controls are disabled, so the game must NOT dwell-select or act on a
  // bare hover — it behaves as an ordinary click/drag app. 'eyegaze' or 'mouse'
  // (cursor-control) means a dwell control is on. controlModeRef is the live value
  // read by the pointer handlers; dwellEnabled drives the toolbar dwell.
  const controlModeRef = useRef<'off' | 'eyegaze' | 'mouse'>('off');
  const [dwellEnabled, setDwellEnabled] = useState(false);

  const [showDebug, setShowDebug] = useState(false);
  const [showParams, setShowParams] = useState(false);
  const [showLab, setShowLab] = useState(false);
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
        // `mode` reflects the student's eyegaze/cursor-control SETTINGS: 'off' =
        // disabled (plain mouse/touch — no dwell, no hover-action), 'eyegaze' or
        // 'mouse' = a dwell control is on. Track it as the gate for everything.
        if (controlModeRef.current !== msg.mode) {
          controlModeRef.current = msg.mode;
          setDwellEnabled(msg.mode !== 'off');
        }
        // Eyegaze position can ONLY come from the platform (the iframe can't
        // sense a camera / hardware tracker). Cursor-control position is read
        // from our own window pointer below — the platform's forwarded position
        // freezes once the cursor is over the iframe (its window pointer events
        // stop firing there). When disabled, clear so nothing acts on hover.
        if (msg.mode === 'eyegaze') {
          gazeRef.current = { x: msg.x, y: msg.y, mode: 'eyegaze' };
        } else if (msg.mode === 'off') {
          gazeRef.current = { x: -1, y: -1, mode: 'off' };
        }
      }
      if (msg.type === 'request_close') {
        sendToParent({ type: 'session_end', reason: 'quit' });
      }
    });
    return () => off();
  }, []);

  // ── Pointer feed (window-level, inside this iframe so it covers the WHOLE
  // game incl. the side toolbar) ────
  // We move the gaze cursor from the mouse only when the platform actually has a
  // dwell control enabled:
  //   • cursor-control ('mouse'): track the cursor on hover (the platform's own
  //     forwarded position freezes over the iframe, so we read it locally here).
  //   • disabled ('off') / plain mouse: act ONLY while a button is held (a direct
  //     press-drag), so the sandbox stays sculptable by mouse/touch but nothing
  //     happens on a bare hover and the toolbar never dwell-selects.
  //   • eyegaze: the platform owns the position; never override it.
  useEffect(() => {
    const onMove = (e: PointerEvent | MouseEvent) => {
      if (controlModeRef.current === 'eyegaze') return;
      const held = e.buttons !== 0;
      if (controlModeRef.current === 'mouse' || held) {
        gazeRef.current = { x: e.clientX, y: e.clientY, mode: 'mouse' };
      } else {
        gazeRef.current = { x: -1, y: -1, mode: 'off' };
      }
    };
    const clear = () => {
      if (controlModeRef.current === 'eyegaze') return;
      if (controlModeRef.current !== 'mouse') gazeRef.current = { x: -1, y: -1, mode: 'off' };
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('mousemove', onMove, { passive: true });
    window.addEventListener('pointerup', clear, { passive: true });
    document.addEventListener('mouseleave', clear);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('pointerup', clear);
      document.removeEventListener('mouseleave', clear);
    };
  }, []);

  const handleReset = useCallback(() => {
    if (showResetConfirm) {
      if (mode === 'world') resetWorld(); else if (mode === 'systems') resetGrid(); else resetGame();
      setShowResetConfirm(false);
    } else {
      setShowResetConfirm(true);
      setTimeout(() => setShowResetConfirm(false), 3000);
    }
  }, [showResetConfirm, resetGame, resetGrid, resetWorld, mode]);

  /** Apply a spec authored in the lab to the main grid and switch to Systems mode. */
  const applyToGrid = useCallback((spec: SystemSpec) => {
    setActiveSpec(spec);
    setMode('systems');
  }, []);

  return (
    <div className="h-full w-full flex flex-col overflow-hidden bg-gradient-to-br from-amber-200 to-orange-300">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-amber-950/80 border-b border-amber-800 shrink-0">
        <h1 className="text-lg font-bold text-amber-100">🏜️ Sandbox</h1>
        <div className="flex items-center gap-2">
          {/* Terrain ↔ Systems (spec-driven grid) */}
          <div className="flex rounded-lg overflow-hidden border border-amber-700">
            <button
              data-dwell
              onClick={() => setMode('terrain')}
              className={`p-1.5 text-xs ${mode === 'terrain' ? 'bg-amber-400 text-amber-950' : 'bg-amber-800 text-amber-100 hover:bg-amber-700'}`}
              aria-label="Terrain mode" title="Terrain — the hand-coded sandbox sim"
            >
              <Mountain size={16} />
            </button>
            <button
              data-dwell
              onClick={() => setMode('systems')}
              className={`p-1.5 text-xs ${mode === 'systems' ? 'bg-sky-500 text-white' : 'bg-amber-800 text-amber-100 hover:bg-amber-700'}`}
              aria-label="Systems mode" title="Systems — the spec-driven cell grid"
            >
              <Grid3x3 size={16} />
            </button>
            <button
              data-dwell
              onClick={() => setMode('world')}
              className={`p-1.5 text-xs ${mode === 'world' ? 'bg-sky-500 text-white' : 'bg-amber-800 text-amber-100 hover:bg-amber-700'}`}
              aria-label="World mode" title="World — cities, trade & roads (entity layer)"
            >
              <Network size={16} />
            </button>
          </div>
          <button
            data-dwell
            onClick={() => setShowLab(s => !s)}
            className={`p-1.5 rounded-lg text-xs ${showLab ? 'bg-sky-600 text-white' : 'bg-amber-800 text-amber-100 hover:bg-amber-700'}`}
            aria-label="Toggle cell system lab"
            title="Cell System Lab — author & test idle-safe enclosed systems (Step 1)"
          >
            <FlaskConical size={16} />
          </button>
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
              onClick={() => (mode === 'world' ? skipWorld(opt.ms) : mode === 'systems' ? skipSystem(opt.ms) : skipTime(opt.ms))}
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
          {mode !== 'world' && (
            <button
              data-dwell
              onClick={mode === 'systems' ? toggleSysWrap : toggleWrap}
              title="Toroidal geometry: the map edges wrap around (no off-grid)."
              aria-label={`Wrap-around edges: ${(mode === 'systems' ? sysWrap : wrap) ? 'on' : 'off'}`}
              className={`px-2 py-0.5 rounded active:scale-95 transition-transform ${
                (mode === 'systems' ? sysWrap : wrap) ? 'bg-emerald-600 hover:bg-emerald-500 text-white' : 'bg-amber-800 hover:bg-amber-700'
              }`}
            >
              <Globe size={10} className="inline mr-1" />
              Wrap: {(mode === 'systems' ? sysWrap : wrap) ? 'on' : 'off'}
            </button>
          )}
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
        {mode !== 'world' && (
          <div className="w-16 sm:w-20 bg-amber-950/40 border-r border-amber-800 shrink-0 overflow-y-auto">
            {mode === 'systems' ? (
              <SystemToolbar
                tools={sysTools}
                selectedId={selectedSysTool}
                onSelect={setSelectedSysTool}
                gazeRef={gazeRef}
                dwellMs={dwellMs}
                dwellEnabled={dwellEnabled}
              />
            ) : (
              <GameToolbar
                selectedTool={selectedTool}
                onSelectTool={setSelectedTool}
                gazeRef={gazeRef}
                dwellMs={dwellMs}
                dwellEnabled={dwellEnabled}
              />
            )}
          </div>
        )}

        <div
          className="flex-1 flex items-center justify-center p-2 sm:p-4 min-h-0 min-w-0"
        >
          <div className="w-full h-full max-w-[min(100%,calc(100vh-8rem))] max-h-[min(100%,calc(100vw-5rem))] aspect-square rounded-lg overflow-hidden shadow-xl">
            {mode === 'world' ? (
              <WorldMap getWorld={getWorld} />
            ) : mode === 'systems' ? (
              <SystemCanvas getGrid={getGrid} gazeRef={gazeRef} toolRef={sysToolRef} spec={activeSpec} />
            ) : (
              <TerrainCanvas getState={getState} gazeRef={gazeRef} toolRef={toolRef} showActiveRef={showActiveRef} />
            )}
          </div>
        </div>

        {showParams && (
          <DebugPanel onApply={applyParams} onReset={resetParams} onClose={() => setShowParams(false)} />
        )}

        {showLab && <CellSystemEditor onClose={() => setShowLab(false)} onApplyToGrid={applyToGrid} />}
      </div>
    </div>
  );
}
