// Sandbox Game — tool sidebar. Two tools (Sculpt / Water), selectable by click
// OR by eyegaze dwell (gaze rests on a button ≥ dwellMs → select), with a
// progress ring so the player sees the dwell building.

import { useEffect, useRef, useState } from 'react';
import type { ToolId } from './types';
import type { GazeState } from './TerrainCanvas';

interface ToolDef {
  id: ToolId;
  label: string;
  symbol: string;
  hint: string;
}

const TOOLS: ToolDef[] = [
  { id: 'sculpt', label: 'Dig', symbol: '⛏️', hint: 'Sweep to push sand — dig valleys, pile hills' },
  { id: 'water', label: 'Water', symbol: '💧', hint: 'Rest your gaze to pour water' },
];

interface Props {
  selectedTool: ToolId | null;
  onSelectTool: (tool: ToolId) => void;
  gazeRef: React.MutableRefObject<GazeState>;
  dwellMs: number;
  /** Dwell-to-select is only active when the platform has an eyegaze/cursor-control
   *  dwell control enabled. With plain mouse/touch the buttons use real clicks. */
  dwellEnabled: boolean;
}

export default function GameToolbar({ selectedTool, onSelectTool, gazeRef, dwellMs, dwellEnabled }: Props) {
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Which button the gaze is dwelling on, and how far along (0..1).
  const [dwell, setDwell] = useState<{ index: number; progress: number } | null>(null);

  useEffect(() => {
    let raf = 0;
    let hoverIndex = -1;
    let hoverStart = 0;
    let fired = false;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const gaze = gazeRef.current;
      // No dwell unless the platform has a dwell control enabled — otherwise a
      // plain mouse press-drag over a button would select it. Buttons use onClick.
      if (!dwellEnabled || gaze.mode === 'off' || gaze.x < 0) {
        if (hoverIndex !== -1) { hoverIndex = -1; setDwell(null); }
        return;
      }
      let over = -1;
      for (let i = 0; i < btnRefs.current.length; i++) {
        const el = btnRefs.current[i];
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (gaze.x >= r.left && gaze.x <= r.right && gaze.y >= r.top && gaze.y <= r.bottom) {
          over = i;
          break;
        }
      }
      if (over !== hoverIndex) {
        hoverIndex = over;
        hoverStart = now;
        fired = false;
      }
      if (over === -1) {
        setDwell(null);
        return;
      }
      const progress = Math.min(1, (now - hoverStart) / dwellMs);
      setDwell({ index: over, progress });
      if (progress >= 1 && !fired) {
        fired = true;
        onSelectTool(TOOLS[over].id);
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [gazeRef, dwellMs, onSelectTool, dwellEnabled]);

  return (
    <div className="flex flex-col gap-3 p-2">
      {TOOLS.map((tool, i) => {
        const active = selectedTool === tool.id;
        const dwelling = dwell?.index === i ? dwell.progress : 0;
        return (
          <button
            key={tool.id}
            ref={el => { btnRefs.current[i] = el; }}
            data-dwell
            onClick={() => onSelectTool(tool.id)}
            title={tool.hint}
            aria-label={`${tool.label} tool — ${tool.hint}`}
            className={`relative flex flex-col items-center justify-center rounded-2xl p-2 aspect-square font-bold transition-all select-none touch-none ${
              active
                ? 'bg-amber-400 text-amber-950 scale-105 shadow-lg'
                : 'bg-amber-900/60 text-amber-100 hover:bg-amber-800'
            }`}
          >
            {/* Dwell progress ring */}
            {dwelling > 0 && (
              <span
                className="absolute inset-0 rounded-2xl pointer-events-none"
                style={{
                  background: `conic-gradient(rgba(255,255,255,0.55) ${dwelling * 360}deg, transparent 0deg)`,
                }}
              />
            )}
            <span className="text-2xl leading-none">{tool.symbol}</span>
            <span className="mt-1 text-xs leading-tight">{tool.label}</span>
          </button>
        );
      })}
    </div>
  );
}
