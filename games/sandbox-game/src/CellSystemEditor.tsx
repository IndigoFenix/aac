// Sandbox Game — Cell System editor / flask lab (Step 1).
//
// A self-contained drawer for authoring a JSON "enclosed system" and watching a
// single cell (the flask) run it. Edit the JSON, Load it (it's validated for the
// idle-safety guarantees first — errors block the load, warnings don't), then
// Step / Run / fast-forward to watch it reach rest or ride a predictable cycle.
// Disturb a settled cell with the +/- inputs to see it re-settle.
//
// Everything here is local to the drawer: the flask cell lives in a ref and a
// heartbeat re-renders it. It does NOT touch the terrain world — Step 2 will be
// where these systems drive actual tiles.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, Play, Pause, FastForward, RotateCcw, Check, AlertTriangle, FlaskConical, Grid3x3 } from 'lucide-react';
import {
  instantiate, stepOne, fastForward, inject,
  validateSpec, SAFE_EXAMPLES, GRID_EXAMPLES,
  type SystemSpec, type CellInstance, type ValidationResult,
} from './cell-systems';
import CellGridView from './CellGridView';

/** A spec is grid-oriented if it uses neighbour transport. */
function usesTransport(spec: SystemSpec): boolean {
  return spec.rules.some(r => r.effects.some(e => 'spread' in e || 'flowDown' in e));
}

const STORAGE_KEY = 'sandbox_cellsystem_json';
const RUN_TICK_MS = 120;       // wall-clock between auto-run advances
const RUN_STEPS_PER_TICK = 2;  // cell-steps per tick while running

interface Props {
  onClose: () => void;
  /** Push the currently-loaded spec onto the main grid (switches to Systems mode). */
  onApplyToGrid?: (spec: SystemSpec) => void;
}

export default function CellSystemEditor({ onClose, onApplyToGrid }: Props) {
  const [text, setText] = useState<string>(() => {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    return saved ?? JSON.stringify(SAFE_EXAMPLES[0], null, 2);
  });
  const [result, setResult] = useState<ValidationResult | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState<'flask' | 'grid'>('flask');
  const [spec, setSpec] = useState<SystemSpec | null>(null);
  const [, setHeartbeat] = useState(0);
  const beat = () => setHeartbeat(h => (h + 1) & 0xffff);

  const instRef = useRef<CellInstance | null>(null);

  /** Parse + validate the editor text. On success (no errors) instantiate a fresh
   *  flask. Warnings are surfaced but don't block. */
  const load = useCallback(() => {
    setRunning(false);
    let parsed: SystemSpec;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setParseError(e instanceof Error ? e.message : String(e));
      setResult(null);
      instRef.current = null;
      setSpec(null);
      return;
    }
    setParseError(null);
    const r = validateSpec(parsed);
    setResult(r);
    if (r.ok) {
      instRef.current = instantiate(parsed);
      setSpec(parsed);
      setMode(usesTransport(parsed) ? 'grid' : 'flask'); // grid specs default to the grid view
      localStorage.setItem(STORAGE_KEY, text);
    } else {
      instRef.current = null;
      setSpec(null);
    }
    beat();
  }, [text]);

  // Load whatever's in the editor on first open.
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const loadExample = (spec: SystemSpec) => {
    setText(JSON.stringify(spec, null, 2));
    setRunning(false);
  };
  // When the text is swapped to an example, auto-load it.
  const prevText = useRef(text);
  useEffect(() => {
    if (prevText.current !== text) { prevText.current = text; }
  }, [text]);

  const restart = useCallback(() => {
    const inst = instRef.current;
    if (inst) { instRef.current = instantiate(inst.spec); beat(); }
    setRunning(false);
  }, []);

  const advance = useCallback((steps: number) => {
    if (instRef.current) { fastForward(instRef.current, steps); beat(); }
  }, []);

  // Auto-run loop.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      if (instRef.current) { fastForward(instRef.current, RUN_STEPS_PER_TICK); beat(); }
    }, RUN_TICK_MS);
    return () => clearInterval(id);
  }, [running]);

  const inst = instRef.current;

  return (
    <div className="absolute top-0 right-0 h-full w-[22rem] sm:w-[26rem] bg-slate-950/97 border-l border-slate-700 text-slate-100 flex flex-col z-20 shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 shrink-0">
        <span className="font-bold text-sm flex items-center gap-1.5">🧪 Cell System Lab</span>
        <button onClick={onClose} className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800" aria-label="Close cell system lab">
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3 text-xs">
        {/* Examples */}
        <section>
          <h3 className="uppercase tracking-wide text-slate-400 text-[10px] mb-1">Flask examples (Step 1)</h3>
          <div className="flex flex-wrap gap-1">
            {SAFE_EXAMPLES.map(ex => (
              <button key={ex.id} data-dwell onClick={() => loadExample(ex)} title={ex.description}
                className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 active:scale-95 transition-transform">
                {ex.name ?? ex.id}
              </button>
            ))}
          </div>
          <h3 className="uppercase tracking-wide text-slate-400 text-[10px] mb-1 mt-2">Grid examples (Step 2)</h3>
          <div className="flex flex-wrap gap-1">
            {GRID_EXAMPLES.map(ex => (
              <button key={ex.id} data-dwell onClick={() => loadExample(ex)} title={ex.description}
                className="px-2 py-0.5 rounded bg-sky-900/70 hover:bg-sky-800 active:scale-95 transition-transform">
                {ex.name ?? ex.id}
              </button>
            ))}
          </div>
        </section>

        {/* JSON editor */}
        <section>
          <h3 className="uppercase tracking-wide text-slate-400 text-[10px] mb-1">System (JSON)</h3>
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            spellCheck={false}
            className="w-full h-48 px-2 py-1 rounded bg-slate-900 border border-slate-700 font-mono text-[11px] leading-snug text-slate-100 focus:outline-none focus:border-sky-500 resize-y"
          />
          <div className="mt-1 flex gap-1">
            <button
              data-dwell
              onClick={load}
              className="flex-1 py-1 rounded bg-sky-600 hover:bg-sky-500 font-semibold active:scale-95 transition-transform"
            >
              Load &amp; validate
            </button>
            {onApplyToGrid && (
              <button
                data-dwell
                disabled={!spec}
                onClick={() => spec && onApplyToGrid(spec)}
                title="Run this system on the main grid"
                className="px-2 py-1 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed font-semibold active:scale-95 transition-transform"
              >
                ⇪ Main grid
              </button>
            )}
          </div>
        </section>

        {/* Validation result */}
        {parseError && (
          <p className="rounded bg-red-950/70 border border-red-800 px-2 py-1 text-red-200">
            <AlertTriangle size={12} className="inline mr-1" />JSON parse error: {parseError}
          </p>
        )}
        {result && result.errors.length > 0 && (
          <ul className="rounded bg-red-950/70 border border-red-800 px-2 py-1 text-red-200 space-y-1 list-disc list-inside">
            {result.errors.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        )}
        {result && result.ok && (
          <p className="rounded bg-emerald-950/60 border border-emerald-800 px-2 py-1 text-emerald-200">
            <Check size={12} className="inline mr-1" />Idle-safe — accepted.
          </p>
        )}
        {result && result.warnings.length > 0 && (
          <ul className="rounded bg-amber-950/60 border border-amber-800 px-2 py-1 text-amber-200 space-y-1 list-disc list-inside">
            {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        )}

        {/* Flask / Grid mode toggle */}
        {spec && (
          <div className="flex gap-1">
            <button data-dwell onClick={() => { setRunning(false); setMode('flask'); }}
              className={`flex-1 py-1 rounded flex items-center justify-center gap-1 ${mode === 'flask' ? 'bg-sky-700 text-white' : 'bg-slate-800 hover:bg-slate-700'}`}>
              <FlaskConical size={12} />Flask
            </button>
            <button data-dwell onClick={() => { setRunning(false); setMode('grid'); }}
              className={`flex-1 py-1 rounded flex items-center justify-center gap-1 ${mode === 'grid' ? 'bg-sky-700 text-white' : 'bg-slate-800 hover:bg-slate-700'}`}>
              <Grid3x3 size={12} />Grid
            </button>
          </div>
        )}

        {/* Grid view (Step 2) */}
        {mode === 'grid' && spec && <CellGridView key={`${spec.id}:${spec.rules.length}`} spec={spec} />}

        {/* Live flask state */}
        {mode === 'flask' && inst && (
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="uppercase tracking-wide text-slate-400 text-[10px]">Flask · step {inst.clock}</h3>
              {inst.armed.size > 0 && <span className="text-[10px] text-sky-300">{inst.armed.size} timer(s) pending</span>}
            </div>

            {/* Stages */}
            {(inst.spec.states ?? []).map(s => (
              <div key={s.name} className="flex items-center gap-2">
                <span className="text-slate-400 w-16 truncate">{s.name}</span>
                <span className="font-semibold text-sky-200">{inst.stages[s.name]}</span>
                <span className="text-slate-600 text-[10px]">
                  ({s.stages.indexOf(inst.stages[s.name]) + 1}/{s.stages.length})
                </span>
              </div>
            ))}

            {/* Scalars as bars, with disturb buttons */}
            {(inst.spec.vars ?? []).map(v => {
              const val = inst.scalars[v.name];
              const frac = (val - v.min) / (v.max - v.min);
              return (
                <div key={v.name}>
                  <div className="flex items-center justify-between">
                    <span className={v.budget ? 'text-amber-300' : 'text-slate-300'}>
                      {v.name}{v.budget ? ' (budget)' : ''}
                    </span>
                    <span className="font-mono text-slate-200">{val.toFixed(3)}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="flex-1 h-2 rounded bg-slate-800 overflow-hidden">
                      <div
                        className={`h-full ${v.budget ? 'bg-amber-500' : 'bg-sky-500'}`}
                        style={{ width: `${Math.max(0, Math.min(1, frac)) * 100}%` }}
                      />
                    </div>
                    <button data-dwell onClick={() => { inject(inst, v.name, +1); beat(); }}
                      className="px-1.5 rounded bg-slate-800 hover:bg-slate-700 text-[10px]" title={`Disturb: ${v.name} +1`}>+</button>
                    <button data-dwell onClick={() => { inject(inst, v.name, -1); beat(); }}
                      className="px-1.5 rounded bg-slate-800 hover:bg-slate-700 text-[10px]" title={`Disturb: ${v.name} -1`}>−</button>
                  </div>
                </div>
              );
            })}

            {/* Clocks */}
            {(inst.spec.clocks ?? []).map(c => {
              const frac = inst.clockPhase[c.name] / c.period;
              return (
                <div key={c.name}>
                  <div className="flex items-center justify-between">
                    <span className="text-violet-300">{c.name} (clock)</span>
                    <span className="font-mono text-slate-200">{(frac * 100).toFixed(0)}%</span>
                  </div>
                  <div className="h-2 rounded bg-slate-800 overflow-hidden">
                    <div className="h-full bg-violet-500" style={{ width: `${frac * 100}%` }} />
                  </div>
                </div>
              );
            })}

            {/* Event log */}
            {inst.log.length > 0 && (
              <div className="rounded bg-slate-900/80 border border-slate-800 px-2 py-1 max-h-24 overflow-y-auto font-mono text-[10px] text-slate-400 space-y-0.5">
                {inst.log.slice(-12).map((e, i) => (
                  <div key={i}><span className="text-slate-600">{e.clock}</span> {e.text}</div>
                ))}
              </div>
            )}
          </section>
        )}
      </div>

      {/* Run controls (flask) */}
      {mode === 'flask' && inst && (
        <div className="flex items-center gap-1 px-3 py-2 border-t border-slate-700 shrink-0">
          <button data-dwell onClick={() => setRunning(r => !r)}
            className={`flex-1 py-1 rounded font-semibold active:scale-95 transition-transform flex items-center justify-center gap-1 ${running ? 'bg-rose-600 hover:bg-rose-500' : 'bg-emerald-600 hover:bg-emerald-500'}`}>
            {running ? <><Pause size={12} />Pause</> : <><Play size={12} />Run</>}
          </button>
          <button data-dwell onClick={() => advance(1)} title="Step once"
            className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 active:scale-95 transition-transform">+1</button>
          <button data-dwell onClick={() => advance(100)} title="Fast-forward 100 steps"
            className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 active:scale-95 transition-transform flex items-center gap-0.5"><FastForward size={11} />100</button>
          <button data-dwell onClick={() => advance(100_000)} title="Fast-forward a long absence (100k steps)"
            className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 active:scale-95 transition-transform flex items-center gap-0.5"><FastForward size={11} />100k</button>
          <button data-dwell onClick={restart} title="Restart from initial state"
            className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 active:scale-95 transition-transform"><RotateCcw size={12} /></button>
        </div>
      )}
    </div>
  );
}
