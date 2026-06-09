// Sandbox Game — terrain renderer + per-frame gaze interaction loop.
//
// Renders "colored boxes" by drawing one backing pixel per cell and letting CSS
// scale the canvas up with `image-rendering: pixelated` (crisp squares, cheap).
// The same rAF loop owns the canvas geometry, so it also maps the gaze position
// into cell space and drives the sculpt brush / water pour for the active tool.

import { useEffect, useRef } from 'react';
import type { GameState, ToolId } from './types';
import { materialColor, POUR, ECO, SHADE, BASELINE_HEIGHT } from './config';
import { wrapCoord } from './grid';
import { applyBrush } from './sculpt';
import { pourWater, activeMask } from './engine';

export interface GazeState {
  x: number; // iframe-local px
  y: number;
  mode: 'off' | 'eyegaze' | 'mouse';
}

interface Props {
  getState: () => GameState;
  gazeRef: React.MutableRefObject<GazeState>;
  toolRef: React.MutableRefObject<ToolId | null>;
  /** Debug: tint cells the scheduler currently has awake (red overlay). */
  showActiveRef?: React.MutableRefObject<boolean>;
}

// Animated flow: a sparse highlight that drifts downstream. Only cells that are
// part of an actual stream (their downhill neighbour is also water) shimmer, and
// only the CREST of the wave brightens (never darkens) — so a sloped river shows
// a few glints travelling with the current rather than whole tiles strobing, and
// a lone wet tile or a flat lake stays calm.
const TAU = Math.PI * 2;
const FLOW_MIN = 0.04;   // surface drop below this = still water (no shimmer)
const FLOW_REF = 1.0;    // drop giving full-strength shimmer
const FLOW_FREQ = 0.32;  // ripple bands per cell (~3-cell wavelength)
const FLOW_AMP = 0.22;   // peak highlight depth (additive only, at the crest)
const FLOW_SPEED = 0.7;  // base scroll speed (cycles/sec)

export default function TerrainCanvas({ getState, gazeRef, toolRef, showActiveRef }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Previous gaze in cell space, for velocity + dwell detection.
  const prevCell = useRef<{ x: number; y: number } | null>(null);
  // Low-passed gaze velocity (cells/frame). Smooths eye-tracker jitter and the
  // 30 Hz gaze / 60 fps render mismatch so the brush's speed-based feel is stable.
  const vel = useRef({ x: 0, y: 0 });
  const dwellFrames = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const init = getState();
    canvas.width = init.cols;
    canvas.height = init.rows;
    const img = ctx.createImageData(init.cols, init.rows);

    let raf = 0;
    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      const state = getState();
      const { cols, rows, cells } = state;
      const ts = t * 0.001; // seconds, for flow animation

      // ── Gaze → cell-space, then drive the active tool ──────────────────────
      const gaze = gazeRef.current;
      let gx = -1, gy = -1;
      if (gaze.mode !== 'off' && gaze.x >= 0) {
        const rect = canvas.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          gx = ((gaze.x - rect.left) / rect.width) * cols;
          gy = ((gaze.y - rect.top) / rect.height) * rows;
        }
      }
      const onGrid = gx >= 0 && gx < cols && gy >= 0 && gy < rows;
      const tool = toolRef.current;

      if (onGrid && tool) {
        const prev = prevCell.current;
        const rawX = prev ? gx - prev.x : 0;
        const rawY = prev ? gy - prev.y : 0;
        // Exponential moving average → steady velocity despite jitter / 30 Hz gaze.
        vel.current.x = vel.current.x * 0.6 + rawX * 0.4;
        vel.current.y = vel.current.y * 0.6 + rawY * 0.4;
        const vx = vel.current.x, vy = vel.current.y;
        const moved = Math.hypot(vx, vy);

        if (tool === 'sculpt') {
          applyBrush(state, gx, gy, vx, vy);
        } else if (tool === 'water') {
          // Ramp pour intensity with dwell so a glance doesn't flood.
          if (moved < 0.6) dwellFrames.current += 1;
          else dwellFrames.current = 0;
          const intensity = Math.min(1, dwellFrames.current / POUR.rampFrames);
          if (intensity > 0) pourWater(state, gx, gy, intensity);
        }
      } else {
        dwellFrames.current = 0;
        vel.current.x = 0;
        vel.current.y = 0;
      }
      prevCell.current = onGrid ? { x: gx, y: gy } : null;

      // ── Render ─────────────────────────────────────────────────────────────
      const data = img.data;
      const wrap = state.wrap;
      // Prominence-box geometry for the elevation shade (read live so the debug
      // panel can tune it). Floored to an integer radius for the box loop.
      const shadeR = Math.max(1, Math.round(SHADE.promRadius));
      const shadeArea = (2 * shadeR + 1) * (2 * shadeR + 1);
      // Neighbour reads wrap on a torus; on a bounded map height clamps and the
      // water surface reads as sea level off-grid (so rivers animate off the edge).
      const h = (x: number, y: number) => {
        if (wrap) return cells[wrapCoord(y, rows) * cols + wrapCoord(x, cols)].height;
        return cells[Math.max(0, Math.min(rows - 1, y)) * cols + Math.max(0, Math.min(cols - 1, x))].height;
      };
      const surf = (x: number, y: number) => {
        if (wrap) { const cc = cells[wrapCoord(y, rows) * cols + wrapCoord(x, cols)]; return cc.height + cc.water; }
        if (x < 0 || x >= cols || y < 0 || y >= rows) return ECO.edgeDrainLevel;
        const cc = cells[y * cols + x];
        return cc.height + cc.water;
      };
      // Debug overlay: which cells the scheduler currently has awake.
      const due = showActiveRef?.current ? activeMask(state) : null;
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const c = cells[y * cols + x];
          const [r, g, b] = materialColor(c.height, c.moisture, c.water, c.fertility, c.plant);
          // Symmetric elevation shade: brightness from PROMINENCE (how far this
          // cell stands above the mean of its surroundings — the same rain-shadow
          // measure that drives rainfall) plus a gentle absolute-height tint. No
          // light direction, so a feature reads the same whichever way it faces.
          let sum = 0;
          for (let oy = -shadeR; oy <= shadeR; oy++)
            for (let ox = -shadeR; ox <= shadeR; ox++) sum += h(x + ox, y + oy);
          const prominence = c.height - sum / shadeArea;
          let factor = 1 + prominence * SHADE.promStrength + (c.height - BASELINE_HEIGHT) * SHADE.heightStrength;
          if (factor < SHADE.min) factor = SHADE.min;
          else if (factor > SHADE.max) factor = SHADE.max;
          // Animated downhill flow on surface water.
          if (c.water >= ECO.waterMin) {
            const s = c.height + c.water;
            let drop = 0, fdx = 0, fdy = 0;
            const e = s - surf(x + 1, y); if (e > drop) { drop = e; fdx = 1; fdy = 0; }
            const we = s - surf(x - 1, y); if (we > drop) { drop = we; fdx = -1; fdy = 0; }
            const so = s - surf(x, y + 1); if (so > drop) { drop = so; fdx = 0; fdy = 1; }
            const no = s - surf(x, y - 1); if (no > drop) { drop = no; fdx = 0; fdy = -1; }
            // The downhill neighbour must itself be flowing water, or this is a
            // lone tile / a stream's leading edge — which would just flash in
            // place rather than carry a travelling ripple.
            let dnx = x + fdx, dny = y + fdy;
            const downstreamInBounds = wrap || (dnx >= 0 && dnx < cols && dny >= 0 && dny < rows);
            if (wrap) { dnx = wrapCoord(dnx, cols); dny = wrapCoord(dny, rows); }
            const downstreamWet =
              downstreamInBounds && cells[dny * cols + dnx].water >= ECO.waterMin;
            if (drop > FLOW_MIN && downstreamWet) {
              const strength = Math.min(1, drop / FLOW_REF);
              const proj = x * fdx + y * fdy;
              const phase = proj * FLOW_FREQ - ts * FLOW_SPEED * (0.5 + strength);
              // Sparse crest: take only the positive lobe and square it, so just
              // a few cells along the stream glint at once and the tile only ever
              // brightens (no darkening half-cycle that reads as a flash).
              const crest = Math.max(0, Math.sin(phase * TAU));
              factor *= 1 + FLOW_AMP * strength * crest * crest;
            }
          }
          const o = (y * cols + x) * 4;
          let rr = r * factor, gg = g * factor, bb = b * factor;
          if (due && due[y * cols + x] >= 0) { rr = rr * 0.45 + 255 * 0.55; gg *= 0.45; bb *= 0.45; } // awake → red
          data[o] = Math.max(0, Math.min(255, rr));
          data[o + 1] = Math.max(0, Math.min(255, gg));
          data[o + 2] = Math.max(0, Math.min(255, bb));
          data[o + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);

      // Gaze cursor: a small ring so the player sees where the tool is acting.
      if (onGrid) {
        ctx.strokeStyle = tool === 'water' ? 'rgba(255,255,255,0.9)' : 'rgba(40,30,10,0.85)';
        ctx.lineWidth = 0.18;
        ctx.beginPath();
        ctx.arc(gx, gy, 1.1, 0, Math.PI * 2);
        ctx.stroke();
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [getState, gazeRef, toolRef]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full touch-none select-none"
      style={{ imageRendering: 'pixelated' }}
    />
  );
}
