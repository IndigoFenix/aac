// client-aac/src/components/apps/MusicApp.tsx
// Full-screen piano overlay with one octave of colorful keys

import { useRef, useCallback } from "react";
import { motion } from "framer-motion";
import { X } from "lucide-react";

const NOTES = [
  { name: "C", freq: 261.63, color: "#EF4444" },  // Red
  { name: "D", freq: 293.66, color: "#F97316" },  // Orange
  { name: "E", freq: 329.63, color: "#EAB308" },  // Yellow
  { name: "F", freq: 349.23, color: "#22C55E" },  // Green
  { name: "G", freq: 392.0,  color: "#3B82F6" },  // Blue
  { name: "A", freq: 440.0,  color: "#6366F1" },  // Indigo
  { name: "B", freq: 493.88, color: "#A855F7" },  // Purple
  { name: "C5", freq: 523.25, color: "#EC4899" }, // Pink
];

interface MusicAppProps {
  onClose: () => void;
}

export default function MusicApp({ onClose }: MusicAppProps) {
  const audioCtxRef = useRef<AudioContext | null>(null);
  const activeOscRef = useRef<Map<string, { osc: OscillatorNode; gain: GainNode }>>(new Map());

  const getAudioCtx = useCallback(() => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext();
    }
    return audioCtxRef.current;
  }, []);

  const startNote = useCallback((name: string, freq: number) => {
    if (activeOscRef.current.has(name)) return;

    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.3, ctx.currentTime + 0.05);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();

    activeOscRef.current.set(name, { osc, gain });
  }, [getAudioCtx]);

  const stopNote = useCallback((name: string) => {
    const entry = activeOscRef.current.get(name);
    if (!entry) return;

    const ctx = getAudioCtx();
    entry.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.1);
    setTimeout(() => {
      try { entry.osc.stop(); } catch { /* ignore */ }
      try { entry.osc.disconnect(); } catch { /* ignore */ }
      try { entry.gain.disconnect(); } catch { /* ignore */ }
    }, 150);

    activeOscRef.current.delete(name);
  }, [getAudioCtx]);

  const btnBase = "flex items-center justify-center rounded-2xl font-bold shadow-lg active:scale-95 transition-transform select-none touch-none";

  return (
    <motion.div
      className="fixed inset-0 z-50 bg-gradient-to-b from-gray-900 to-gray-800 flex flex-col"
      data-dwell-trap
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ type: "spring", damping: 25, stiffness: 300 }}
    >
      {/* Piano keys — pt-14 clears the header */}
      <div className="flex-1 flex items-stretch gap-3 px-3 pt-14 pb-3">
        {NOTES.map((note) => (
          <button
            data-dwell
            key={note.name}
            className="flex-1 rounded-3xl flex flex-col items-center justify-end pb-8 text-white text-2xl font-bold shadow-xl transition-transform active:scale-[0.97] select-none touch-none"
            style={{ backgroundColor: note.color }}
            onPointerDown={(e) => {
              startNote(note.name, note.freq);
              (e.target as HTMLElement).setPointerCapture(e.pointerId);
            }}
            onPointerUp={() => stopNote(note.name)}
            onPointerCancel={() => stopNote(note.name)}
            onPointerLeave={() => stopNote(note.name)}
            aria-label={`Play ${note.name}`}
          >
            <span className="text-white/80 text-lg">{note.name}</span>
          </button>
        ))}
      </div>

      {/* Close button at bottom — large and visible */}
      <div className="px-3 pb-4">
        <button
          data-dwell
          onClick={onClose}
          className={`${btnBase} w-full h-14 bg-red-500 text-white text-lg gap-2`}
          aria-label="Close Music Maker"
        >
          <X size={24} />
          Close
        </button>
      </div>
    </motion.div>
  );
}
