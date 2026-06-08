// Sandbox Game — terrain renderer + per-frame gaze interaction loop.
//
// Renders "colored boxes" by drawing one backing pixel per cell and letting CSS
// scale the canvas up with `image-rendering: pixelated` (crisp squares, cheap).
// The same rAF loop owns the canvas geometry, so it also maps the gaze position
// into cell space and drives the sculpt brush / water pour for the active tool.

import { useEffect, useRef } from 'react';
import type { GameState, ToolId } from './types';
import { materialColor, POUR } from './config';
import { applyBrush } from './sculpt';
import { pourWater } from './engine';

export interface GazeState {
  x: number; // iframe-local px
  y: number;
  mode: 'off' | 'eyegaze' | 'mouse';
}

interface Props {
  getState: () => GameState;
  gazeRef: React.MutableRefObject<GazeState>;
  toolRef: React.MutableRefObject<ToolId | null>;
}

const SHADE_STRENGTH = 0.07; // how strongly slope lightens/darkens relief

export default function TerrainCanvas({ getState, gazeRef, toolRef }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Previous gaze in cell space, for velocity + dwell detection.
  const prevCell = useRef<{ x: number; y: number } | null>(null);
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
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const state = getState();
      const { cols, rows, cells } = state;

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
        const vx = prev ? gx - prev.x : 0;
        const vy = prev ? gy - prev.y : 0;
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
      }
      prevCell.current = onGrid ? { x: gx, y: gy } : null;

      // ── Render ─────────────────────────────────────────────────────────────
      const data = img.data;
      const h = (x: number, y: number) =>
        cells[Math.max(0, Math.min(rows - 1, y)) * cols + Math.max(0, Math.min(cols - 1, x))].height;
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const c = cells[y * cols + x];
          const [r, g, b] = materialColor(c.height, c.moisture, c.water, c.plant);
          // Slope-based relief shade (light from the top-left).
          const slope = (h(x + 1, y) - h(x - 1, y)) + (h(x, y + 1) - h(x, y - 1));
          const factor = Math.max(0.55, Math.min(1.4, 1 - slope * SHADE_STRENGTH));
          const o = (y * cols + x) * 4;
          data[o] = Math.max(0, Math.min(255, r * factor));
          data[o + 1] = Math.max(0, Math.min(255, g * factor));
          data[o + 2] = Math.max(0, Math.min(255, b * factor));
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
