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
  bubbleAtPoint,
  bubbleNearPoint,
  createGameState,
  handleTouch,
  popBubbleById,
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

// Gaze-paint pop: as the gaze sweeps across a bubble it "paints" the visited
// angular sectors. When enough sectors are filled, the bubble pops. The user
// has to draw the line all over the bubble — a stationary stare doesn't pop.
const GAZE_BUBBLE_LEEWAY_PX = 24;        // outside bubble.radius still counts as "on"
const GAZE_PAINT_MIN_SEG_PX = 2;         // skip drawing segments shorter than this

const PAINT_SECTORS = 12;                // angular sectors used for coverage
const PAINT_POP_SECTOR_COUNT = 9;        // pop once this many sectors visited (of PAINT_SECTORS)
const PAINT_INNER_RADIUS_FRAC = 0.18;    // ignore gaze too near bubble center
const PAINT_INTERP_STEPS = 6;            // interpolate between samples so fast moves don't skip sectors
const PAINT_LINE_WIDTH = 6;
const PAINT_STROKE_STYLE = 'rgba(14, 165, 233, 0.9)';

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

  // Persistent paint, one offscreen canvas per painted bubble. Paint is drawn
  // incrementally as the gaze moves and blitted onto the main canvas each
  // frame, clipped to the bubble's current circle — so the paint moves with
  // the bubble and stays visible for the bubble's whole lifetime at O(1)
  // cost per frame regardless of how much paint has accumulated.
  const paintCanvasByBubble = useRef<Map<number, HTMLCanvasElement>>(new Map());

  // Persistent coverage state per bubble — bitmask of visited angular sectors.
  // Survives until the bubble pops or is culled.
  const coverageMaskByBubble = useRef<Map<number, number>>(new Map());

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
    // Previous gaze sample in bubble-local coords (for interpolation across
    // fast moves). Tracked per bubble so a hop between bubbles doesn't
    // interpolate across the gap.
    let lastPaintBubbleId: number | null = null;
    let lastPaintLocalX = 0;
    let lastPaintLocalY = 0;

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

      // ── Gaze handling: persistent bubble-local paint + coverage-to-pop ──
      // Coordinates from the bridge are already iframe-local, but the canvas
      // sits inside the iframe with a (possibly nonzero) bounding rect — so
      // we still subtract the canvas's offset within the iframe.
      const gaze = gazeRef.current;
      const coverage = coverageMaskByBubble.current;
      const paintCanvases = paintCanvasByBubble.current;

      if (gaze.mode !== 'off' && gaze.x >= 0) {
        const rect = canvas.getBoundingClientRect();
        const gx = gaze.x - rect.left;
        const gy = gaze.y - rect.top;

        const onBubble = bubbleAtPoint(state, gx, gy, GAZE_BUBBLE_LEEWAY_PX);

        if (onBubble) {
          const localX = gx - onBubble.x;
          const localY = gy - onBubble.y;

          // Get or create this bubble's offscreen paint canvas. Sized to the
          // bubble's max possible footprint (targetRadius + leeway) so paint
          // never overflows the buffer.
          let paintCanvas = paintCanvases.get(onBubble.id);
          let half: number;
          if (!paintCanvas) {
            half = Math.ceil(onBubble.targetRadius + GAZE_BUBBLE_LEEWAY_PX + 4);
            paintCanvas = document.createElement('canvas');
            paintCanvas.width = half * 2;
            paintCanvas.height = half * 2;
            paintCanvases.set(onBubble.id, paintCanvas);
          } else {
            half = paintCanvas.width / 2;
          }
          const pctx = paintCanvas.getContext('2d');

          // Paint the new segment (or a starting dot) onto the offscreen.
          const continuing = lastPaintBubbleId === onBubble.id;
          if (pctx) {
            pctx.lineCap = 'round';
            pctx.lineJoin = 'round';
            pctx.strokeStyle = PAINT_STROKE_STYLE;
            pctx.fillStyle = PAINT_STROKE_STYLE;
            pctx.lineWidth = PAINT_LINE_WIDTH;
            if (continuing) {
              const segLen = Math.hypot(localX - lastPaintLocalX, localY - lastPaintLocalY);
              if (segLen >= GAZE_PAINT_MIN_SEG_PX) {
                pctx.beginPath();
                pctx.moveTo(lastPaintLocalX + half, lastPaintLocalY + half);
                pctx.lineTo(localX + half, localY + half);
                pctx.stroke();
              }
            } else {
              // First sample on this bubble — drop a starting dot so paint
              // is visible immediately even before the gaze moves.
              pctx.beginPath();
              pctx.arc(localX + half, localY + half, PAINT_LINE_WIDTH / 2, 0, Math.PI * 2);
              pctx.fill();
            }
          }

          // Update coverage: interpolate along the segment so a fast move
          // doesn't skip sectors.
          let mask = coverage.get(onBubble.id) ?? 0;
          const fromX = continuing ? lastPaintLocalX : localX;
          const fromY = continuing ? lastPaintLocalY : localY;
          const innerR2 = (onBubble.radius * PAINT_INNER_RADIUS_FRAC) ** 2;
          for (let s = 1; s <= PAINT_INTERP_STEPS; s++) {
            const k = s / PAINT_INTERP_STEPS;
            const tx = fromX + (localX - fromX) * k;
            const ty = fromY + (localY - fromY) * k;
            if (tx * tx + ty * ty < innerR2) continue;
            const a = Math.atan2(ty, tx);
            const sector = Math.floor(((a + Math.PI) / (Math.PI * 2)) * PAINT_SECTORS) % PAINT_SECTORS;
            mask |= 1 << sector;
          }
          coverage.set(onBubble.id, mask);
          lastPaintBubbleId = onBubble.id;
          lastPaintLocalX = localX;
          lastPaintLocalY = localY;

          // Pop when enough sectors visited.
          let popcount = 0;
          for (let m = mask; m; m >>>= 1) popcount += m & 1;
          if (popcount >= PAINT_POP_SECTOR_COUNT) {
            const popped = popBubbleById(state, onBubble.id, now);
            if (popped) {
              popAnimsRef.current.push({
                x: popped.x,
                y: popped.y,
                radius: popped.radius,
                startTime: now,
                special: popped.special,
              });
            }
            coverage.delete(onBubble.id);
            paintCanvases.delete(onBubble.id);
            lastPaintBubbleId = null;
          }
        } else {
          // Gaze in empty space — break the paint chain so the next hop onto
          // a bubble doesn't draw a long phantom segment.
          lastPaintBubbleId = null;
        }

        // AI encouragement: student watching a nearby bubble without touching.
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
                  hint: 'Student is watching a bubble closely but not popping it. Offer gentle encouragement to move their gaze around the bubble or touch the screen.',
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
      } else {
        lastPaintBubbleId = null;
        gazeLockBubbleId = null;
      }

      // Drop coverage + paint canvases for bubbles that no longer exist.
      const liveBubbleIds = new Set<number>();
      for (const b of state.bubbles) liveBubbleIds.add(b.id);
      for (const id of Array.from(coverage.keys())) {
        if (!liveBubbleIds.has(id)) coverage.delete(id);
      }
      for (const id of Array.from(paintCanvases.keys())) {
        if (!liveBubbleIds.has(id)) paintCanvases.delete(id);
      }

      // ── Blit each bubble's paint canvas onto the main canvas, clipped to
      //    the bubble's current visual radius so the paint sits "on" it. ──
      for (const b of state.bubbles) {
        const pc = paintCanvases.get(b.id);
        if (!pc) continue;
        let drawRadius = b.radius;
        if (b.pendingTouchTime !== undefined) {
          const p = Math.min(1, (now - b.pendingTouchTime) / POP_WINDOW_MS);
          drawRadius = b.radius * (1 + 0.25 * p);
        }
        const half = pc.width / 2;
        ctx.save();
        ctx.beginPath();
        ctx.arc(b.x, b.y, drawRadius, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(pc, b.x - half, b.y - half);
        ctx.restore();
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

    // Always emit a small ripple at the click point so the user gets the same
    // tactile feedback whether or not the click landed on a bubble.
    popAnimsRef.current.push({
      x,
      y,
      radius: 18,
      startTime: now,
      special: false,
    });

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

  // Feed gaze from local mouse movement. Coordinates here are in the same
  // space as the platform-bridged gaze (iframe-local viewport pixels), so the
  // loop's existing rect.left/top subtraction works for both.
  //
  // Only mouse pointers drive this — touch can't hover, and dragging a finger
  // shouldn't paint a trail. We also defer to the platform when it's actively
  // sending real eyegaze data (mode === 'eyegaze'), so a real eye tracker
  // isn't overwritten by an incidental mouse twitch.
  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType !== 'mouse') return;
    if (gazeRef.current.mode === 'eyegaze') return;
    gazeRef.current = { x: e.clientX, y: e.clientY, mode: 'mouse' };
  }, []);

  const handlePointerLeave = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType !== 'mouse') return;
    if (gazeRef.current.mode === 'eyegaze') return;
    gazeRef.current = { x: -1, y: -1, mode: 'off' };
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
          onPointerMove={handlePointerMove}
          onPointerLeave={handlePointerLeave}
        />
      </div>
    </div>
  );
}
