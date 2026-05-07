// Space Trader — Main app component (canvas + input + render loop).
// Sprites are placeholder shapes; swap in artwork later.

import { useCallback, useEffect, useRef, useState } from 'react';
import { X, RotateCcw } from 'lucide-react';
import { onPlatformMessage, sendToParent } from '@shared/games-bridge';
import {
  POI_DESPAWN_DIST,
  SHIP_RADIUS,
  TRAIL_FADE_MS,
  activeMessages,
  createGameState,
  isOnScreen,
  resetGame,
  resizeGame,
  setLevel,
  setShipTargetFromScreen,
  tick,
  worldToScreen,
} from './engine';
import type {
  AsteroidPOI,
  GameState,
  Item,
  ItemKind,
  PiratePOI,
  POI,
  Shape,
  TraderPOI,
} from './types';

const GAME_ID = 'space-trader';
const MAX_LEVEL = 2;
const ROCK_ORBIT_CAP = 12;
const ROCK_ORBIT_RADIUS = SHIP_RADIUS + 22;
const SHIELD_RING_INNER = SHIP_RADIUS + 6;
const SHIELD_RING_STEP = 4;
const SHIELD_RING_CAP = 5;

const HUD_REFRESH_MS = 250;

// Visual palette
const COLORS = {
  bg0: '#050816',
  bg1: '#0c0a26',
  starfield: 'rgba(255,255,255,0.7)',
  ship: '#7dd3fc',
  shipOutline: '#0ea5e9',
  asteroid: '#6b6b73',
  asteroidEdge: '#3f3f46',
  rock: '#9ca3af',
  trader: '#fbbf24',
  traderOutline: '#b45309',
  pirate: '#ef4444',
  pirateOutline: '#7f1d1d',
  shield: '#10b981',
  blue: '#3b82f6',
  purple: '#a855f7',
  star: '#facc15',
  bubble: 'rgba(255,255,255,0.92)',
  bubbleStroke: 'rgba(0,0,0,0.55)',
  arrow: 'rgba(255,255,255,0.7)',
  badArrow: 'rgba(248,113,113,0.85)',
};

export default function SpaceTraderApp() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const stateRef = useRef<GameState>(createGameState(1, 1));
  const starsRef = useRef<{ x: number; y: number; r: number; phase: number }[]>([]);
  const wonReportedRef = useRef(false);
  const isEmbedded = typeof window !== 'undefined' && window.parent !== window;

  const [hud, setHud] = useState({
    rocks: 0,
    shields: 0,
    level: 0,
    inventory: [] as Item[],
    won: false,
    messages: [] as { id: number; text: string }[],
  });

  // ── Bridge: announce ready and listen for platform messages ──────────
  useEffect(() => {
    sendToParent({ type: 'ready', gameId: GAME_ID });
    const off = onPlatformMessage(msg => {
      if (msg.type === 'request_close') {
        sendToParent({ type: 'session_end', reason: 'quit' });
      }
      // Other message types are accepted but ignored for now (init, expression, etc.)
    });
    return () => off();
  }, []);

  // ── Resize canvas + regenerate parallax stars ────────────────────────
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

      // Re-tile stars to cover the whole viewport.
      const count = Math.round((rect.width * rect.height) / 4500);
      const stars: typeof starsRef.current = [];
      for (let i = 0; i < count; i++) {
        stars.push({
          x: Math.random() * rect.width,
          y: Math.random() * rect.height,
          r: Math.random() * 1.4 + 0.4,
          phase: Math.random() * Math.PI * 2,
        });
      }
      starsRef.current = stars;
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

  // ── Render + game loop ──────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let rafId = 0;
    let lastTime = performance.now();
    let lastHud = 0;

    const loop = (time: number) => {
      rafId = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (time - lastTime) / 1000);
      lastTime = time;

      const state = stateRef.current;
      const now = Date.now();

      tick(state, dt, now);

      drawScene(ctx, state, starsRef.current, now);

      // Notify the platform once when the player wins.
      if (state.won && !wonReportedRef.current) {
        wonReportedRef.current = true;
        sendToParent({ type: 'session_end', reason: 'won', summary: 'Captured the Star.' });
      }

      if (now - lastHud >= HUD_REFRESH_MS) {
        lastHud = now;
        setHud({
          rocks: state.ship.rocks,
          shields: state.ship.shields,
          level: state.level,
          inventory: [...state.ship.inventory],
          won: state.won,
          messages: activeMessages(state, now).map(m => ({ id: m.id, text: m.text })),
        });
      }
    };

    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, []);

  // ── Pointer / touch — drives ship target ────────────────────────────
  const setTargetFromEvent = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    setShipTargetFromScreen(stateRef.current, e.clientX - rect.left, e.clientY - rect.top);
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    setTargetFromEvent(e);
  }, [setTargetFromEvent]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    // Track only when a button is held OR for hover-style steering with a mouse.
    if (e.pointerType === 'mouse' || e.buttons > 0) {
      setTargetFromEvent(e);
    }
  }, [setTargetFromEvent]);

  const handleReset = useCallback(() => {
    wonReportedRef.current = false;
    resetGame(stateRef.current);
  }, []);

  const handleCycleLevel = useCallback(() => {
    const next = (stateRef.current.level + 1) % (MAX_LEVEL + 1);
    wonReportedRef.current = false;
    setLevel(stateRef.current, next);
    sendToParent({ type: 'level_changed', level: next });
  }, []);

  const handleClose = useCallback(() => {
    sendToParent({ type: 'request_close' });
  }, []);

  return (
    <div
      ref={containerRef}
      className="h-full w-full bg-slate-950 flex flex-col overflow-hidden select-none relative"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-black/50 backdrop-blur border-b border-slate-800 shrink-0 z-10">
        <h1 className="text-lg font-bold text-sky-200">🚀 Space Trader</h1>
        <div className="flex items-center gap-2">
          <button
            data-dwell
            onClick={handleCycleLevel}
            className="px-3 py-1.5 rounded-lg bg-purple-700 hover:bg-purple-600 text-purple-100 text-sm font-medium active:scale-95 transition-transform"
            aria-label={`Difficulty level ${hud.level} of ${MAX_LEVEL}`}
            title="Cycle difficulty level (resets the world)"
          >
            Lv {hud.level}
          </button>
          <button
            data-dwell
            onClick={handleReset}
            className="px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-100 text-sm font-medium active:scale-95 transition-transform flex items-center gap-1"
            aria-label="Reset"
          >
            <RotateCcw size={14} /> Reset
          </button>
          {isEmbedded && (
            <button
              data-dwell
              onClick={handleClose}
              className="p-1.5 rounded-lg bg-red-600 text-white hover:bg-red-700 active:scale-95 transition-transform"
              aria-label="Close game"
            >
              <X size={20} />
            </button>
          )}
        </div>
      </div>

      {/* Canvas area */}
      <div className="flex-1 relative">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 touch-none cursor-crosshair"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
        />

        {/* Inventory HUD overlay (top-left). Rocks/shields now render around the
            ship itself, so the HUD only summarises overflow + towed items. */}
        {(hud.rocks > ROCK_ORBIT_CAP || hud.shields > SHIELD_RING_CAP || hud.inventory.length > 0) && (
          <div className="absolute top-2 left-2 flex flex-col gap-1 text-slate-100 text-sm z-10 pointer-events-none">
            {(hud.rocks > ROCK_ORBIT_CAP || hud.shields > SHIELD_RING_CAP) && (
              <div className="flex items-center gap-2 bg-black/40 px-2 py-1 rounded">
                {hud.rocks > ROCK_ORBIT_CAP && (
                  <>
                    <span style={{ color: COLORS.rock }}>●</span>
                    <span className="tabular-nums">×{hud.rocks}</span>
                  </>
                )}
                {hud.shields > SHIELD_RING_CAP && (
                  <>
                    <span className="text-slate-500">·</span>
                    <span style={{ color: COLORS.shield }}>◇</span>
                    <span className="tabular-nums">×{hud.shields}</span>
                  </>
                )}
              </div>
            )}
            {hud.inventory.length > 0 && (
              <div className="flex items-center gap-1 flex-wrap bg-black/40 px-2 py-1 rounded max-w-[40vw]">
                {hud.inventory.map(item => (
                  <ItemBadge key={item.id} item={item} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Floating messages (bottom-center) */}
        <div className="absolute bottom-3 left-0 right-0 flex flex-col items-center gap-1 z-10 pointer-events-none">
          {hud.messages.slice(-3).map(m => (
            <div
              key={m.id}
              className="px-3 py-1 rounded-lg bg-black/70 text-slate-100 text-sm shadow-lg"
            >
              {m.text}
            </div>
          ))}
        </div>

        {/* Win overlay */}
        {hud.won && (
          <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center gap-4 z-20">
            <div className="text-5xl">⭐</div>
            <div className="text-3xl font-bold text-yellow-300">Mission Complete!</div>
            <div className="text-slate-200">You captured the Star.</div>
            <button
              data-dwell
              onClick={handleReset}
              className="mt-2 px-4 py-2 rounded-lg bg-yellow-500 hover:bg-yellow-400 text-slate-900 font-medium"
            >
              Play again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── HUD item badge ─────────────────────────────────────────────────────

function ItemBadge({ item }: { item: Item }) {
  const color =
    item.kind === 'blue' ? COLORS.blue
    : item.kind === 'purple' ? COLORS.purple
    : item.kind === 'star' ? COLORS.star
    : COLORS.rock;
  const symbol =
    item.kind === 'star' ? '★'
    : item.shape === 'circle' ? '●'
    : item.shape === 'triangle' ? '▲'
    : item.shape === 'square' ? '■'
    : '●';
  return (
    <span className="inline-flex items-center" style={{ color }}>
      {symbol}
    </span>
  );
}

// ── Canvas drawing ─────────────────────────────────────────────────────

function drawScene(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  stars: { x: number; y: number; r: number; phase: number }[],
  now: number,
): void {
  const { width, height } = state;

  // Background gradient.
  const grad = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.max(width, height) * 0.7);
  grad.addColorStop(0, COLORS.bg1);
  grad.addColorStop(1, COLORS.bg0);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  // Parallax stars (drift opposite to ship position).
  ctx.fillStyle = COLORS.starfield;
  const sx = state.ship.pos.x * 0.05;
  const sy = state.ship.pos.y * 0.05;
  for (const s of stars) {
    const x = ((s.x - sx) % width + width) % width;
    const y = ((s.y - sy) % height + height) % height;
    const tw = 0.55 + 0.45 * Math.sin(now / 600 + s.phase);
    ctx.globalAlpha = tw;
    ctx.beginPath();
    ctx.arc(x, y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Draw item trail (behind ship).
  drawShipTrail(ctx, state, now);

  // POIs.
  for (const poi of state.pois) {
    if (!isOnScreen(state, poi.pos, 100)) continue;
    if (poi.kind === 'asteroid') drawAsteroid(ctx, state, poi);
    else if (poi.kind === 'trader') drawTrader(ctx, state, poi);
    else if (poi.kind === 'pirate') drawPirate(ctx, state, poi, now);
  }

  // Ship + things orbiting around it.
  drawShip(ctx, state);
  drawShieldRings(ctx, state);
  drawOrbitingRocks(ctx, state, now);
  drawFlyingRocks(ctx, state, now);

  // Off-screen direction arrows.
  drawOffscreenArrows(ctx, state);
}

function drawShip(ctx: CanvasRenderingContext2D, state: GameState) {
  const cx = state.width / 2;
  const cy = state.height / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(state.ship.heading);
  // Body — pointed triangle
  ctx.beginPath();
  ctx.moveTo(SHIP_RADIUS, 0);
  ctx.lineTo(-SHIP_RADIUS * 0.8, -SHIP_RADIUS * 0.7);
  ctx.lineTo(-SHIP_RADIUS * 0.5, 0);
  ctx.lineTo(-SHIP_RADIUS * 0.8, SHIP_RADIUS * 0.7);
  ctx.closePath();
  ctx.fillStyle = COLORS.ship;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = COLORS.shipOutline;
  ctx.stroke();
  // Cockpit
  ctx.beginPath();
  ctx.arc(SHIP_RADIUS * 0.2, 0, SHIP_RADIUS * 0.3, 0, Math.PI * 2);
  ctx.fillStyle = '#0c4a6e';
  ctx.fill();
  ctx.restore();
}

function drawShieldRings(ctx: CanvasRenderingContext2D, state: GameState) {
  const cx = state.width / 2;
  const cy = state.height / 2;
  const visibleShields = Math.min(SHIELD_RING_CAP, state.ship.shields);
  for (let i = 0; i < visibleShields; i++) {
    const r = SHIELD_RING_INNER + i * SHIELD_RING_STEP;
    const alpha = 0.85 - i * 0.12;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(16, 185, 129, ${alpha})`;
    ctx.lineWidth = 2;
    ctx.stroke();
    // Subtle inner glow ring.
    ctx.beginPath();
    ctx.arc(cx, cy, r - 1, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(167, 243, 208, ${alpha * 0.4})`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function drawOrbitingRocks(ctx: CanvasRenderingContext2D, state: GameState, now: number) {
  const cx = state.width / 2;
  const cy = state.height / 2;
  const inFlight = state.flyingRocks.length;
  const orbiting = Math.max(0, state.ship.rocks - inFlight);
  const drawCount = Math.min(ROCK_ORBIT_CAP, orbiting);
  if (drawCount > 0) {
    const baseAngle = now / 1500;
    for (let i = 0; i < drawCount; i++) {
      const a = baseAngle + (i / drawCount) * Math.PI * 2;
      const x = cx + Math.cos(a) * ROCK_ORBIT_RADIUS;
      const y = cy + Math.sin(a) * ROCK_ORBIT_RADIUS;
      drawRockSymbol(ctx, x, y, 4);
    }
  }
  if (orbiting > ROCK_ORBIT_CAP) {
    ctx.fillStyle = '#e5e7eb';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`+${orbiting - ROCK_ORBIT_CAP}`, cx, cy + ROCK_ORBIT_RADIUS + 12);
  }
}

function drawFlyingRocks(ctx: CanvasRenderingContext2D, state: GameState, now: number) {
  for (const f of state.flyingRocks) {
    const t = Math.min(1, (now - f.startTime) / f.duration);
    // Ease-in: rocks accelerate as they're pulled toward the ship.
    const k = t * t;
    const sp = worldToScreen(state, f.startPos);
    const ep = worldToScreen(state, state.ship.pos);
    const x = sp.x + (ep.x - sp.x) * k;
    const y = sp.y + (ep.y - sp.y) * k;
    drawRockSymbol(ctx, x, y, 4);
  }
}

function drawRockSymbol(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
  ctx.beginPath();
  ctx.arc(x, y, size, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.rock;
  ctx.fill();
  ctx.strokeStyle = COLORS.asteroidEdge;
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawShipTrail(ctx: CanvasRenderingContext2D, state: GameState, now: number) {
  const ship = state.ship;
  const trail = ship.trailPositions;

  // Faint motion trail — each segment's alpha fades with the older endpoint's age,
  // so the trail retreats toward the ship when the player stops.
  if (trail.length >= 2) {
    ctx.lineWidth = 3;
    for (let i = 1; i < trail.length; i++) {
      const a = worldToScreen(state, trail[i - 1]);
      const b = worldToScreen(state, trail[i]);
      const age = now - trail[i - 1].t;
      const alpha = Math.max(0, 1 - age / TRAIL_FADE_MS);
      if (alpha <= 0) continue;
      ctx.strokeStyle = `rgba(125, 211, 252, ${0.35 * alpha})`;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  // Towed items: place each along the trail. When the ship has been stationary
  // and the trail has shrunk, fall back to clustering items behind the ship so
  // they don't pop in/out of existence.
  const spacing = 4;
  const inv = ship.inventory;
  for (let i = 0; i < inv.length; i++) {
    const idx = trail.length - 1 - (i + 1) * spacing;
    let world;
    if (idx >= 0) {
      world = trail[idx];
    } else {
      const offset = (i + 1) * 14;
      world = {
        x: ship.pos.x - Math.cos(ship.heading) * offset,
        y: ship.pos.y - Math.sin(ship.heading) * offset,
      };
    }
    const p = worldToScreen(state, world);
    drawItemBadge(ctx, p.x, p.y, inv[i], 12);
  }
}

function drawAsteroid(ctx: CanvasRenderingContext2D, state: GameState, poi: AsteroidPOI) {
  const p = worldToScreen(state, poi.pos);
  ctx.save();
  ctx.translate(p.x, p.y);

  // Lumpy body — stable per-id random.
  const seed = poi.id * 9301 + 49297;
  const lumps = 8;
  ctx.beginPath();
  for (let i = 0; i < lumps; i++) {
    const a = (i / lumps) * Math.PI * 2;
    const wob = 0.85 + ((Math.sin(seed + i) + 1) / 2) * 0.3;
    const r = poi.radius * wob;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = COLORS.asteroid;
  ctx.fill();
  ctx.strokeStyle = COLORS.asteroidEdge;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Hint of contained item.
  if (poi.containedItem) {
    drawItemBadge(ctx, 0, 0, poi.containedItem, Math.min(poi.radius * 0.5, 14));
  }

  // Break-progress arc when ship is harvesting.
  if (poi.breakProgress > 0) {
    const frac = Math.max(0, Math.min(1, poi.breakProgress / poi.breakInterval));
    ctx.beginPath();
    ctx.arc(0, 0, poi.radius + 6, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  // Rocks-remaining pip count.
  ctx.fillStyle = '#e5e7eb';
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (!poi.containedItem) {
    ctx.fillText(`×${poi.rocksRemaining}`, 0, 0);
  }
  ctx.restore();
}

function drawTrader(ctx: CanvasRenderingContext2D, state: GameState, poi: TraderPOI) {
  const p = worldToScreen(state, poi.pos);

  ctx.save();
  ctx.translate(p.x, p.y);

  if (poi.done) {
    // Inert — dim circle.
    ctx.beginPath();
    ctx.arc(0, 0, poi.radius, 0, Math.PI * 2);
    ctx.fillStyle = '#52525b';
    ctx.fill();
    ctx.strokeStyle = '#27272a';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
    return;
  }

  // Trader station body.
  ctx.beginPath();
  ctx.arc(0, 0, poi.radius, 0, Math.PI * 2);
  ctx.fillStyle = poi.badDeal ? '#dc2626' : COLORS.trader;
  ctx.fill();
  ctx.strokeStyle = poi.badDeal ? '#7f1d1d' : COLORS.traderOutline;
  ctx.lineWidth = 3;
  ctx.stroke();

  // Antenna so it reads as a structure rather than a planet.
  ctx.beginPath();
  ctx.moveTo(0, -poi.radius);
  ctx.lineTo(0, -poi.radius - 10);
  ctx.strokeStyle = COLORS.traderOutline;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, -poi.radius - 12, 3, 0, Math.PI * 2);
  ctx.fillStyle = '#fde68a';
  ctx.fill();

  ctx.restore();

  // Thought bubble showing what they want.
  drawThoughtBubble(ctx, p.x + poi.radius + 8, p.y - poi.radius - 8, poi);

  // Trade-in-progress arc.
  if (poi.hoverProgress > 0) {
    const frac = Math.max(0, Math.min(1, poi.hoverProgress / poi.hoverDuration));
    ctx.beginPath();
    ctx.arc(p.x, p.y, poi.radius + 6, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 3;
    ctx.stroke();
  }
}

function drawThoughtBubble(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  trader: TraderPOI,
) {
  // Wider bubble when the want is a rock pile so the cluster fits.
  const wantsRocks = trader.want.kind === 'rock';
  const w = wantsRocks ? 96 : 72;
  const h = wantsRocks ? 44 : 38;
  const r = 12;

  // Bubble background (rounded rectangle).
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fillStyle = COLORS.bubble;
  ctx.fill();
  ctx.strokeStyle = COLORS.bubbleStroke;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Connector dots toward trader (lower-left).
  for (let i = 0; i < 2; i++) {
    const dx = -8 - i * 6;
    const dy = h + 4 + i * 4;
    ctx.beginPath();
    ctx.arc(x + dx, y + dy, 2 + i, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.bubble;
    ctx.fill();
    ctx.strokeStyle = COLORS.bubbleStroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  const cy = y + h / 2;
  const wantCx = x + (wantsRocks ? 24 : 14);
  if (wantsRocks) {
    drawRockCluster(ctx, wantCx, cy, trader.want.rockCount ?? 1);
  } else {
    drawItemSymbolKind(ctx, wantCx, cy, trader.want.kind, trader.want.shape, 8);
  }

  // Arrow.
  ctx.strokeStyle = '#1f2937';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x + w / 2 - 4, cy);
  ctx.lineTo(x + w / 2 + 4, cy);
  ctx.moveTo(x + w / 2 + 1, cy - 3);
  ctx.lineTo(x + w / 2 + 4, cy);
  ctx.lineTo(x + w / 2 + 1, cy + 3);
  ctx.stroke();

  // Offer side.
  drawItemSymbolKind(ctx, x + w - 14, cy, trader.offer.kind, trader.offer.shape, 8);
}

/**
 * Draw up to 8 rocks in a tight cluster centered on (cx,cy). Beyond 8 rocks,
 * the cluster stays at 8 and a small "+N" label notes the surplus.
 */
function drawRockCluster(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  count: number,
) {
  const display = Math.max(1, Math.min(8, count));
  const radius = 3;
  const spacingX = 8;
  const spacingY = 8;
  const topCount = display <= 4 ? display : 4;
  const botCount = display <= 4 ? 0 : display - 4;

  function row(n: number, yOffset: number) {
    const rowWidth = (n - 1) * spacingX;
    const startX = cx - rowWidth / 2;
    for (let i = 0; i < n; i++) {
      drawRockSymbol(ctx, startX + i * spacingX, cy + yOffset, radius);
    }
  }

  if (botCount > 0) {
    row(topCount, -spacingY / 2);
    row(botCount, spacingY / 2);
  } else {
    row(topCount, 0);
  }

  if (count > 8) {
    ctx.fillStyle = '#1f2937';
    ctx.font = 'bold 9px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`+${count - 8}`, cx + 18, cy);
  }
}

function drawPirate(ctx: CanvasRenderingContext2D, state: GameState, poi: PiratePOI, now: number) {
  const p = worldToScreen(state, poi.pos);
  const dx = state.ship.pos.x - poi.pos.x;
  const dy = state.ship.pos.y - poi.pos.y;
  const heading = Math.atan2(dy, dx) + (poi.fleeing ? Math.PI : 0);

  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(heading);

  // Wedge shape.
  ctx.beginPath();
  ctx.moveTo(poi.radius, 0);
  ctx.lineTo(-poi.radius, -poi.radius * 0.8);
  ctx.lineTo(-poi.radius * 0.6, 0);
  ctx.lineTo(-poi.radius, poi.radius * 0.8);
  ctx.closePath();
  ctx.fillStyle = poi.fleeing ? '#fda4af' : COLORS.pirate;
  ctx.fill();
  ctx.strokeStyle = COLORS.pirateOutline;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Skull blip
  ctx.beginPath();
  ctx.arc(-2, 0, poi.radius * 0.25, 0, Math.PI * 2);
  ctx.fillStyle = '#1f1f1f';
  ctx.fill();

  ctx.restore();

  // Pulsing menace ring (only while chasing).
  if (!poi.fleeing) {
    const pulse = 0.5 + 0.5 * Math.sin(now / 250);
    ctx.beginPath();
    ctx.arc(p.x, p.y, poi.radius + 6 + pulse * 2, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(239, 68, 68, ${0.25 + pulse * 0.35})`;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function drawOffscreenArrows(ctx: CanvasRenderingContext2D, state: GameState) {
  const cx = state.width / 2;
  const cy = state.height / 2;
  const margin = 26;

  for (const poi of state.pois) {
    if (isOnScreen(state, poi.pos, 0)) continue;

    const dx = poi.pos.x - state.ship.pos.x;
    const dy = poi.pos.y - state.ship.pos.y;
    const d = Math.hypot(dx, dy);
    if (d > POI_DESPAWN_DIST) continue;

    const angle = Math.atan2(dy, dx);
    // Closer POIs => arrow nearer to the ship; farther => arrow at edge.
    const innerR = Math.min(state.width, state.height) / 2 - margin;
    const minR = Math.min(80, innerR * 0.3);
    const t = Math.min(1, d / POI_DESPAWN_DIST);
    const r = minR + t * (innerR - minR);

    const ax = cx + Math.cos(angle) * r;
    const ay = cy + Math.sin(angle) * r;

    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate(angle);

    const color = colorForPOI(poi);
    ctx.fillStyle = color;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(8, 0);
    ctx.lineTo(-6, -5);
    ctx.lineTo(-3, 0);
    ctx.lineTo(-6, 5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

function colorForPOI(poi: POI): string {
  if (poi.kind === 'pirate') return COLORS.pirate;
  if (poi.kind === 'trader') return (poi as TraderPOI).badDeal ? COLORS.pirate : COLORS.trader;
  return COLORS.asteroid;
}

// ── Item glyph helpers (placeholders for sprites) ─────────────────────

function drawItemBadge(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  item: Item,
  size: number,
) {
  drawItemSymbolKind(ctx, x, y, item.kind, item.shape, size);
}

function drawItemSymbolKind(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  kind: ItemKind,
  shape: Shape | undefined,
  size: number,
) {
  ctx.save();
  ctx.lineWidth = 1.5;

  if (kind === 'rock') {
    ctx.fillStyle = COLORS.rock;
    ctx.strokeStyle = COLORS.asteroidEdge;
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else if (kind === 'shield') {
    ctx.fillStyle = COLORS.shield;
    ctx.strokeStyle = '#064e3b';
    ctx.beginPath();
    ctx.moveTo(x, y - size);
    ctx.lineTo(x + size, y);
    ctx.lineTo(x, y + size);
    ctx.lineTo(x - size, y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else if (kind === 'star') {
    ctx.fillStyle = COLORS.star;
    ctx.strokeStyle = '#854d0e';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const points = 5;
    const inner = size * 0.45;
    for (let i = 0; i < points * 2; i++) {
      const r = i % 2 === 0 ? size : inner;
      const a = -Math.PI / 2 + (i / (points * 2)) * Math.PI * 2;
      const px = x + Math.cos(a) * r;
      const py = y + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else {
    const fill = kind === 'purple' ? COLORS.purple : COLORS.blue;
    const stroke = kind === 'purple' ? '#581c87' : '#1e3a8a';
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    if (shape === 'triangle') {
      ctx.beginPath();
      ctx.moveTo(x, y - size);
      ctx.lineTo(x + size, y + size * 0.85);
      ctx.lineTo(x - size, y + size * 0.85);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else if (shape === 'square') {
      ctx.fillRect(x - size, y - size, size * 2, size * 2);
      ctx.strokeRect(x - size, y - size, size * 2, size * 2);
    } else {
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();
}
