// Musical Microbes — Main app component.
//
// A calm generative-music sandbox. Place Pulsers (heartbeats) and Responders
// (notes) in the tank and listen to the patterns that emerge. There are no
// wrong notes — a hidden scale + beat grid keep everything in tune (see audio.ts
// and engine.ts).
//
// Unified controls — the same `activateAt(x, y)` is reached three ways, so the
// game plays identically with a mouse, a touchscreen, or an eye tracker:
//   - mouse / touch: a click or tap on the canvas acts immediately;
//   - eye gaze:      a short dwell (gaze held still) acts, with a filling ring
//                    for feedback. Gaze comes from the platform bridge when
//                    embedded, or from the local mouse when running standalone.
// An "Observe" toggle freezes all placement so the player (especially a gaze
// user) can look around and admire the tank without dropping organisms, and a
// one-tap Undo keeps mistakes cheap.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Eraser, Eye, Lightbulb, Moon, Trash2, Undo2, X } from 'lucide-react';
import { onPlatformMessage, sendToParent } from '@shared/games-bridge';
import { audioSink, getAudioTime, unlockAudio } from './audio';
import {
  ERASE_RADIUS,
  PULSE_PERIOD_BEATS,
  SILENCE_MAX_RADIUS,
  WAVE_MAX_RADIUS,
  clearAll,
  createState,
  eraseAt,
  interactionRadius,
  placeOrganism,
  resize,
  silenceRadius,
  suppressionAt,
  tick,
  waveRadius,
} from './engine';
import type { GameState, Organism, Tool } from './types';

const GAME_ID = 'musical-microbes';
const HUD_REFRESH_MS = 300;
const AI_REPORT_INTERVAL_MS = 45_000;

// Dwell-to-act (eye gaze): hold the gaze roughly still to activate. This is the
// standalone default; when embedded, the platform's configured dwell time (from
// the eyegaze settings) overrides it via the `init` bridge message.
const DEFAULT_DWELL_MS = 650;
const DWELL_RADIUS_PX = 70;

const GLOW_DECAY_BEATS = 1.6; // how long an organism stays lit after firing
const HISTORY_LIMIT = 50;
const LIGHT_FADE_TAU = 0.45; // seconds — time constant of the lights fade

interface GazeState {
  x: number;
  y: number;
  mode: 'off' | 'eyegaze' | 'mouse';
}

interface Snapshot {
  organisms: Organism[];
  nextId: number;
}

const SPECIES_COLOR: Record<string, { core: string; glow: string }> = {
  pulser: { core: '#f472b6', glow: 'rgba(244, 114, 182, 0.9)' },
  responder: { core: '#38bdf8', glow: 'rgba(56, 189, 248, 0.9)' },
  harmonizer: { core: '#fbbf24', glow: 'rgba(251, 191, 36, 0.9)' },
  echoer: { core: '#34d399', glow: 'rgba(52, 211, 153, 0.9)' },
  silencer: { core: '#1e1b4b', glow: 'rgba(129, 140, 248, 0.9)' },
};

const SPECIES_RADIUS: Record<string, number> = {
  pulser: 16,
  responder: 11,
  harmonizer: 12,
  echoer: 12,
  silencer: 13,
};

export default function MusicalMicrobesApp() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isEmbedded = typeof window !== 'undefined' && window.parent !== window;

  const stateRef = useRef<GameState>(createState(1, 1));
  const gazeRef = useRef<GazeState>({ x: -1, y: -1, mode: 'off' });
  // Whether the platform has a dwell control enabled (the student's eyegaze /
  // cursor-control SETTINGS), encoded by the host in the gaze `mode`. 'off' means
  // plain mouse/touch — no dwell-to-select; placement is by click. 'eyegaze' or
  // 'mouse' (cursor-control) enables dwell. Gates the palette dwell loop below.
  const controlModeRef = useRef<'off' | 'eyegaze' | 'mouse'>('off');
  const historyRef = useRef<Snapshot[]>([]);
  // Dwell time (ms) to commit a gaze placement — overridden by the platform's
  // eyegaze setting via `init` when embedded.
  const dwellMsRef = useRef(DEFAULT_DWELL_MS);
  // Visual brightness, eased toward the light switch's target (0 dark, 1 lit).
  const lightLevelRef = useRef(0);
  // Overlay ring that shows dwell progress on the palette buttons. The canvas
  // has its own in-draw dwell ring; the [data-dwell] buttons had no feedback, so
  // we drive this ring imperatively from the palette dwell loop (no per-frame
  // React re-render of the whole component).
  const dwellRingRef = useRef<SVGSVGElement | null>(null);
  const dwellRingCircleRef = useRef<SVGCircleElement | null>(null);

  // UI state mirrored into refs so the rAF loop and pointer handlers read the
  // latest value without re-subscribing.
  const [tool, setTool] = useState<Tool>('pulser');
  const [observing, setObserving] = useState(false);
  // "Light switch" metaphor: lights OFF (default) = night, the microbes wake and
  // put on a light-and-music show. Lights ON = the microbes go to sleep and emit
  // no new pulses; any pulse already travelling finishes on its own.
  const [lightsOn, setLightsOn] = useState(false);
  const [count, setCount] = useState(0);
  const toolRef = useRef(tool);
  const observingRef = useRef(observing);
  const lightsOnRef = useRef(lightsOn);
  toolRef.current = tool;
  observingRef.current = observing;
  lightsOnRef.current = lightsOn;

  const refreshCount = useCallback(() => {
    setCount(stateRef.current.organisms.length);
  }, []);

  const pushHistory = useCallback(() => {
    const s = stateRef.current;
    historyRef.current.push({ organisms: s.organisms.map(o => ({ ...o })), nextId: s.nextId });
    if (historyRef.current.length > HISTORY_LIMIT) historyRef.current.shift();
  }, []);

  // The single activation primitive every input modality funnels through.
  const activateAt = useCallback(
    (x: number, y: number) => {
      if (observingRef.current) return;
      unlockAudio();
      const state = stateRef.current;
      if (toolRef.current === 'eraser') {
        // Only record history if something will actually change.
        const willErase = state.organisms.some(o => Math.hypot(o.x - x, o.y - y) <= ERASE_RADIUS);
        if (!willErase) return;
        pushHistory();
        eraseAt(state, x, y);
      } else {
        pushHistory();
        placeOrganism(state, toolRef.current, x, y);
      }
      refreshCount();
    },
    [pushHistory, refreshCount],
  );

  const handleUndo = useCallback(() => {
    const snap = historyRef.current.pop();
    if (!snap) return;
    const state = stateRef.current;
    state.organisms = snap.organisms;
    state.nextId = snap.nextId;
    state.waves = [];
    refreshCount();
  }, [refreshCount]);

  const handleClear = useCallback(() => {
    if (stateRef.current.organisms.length === 0) return;
    pushHistory();
    clearAll(stateRef.current);
    refreshCount();
  }, [pushHistory, refreshCount]);

  const toggleLights = useCallback(() => {
    unlockAudio();
    setLightsOn(on => {
      const next = !on;
      // Lights only put the pulsers to sleep. The clock keeps running, so any
      // pulse already travelling finishes on its own.
      stateRef.current.pulsersAwake = !next;
      return next;
    });
  }, []);

  // ── Bridge: announce ready, listen for gaze, close, pause/resume ──
  useEffect(() => {
    sendToParent({ type: 'ready', gameId: GAME_ID, version: '0.1.0' });
    const off = onPlatformMessage(msg => {
      if (msg.type === 'gaze') {
        // `mode` reflects the student's eyegaze/cursor-control SETTINGS: 'off' =
        // disabled (plain mouse/touch — placement by click, no dwell), 'eyegaze'
        // or 'mouse' = a dwell control is on. Track it as the dwell gate.
        controlModeRef.current = msg.mode;
        // Eyegaze position can ONLY come from the platform (the iframe can't
        // sense a camera / hardware tracker). Cursor-control position is read
        // from our own window pointer below — the platform's forwarded position
        // freezes once the cursor is over the iframe. When disabled, clear so
        // nothing acts on hover.
        if (msg.mode === 'eyegaze') {
          gazeRef.current = { x: msg.x, y: msg.y, mode: 'eyegaze' };
        } else if (msg.mode === 'off') {
          gazeRef.current = { x: -1, y: -1, mode: 'off' };
        }
      } else if (msg.type === 'init') {
        // Honour the platform's configured dwell time for eyegaze placement.
        if (typeof msg.dwellMs === 'number' && msg.dwellMs > 0) dwellMsRef.current = msg.dwellMs;
      } else if (msg.type === 'pause') {
        // A genuine platform pause (e.g. the game is backgrounded) freezes the
        // whole clock — distinct from the in-world light switch.
        stateRef.current.running = false;
      } else if (msg.type === 'resume') {
        stateRef.current.running = true;
      } else if (msg.type === 'request_close') {
        sendToParent({ type: 'session_end', reason: 'quit' });
      }
    });
    return () => off();
  }, []);

  // ── Resize canvas to its container ──
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const doResize = () => {
      const rect = container.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      const cctx = canvas.getContext('2d');
      if (cctx) cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      resize(stateRef.current, rect.width, rect.height);
    };
    doResize();
    const obs = new ResizeObserver(doResize);
    obs.observe(container);
    window.addEventListener('resize', doResize);
    return () => {
      obs.disconnect();
      window.removeEventListener('resize', doResize);
    };
  }, []);

  // ── Game + render loop ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let rafId = 0;
    let lastTime = performance.now();
    let lastHud = 0;
    let lastReport = performance.now();

    // Dwell tracking (eye gaze only).
    let dwellAnchorX = -1;
    let dwellAnchorY = -1;
    let dwellMs = 0;
    let committed = false;

    const loop = (time: number) => {
      rafId = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (time - lastTime) / 1000);
      lastTime = time;
      const now = Date.now();
      const state = stateRef.current;

      const audioTime = getAudioTime();
      tick(state, dt, audioTime, audioSink);

      // Ease the visual light level toward the switch's target so the tank
      // brightens / darkens gently rather than snapping.
      const lightTarget = lightsOnRef.current ? 1 : 0;
      lightLevelRef.current += (lightTarget - lightLevelRef.current) * (1 - Math.exp(-dt / LIGHT_FADE_TAU));

      // ── Dwell-to-act for gaze / cursor-control ──
      // Plain mouse/touch act via pointerdown — they report mode 'off' here (the
      // platform only feeds a non-off gaze mode when an eyegaze/cursor-control
      // dwell control is enabled), so an incidental cursor resting on the canvas
      // never drops an organism. Eyegaze AND cursor-control (both dwell paradigms)
      // place by dwelling.
      const gaze = gazeRef.current;
      let dwellProgress = 0;
      const rect = canvas.getBoundingClientRect();
      const localGazeX = gaze.x - rect.left;
      const localGazeY = gaze.y - rect.top;
      const gazeOnCanvas =
        gaze.x >= 0 && localGazeX >= 0 && localGazeY >= 0 && localGazeX <= state.width && localGazeY <= state.height;

      if (gaze.mode !== 'off' && !observingRef.current && gazeOnCanvas) {
        const moved = Math.hypot(localGazeX - dwellAnchorX, localGazeY - dwellAnchorY);
        if (moved <= DWELL_RADIUS_PX) {
          if (!committed) {
            dwellMs += dt * 1000;
            if (dwellMs >= dwellMsRef.current) {
              activateAt(localGazeX, localGazeY);
              committed = true;
              dwellMs = 0;
            }
          }
        } else {
          dwellAnchorX = localGazeX;
          dwellAnchorY = localGazeY;
          dwellMs = 0;
          committed = false;
        }
        dwellProgress = committed ? 0 : dwellMs / dwellMsRef.current;
      } else {
        dwellMs = 0;
        committed = false;
        dwellAnchorX = -1;
        dwellAnchorY = -1;
      }

      draw(ctx, state, {
        gaze,
        localGazeX,
        localGazeY,
        gazeOnCanvas,
        tool: toolRef.current,
        observing: observingRef.current,
        lightLevel: lightLevelRef.current,
        dwellProgress,
      });

      if (now - lastHud >= HUD_REFRESH_MS) lastHud = now;

      if (now - lastReport >= AI_REPORT_INTERVAL_MS && state.organisms.length > 0) {
        lastReport = now;
        const pulsers = state.organisms.filter(o => o.species === 'pulser').length;
        sendToParent({
          type: 'ai_observation',
          surface: {
            event: 'musical_microbes_progress',
            pulsers,
            responders: state.organisms.length - pulsers,
            microbesAwake: state.pulsersAwake,
            hint: 'Student is building a musical garden. Offer gentle, specific encouragement about what they are creating.',
          },
        } as never);
      }
    };

    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [activateAt]);

  // ── Pointer handling (mouse + touch) ──
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      activateAt(e.clientX - rect.left, e.clientY - rect.top);
    },
    [activateAt],
  );

  // Cursor-control pointer feed (window-level, inside this iframe so it covers the
  // WHOLE game incl. the side palette — a canvas-scoped listener froze gazeRef the
  // moment the cursor moved onto the palette). Only active when the platform has
  // CURSOR-CONTROL dwell enabled ('mouse'); with eyegaze the platform owns the
  // position, and with controls off we leave gazeRef cleared so a plain mouse user
  // gets no hover-dwell (they place by click). The platform's own forwarded mouse
  // position is unusable here — it freezes once the cursor is over the iframe.
  useEffect(() => {
    const onMove = (e: PointerEvent | MouseEvent) => {
      if (controlModeRef.current !== 'mouse') return;
      gazeRef.current = { x: e.clientX, y: e.clientY, mode: 'mouse' };
    };
    const onLeave = () => {
      if (controlModeRef.current === 'mouse') gazeRef.current = { x: -1, y: -1, mode: 'off' };
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('mousemove', onMove, { passive: true });
    document.addEventListener('mouseleave', onLeave);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseleave', onLeave);
    };
  }, []);

  // Dwell-to-click for the side palette / control buttons. The canvas has its own
  // dwell-to-place loop above, but the [data-dwell] buttons had none — and the
  // platform's host dwell engine can't reach buttons inside this iframe
  // (document.elementsFromPoint stops at the iframe boundary). So run a small
  // dwell here over our own [data-dwell] elements — but ONLY when a dwell control
  // is enabled (controlMode !== 'off'); with a plain mouse the buttons use real
  // onClick. elementFromPoint uses iframe-local coords — exactly what gazeRef
  // holds (window pointer in cursor-control, bridge-converted in eyegaze). The
  // canvas isn't [data-dwell], so this never competes with canvas placement.
  useEffect(() => {
    let raf = 0;
    let hoverEl: HTMLElement | null = null;
    let hoverStart = 0;
    let fired = false;

    const hideRing = () => {
      if (dwellRingRef.current) dwellRingRef.current.style.display = 'none';
    };
    // Draw a filling arc over the hovered button, sized to the button itself.
    const showRing = (el: HTMLElement, progress: number) => {
      const svg = dwellRingRef.current;
      const circle = dwellRingCircleRef.current;
      if (!svg || !circle) return;
      const rect = el.getBoundingClientRect();
      const stroke = 4;
      const size = Math.min(rect.width, rect.height);
      const r = size / 2 - stroke / 2;
      if (r <= 0) { hideRing(); return; }
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const circ = 2 * Math.PI * r;
      svg.style.display = 'block';
      svg.style.left = `${cx - size / 2}px`;
      svg.style.top = `${cy - size / 2}px`;
      svg.style.width = `${size}px`;
      svg.style.height = `${size}px`;
      circle.setAttribute('cx', `${size / 2}`);
      circle.setAttribute('cy', `${size / 2}`);
      circle.setAttribute('r', `${r}`);
      circle.setAttribute('stroke-dasharray', `${circ}`);
      circle.setAttribute('stroke-dashoffset', `${circ * (1 - progress)}`);
      circle.setAttribute('transform', `rotate(-90 ${size / 2} ${size / 2})`);
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const gaze = gazeRef.current;
      if (controlModeRef.current === 'off' || gaze.mode === 'off' || gaze.x < 0) { hoverEl = null; fired = false; hideRing(); return; }
      const hit = document.elementFromPoint(gaze.x, gaze.y) as HTMLElement | null;
      const dwellEl = hit ? (hit.closest('[data-dwell]') as HTMLElement | null) : null;
      if (dwellEl !== hoverEl) { hoverEl = dwellEl; hoverStart = now; fired = false; }
      if (!dwellEl) { hideRing(); return; }
      if (fired) { hideRing(); return; }
      const progress = Math.min(1, (now - hoverStart) / dwellMsRef.current);
      showRing(dwellEl, progress);
      if (now - hoverStart >= dwellMsRef.current) {
        fired = true;
        hideRing();
        dwellEl.click();
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Icon-only palette button. Labels are dropped so every control fits in a
  // two-column grid with no scrollbar (eyegaze can't drive a scrollbar); the
  // name lives on aria-label / title for hover + assistive tech.
  const toolBtn = (id: Tool, label: string, node: React.ReactNode) => (
    <button
      data-dwell
      onClick={() => {
        unlockAudio();
        setTool(id);
        if (observingRef.current) setObserving(false);
      }}
      aria-label={label}
      title={label}
      className={`flex items-center justify-center aspect-square rounded-2xl transition-transform active:scale-95 ${
        tool === id && !observing
          ? 'bg-white/20 ring-2 ring-white/80 text-white'
          : 'bg-white/5 text-slate-300 hover:bg-white/10'
      }`}
    >
      {node}
    </button>
  );

  return (
    <div className="h-full w-full flex bg-[#07112b] text-slate-100 select-none overflow-hidden">
      {/* Palette / parking strip — two icon-only columns so every control fits
          without a scrollbar (unusable by eyegaze). */}
      <div className="shrink-0 w-28 grid grid-cols-2 auto-rows-min content-start gap-2 p-2 bg-black/30 backdrop-blur border-r border-white/10">
        {toolBtn(
          'pulser',
          'Pulser',
          <span className="h-7 w-7 rounded-full bg-pink-400 shadow-[0_0_12px_3px_rgba(244,114,182,0.8)]" />,
        )}
        {toolBtn(
          'responder',
          'Responder',
          <span className="h-6 w-6 rounded-full bg-sky-400 shadow-[0_0_12px_3px_rgba(56,189,248,0.8)]" />,
        )}
        {toolBtn(
          'harmonizer',
          'Harmonizer',
          <span className="h-6 w-6 rounded-full bg-amber-400 shadow-[0_0_12px_3px_rgba(251,191,36,0.8)]" />,
        )}
        {toolBtn(
          'echoer',
          'Echoer',
          <span className="h-6 w-6 rounded-full bg-emerald-400 shadow-[0_0_12px_3px_rgba(52,211,153,0.8)]" />,
        )}
        {toolBtn(
          'silencer',
          'Silencer',
          <span className="h-6 w-6 rounded-full bg-slate-900 border-2 border-violet-300 shadow-[0_0_12px_3px_rgba(129,140,248,0.6)]" />,
        )}
        {toolBtn('eraser', 'Erase', <Eraser size={26} />)}

        <div className="col-span-2 my-1 border-t border-white/10" />

        <button
          data-dwell
          onClick={() => setObserving(o => !o)}
          aria-label="Observe mode"
          title={observing ? 'Looking' : 'Observe'}
          className={`flex items-center justify-center aspect-square rounded-2xl transition-transform active:scale-95 ${
            observing ? 'bg-amber-400/30 ring-2 ring-amber-300 text-amber-100' : 'bg-white/5 text-slate-300 hover:bg-white/10'
          }`}
        >
          <Eye size={26} />
        </button>

        <button
          data-dwell
          onClick={toggleLights}
          aria-label={lightsOn ? 'Turn the lights off so the microbes wake up' : 'Turn the lights on so the microbes sleep'}
          title={lightsOn ? 'Lights on' : 'Lights off'}
          className={`flex items-center justify-center aspect-square rounded-2xl transition-transform active:scale-95 ${
            lightsOn
              ? 'bg-amber-300/30 ring-2 ring-amber-200 text-amber-100'
              : 'bg-white/5 text-slate-300 hover:bg-white/10'
          }`}
        >
          {lightsOn ? <Lightbulb size={26} /> : <Moon size={26} />}
        </button>

        <button
          data-dwell
          onClick={handleUndo}
          aria-label="Undo"
          title="Undo"
          className="flex items-center justify-center aspect-square rounded-2xl bg-white/5 text-slate-300 hover:bg-white/10 transition-transform active:scale-95"
        >
          <Undo2 size={26} />
        </button>

        <button
          data-dwell
          onClick={handleClear}
          aria-label="Clear all"
          title="Clear all"
          className="flex items-center justify-center aspect-square rounded-2xl bg-white/5 text-slate-300 hover:bg-white/10 transition-transform active:scale-95"
        >
          <Trash2 size={26} />
        </button>

        {isEmbedded && (
          <button
            data-dwell
            onClick={() => sendToParent({ type: 'request_close' })}
            aria-label="Close"
            title="Close"
            className="col-span-2 flex items-center justify-center rounded-2xl py-3 bg-red-600/80 text-white hover:bg-red-600 transition-transform active:scale-95"
          >
            <X size={26} />
          </button>
        )}
      </div>

      {/* Tank */}
      <div ref={containerRef} className="relative flex-1">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 touch-none"
          onPointerDown={handlePointerDown}
        />
        <div className="pointer-events-none absolute top-2 left-3 text-xs text-slate-400/80 tabular-nums">
          {count} {count === 1 ? 'microbe' : 'microbes'}
        </div>
      </div>

      {/* Dwell-progress ring for the palette buttons (positioned imperatively). */}
      <svg ref={dwellRingRef} className="pointer-events-none fixed z-50" style={{ display: 'none' }}>
        <circle
          ref={dwellRingCircleRef}
          fill="none"
          stroke="rgba(255,255,255,0.95)"
          strokeWidth={4}
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}

// ── Rendering ──────────────────────────────────────────────────────────────

interface DrawCtx {
  gaze: GazeState;
  localGazeX: number;
  localGazeY: number;
  gazeOnCanvas: boolean;
  tool: Tool;
  observing: boolean;
  /** 0 = dark night (show on) … 1 = fully lit (microbes asleep). Eased, not binary. */
  lightLevel: number;
  dwellProgress: number;
}

// Night → day endpoints for the tank gradient, interpolated by `lightLevel`.
const NIGHT_TOP = [10, 24, 56];
const NIGHT_BOT = [5, 16, 31];
const DAY_TOP = [42, 93, 128];
const DAY_BOT = [23, 60, 82];

function lerpRgb(a: number[], b: number[], t: number): string {
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgb(${r}, ${g}, ${bl})`;
}

function draw(ctx: CanvasRenderingContext2D, state: GameState, d: DrawCtx) {
  const { width: w, height: h } = state;
  const beat = state.beatTime;
  const light = d.lightLevel;

  // Tank background: smoothly crossfades from a deep, dark night (the show is on)
  // to a brighter, daylit tank as the lights come up and the microbes sleep.
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, lerpRgb(NIGHT_TOP, DAY_TOP, light));
  bg.addColorStop(1, lerpRgb(NIGHT_BOT, DAY_BOT, light));
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // Silencer fields: pools of quiet dark that visibly darken their region. Drawn
  // before everything else so waves and cells read as dimmed where they overlap.
  // Opacity tracks the field's current strength (level), so a weakening silencer
  // visibly thins out before it retreats.
  for (const s of state.organisms) {
    if (s.species !== 'silencer') continue;
    const sr = silenceRadius(s);
    if (sr <= 4) continue;
    const lvl = s.level ?? 0;
    // Nearly solid out to the edge then a thin soft rim — reads as the hard kill
    // boundary it now is, rather than a soft gradient.
    const grad = ctx.createRadialGradient(s.x, s.y, sr * 0.1, s.x, s.y, sr);
    grad.addColorStop(0, `rgba(2, 2, 12, ${0.85 * lvl})`);
    grad.addColorStop(0.85, `rgba(2, 2, 12, ${0.8 * lvl})`);
    grad.addColorStop(1, 'rgba(2, 2, 12, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(s.x, s.y, sr, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(129, 140, 248, ${0.22 * lvl})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(s.x, s.y, sr, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Expanding pulse waves, fainter as they travel.
  for (const wave of state.waves) {
    const r = waveRadius(state, wave);
    if (r <= 0) continue;
    const fade = Math.max(0, 1 - r / WAVE_MAX_RADIUS);
    ctx.strokeStyle = `rgba(244, 114, 182, ${0.35 * fade})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(wave.x, wave.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Organisms.
  const litDim = 1 - 0.5 * light; // dim toward dormant as the lights rise
  for (const o of state.organisms) {
    const colors = SPECIES_COLOR[o.species];
    // Grow-in animates with the clock; if the clock is frozen (a real pause)
    // just show full size so nothing is stuck invisible.
    const grow = state.running ? Math.min(1, Math.max(0, (beat - o.bornBeat) / 0.4)) : 1;
    const lit = Math.max(0, 1 - (beat - o.lastFiredBeat) / GLOW_DECAY_BEATS);
    const baseR = SPECIES_RADIUS[o.species] ?? 11;
    // Harmonizers swell as they're recruited (activation) — you watch the prey
    // population fill in, and a dormant one is just a faint seed.
    const act = o.species === 'harmonizer' ? o.activation ?? 0 : 1;
    const r = baseR * grow * (1 + 0.35 * lit) * (o.species === 'harmonizer' ? 0.5 + 0.5 * act : 1);
    // Cells inside a silencer field (silencers don't silence themselves) dim in
    // proportion to how strongly they're suppressed — a visible cue that fades
    // back up as the field recedes and they begin to escape.
    const sup = o.species === 'silencer' ? 0 : suppressionAt(state, o.x, o.y);
    const hushed = sup > 0.5;
    const coreAlpha = litDim * (1 - 0.7 * sup) * (o.species === 'harmonizer' ? 0.2 + 0.8 * act : 1);

    // Glow halo when recently fired — kept even under the lights so a show that
    // was already in motion finishes its last shimmer as the microbes settle.
    if (lit > 0.01) {
      ctx.fillStyle = colors.glow.replace('0.9)', `${0.5 * lit})`);
      ctx.beginPath();
      ctx.arc(o.x, o.y, r * (2.2 + lit), 0, Math.PI * 2);
      ctx.fill();
    }

    // Pulsers gently breathe in time with their period so you can see the beat
    // coming — only while awake and not hushed.
    if (o.species === 'pulser' && state.pulsersAwake && !hushed) {
      const phase = ((beat % PULSE_PERIOD_BEATS) / PULSE_PERIOD_BEATS) * Math.PI * 2;
      const breathe = 0.12 * (1 + Math.sin(phase));
      ctx.fillStyle = `rgba(244, 114, 182, ${0.18 * (1 - light)})`;
      ctx.beginPath();
      ctx.arc(o.x, o.y, r * (1.6 + breathe), 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalAlpha = coreAlpha;
    ctx.fillStyle = colors.core;
    ctx.beginPath();
    ctx.arc(o.x, o.y, r, 0, Math.PI * 2);
    ctx.fill();
    // Silencers get a bright violet rim (a hollow "void"); others a soft white edge.
    ctx.strokeStyle = o.species === 'silencer' ? 'rgba(165, 180, 252, 0.95)' : 'rgba(255,255,255,0.7)';
    ctx.lineWidth = o.species === 'silencer' ? 2.5 : 1.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Ghost preview + dwell ring at the gaze/cursor point.
  if (!d.observing && d.gazeOnCanvas && d.gaze.mode !== 'off') {
    const gx = d.localGazeX;
    const gy = d.localGazeY;

    // Preview the connections: a flowing line to every existing organism this
    // object would affect or be affected by, coloured by that organism's species.
    if (d.tool !== 'eraser') {
      ctx.save();
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 5]);
      ctx.lineDashOffset = -((beat * 10) % 10); // gentle flow toward the connections
      for (const o of state.organisms) {
        const reach = interactionRadius(d.tool, o.species);
        if (reach <= 0 || Math.hypot(o.x - gx, o.y - gy) > reach) continue;
        ctx.strokeStyle = SPECIES_COLOR[o.species].glow.replace('0.9)', '0.55)');
        ctx.beginPath();
        ctx.moveTo(gx, gy);
        ctx.lineTo(o.x, o.y);
        ctx.stroke();
      }
      ctx.restore();
    }

    if (d.tool === 'eraser') {
      ctx.strokeStyle = 'rgba(248, 113, 113, 0.8)';
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(gx, gy, ERASE_RADIUS, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      const colors = SPECIES_COLOR[d.tool];
      const ghostR = SPECIES_RADIUS[d.tool] ?? 11;
      // Silencers preview the quiet field they'll create.
      if (d.tool === 'silencer') {
        ctx.fillStyle = 'rgba(2, 2, 12, 0.4)';
        ctx.beginPath();
        ctx.arc(gx, gy, SILENCE_MAX_RADIUS, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(129, 140, 248, 0.4)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.arc(gx, gy, SILENCE_MAX_RADIUS, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = colors.core;
      ctx.beginPath();
      ctx.arc(gx, gy, ghostR, 0, Math.PI * 2);
      ctx.fill();
      if (d.tool === 'silencer') {
        ctx.globalAlpha = 0.7;
        ctx.strokeStyle = 'rgba(165, 180, 252, 0.9)';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // Dwell ring (eye gaze): a filling arc shows commitment progress.
    if (d.dwellProgress > 0) {
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(gx, gy, 26, -Math.PI / 2, -Math.PI / 2 + d.dwellProgress * Math.PI * 2);
      ctx.stroke();
    }
  }

  // A soft "Observing" banner so the looking-vs-acting mode is unmistakable.
  if (d.observing) {
    ctx.fillStyle = 'rgba(251, 191, 36, 0.9)';
    ctx.font = '600 14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('👁  Observing — placement paused', w / 2, 22);
    ctx.textAlign = 'left';
  }
}
