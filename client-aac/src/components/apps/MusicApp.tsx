// client-aac/src/components/apps/MusicApp.tsx
// Xylophone overlay: a row of pentatonic bars along the bottom of the screen.
//
// Two ways to play, both funnelling through `strike(note)`:
//   - touch / mouse: tap a bar.
//   - eye gaze / cursor-control: a glowing ball follows the gaze. Sweeping
//     sideways does nothing — only glancing DOWN into the bars "hits" the one
//     under the ball. This is a strike line at the top of the bar strip: a
//     downward crossing fires that column's note and disarms until the gaze
//     rises back above the bars, so a resting or wandering gaze never plays.
//
// The scale is the major pentatonic (no F or B), so every bar — and every
// combination of bars — sounds consonant; there are no wrong notes.

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronsDown, X } from "lucide-react";
import { useEyeTrackingDwell } from "@/contexts/EyeTrackingDwellContext";

interface Note {
  name: string;
  freq: number;
  color: string;
}

// Major pentatonic across one octave (C D E G A C). Dropping the 4th (F) and
// 7th (B) removes the only half-step clashes, so any notes sounded together
// harmonise.
const NOTES: Note[] = [
  { name: "C", freq: 261.63, color: "#EF4444" },  // Red
  { name: "D", freq: 293.66, color: "#F97316" },  // Orange
  { name: "E", freq: 329.63, color: "#EAB308" },  // Yellow
  { name: "G", freq: 392.0, color: "#22C55E" },   // Green
  { name: "A", freq: 440.0, color: "#3B82F6" },   // Blue
  { name: "C5", freq: 523.25, color: "#A855F7" }, // Purple
];

// The bars occupy this fraction of the play area's height, anchored to the
// bottom; the strike line sits at the top edge of that strip.
const BAR_AREA_FRAC = 0.46;
// Re-arm hysteresis: after a strike, the gaze must rise this far above the
// strike line before another hit can register — stops a gaze hovering right on
// the line from machine-gunning the note.
const REARM_MARGIN_PX = 30;
const TICK_MS = 30;

interface MusicAppProps {
  onClose: () => void;
}

interface Ripple {
  id: number;
  x: number;
  y: number;
  color: string;
}

export default function MusicApp({ onClose }: MusicAppProps) {
  const audioCtxRef = useRef<AudioContext | null>(null);
  const playRef = useRef<HTMLDivElement>(null);

  // Live gaze (eyegaze) or cursor (cursor-control); null in plain touch/mouse.
  const { gazePosition, mode: dwellMode } = useEyeTrackingDwell();
  const gazePosRef = useRef(gazePosition);
  gazePosRef.current = gazePosition;

  // Per-bar flash counter — bumping it remounts the flash overlay so the
  // one-shot CSS flash replays. Covers both touch and gaze strikes.
  const [flashes, setFlashes] = useState<Record<string, number>>({});
  // Ball position inside the play area (local px); null when there's no gaze.
  const [ball, setBall] = useState<{ x: number; y: number } | null>(null);
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const rippleIdRef = useRef(0);

  const getAudioCtx = useCallback(() => {
    if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
    const ctx = audioCtxRef.current;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  }, []);

  // A struck bar: a marimba-like tone — stacked sine harmonics with a fast
  // attack and a natural decay. Percussive like a real xylophone, so there is
  // no note-off to track.
  const playTone = useCallback(
    (freq: number) => {
      const ctx = getAudioCtx();
      const t = ctx.currentTime;
      const harmonics = [1, 2, 3];
      const harmGains = [1, 0.4, 0.18];
      const dur = 0.9;
      for (let i = 0; i < harmonics.length; i++) {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = freq * harmonics[i];
        const g = ctx.createGain();
        const peak = 0.3 * harmGains[i];
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(peak, t + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        osc.connect(g).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + dur + 0.05);
      }
    },
    [getAudioCtx],
  );

  // The single strike primitive every input path funnels through.
  const strike = useCallback(
    (note: Note, ripple?: { x: number; y: number }) => {
      playTone(note.freq);
      setFlashes((f) => ({ ...f, [note.name]: (f[note.name] ?? 0) + 1 }));
      if (ripple) {
        const id = rippleIdRef.current++;
        setRipples((r) => [...r, { id, x: ripple.x, y: ripple.y, color: note.color }]);
        // Drop it once the CSS animation has finished.
        window.setTimeout(() => setRipples((r) => r.filter((x) => x.id !== id)), 600);
      }
    },
    [playTone],
  );

  // ── Gaze "ball" + downward-strike detection (eyegaze / cursor-control) ──
  useEffect(() => {
    if (dwellMode === "off") {
      setBall(null);
      return;
    }

    let raf = 0;
    let lastTick = 0;
    let prevY: number | null = null;
    let armed = true;

    const tick = (time: number) => {
      raf = requestAnimationFrame(tick);
      if (time - lastTick < TICK_MS) return;
      lastTick = time;

      const gaze = gazePosRef.current;
      const play = playRef.current;
      if (!gaze || !play) {
        setBall(null);
        prevY = null;
        armed = true;
        return;
      }

      const rect = play.getBoundingClientRect();
      const x = gaze.x - rect.left;
      const y = gaze.y - rect.top;
      if (x < 0 || x > rect.width || y < 0 || y > rect.height) {
        setBall(null);
        prevY = null;
        armed = true;
        return;
      }

      setBall({ x, y });

      const strikeLine = rect.height * (1 - BAR_AREA_FRAC);
      // A downward crossing of the strike line, while armed, hits the bar in
      // this column. Sideways motion below the line keeps prevY ≈ y, so it
      // never crosses and never fires.
      if (armed && prevY !== null && prevY < strikeLine && y >= strikeLine) {
        const col = Math.min(
          NOTES.length - 1,
          Math.max(0, Math.floor((x / rect.width) * NOTES.length)),
        );
        strike(NOTES[col], { x, y });
        armed = false;
      }
      // Re-arm only once the gaze has clearly risen back above the bars.
      if (y < strikeLine - REARM_MARGIN_PX) armed = true;
      prevY = y;
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [dwellMode, strike]);

  const showBall = dwellMode !== "off" && ball !== null;

  return (
    // dir="ltr": a xylophone reads low→high left-to-right in every locale —
    // Hebrew/Arabic instruments are laid out LTR too — so this app must never
    // mirror with the surrounding RTL UI.
    <div dir="ltr" className="h-full bg-gradient-to-b from-gray-900 to-gray-800 flex flex-col select-none">
      {/* Top bar: close */}
      <div className="flex items-center justify-end px-3 pt-3">
        <button
          type="button"
          data-dwell
          onClick={onClose}
          aria-label="Close Music Maker"
          className="flex items-center justify-center rounded-2xl w-12 h-12 bg-red-500 text-white shadow-lg active:scale-95 transition-transform touch-none"
        >
          <X size={24} />
        </button>
      </div>

      {/* Play area: open space on top (where the ball travels), bars at the bottom */}
      <div ref={playRef} className="relative flex-1 overflow-hidden">
        {/* Bars */}
        <div
          className="absolute inset-x-0 bottom-0 flex items-stretch gap-2 px-2 pb-2"
          style={{ height: `${BAR_AREA_FRAC * 100}%` }}
        >
          {NOTES.map((note) => (
            <button
              type="button"
              key={note.name}
              // Deliberately NOT data-dwell: a resting or sweeping gaze must not
              // play a bar — only a downward strike (the ball loop) or a tap.
              onPointerDown={() => strike(note)}
              aria-label={`Play ${note.name}`}
              className="relative flex-1 rounded-2xl shadow-xl flex items-end justify-center pb-4 text-lg font-bold text-white/85 overflow-hidden active:scale-[0.98] transition-transform touch-none"
              style={{ backgroundColor: note.color }}
            >
              {/* "Look down to play" cue — one per bar, gaze modes only, no
                  text (for non-readers) */}
              {dwellMode !== "off" && (
                <ChevronsDown
                  className="pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 text-white/50 animate-bounce"
                  size={28}
                />
              )}
              <span className="pointer-events-none">{note.name}</span>
              {/* one-shot flash overlay (remounts on each strike) */}
              <span
                key={flashes[note.name] ?? 0}
                className={`pointer-events-none absolute inset-0 rounded-2xl bg-white ${
                  flashes[note.name] ? "xylo-key-flash" : "opacity-0"
                }`}
              />
            </button>
          ))}
        </div>

        {/* Strike ripples */}
        {ripples.map((r) => (
          <span
            key={r.id}
            className="xylo-ripple pointer-events-none absolute rounded-full"
            style={{ left: r.x, top: r.y, width: 80, height: 80, border: `4px solid ${r.color}` }}
          />
        ))}

        {/* Gaze ball */}
        {showBall && ball && (
          <span
            className="pointer-events-none absolute rounded-full"
            style={{
              left: ball.x,
              top: ball.y,
              width: 40,
              height: 40,
              transform: "translate(-50%, -50%)",
              background:
                "radial-gradient(circle at 35% 30%, rgba(255,255,255,0.95), rgba(125,211,252,0.55) 60%, rgba(125,211,252,0) 75%)",
              boxShadow: "0 0 18px 6px rgba(125,211,252,0.55)",
            }}
          />
        )}
      </div>
    </div>
  );
}
