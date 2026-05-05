// Sandbox Game — Main app component
// A grid-based idle farming game designed for AAC interaction.

import { useState, useCallback, useEffect } from 'react';
import { X, FastForward, RotateCcw, ChevronDown, ChevronUp } from 'lucide-react';
import { onPlatformMessage, sendToParent } from '@shared/games-bridge';
import { useGameEngine } from './useGameEngine';
import GameGrid from './GameGrid';
import GameToolbar from './GameToolbar';
import type { ToolId } from './types';

const GAME_ID = 'sandbox-game';

const SKIP_OPTIONS = [
  { label: '1h', ms: 60 * 60 * 1000 },
  { label: '4h', ms: 4 * 60 * 60 * 1000 },
  { label: '12h', ms: 12 * 60 * 60 * 1000 },
  { label: '1d', ms: 24 * 60 * 60 * 1000 },
];

export default function SandboxGameApp() {
  // The engine persists per-student state to localStorage. When embedded the
  // platform passes a studentDisplayName via init, but we don't currently
  // identify the student in localStorage — keep using "default" until the
  // platform decides to expose a stable identifier through the bridge.
  const [studentKey, setStudentKey] = useState<string>('default');
  const { gameState, doAction, canPlace, skipTime, resetGame } = useGameEngine(studentKey);
  const [selectedTool, setSelectedTool] = useState<ToolId | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const isEmbedded = typeof window !== 'undefined' && window.parent !== window;

  useEffect(() => {
    sendToParent({ type: 'ready', gameId: GAME_ID });
    const off = onPlatformMessage(msg => {
      if (msg.type === 'init' && msg.studentDisplayName) {
        // Use the platform-provided name as a localStorage namespace.
        setStudentKey(msg.studentDisplayName);
      }
      if (msg.type === 'request_close') {
        sendToParent({ type: 'session_end', reason: 'quit' });
      }
    });
    return () => off();
  }, []);

  const handleCellClick = useCallback((x: number, y: number) => {
    if (!selectedTool) return;
    doAction(x, y, selectedTool);
  }, [selectedTool, doAction]);

  const handleReset = useCallback(() => {
    if (showResetConfirm) {
      resetGame();
      setShowResetConfirm(false);
    } else {
      setShowResetConfirm(true);
      setTimeout(() => setShowResetConfirm(false), 3000);
    }
  }, [showResetConfirm, resetGame]);

  const pendingTimers = gameState.timers.length;
  const nextTimer = gameState.timers[0];
  const nextTimerIn = nextTimer ? Math.max(0, nextTimer.fireAt - Date.now()) : 0;
  const nextTimerLabel = nextTimer
    ? formatDuration(nextTimerIn)
    : 'none';

  return (
    <div className="h-full w-full bg-gradient-to-br from-green-900 to-green-950 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-black/30 border-b border-green-800 shrink-0">
        <h1 className="text-lg font-bold text-green-200">🌱 Sandbox Farm</h1>
        <div className="flex items-center gap-2">
          {/* Debug toggle */}
          <button
            data-dwell
            onClick={() => setShowDebug(!showDebug)}
            className="p-1.5 rounded-lg bg-gray-700 text-gray-300 hover:bg-gray-600 text-xs"
            aria-label="Toggle debug panel"
          >
            {showDebug ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
          {/* Close — only meaningful when embedded */}
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

      {/* Debug panel (collapsible) */}
      {showDebug && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-black/40 border-b border-green-800 text-xs text-green-300 shrink-0 flex-wrap">
          <span>Timers: {pendingTimers}</span>
          <span>Next: {nextTimerLabel}</span>
          <span className="border-l border-green-700 pl-2">Skip:</span>
          {SKIP_OPTIONS.map((opt) => (
            <button
              key={opt.label}
              data-dwell
              onClick={() => skipTime(opt.ms)}
              className="px-2 py-0.5 rounded bg-green-800 hover:bg-green-700 active:scale-95 transition-transform"
            >
              <FastForward size={10} className="inline mr-1" />
              {opt.label}
            </button>
          ))}
          <button
            data-dwell
            onClick={handleReset}
            className={`px-2 py-0.5 rounded active:scale-95 transition-transform ${
              showResetConfirm ? 'bg-red-600 hover:bg-red-500' : 'bg-gray-700 hover:bg-gray-600'
            }`}
          >
            <RotateCcw size={10} className="inline mr-1" />
            {showResetConfirm ? 'Confirm?' : 'Reset'}
          </button>
        </div>
      )}

      {/* Main area: toolbar + grid */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Toolbar */}
        <div className="w-16 sm:w-20 bg-gray-800 border-r border-gray-700 shrink-0 overflow-y-auto">
          <GameToolbar
            selectedTool={selectedTool}
            onSelectTool={setSelectedTool}
            playerEnergy={gameState.playerEnergy}
            maxPlayerEnergy={gameState.maxPlayerEnergy}
            harvested={gameState.harvested}
          />
        </div>

        {/* Grid container — maintains square aspect */}
        <div className="flex-1 flex items-center justify-center p-2 sm:p-4 min-h-0 min-w-0">
          <div className="w-full h-full max-w-[min(100%,calc(100vh-8rem))] max-h-[min(100%,calc(100vw-5rem))] aspect-square">
            <GameGrid
              gameState={gameState}
              selectedTool={selectedTool}
              onCellClick={handleCellClick}
              canPlace={canPlace}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms <= 0) return 'now';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  if (hours < 24) return `${hours}h${remainMin > 0 ? ` ${remainMin}m` : ''}`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
