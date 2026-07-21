// client-aac/src/contexts/BoardAudioContext.tsx
//
// Shared controller for the board's YELLOW highlight + spoken readout, used by
// two features:
//
//   1. Hold-to-highlight (HoldHighlightOverlay): when a caretaker presses and
//      holds a button (eyegaze mode), the button is highlighted instead of
//      selected — and its sentence is spoken via the client-side TTS.
//
//   2. Audio scan (the ear button next to the FaceMirror): highlights every
//      button on the board one at a time, reading each aloud. Pressing the ear
//      again, or pressing any button, stops the readout.
//
// Both funnel through one `highlightEl` so a single overlay draws the highlight,
// and one `speak` (browser speechSynthesis) so they never talk over each other.
//
// The spoken text for a button is read from its `data-speech` attribute
// (accurate sentence), falling back to aria-label / text content. The scan
// enumerates `[data-dwell]` buttons inside the `[data-scan-root]` board grid.

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useTextToSpeech } from "@/hooks/useTextToSpeech";

// How long a button stays highlighted after its readout before the scan advances.
const SCAN_GAP_MS = 350;

interface BoardAudioContextValue {
  /** The button currently wearing the yellow highlight (hold-commit OR scan step). */
  highlightEl: HTMLElement | null;
  /** Highlight a button; when speak=true, also voice its sentence via client TTS. */
  highlight: (el: HTMLElement | null, speak?: boolean) => void;
  /** True while the audio scan is stepping through the board. */
  scanning: boolean;
  /** Start the scan if idle, stop it if running (the ear button). */
  toggleScan: () => void;
  /** Stop the scan and cancel any readout (pressing a button, or turning it off). */
  stopScan: () => void;
  /** The most recent sentence voiced by a readout (hold-highlight OR scan step),
   *  with a monotonic tick so identical repeats still notify. The AI forwards
   *  this to the Observer as [OWN_SPEECH] so it disregards hearing its own
   *  readout through the mic (echo suppression — no response). */
  lastSpoken: { text: string; tick: number } | null;
}

const noop = () => {};
const BoardAudioContext = createContext<BoardAudioContextValue>({
  highlightEl: null,
  highlight: noop,
  scanning: false,
  toggleScan: noop,
  stopScan: noop,
  lastSpoken: null,
});

export function useBoardAudio() {
  return useContext(BoardAudioContext);
}

/** Read the sentence a button should speak: explicit data-speech, else its label. */
function speechTextOf(el: HTMLElement): string {
  return (
    el.getAttribute("data-speech") ||
    el.getAttribute("aria-label") ||
    el.textContent?.trim() ||
    ""
  );
}

function isVisible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

interface Props {
  /** BCP-47 language passed to the TTS (mirrors the board's speak() calls). */
  language?: string;
  /** Student voice preset ('boy' | 'girl' | 'man' | 'woman'). */
  voiceType?: string;
  children: ReactNode;
}

export function BoardAudioProvider({ language, voiceType, children }: Props) {
  const { speak, cancel } = useTextToSpeech();
  const [highlightEl, setHighlightEl] = useState<HTMLElement | null>(null);
  const [scanning, setScanning] = useState(false);
  // The latest readout sentence (see lastSpoken doc) — the AI echo-suppresses on it.
  const [lastSpoken, setLastSpoken] = useState<{ text: string; tick: number } | null>(null);
  const tickRef = useRef(0);
  // Set true to break out of the async scan loop (stop / re-toggle / unmount).
  const abortRef = useRef(false);

  // Keep the latest voice settings in a ref so the scan loop always reads the
  // current values without being re-created on every settings change.
  const voiceRef = useRef({ language, voiceType });
  voiceRef.current = { language, voiceType };

  const speakEl = useCallback(
    (el: HTMLElement): Promise<void> => {
      const text = speechTextOf(el);
      if (!text) return Promise.resolve();
      const { language: lang, voiceType: vt } = voiceRef.current;
      // Announce the sentence as it starts so the AI can tag it [OWN_SPEECH] to
      // the Observer before it hears the readout through the mic — that's what
      // stops the AI responding to its own reading.
      tickRef.current += 1;
      setLastSpoken({ text, tick: tickRef.current });
      return speak(text, lang, vt as any);
    },
    [speak],
  );

  const highlight = useCallback(
    (el: HTMLElement | null, doSpeak = false) => {
      setHighlightEl(el);
      if (el && doSpeak) void speakEl(el);
    },
    [speakEl],
  );

  const stopScan = useCallback(() => {
    abortRef.current = true;
    cancel();
    setScanning(false);
    setHighlightEl(null);
  }, [cancel]);

  const startScan = useCallback(async () => {
    const root = document.querySelector<HTMLElement>("[data-scan-root]");
    if (!root) return;
    const buttons = Array.from(root.querySelectorAll<HTMLElement>("[data-dwell]")).filter(isVisible);
    if (buttons.length === 0) return;

    abortRef.current = false;
    setScanning(true);
    for (const btn of buttons) {
      if (abortRef.current || !document.contains(btn)) break;
      setHighlightEl(btn);
      await speakEl(btn); // resolves when the utterance ends, errors, or is cancelled
      if (abortRef.current) break;
      await new Promise((r) => setTimeout(r, SCAN_GAP_MS));
    }
    // Natural completion (not aborted) returns the board to its resting state.
    if (!abortRef.current) {
      setScanning(false);
      setHighlightEl(null);
    }
  }, [speakEl]);

  const scanningRef = useRef(scanning);
  scanningRef.current = scanning;
  const toggleScan = useCallback(() => {
    if (scanningRef.current) stopScan();
    else void startScan();
  }, [stopScan, startScan]);

  // While scanning, ANY press (except the ear toggle itself) stops the readout.
  // Capture phase so it runs before the pressed button's own handler, but it
  // never preventDefaults — the button still performs its normal action.
  useEffect(() => {
    if (!scanning) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("[data-audio-scan-toggle]")) return; // the ear owns start/stop
      stopScan();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [scanning, stopScan]);

  // Abort any running scan when the provider unmounts.
  useEffect(
    () => () => {
      abortRef.current = true;
      cancel();
    },
    [cancel],
  );

  return (
    <BoardAudioContext.Provider
      value={{ highlightEl, highlight, scanning, toggleScan, stopScan, lastSpoken }}
    >
      {children}
    </BoardAudioContext.Provider>
  );
}
