// Sandbox Game — Cell System grid view (Step 2: the system running on tiles).
//
// Runs a validated SystemSpec across a small grid of tiles and renders it to a
// canvas (coloured by the spec's `display` field). Run / step / fast-forward to
// watch spread & flow settle; click a tile to seed / disturb it. Demonstrates
// that the coupled grid is still fast-forwardable — the same engine the terrain
// would eventually use for custom materials.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Play, Pause, FastForward, RotateCcw } from 'lucide-react';
import {
  createGrid, worldStep, gridFastForward, injectTile, totalField, pendingCount,
  type CellGrid, type SystemSpec, type DisplaySpec,
} from '@shared/world-engine/kernel/cells';

const GRID_N = 24;          // tiles per side
const CANVAS_PX = 336;      // square render size
const RUN_TICK_MS = 80;
const RUN_STEPS_PER_TICK = 1;

interface Props {
  spec: SystemSpec;
}

function resolveDisplay(spec: SystemSpec): DisplaySpec {
  if (spec.display) return spec.display;
  const v = spec.vars?.[0];
  return { field: v?.name ?? '', kind: 'var', min: v?.min ?? 0, max: v?.max ?? 1 };
}

export default function CellGridView({ spec }: Props) {
  const gridRef = useRef<CellGrid | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [running, setRunning] = useState(false);
  const [, setHeartbeat] = useState(0);
  const beat = () => setHeartbeat(h => (h + 1) & 0xffff);

  const disp = resolveDisplay(spec);

  // (Re)create the grid whenever the spec changes.
  useEffect(() => {
    gridRef.current = createGrid(spec, GRID_N, GRID_N);
    setRunning(false);
    beat();
  }, [spec]);

  const draw = useCallback(() => {
    const grid = gridRef.current;
    const canvas = canvasRef.current;
    if (!grid || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const cell = CANVAS_PX / grid.cols;
    const from = disp.from ?? [20, 24, 40];
    const to = disp.to ?? [120, 200, 255];
    const isStage = disp.kind === 'stage';
    const stages = isStage ? spec.states?.find(s => s.name === disp.field)?.stages.length ?? 1 : 1;
    const lo = disp.min ?? 0;
    const hi = disp.max ?? 1;
    for (let i = 0; i < grid.cols * grid.rows; i++) {
      let frac: number;
      if (isStage) frac = grid.stageIdx[disp.field] ? grid.stageIdx[disp.field][i] / Math.max(1, stages - 1) : 0;
      else { const v = grid.fields[disp.field] ? grid.fields[disp.field][i] : 0; frac = (v - lo) / (hi - lo || 1); }
      frac = Math.max(0, Math.min(1, frac));
      const r = Math.round(from[0] + (to[0] - from[0]) * frac);
      const g = Math.round(from[1] + (to[1] - from[1]) * frac);
      const b = Math.round(from[2] + (to[2] - from[2]) * frac);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect((i % grid.cols) * cell, ((i / grid.cols) | 0) * cell, cell + 1, cell + 1);
    }
  }, [spec, disp]);

  // Redraw on every heartbeat.
  useEffect(() => { draw(); });

  // Auto-run loop.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      if (gridRef.current) { gridFastForward(gridRef.current, RUN_STEPS_PER_TICK); beat(); }
    }, RUN_TICK_MS);
    return () => clearInterval(id);
  }, [running]);

  const advance = (steps: number) => { if (gridRef.current) { gridFastForward(gridRef.current, steps); beat(); } };
  const restart = () => { gridRef.current = createGrid(spec, GRID_N, GRID_N); setRunning(false); beat(); };

  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const grid = gridRef.current;
    const canvas = canvasRef.current;
    if (!grid || !canvas || disp.kind === 'stage') return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * grid.cols);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * grid.rows);
    if (x < 0 || y < 0 || x >= grid.cols || y >= grid.rows) return;
    const span = (disp.max ?? 1) - (disp.min ?? 0);
    injectTile(grid, y * grid.cols + x, disp.field, span * 0.9); // seed the display field
    beat();
  };

  const grid = gridRef.current;

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="uppercase tracking-wide text-slate-400 text-[10px]">
          Grid {GRID_N}×{GRID_N} · step {grid?.clock ?? 0}
        </h3>
        <span className="text-[10px] text-slate-500">
          {grid && pendingCount(grid) === 0 ? 'at rest' : `${grid ? pendingCount(grid) : 0} awake`}
        </span>
      </div>

      <canvas
        ref={canvasRef}
        width={CANVAS_PX}
        height={CANVAS_PX}
        onClick={onCanvasClick}
        title={disp.kind === 'stage' ? '' : `Click to seed ${disp.field}`}
        className="w-full rounded border border-slate-700 bg-slate-900 cursor-crosshair"
        style={{ imageRendering: 'pixelated' }}
      />

      <div className="flex items-center justify-between text-[10px] text-slate-400">
        <span>colour: <span className="text-slate-200">{disp.field}</span> ({disp.kind ?? 'var'})</span>
        {grid && grid.fields[disp.field] && disp.kind !== 'stage' && (
          <span>total {disp.field}: <span className="font-mono text-slate-200">{totalField(grid, disp.field).toFixed(1)}</span></span>
        )}
      </div>

      <div className="flex items-center gap-1">
        <button data-dwell onClick={() => setRunning(r => !r)}
          className={`flex-1 py-1 rounded font-semibold active:scale-95 transition-transform flex items-center justify-center gap-1 ${running ? 'bg-rose-600 hover:bg-rose-500' : 'bg-emerald-600 hover:bg-emerald-500'}`}>
          {running ? <><Pause size={12} />Pause</> : <><Play size={12} />Run</>}
        </button>
        <button data-dwell onClick={() => advance(1)} title="Step once"
          className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 active:scale-95 transition-transform">+1</button>
        <button data-dwell onClick={() => advance(100)} title="Fast-forward 100 steps"
          className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 active:scale-95 transition-transform flex items-center gap-0.5"><FastForward size={11} />100</button>
        <button data-dwell onClick={() => advance(100_000)} title="Fast-forward a long absence"
          className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 active:scale-95 transition-transform flex items-center gap-0.5"><FastForward size={11} />100k</button>
        <button data-dwell onClick={restart} title="Restart from initial state"
          className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 active:scale-95 transition-transform"><RotateCcw size={12} /></button>
      </div>
    </section>
  );
}
