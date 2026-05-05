// Bubbles Game — Main app component.
// Canvas-based reflex game: pop bubbles by tapping/clicking.
// - Uses pointer events for multi-touch detection.
// - When embedded, receives gaze position from the platform via the games
//   bridge (`gaze` PlatformMessage) and uses it to detect tracking-without-
//   touching, sending an `ai_observation` so the AI can encourage the student.
// - Sends periodic success-rate observations to the AI through the bridge.

import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { onPlatformMessage, sendToParent } from '@shared/games-bridge';
import {
  POP_WINDOW_MS,
  bubbleNearPoint,
  createGameState,
  handleTouch,
  resetGame,
  resizeGame,
  tick,
} from './engine';
import type { GameStats } from './types';

const GAME_ID = 'bubbles-game';
const HUD_REFRESH_MS = 400;
const AI_REPORT_INTERVAL_MS = 45_000;        // periodic success-rate report
const GAZE_ENCOURAGE_THRESHOLD_MS = 2000;    // dwell on bubble without touch
const GAZE_ENCOURAGE_COOLDOWN_MS = 25_000;   // min between encouragements
const GAZE_HIT_RADIUS_PX = 90;
const IDLE_AFTER_TOUCH_MS = 1500;            // must not have touched recently

const POP_RING_MS = 350;

interface PopAnim {
  x: number;
  y: number;
  radius: number;
  startTime: number;
  special: boolean;
}

interface GazeState {
  x: number;
  y: number;
  mode: 'off' | 'eyegaze' | 'mouse';
}

export default function BubblesGameApp() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isEmbedded = typeof window !== 'undefined' && window.parent !== window;

  // Game state lives in a ref so the rAF loop doesn't trigger re-renders.
  const stateRef = useRef(createGameState(1, 1));
  const popAnimsRef = useRef<PopAnim[]>([]);

  // HUD state (updated periodically)
  const [hudStats, setHudStats] = useState<GameStats>(stateRef.current.stats);

  // Gaze state — updated from `gaze` platform messages. iframe-local pixels.
  const gazeRef = useRef<GazeState>({ x: -1, y: -1, mode: 'off' });

  // Bridge: announce ready, listen for gaze + close.
  useEffect(() => {
    sendToParent({ type: 'ready', gameId: GAME_ID });
    const off = onPlatformMessage(msg => {
      if (msg.type === 'gaze') {
        gazeRef.current = { x: msg.x, y: msg.y, mode: msg.mode };
      }
      if (msg.type === 'request_close') {
        sendToParent({ type: 'session_end', reason: 'quit' });
      }
    });
    return () => off();
  }, []);

  // ── Resize canvas to container ─────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      resizeGame(stateRef.current, rect.width, rect.height);
    };
    resize();
    const obs = new ResizeObserver(resize);
    obs.observe(container);
    window.addEventListener('resize', resize);
    return () => {
      obs.disconnect();
      window.removeEventListener('resize', resize);
    };
  }, []);

  // ── Render + game loop ─────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let rafId = 0;
    let lastTime = performance.now();
    let lastHudUpdate = 0;
    let lastReportTime = performance.now();
    let lastEncourageTime = 0;
    let gazeLockBubbleId: number | null = null;
    let gazeLockStart = 0;

    const loop = (time: number) => {
      rafId = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (time - lastTime) / 1000);
      lastTime = time;

      const state = stateRef.current;
      const now = Date.now();

      tick(state, dt, now);

      // ── Draw ──
      ctx.clearRect(0, 0, state.width, state.height);
      const grad = ctx.createLinearGradient(0, 0, 0, state.height);
      grad.addColorStop(0, '#bae6fd');
      grad.addColorStop(1, '#e0f2fe');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, state.width, state.height);

      // Bubbles
      for (const b of state.bubbles) {
        let drawRadius = b.radius;
        if (b.pendingTouchTime !== undefined) {
          const p = Math.min(1, (now - b.pendingTouchTime) / POP_WINDOW_MS);
          drawRadius = b.radius * (1 + 0.25 * p);
        }

        const bodyGrad = ctx.createRadialGradient(
          b.x - drawRadius * 0.3, b.y - drawRadius * 0.3, drawRadius * 0.1,
          b.x, b.y, drawRadius,
        );
        const baseH = b.hue;
        const sat = b.damaged ? 30 : 75;
        bodyGrad.addColorStop(0, `hsla(${baseH}, ${sat}%, 92%, 0.9)`);
        bodyGrad.addColorStop(0.6, `hsla(${baseH}, ${sat}%, 65%, 0.7)`);
        bodyGrad.addColorStop(1, `hsla(${baseH}, ${sat}%, 50%, 0.5)`);
        ctx.fillStyle = bodyGrad;
        ctx.beginPath();
        ctx.arc(b.x, b.y, drawRadius, 0, Math.PI * 2);
        ctx.fill();

        ctx.lineWidth = 2;
        ctx.strokeStyle = b.damaged ? 'rgba(239, 68, 68, 0.8)' : 'rgba(255, 255, 255, 0.9)';
        if (b.damaged) ctx.setLineDash([6, 4]); else ctx.setLineDash([]);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
        ctx.beginPath();
        ctx.arc(b.x - drawRadius * 0.35, b.y - drawRadius * 0.4, drawRadius * 0.18, 0, Math.PI * 2);
        ctx.fill();

        if (b.special) {
          const t2 = now / 300;
          for (let i = 0; i < 5; i++) {
            const a = t2 + i * (Math.PI * 2 / 5);
            const sx = b.x + Math.cos(a) * drawRadius * 0.85;
            const sy = b.y + Math.sin(a) * drawRadius * 0.85;
            const ssize = 3 + Math.sin(t2 * 2 + i) * 1.5;
            ctx.fillStyle = 'rgba(255, 255, 160, 0.9)';
            ctx.beginPath();
            ctx.arc(sx, sy, ssize, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      // Pop rings
      const keptAnims: PopAnim[] = [];
      for (const a of popAnimsRef.current) {
        const elapsed = now - a.startTime;
        if (elapsed >= POP_RING_MS) continue;
        const p = elapsed / POP_RING_MS;
        const r = a.radius * (1 + p * 1.4);
        ctx.strokeStyle = a.special
          ? `rgba(250, 204, 21, ${1 - p})`
          : `rgba(59, 130, 246, ${1 - p})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(a.x, a.y, r, 0, Math.PI * 2);
        ctx.stroke();
        keptAnims.push(a);
      }
      popAnimsRef.current = keptAnims;

      // ── Gaze tracking without touch: nudge AI ──
      // Coordinates from the bridge are already iframe-local, but the canvas
      // sits inside the iframe with a (possibly nonzero) bounding rect — so
      // we still subtract the canvas's offset within the iframe.
      const gaze = gazeRef.current;
      if (gaze.mode !== 'off' && gaze.x >= 0) {
        const rect = canvas.getBoundingClientRect();
        const gx = gaze.x - rect.left;
        const gy = gaze.y - rect.top;
        const nearest = bubbleNearPoint(state, gx, gy, GAZE_HIT_RADIUS_PX);
        const idleSinceTouch = now - state.lastTouchTime > IDLE_AFTER_TOUCH_MS;

        if (nearest && idleSinceTouch) {
          if (gazeLockBubbleId === nearest.id) {
            if (
              now - gazeLockStart >= GAZE_ENCOURAGE_THRESHOLD_MS &&
              now - lastEncourageTime >= GAZE_ENCOURAGE_COOLDOWN_MS
            ) {
              lastEncourageTime = now;
              sendToParent({
                type: 'ai_observation',
                surface: {
                  event: 'student_watching_bubble',
                  hint: 'Student is watching a bubble closely but not reaching out to pop it. Offer gentle encouragement to try touching the screen.',
                  bubbleHue: nearest.hue,
                  isSpecial: nearest.special,
                },
              } as never);
            }
          } else {
            gazeLockBubbleId = nearest.id;
            gazeLockStart = now;
          }
        } else {
          gazeLockBubbleId = null;
        }
      }

      // ── Periodic HUD refresh ──
      if (now - lastHudUpdate >= HUD_REFRESH_MS) {
        lastHudUpdate = now;
        setHudStats({ ...state.stats, difficulty: { ...state.stats.difficulty } });
      }

      // ── Periodic AI success report ──
      if (
        now - lastReportTime >= AI_REPORT_INTERVAL_MS &&
        state.stats.popped + state.stats.missed > 0
      ) {
        lastReportTime = now;
        sendToParent({
          type: 'ai_observation',
          surface: {
            event: 'periodic_progress',
            popped: state.stats.popped,
            missed: state.stats.missed,
            successRatePct: Math.round(state.stats.successRate * 100),
            popsPerSec: Number(state.stats.popRate.toFixed(2)),
          },
        } as never);
      }
    };

    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, []);

  // ── Pointer handling ─────────────────────────────────────────────
  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const now = Date.now();
    const result = handleTouch(stateRef.current, x, y, now);
    if (result.popped && result.bubble) {
      popAnimsRef.current.push({
        x: result.bubble.x,
        y: result.bubble.y,
        radius: result.bubble.radius,
        startTime: now,
        special: result.bubble.special,
      });
    }
  }, []);

  const handleReset = useCallback(() => {
    resetGame(stateRef.current);
    popAnimsRef.current = [];
    setHudStats({ ...stateRef.current.stats });
  }, []);

  return (
    <div
      ref={containerRef}
      className="h-full w-full bg-sky-100 flex flex-col overflow-hidden select-none"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-white/70 backdrop-blur border-b border-sky-200 shrink-0">
        <h1 className="text-lg font-bold text-sky-700">🫧 Bubbles</h1>
        <div className="flex items-center gap-3">
          <div className="text-sm text-sky-800">
            <span className="font-semibold">Score: </span>
            <span className="tabular-nums">{hudStats.score}</span>
          </div>
          <button
            data-dwell
            onClick={handleReset}
            className="px-3 py-1.5 rounded-lg bg-sky-200 hover:bg-sky-300 text-sky-900 text-sm font-medium active:scale-95 transition-transform"
            aria-label="Reset"
          >
            Reset
          </button>
          {isEmbedded && (
            <button
              data-dwell
              onClick={() => sendToParent({ type: 'request_close' })}
              className="p-1.5 rounded-lg bg-red-600 text-white hover:bg-red-700 active:scale-95 transition-transform"
              aria-label="Close"
            >
              <X size={20} />
            </button>
          )}
        </div>
      </div>

      {/* Canvas */}
      <div className="flex-1 relative">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 touch-none"
          onPointerDown={handlePointerDown}
        />
      </div>
    </div>
  );
}
