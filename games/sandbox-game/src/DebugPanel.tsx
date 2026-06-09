// Sandbox Game — side debug panel for live-tuning the simulation parameters.
//
// Lists every numeric knob in config.ts (ecology, fertility, brush, water),
// grouped, as number inputs. "Apply" mutates the live config + persists it +
// re-settles the world; "Reset" restores the built-in defaults. Changes stick
// across reloads (see debug-config.ts).

import { useState } from 'react';
import { X, Info } from 'lucide-react';
import { getTunables, GROUP_ORDER, type Tunable } from './debug-config';

interface Props {
  onApply: (draft: Record<string, number>) => void;
  onReset: () => void;
  onClose: () => void;
}

export default function DebugPanel({ onApply, onReset, onClose }: Props) {
  // Snapshot the tunables (with their current live values) when the panel opens.
  const [tunables] = useState<Tunable[]>(getTunables);
  const [draft, setDraft] = useState<Record<string, number>>(
    () => Object.fromEntries(tunables.map(t => [t.flat, t.value])),
  );
  const [showDesc, setShowDesc] = useState(true);

  const edit = (flat: string, raw: string) => {
    const v = parseFloat(raw);
    setDraft(d => ({ ...d, [flat]: Number.isFinite(v) ? v : d[flat] }));
  };

  return (
    <div className="absolute top-0 right-0 h-full w-60 sm:w-64 bg-amber-950/95 border-l border-amber-700 text-amber-100 flex flex-col z-20 shadow-2xl">
      <div className="flex items-center justify-between px-3 py-2 border-b border-amber-800 shrink-0">
        <span className="font-bold text-sm">Tuning</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowDesc(d => !d)}
            className={`p-1 rounded hover:bg-amber-800 ${showDesc ? 'text-emerald-300' : 'text-amber-300 hover:text-white'}`}
            aria-label="Toggle parameter descriptions"
            title="Show/hide what each parameter does"
          >
            <Info size={16} />
          </button>
          <button onClick={onClose} className="p-1 rounded text-amber-300 hover:text-white hover:bg-amber-800" aria-label="Close tuning panel">
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 text-xs space-y-3">
        {GROUP_ORDER.map(g => (
          <section key={g}>
            <h3 className="uppercase tracking-wide text-amber-400 text-[10px] mb-1">{g}</h3>
            <div className="space-y-1">
              {tunables.filter(t => t.group === g).map(t => {
                const changed = draft[t.flat] !== t.def;
                return (
                  <div key={t.flat}>
                    <label className="flex items-center justify-between gap-2">
                      <span className={`truncate ${changed ? 'text-emerald-300' : 'text-amber-200'}`} title={`${t.desc}\n(default ${t.def})`}>
                        {t.key}
                      </span>
                      <input
                        type="number"
                        step={t.step}
                        value={draft[t.flat]}
                        onChange={e => edit(t.flat, e.target.value)}
                        className="w-20 px-1 py-0.5 rounded bg-amber-900 border border-amber-700 text-right text-amber-50 focus:outline-none focus:border-amber-400"
                      />
                    </label>
                    {showDesc && t.desc && (
                      <p className="text-[10px] leading-tight text-amber-400/80 mt-0.5 mb-1">{t.desc}</p>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      <div className="flex gap-2 px-3 py-2 border-t border-amber-800 shrink-0">
        <button
          onClick={() => onApply(draft)}
          className="flex-1 py-1 rounded bg-emerald-600 hover:bg-emerald-500 font-semibold active:scale-95 transition-transform"
        >
          Apply
        </button>
        <button
          onClick={() => { onReset(); setDraft(Object.fromEntries(tunables.map(t => [t.flat, t.def]))); }}
          className="px-2 py-1 rounded bg-amber-800 hover:bg-amber-700 active:scale-95 transition-transform"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
