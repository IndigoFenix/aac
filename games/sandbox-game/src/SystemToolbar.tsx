// Sandbox Game — toolbar for the cell-system main grid. Renders the buttons a
// spec DECLARES (its `tools`), selectable by click or eyegaze dwell (same dwell
// ring as the terrain toolbar).

import { useEffect, useRef, useState } from 'react';
import type { ToolSpec } from '@shared/engine/cells';
import type { GazeState } from './TerrainCanvas';

interface Props {
  tools: ToolSpec[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  gazeRef: React.MutableRefObject<GazeState>;
  dwellMs: number;
  dwellEnabled: boolean;
}

export default function SystemToolbar({ tools, selectedId, onSelect, gazeRef, dwellMs, dwellEnabled }: Props) {
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [dwell, setDwell] = useState<{ index: number; progress: number } | null>(null);

  useEffect(() => {
    let raf = 0, hoverIndex = -1, hoverStart = 0, fired = false;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const gaze = gazeRef.current;
      if (!dwellEnabled || gaze.mode === 'off' || gaze.x < 0) {
        if (hoverIndex !== -1) { hoverIndex = -1; setDwell(null); }
        return;
      }
      let over = -1;
      for (let i = 0; i < btnRefs.current.length; i++) {
        const el = btnRefs.current[i];
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (gaze.x >= r.left && gaze.x <= r.right && gaze.y >= r.top && gaze.y <= r.bottom) { over = i; break; }
      }
      if (over !== hoverIndex) { hoverIndex = over; hoverStart = now; fired = false; }
      if (over === -1) { setDwell(null); return; }
      const progress = Math.min(1, (now - hoverStart) / dwellMs);
      setDwell({ index: over, progress });
      if (progress >= 1 && !fired) { fired = true; onSelect(tools[over].id); }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [gazeRef, dwellMs, onSelect, dwellEnabled, tools]);

  return (
    <div className="flex flex-col gap-3 p-2">
      {tools.map((tool, i) => {
        const active = selectedId === tool.id;
        const dwelling = dwell?.index === i ? dwell.progress : 0;
        return (
          <button
            key={tool.id}
            ref={el => { btnRefs.current[i] = el; }}
            data-dwell
            onClick={() => onSelect(tool.id)}
            title={tool.label}
            aria-label={`${tool.label} tool`}
            className={`relative flex flex-col items-center justify-center rounded-2xl p-2 aspect-square font-bold transition-all select-none touch-none ${
              active ? 'bg-amber-400 text-amber-950 scale-105 shadow-lg' : 'bg-amber-900/60 text-amber-100 hover:bg-amber-800'
            }`}
          >
            {dwelling > 0 && (
              <span className="absolute inset-0 rounded-2xl pointer-events-none"
                style={{ background: `conic-gradient(rgba(255,255,255,0.55) ${dwelling * 360}deg, transparent 0deg)` }} />
            )}
            <span className="text-2xl leading-none">{tool.symbol}</span>
            <span className="mt-1 text-xs leading-tight">{tool.label}</span>
          </button>
        );
      })}
    </div>
  );
}
