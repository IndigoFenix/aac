// Sandbox Game — main-canvas renderer + gaze interaction for a CELL SYSTEM grid.
//
// The spec-driven analogue of TerrainCanvas: one backing pixel per tile (CSS
// scales it up, pixelated), a per-frame rAF loop that maps the gaze into tile
// space and applies the selected TOOL (paint material / change substrate), and a
// COMPOSITE renderer driven by the spec's `display.layers` (substrate relief →
// plants → water → stone). Reads the live CellGrid each frame; the simulation
// itself is ticked by useSystemGrid.

import { useEffect, useRef } from 'react';
import type { GazeState } from './TerrainCanvas';
import type { CellGrid, SystemSpec, ToolSpec, LayerSpec } from '@shared/world-engine/kernel/cells';
import { injectTile, setStageTile } from '@shared/world-engine/kernel/cells';

interface Props {
  getGrid: () => CellGrid;
  gazeRef: React.MutableRefObject<GazeState>;
  toolRef: React.MutableRefObject<ToolSpec | null>;
  spec: SystemSpec;
}

const RAMP_FRAMES = 16; // dwell frames before a tool ramps to full strength

function lerp(a: number, b: number, t: number) { return a + (b - a) * Math.max(0, Math.min(1, t)); }

export default function SystemCanvas({ getGrid, gazeRef, toolRef, spec }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dwell = useRef(0);
  const prev = useRef<{ x: number; y: number } | null>(null);
  const lastT = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const g0 = getGrid();
    canvas.width = g0.cols;
    canvas.height = g0.rows;
    let img = ctx.createImageData(g0.cols, g0.rows);

    // Resolve display layers (fallback: the single display field, else first var).
    const layers: LayerSpec[] = spec.display?.layers
      ?? (spec.display ? [spec.display] : spec.vars?.[0] ? [{ field: spec.vars[0].name }] : []);
    const stageCount = (field: string) => spec.states?.find(s => s.name === field)?.stages.length ?? 1;

    let raf = 0;
    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      const grid = getGrid();
      const { cols, rows } = grid;
      if (canvas.width !== cols || canvas.height !== rows) { canvas.width = cols; canvas.height = rows; img = ctx.createImageData(cols, rows); }
      const dt = lastT.current ? Math.min(0.1, (t - lastT.current) / 1000) : 0;
      lastT.current = t;

      // ── Gaze → tile space, then apply the active tool ──────────────────────
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
        const p = prev.current;
        const moved = p ? Math.hypot(gx - p.x, gy - p.y) : 0;
        if (moved < 0.6) dwell.current += 1; else dwell.current = Math.max(0, dwell.current - 2);
        const intensity = Math.min(1, dwell.current / RAMP_FRAMES);
        if (intensity > 0) applyTool(grid, tool, gx, gy, intensity, dt, stageCount);
      } else {
        dwell.current = 0;
      }
      prev.current = onGrid ? { x: gx, y: gy } : null;

      // ── Composite render ────────────────────────────────────────────────────
      const data = img.data;
      const heightArr = grid.fields['height'];
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const i = y * cols + x;
          let r = 30, gg = 30, b = 36;
          for (let li = 0; li < layers.length; li++) {
            const L = layers[li];
            let val: number, frac: number;
            if (L.kind === 'stage') { val = grid.stageIdx[L.field]?.[i] ?? 0; frac = val / Math.max(1, stageCount(L.field) - 1); }
            else { val = grid.fields[L.field]?.[i] ?? 0; const lo = L.min ?? 0, hi = L.max ?? 1; frac = (val - lo) / (hi - lo || 1); }
            if (li > 0 && !(val > (L.over ?? 0.0001))) continue; // overlay only where present
            const from = L.from ?? [20, 24, 40], to = L.to ?? [120, 200, 255];
            let cr = lerp(from[0], to[0], frac), cg = lerp(from[1], to[1], frac), cb = lerp(from[2], to[2], frac);
            if (L.shade && heightArr) {
              // Cheap symmetric relief: brighten where above the 4-neighbour mean.
              const hC = heightArr[i];
              let sum = 0, n = 0;
              if (x > 0) { sum += heightArr[i - 1]; n++; }
              if (x < cols - 1) { sum += heightArr[i + 1]; n++; }
              if (y > 0) { sum += heightArr[i - cols]; n++; }
              if (y < rows - 1) { sum += heightArr[i + cols]; n++; }
              const f = Math.max(0.7, Math.min(1.3, 1 + (hC - (n ? sum / n : hC)) * 0.08));
              cr *= f; cg *= f; cb *= f;
            }
            r = cr; gg = cg; b = cb;
          }
          const o = i * 4;
          data[o] = Math.max(0, Math.min(255, r));
          data[o + 1] = Math.max(0, Math.min(255, gg));
          data[o + 2] = Math.max(0, Math.min(255, b));
          data[o + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);

      if (onGrid) {
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 0.18;
        ctx.beginPath();
        ctx.arc(gx, gy, (tool?.radius ?? 1.5), 0, Math.PI * 2);
        ctx.stroke();
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [getGrid, gazeRef, toolRef, spec]);

  return <canvas ref={canvasRef} className="w-full h-full touch-none select-none" style={{ imageRendering: 'pixelated' }} />;
}

/** Paint a tool over the tiles under the brush (radius, distance falloff). Paints
 *  are per-second amounts scaled by dwell-intensity and dt; setStage fires once. */
function applyTool(
  grid: CellGrid, tool: ToolSpec, gx: number, gy: number, intensity: number, dt: number,
  _stageCount: (f: string) => number,
): void {
  const r = tool.radius ?? 1.5;
  const x0 = Math.max(0, Math.floor(gx - r)), x1 = Math.min(grid.cols - 1, Math.ceil(gx + r));
  const y0 = Math.max(0, Math.floor(gy - r)), y1 = Math.min(grid.rows - 1, Math.ceil(gy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dist = Math.hypot(x + 0.5 - gx, y + 0.5 - gy);
      if (dist > r) continue;
      const falloff = 1 - dist / r;
      const cell = y * grid.cols + x;
      for (const p of tool.paints ?? []) injectTile(grid, cell, p.scalar, p.amount * intensity * dt * falloff);
      if (tool.setStage && intensity > 0.5) setStageTile(grid, cell, tool.setStage.state, tool.setStage.to);
    }
  }
}
