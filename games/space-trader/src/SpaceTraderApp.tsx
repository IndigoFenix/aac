// Space Trader — Main app component (canvas + input + render loop).
// Sprites are placeholder shapes; swap in artwork later.

import { useCallback, useEffect, useRef, useState } from 'react';
import { X, RotateCcw } from 'lucide-react';
import { onPlatformMessage, sendToParent } from '@shared/games-bridge';
import {
  POI_DESPAWN_DIST,
  SHIP_RADIUS,
  ASTEROID_FADE_OUT_MS,
  TRADER_BUBBLE_DIST,
  TRADER_DEFENSIVE_DIST,
  TRADER_FADE_START_MS,
  TRADER_OUTRO_DURATION,
  TRADER_RIPPLE_START_MS,
  TRADER_SMILE_START_MS,
  TRADER_SPAWN_FADE_MS,
  TRADER_SWAP_MS,
  TRAIL_FADE_MS,
  asteroidVisualRadius,
  createGameState,
  getAlternateTradeItems,
  isOnScreen,
  itemRenderPos,
  resetGame,
  resizeGame,
  setLevel,
  setShipTargetFromScreen,
  shipCanCompleteTrade,
  tick,
  transitionFadeAlpha,
  transitionPhase,
  wantRequirements,
  warpSpeedFractionAt,
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
  TradeRequirement,
  TradeWant,
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
  const isEmbedded = typeof window !== 'undefined' && window.parent !== window;

  const [hud, setHud] = useState({
    rocks: 0,
    shields: 0,
    level: 0,
    inventory: [] as Item[],
    transitioning: false,
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

      if (now - lastHud >= HUD_REFRESH_MS) {
        lastHud = now;
        setHud({
          rocks: state.ship.rocks,
          shields: state.ship.shields,
          level: state.level,
          inventory: [...state.ship.inventory],
          transitioning: state.transitionStart !== null,
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
    resetGame(stateRef.current);
  }, []);

  const handleCycleLevel = useCallback(() => {
    const next = (stateRef.current.level + 1) % (MAX_LEVEL + 1);
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
  const phase = transitionPhase(state, now);
  const warping = phase === 'warp_out' || phase === 'warp_in';

  // Background gradient.
  const grad = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.max(width, height) * 0.7);
  grad.addColorStop(0, COLORS.bg1);
  grad.addColorStop(1, COLORS.bg0);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  // Parallax stars (drift opposite to camera). During warp, stretch them into
  // streaks along the ship's heading; length tracks the eased warp speed so the
  // streaks lengthen and shorten with the ship's acceleration.
  ctx.fillStyle = COLORS.starfield;
  const sx = state.cameraPos.x * 0.05;
  const sy = state.cameraPos.y * 0.05;
  if (warping) {
    const headDx = Math.cos(state.ship.heading);
    const headDy = Math.sin(state.ship.heading);
    const streakLen = 90 * warpSpeedFractionAt(state, now);
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    for (const s of stars) {
      const x = ((s.x - sx) % width + width) % width;
      const y = ((s.y - sy) % height + height) % height;
      if (streakLen > 0.5) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - headDx * streakLen, y - headDy * streakLen);
        ctx.stroke();
      }
      // Head dot so the star never fully vanishes at the edges of the warp.
      ctx.beginPath();
      ctx.arc(x, y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
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
  }

  // Draw item trail (behind ship).
  drawShipTrail(ctx, state, now);

  // POIs.
  for (const poi of state.pois) {
    if (!isOnScreen(state, poi.pos, 100)) continue;
    if (poi.kind === 'asteroid') drawAsteroid(ctx, state, poi, now);
    else if (poi.kind === 'trader') drawTrader(ctx, state, poi, now);
    else if (poi.kind === 'pirate') drawPirate(ctx, state, poi, now);
  }

  // Ship + things orbiting around it.
  drawShip(ctx, state);
  drawShieldRings(ctx, state);
  drawOrbitingRocks(ctx, state, now);
  drawFlyingRocks(ctx, state, now);

  // Off-screen direction arrows (hidden during warp).
  if (!warping) drawOffscreenArrows(ctx, state, now);

  // Black warp overlay — peaks at 1 at the midpoint of the level transition.
  const fade = transitionFadeAlpha(state, now);
  if (fade > 0) {
    ctx.fillStyle = `rgba(0, 0, 0, ${fade})`;
    ctx.fillRect(0, 0, width, height);
  }
}

function drawShip(ctx: CanvasRenderingContext2D, state: GameState) {
  const screen = worldToScreen(state, state.ship.pos);
  ctx.save();
  ctx.translate(screen.x, screen.y);
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
  const screen = worldToScreen(state, state.ship.pos);
  const cx = screen.x;
  const cy = screen.y;
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
  const screen = worldToScreen(state, state.ship.pos);
  const cx = screen.x;
  const cy = screen.y;
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

  // Towed items: each one is locked to its chain point, only tweening when a
  // slot-shift happens (new item arrives or one is stolen / consumed).
  const inv = ship.inventory;
  for (let i = 0; i < inv.length; i++) {
    const world = itemRenderPos(state, i, now);
    const p = worldToScreen(state, world);
    drawItemBadge(ctx, p.x, p.y, inv[i], 12);
  }
}

const ASTEROID_FADE_IN_MS = 700;

function drawAsteroid(ctx: CanvasRenderingContext2D, state: GameState, poi: AsteroidPOI, now: number) {
  const p = worldToScreen(state, poi.pos);
  const r = asteroidVisualRadius(poi);
  // Fade out when a cluster has spawned over this asteroid.
  const fadeOut = poi.fadeOutStart !== undefined
    ? Math.max(0, 1 - (now - poi.fadeOutStart) / ASTEROID_FADE_OUT_MS)
    : 1;
  // Fade in on spawn so new asteroids don't pop into the world.
  const fadeIn = Math.max(0, Math.min(1, (now - poi.spawnTime) / ASTEROID_FADE_IN_MS));
  const fadeAlpha = fadeOut * fadeIn;
  if (fadeAlpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = fadeAlpha;
  ctx.translate(p.x, p.y);

  // Lumpy body — stable per-id random.
  const seed = poi.id * 9301 + 49297;
  const lumps = 8;
  ctx.beginPath();
  for (let i = 0; i < lumps; i++) {
    const a = (i / lumps) * Math.PI * 2;
    const wob = 0.85 + ((Math.sin(seed + i) + 1) / 2) * 0.3;
    const rr = r * wob;
    const x = Math.cos(a) * rr;
    const y = Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = COLORS.asteroid;
  ctx.fill();
  ctx.strokeStyle = COLORS.asteroidEdge;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Break-progress arc when ship is harvesting.
  if (poi.breakProgress > 0) {
    const frac = Math.max(0, Math.min(1, poi.breakProgress / poi.breakInterval));
    ctx.beginPath();
    ctx.arc(0, 0, r + 6, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  // Rocks-remaining pip count.
  ctx.fillStyle = '#e5e7eb';
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`×${poi.rocksRemaining}`, 0, 0);
  ctx.restore();
}

function drawTrader(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  poi: TraderPOI,
  now: number,
) {
  const p = worldToScreen(state, poi.pos);
  const ship = state.ship;
  const dx = ship.pos.x - poi.pos.x;
  const dy = ship.pos.y - poi.pos.y;
  const distToShip = Math.hypot(dx, dy);
  const angleToShip = Math.atan2(dy, dx);
  const r = poi.radius;

  // Outro-phase timing relative to tradeStartAt.
  let swapT = 0;
  let smileT = 0;
  let rippleT = 0;
  let fadeAlpha = 1;
  let defensiveT = 0;
  let bubbleVis = 0;
  const isOutro = poi.done && poi.tradeStartAt !== undefined;

  if (isOutro) {
    const e = now - (poi.tradeStartAt as number);
    swapT = clamp01(e / TRADER_SWAP_MS);
    smileT = clamp01((e - TRADER_SMILE_START_MS) / 400);
    rippleT = clamp01((e - TRADER_RIPPLE_START_MS) / (TRADER_OUTRO_DURATION - TRADER_RIPPLE_START_MS));
    fadeAlpha = 1 - clamp01((e - TRADER_FADE_START_MS) / (TRADER_OUTRO_DURATION - TRADER_FADE_START_MS));
    bubbleVis = (1 - swapT) * fadeAlpha;
  } else {
    // Bubble fades in as the player approaches — generous distance.
    bubbleVis = clamp01((TRADER_BUBBLE_DIST - distToShip) / 60);
    // Defensive posture only when the player has NO way to settle this trade
    // (normal or alt) — accepting a valid alt purple shouldn't make the trader
    // pull their offer in.
    if (distToShip < TRADER_DEFENSIVE_DIST && !shipCanCompleteTrade(ship, poi)) {
      defensiveT = clamp01((TRADER_DEFENSIVE_DIST - distToShip) / 80);
    }
  }

  // Spawn-in: trader fades up and a ring collapses inward to reveal it. Always
  // runs but invisible past the fade duration.
  const spawnT = clamp01((now - poi.spawnTime) / TRADER_SPAWN_FADE_MS);
  const spawnAlpha = spawnT;
  fadeAlpha *= spawnAlpha;
  bubbleVis *= spawnAlpha;

  // Eye / pupil tracking — pupils drift toward the player (clamped) with a soft
  // idle wobble. Hands gently bob and lean toward the ship.
  const pupilDriftMax = r * 0.18;
  const pupilDriftX = Math.cos(angleToShip) * pupilDriftMax;
  const pupilDriftY = Math.sin(angleToShip) * pupilDriftMax;
  const wobbleX = Math.sin(now / 730 + poi.id) * 1.2;
  const wobbleY = Math.cos(now / 810 + poi.id) * 1.2;
  const headTiltY = Math.sin(now / 950 + poi.id) * 1.5;

  const { skin, stroke: skinStroke } = traderColors(poi);

  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.globalAlpha = fadeAlpha;
  ctx.translate(0, headTiltY * 0.5);

  // Head.
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = skin;
  ctx.fill();
  ctx.strokeStyle = skinStroke;
  ctx.lineWidth = 3;
  ctx.stroke();

  // Eyes.
  const eyeY = -r * 0.15;
  const eyeX = r * 0.38;
  const eyeOuterR = r * 0.22;
  const pupilR = eyeOuterR * 0.5;
  for (const side of [-1, 1]) {
    const ex = side * eyeX;
    ctx.beginPath();
    ctx.arc(ex, eyeY, eyeOuterR, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#1f2937';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(ex + pupilDriftX + wobbleX * 0.2, eyeY + pupilDriftY + wobbleY * 0.2, pupilR, 0, Math.PI * 2);
    ctx.fillStyle = '#1f2937';
    ctx.fill();
  }

  // Mouth — neutral, deepens to a smile during the smile phase.
  const mouthY = r * 0.32;
  const mouthW = r * 0.55;
  const curve = mouthY + smileT * r * 0.32;
  ctx.beginPath();
  ctx.moveTo(-mouthW * 0.5, mouthY);
  ctx.quadraticCurveTo(0, curve, mouthW * 0.5, mouthY);
  ctx.strokeStyle = '#1f2937';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.stroke();

  // Hands — flank the head, drift toward each other when defensive.
  const baseHandX = r * 1.05;
  const baseHandY = r * 0.7;
  const handR = r * 0.24;
  const handXIn = baseHandX * (1 - defensiveT * 0.65);
  const handYIn = baseHandY + defensiveT * r * 0.08;
  const handTrackX = Math.cos(angleToShip) * 2.5;
  const handTrackY = Math.sin(angleToShip) * 2.5;
  for (const side of [-1, 1]) {
    const hx = side * handXIn + handTrackX + wobbleX * 0.4;
    const hy = handYIn + handTrackY + wobbleY * 0.4;
    ctx.beginPath();
    ctx.arc(hx, hy, handR, 0, Math.PI * 2);
    ctx.fillStyle = skin;
    ctx.fill();
    ctx.strokeStyle = skinStroke;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Offer between the hands — fades out during the swap (it's now flying to the ship).
  const offerAlpha = (1 - swapT) * (1 - defensiveT * 0.4);
  if (offerAlpha > 0.02) {
    ctx.save();
    ctx.globalAlpha = fadeAlpha * offerAlpha;
    const offerX = handTrackX + wobbleX * 0.4;
    const offerY = handYIn + handTrackY + wobbleY * 0.4 - r * 0.02;
    drawItemSymbolKind(ctx, offerX, offerY, poi.offer.kind, poi.offer.shape, r * 0.32);
    ctx.restore();
  }

  ctx.restore();

  // Speech bubble — fades in by proximity, fades out during the swap. Pushed
  // further off the trader's body than before so it doesn't overlap the trade
  // hot-spot; a tail of dots keeps the speaker reading clearly.
  const bubbleX = p.x + r + 30;
  const bubbleY = p.y - r - 52;
  const { h: bubbleH } = bubbleDimensions(poi.want);
  if (bubbleVis > 0.01) {
    ctx.save();
    ctx.globalAlpha = bubbleVis;
    drawBubbleTail(ctx, bubbleX, bubbleY, bubbleH, p.x, p.y, r);
    drawThoughtBubble(ctx, bubbleX, bubbleY, poi);
    ctx.restore();
  }

  // Alternate trade-down bubble. Only appears when the normal trade is NOT
  // currently payable but the trade-down rule yields a valid payment plan.
  // Shows the exact items the player will hand over (matched items + purple
  // substitutions), not a placeholder.
  if (bubbleVis > 0.01 && !isOutro) {
    const altItems = getAlternateTradeItems(ship, poi);
    if (altItems !== null) {
      ctx.save();
      ctx.globalAlpha = bubbleVis;
      drawAlternateTradeBubble(ctx, bubbleX, bubbleY + bubbleH + 6, altItems, poi.offer);
      ctx.restore();
    }
  }

  // Trade-in-progress arc (only while genuinely hovering, never during outro).
  if (!isOutro && poi.hoverProgress > 0) {
    const frac = Math.max(0, Math.min(1, poi.hoverProgress / poi.hoverDuration));
    ctx.beginPath();
    ctx.arc(p.x, p.y, r + 8, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  // Outro ripple — expanding rings that pulse outward as the trader fades.
  if (rippleT > 0) {
    for (let i = 0; i < 2; i++) {
      const stagger = i * 0.18;
      const tt = clamp01(rippleT * 1.1 - stagger);
      if (tt <= 0) continue;
      const rr = r + tt * 90;
      ctx.beginPath();
      ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(251, 191, 36, ${(1 - tt) * 0.65})`;
      ctx.lineWidth = 3 - i;
      ctx.stroke();
    }
  }

  // Spawn-in ripple — ring collapses inward as the trader materialises.
  if (spawnT < 1) {
    const collapse = 1 - spawnT;
    const rr = r + collapse * 70;
    ctx.beginPath();
    ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(251, 191, 36, ${collapse * 0.7})`;
    ctx.lineWidth = 3;
    ctx.stroke();
  }
}

/**
 * Trade-down bubble: shows the actual items the player would hand over under
 * the alternate-payment plan, with an "or" prefix. Items are rendered in the
 * same +-separated row format as the primary bubble, ending in the trader's
 * offer so the player can compare both routes at a glance.
 */
function drawAlternateTradeBubble(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  items: TradeRequirement[],
  offer: Item,
) {
  const prefixW = 18;
  let wantsW = 0;
  for (let i = 0; i < items.length; i++) {
    wantsW += requirementWidth(items[i]);
    if (i < items.length - 1) wantsW += 12;
  }
  const w = 10 + prefixW + wantsW + 6 + 14 + 6 + 18 + 10;
  const hasRocks = items.some(r => r.kind === 'rock');
  const h = hasRocks ? 44 : 38;
  const r = 12;

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
  ctx.fillStyle = 'rgba(243,232,255,0.95)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(88,28,135,0.55)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const cy = y + h / 2;
  ctx.fillStyle = '#581c87';
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('or', x + 10, cy);

  let cursor = x + 10 + prefixW;
  for (let i = 0; i < items.length; i++) {
    const req = items[i];
    const reqW = requirementWidth(req);
    const centerX = cursor + reqW / 2;
    if (req.kind === 'rock') {
      drawRockCluster(ctx, centerX, cy, req.rockCount ?? 1);
    } else {
      drawItemSymbolKind(ctx, centerX, cy, req.kind, req.shape, 8);
    }
    cursor += reqW;
    if (i < items.length - 1) {
      ctx.fillStyle = '#581c87';
      ctx.textAlign = 'center';
      ctx.fillText('+', cursor + 6, cy);
      ctx.textAlign = 'left';
      cursor += 12;
    }
  }

  cursor += 6;
  ctx.strokeStyle = '#581c87';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cursor, cy);
  ctx.lineTo(cursor + 10, cy);
  ctx.moveTo(cursor + 7, cy - 3);
  ctx.lineTo(cursor + 10, cy);
  ctx.lineTo(cursor + 7, cy + 3);
  ctx.stroke();
  cursor += 14;

  drawItemSymbolKind(ctx, cursor + 12, cy, offer.kind, offer.shape, 8);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Light-tinted body colour for a trader, keyed off what they're holding so the
 * player can read each trader's offer at a glance.
 */
function traderColors(poi: TraderPOI): { skin: string; stroke: string } {
  switch (poi.offer.kind) {
    case 'blue':
      return { skin: '#bfdbfe', stroke: '#1e3a8a' };
    case 'purple':
      return { skin: '#e9d5ff', stroke: '#581c87' };
    case 'star':
    default:
      return { skin: '#fde68a', stroke: COLORS.traderOutline };
  }
}

/** Width budgeted for one requirement entry inside the bubble's want section. */
function requirementWidth(req: TradeRequirement): number {
  return req.kind === 'rock' ? 38 : 18;
}

function bubbleDimensions(want: TradeWant): { w: number; h: number } {
  const reqs = wantRequirements(want);
  let wantsW = 0;
  for (let i = 0; i < reqs.length; i++) {
    wantsW += requirementWidth(reqs[i]);
    if (i < reqs.length - 1) wantsW += 12; // "+" separator
  }
  // 10px padding, wants, 6px gap, 14px arrow, 6px gap, 18px offer, 10px padding.
  const w = 10 + wantsW + 6 + 14 + 6 + 18 + 10;
  const hasRocks = reqs.some(r => r.kind === 'rock');
  const h = hasRocks ? 44 : 38;
  return { w, h };
}

/**
 * Chain of shrinking dots from the bubble's lower-left corner to the trader's
 * edge facing the bubble — bigger dots near the bubble, smaller near the speaker.
 */
function drawBubbleTail(
  ctx: CanvasRenderingContext2D,
  bubbleX: number,
  bubbleY: number,
  bubbleH: number,
  traderX: number,
  traderY: number,
  traderRadius: number,
) {
  const ax = bubbleX + 4;
  const ay = bubbleY + bubbleH - 2;
  const dx = traderX - ax;
  const dy = traderY - ay;
  const d = Math.hypot(dx, dy);
  if (d < 1) return;
  const nx = dx / d;
  const ny = dy / d;
  const tipX = traderX - nx * traderRadius;
  const tipY = traderY - ny * traderRadius;
  for (let i = 0; i < 3; i++) {
    const t = (i + 1) / 4;
    const dotX = ax + (tipX - ax) * t;
    const dotY = ay + (tipY - ay) * t;
    const radius = 5 - i * 1.3;
    ctx.beginPath();
    ctx.arc(dotX, dotY, radius, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.bubble;
    ctx.fill();
    ctx.strokeStyle = COLORS.bubbleStroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function drawThoughtBubble(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  trader: TraderPOI,
) {
  const { w, h } = bubbleDimensions(trader.want);
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

  const cy = y + h / 2;
  const reqs = wantRequirements(trader.want);
  let cursor = x + 10;
  ctx.fillStyle = '#1f2937';
  ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < reqs.length; i++) {
    const req = reqs[i];
    const reqW = requirementWidth(req);
    const centerX = cursor + reqW / 2;
    if (req.kind === 'rock') {
      drawRockCluster(ctx, centerX, cy, req.rockCount ?? 1);
    } else {
      drawItemSymbolKind(ctx, centerX, cy, req.kind, req.shape, 8);
    }
    cursor += reqW;
    if (i < reqs.length - 1) {
      ctx.fillStyle = '#1f2937';
      ctx.fillText('+', cursor + 6, cy);
      cursor += 12;
    }
  }

  // Arrow between wants and offer.
  cursor += 6;
  ctx.strokeStyle = '#1f2937';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cursor, cy);
  ctx.lineTo(cursor + 10, cy);
  ctx.moveTo(cursor + 7, cy - 3);
  ctx.lineTo(cursor + 10, cy);
  ctx.lineTo(cursor + 7, cy + 3);
  ctx.stroke();
  cursor += 14;

  // Offer side.
  drawItemSymbolKind(ctx, cursor + 12, cy, trader.offer.kind, trader.offer.shape, 8);
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

  // Stolen item drags behind the pirate as it flees. Drawn before the body so
  // the wedge sits on top of the tether/item.
  if (poi.fleeing && poi.carriedItem) {
    const trailDist = poi.radius + 18;
    const tx = p.x - Math.cos(poi.heading) * trailDist;
    const ty = p.y - Math.sin(poi.heading) * trailDist;
    ctx.strokeStyle = 'rgba(252, 165, 165, 0.7)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(p.x - Math.cos(poi.heading) * poi.radius * 0.7,
               p.y - Math.sin(poi.heading) * poi.radius * 0.7);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    drawItemSymbolKind(ctx, tx, ty, poi.carriedItem.kind, poi.carriedItem.shape, 9);
  }

  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(poi.heading);

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

  ctx.beginPath();
  ctx.arc(-2, 0, poi.radius * 0.25, 0, Math.PI * 2);
  ctx.fillStyle = '#1f1f1f';
  ctx.fill();

  ctx.restore();

  // Pulsing menace ring while chasing — fades with depleting morale.
  if (!poi.fleeing) {
    const moraleFrac = poi.moraleMax > 0 ? Math.max(0, poi.morale / poi.moraleMax) : 1;
    const pulse = 0.5 + 0.5 * Math.sin(now / 250);
    ctx.beginPath();
    ctx.arc(p.x, p.y, poi.radius + 6 + pulse * 2, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(239, 68, 68, ${(0.25 + pulse * 0.35) * moraleFrac})`;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Morale bar — short red bar above the pirate, shrinks left-to-right.
    if (moraleFrac < 0.99) {
      const barW = poi.radius * 1.8;
      const barH = 3;
      const barX = p.x - barW / 2;
      const barY = p.y - poi.radius - 9;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(barX, barY, barW, barH);
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(barX, barY, barW * moraleFrac, barH);
    }
  }
}

const RADAR_FADE_BUFFER = 70;
const RADAR_SPAWN_FADE_MS = 700;

function drawOffscreenArrows(ctx: CanvasRenderingContext2D, state: GameState, now: number) {
  const cx = state.width / 2;
  const cy = state.height / 2;
  const margin = 26;
  // Outermost ring sits just inside the canvas edge; the closer ring sits at
  // ~80% of that, so radar icons hug the screen perimeter instead of cluttering
  // the middle of the play area.
  const innerR = Math.min(state.width, state.height) / 2 - margin;
  const minR = innerR * 0.82;

  for (const poi of state.pois) {
    if (poi.kind === 'trader' && poi.done) continue;

    const dx = poi.pos.x - state.ship.pos.x;
    const dy = poi.pos.y - state.ship.pos.y;
    const d = Math.hypot(dx, dy);
    if (d > POI_DESPAWN_DIST) continue;

    const angle = Math.atan2(dy, dx);
    const t = Math.min(1, d / POI_DESPAWN_DIST);
    const r = minR + t * (innerR - minR);

    // Fade out as the POI distance approaches the indicator's radius — that's
    // the point where the icon would be drawn on top of the actual object —
    // and fade in just before despawn range so newly discovered POIs ease in.
    const nearFade = Math.max(0, Math.min(1, (d - r) / RADAR_FADE_BUFFER));
    const farFade = Math.max(0, Math.min(1, (POI_DESPAWN_DIST - d) / RADAR_FADE_BUFFER));
    // Spawn-in fade so the icon eases in along with the entity it represents.
    const spawnTime =
      poi.kind === 'trader' ? poi.spawnTime
      : poi.kind === 'pirate' ? poi.spawnTime
      : poi.kind === 'asteroid' ? poi.spawnTime
      : 0;
    const spawnFade = Math.max(0, Math.min(1, (now - spawnTime) / RADAR_SPAWN_FADE_MS));
    const alpha = Math.min(nearFade, farFade) * spawnFade;
    if (alpha <= 0.01) continue;

    const ax = cx + Math.cos(angle) * r;
    const ay = cy + Math.sin(angle) * r;

    // Encountered traders carry their offer on the indicator — small badge
    // anchored on the ring, with a directional arrow tucked behind it.
    const isEncounteredTrader = poi.kind === 'trader' && poi.encountered;

    ctx.save();
    ctx.globalAlpha = alpha;

    if (isEncounteredTrader) {
      // Tag the offer item; the small triangle still points the direction.
      ctx.save();
      ctx.translate(ax, ay);
      ctx.rotate(angle);
      ctx.fillStyle = colorForPOI(poi);
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(10, 0);
      ctx.lineTo(-2, -4);
      ctx.lineTo(-2, 4);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      // Badge backing.
      ctx.beginPath();
      ctx.arc(ax, ay, 10, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
      ctx.fill();
      ctx.strokeStyle = colorForPOI(poi);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      drawItemSymbolKind(ctx, ax, ay, poi.offer.kind, poi.offer.shape, 6);
    } else {
      ctx.translate(ax, ay);
      ctx.rotate(angle);
      ctx.fillStyle = colorForPOI(poi);
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
    }
    ctx.restore();
  }
}

function colorForPOI(poi: POI): string {
  if (poi.kind === 'pirate') return COLORS.pirate;
  if (poi.kind === 'trader') {
    // Radar marker echoes the trader's tint so the player can tell offers apart.
    switch (poi.offer.kind) {
      case 'blue': return COLORS.blue;
      case 'purple': return COLORS.purple;
      default: return COLORS.trader;
    }
  }
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
