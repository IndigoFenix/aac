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
//
// AUTOMATED SCAN (eyegaze). When the student has it on, the same scan can start
// by itself once they have been HUNTING across the board for their configured
// delay without selecting anything — see auto-audio-scan.ts for what counts as
// hunting. It deliberately drives the very same `scanning` state as the ear
// button, so everything downstream falls out for free: the ear lights up
// yellow while it runs, pressing it stops it, and pressing any board button
// stops it. There is no second scan, no second "is it running" flag, and
// nothing for the UI to learn.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { useTextToSpeech } from "@/hooks/useTextToSpeech";
import { useEyeTrackingDwell } from "@/contexts/EyeTrackingDwellContext";
import {
  initialHuntState,
  noteHover,
  noteScanEnded,
  resetHunt,
  shouldAutoScan,
  type HuntState,
} from "@/lib/auto-audio-scan";

// How long a button stays highlighted after its readout before the scan advances.
const SCAN_GAP_MS = 350;

// How often the automated scan re-asks "is this student stuck?". The threshold
// it compares against is 5s at the very least (the server floors it), so this
// is fine-grained by a factor of ten and costs one Set build per tick.
const AUTO_SCAN_EVAL_MS = 500;

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

/**
 * Identity of a button for the hunt detector: what it would SAY. Two buttons
 * that read the same are the same option to a student looking for a word, and
 * a word that survives a board rebuild keeps its identity. Board chrome with
 * nothing to say falls back to a per-node id so it still counts as a distinct
 * place the gaze visited.
 */
const nodeHuntIds = new WeakMap<HTMLElement, string>();
let nodeHuntIdSeq = 0;
function huntIdOf(el: HTMLElement): string {
  const said = speechTextOf(el);
  if (said) return said;
  let id = nodeHuntIds.get(el);
  if (!id) {
    id = `node:${(nodeHuntIdSeq += 1)}`;
    nodeHuntIds.set(el, id);
  }
  return id;
}

/** Is there a board on screen with something to read? */
function boardHasButtons(): boolean {
  return !!document.querySelector("[data-scan-root] [data-dwell]");
}

interface Props {
  /** BCP-47 language passed to the TTS (mirrors the board's speak() calls). */
  language?: string;
  /** Student voice preset ('boy' | 'girl' | 'man' | 'woman'). */
  voiceType?: string;
  /**
   * Automated audio scan is on for this student. Server-resolved: it is only
   * ever true alongside eyegaze, because the feature exists to rescue a student
   * hunting with their gaze and a touch user who pauses is not stuck.
   */
  autoScan?: boolean;
  /** Hunt time before the automated scan fires, in ms. */
  autoScanDelayMs?: number;
  /**
   * The AI is mid-turn — composing a reply, voicing one, or interpreting a
   * composed sentence. The scan must never start talking over it.
   */
  aiSpeaking?: boolean;
  /**
   * The Board Manager is rebuilding the board. Blocks the automated scan while
   * it runs, and finishing it clears the hunt: whatever the student was
   * hunting through is not what is in front of them any more.
   */
  boardRebuilding?: boolean;
  children: ReactNode;
}

/** Fallback when the server sent no delay; mirrors the server's own default. */
const DEFAULT_AUTO_SCAN_DELAY_MS = 15_000;

export function BoardAudioProvider({
  language,
  voiceType,
  autoScan = false,
  autoScanDelayMs,
  aiSpeaking = false,
  boardRebuilding = false,
  children,
}: Props) {
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

  // Hunt bookkeeping for the automated scan. A ref, not state: it is written
  // from a 20Hz gaze signal and must never re-render the board to do it.
  const huntRef = useRef<HuntState>(initialHuntState());

  // Mirrors `scanning`, but written EAGERLY by start/stop so the automated
  // evaluator (which runs off a timer, not off a render) can never see a stale
  // "idle" between firing and React committing, and fire twice.
  const scanningRef = useRef(scanning);
  scanningRef.current = scanning;

  /** `rejected` = the student stopped it (the ear), not "it was interrupted by
   *  a selection". Only the first earns the long cooldown — see auto-audio-scan. */
  const stopScan = useCallback((rejected = false) => {
    abortRef.current = true;
    cancel();
    if (scanningRef.current) {
      huntRef.current = noteScanEnded(huntRef.current, Date.now(), rejected);
      scanningRef.current = false;
    }
    setScanning(false);
    setHighlightEl(null);
  }, [cancel]);

  const startScan = useCallback(async () => {
    const root = document.querySelector<HTMLElement>("[data-scan-root]");
    if (!root) return;
    const buttons = Array.from(root.querySelectorAll<HTMLElement>("[data-dwell]")).filter(isVisible);
    if (buttons.length === 0) return;

    abortRef.current = false;
    scanningRef.current = true;
    // Whatever the student was hunting for, they are being read the board now.
    huntRef.current = resetHunt(huntRef.current);
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
      huntRef.current = noteScanEnded(huntRef.current, Date.now(), false);
      scanningRef.current = false;
      setScanning(false);
      setHighlightEl(null);
    }
  }, [speakEl]);

  const toggleScan = useCallback(() => {
    // Pressing the ear to stop it is the student answering "no" — that is what
    // buys the long quiet period, and only this path counts as one.
    if (scanningRef.current) stopScan(true);
    else void startScan();
  }, [stopScan, startScan]);

  // ── Automated scan ──
  const autoDelayMs = Math.max(1, autoScanDelayMs ?? DEFAULT_AUTO_SCAN_DELAY_MS);
  const autoArmed = autoScan;

  // Busy flags read by the evaluator's timer, so it sees the current values
  // without the timer being torn down and rebuilt every time they change.
  const aiBusyRef = useRef(false);
  aiBusyRef.current = aiSpeaking || boardRebuilding;

  const fireAutoScan = useCallback(() => {
    // Clear the hunt even if startScan bails (board gone mid-tick) so a failed
    // attempt can't retry on every evaluator tick.
    huntRef.current = resetHunt(huntRef.current);
    void startScan();
  }, [startScan]);

  // Any press ends the hunt: the student found what they wanted, so they were
  // not stuck. `click` rather than `pointerdown` because a dwell selection is a
  // synthesized .click() and produces no pointer events at all.
  useEffect(() => {
    if (!autoArmed) return;
    const onClick = () => { huntRef.current = resetHunt(huntRef.current); };
    window.addEventListener("click", onClick, true);
    return () => window.removeEventListener("click", onClick, true);
  }, [autoArmed]);

  // A finished board rebuild ends the hunt too — the options in front of the
  // student are not the ones they were hunting through.
  const wasRebuildingRef = useRef(false);
  useEffect(() => {
    if (wasRebuildingRef.current && !boardRebuilding) {
      huntRef.current = resetHunt(huntRef.current);
    }
    wasRebuildingRef.current = boardRebuilding;
  }, [boardRebuilding]);

  // While scanning, ANY press (except the ear toggle itself) stops the readout.
  // Capture phase so it runs before the pressed button's own handler, but it
  // never preventDefaults — the button still performs its normal action.
  //
  // Both events, because they are not the same population: a touch press fires
  // pointerdown, while a DWELL selection is a synthesized .click() and fires no
  // pointer events at all. Eyegaze students only ever produce the latter — and
  // they are exactly the students the automated scan runs for, so listening for
  // pointerdown alone would let it read on over the selection they just made.
  useEffect(() => {
    if (!scanning) return;
    const onPress = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("[data-audio-scan-toggle]")) return; // the ear owns start/stop
      stopScan();
    };
    window.addEventListener("pointerdown", onPress, true);
    window.addEventListener("click", onPress, true);
    return () => {
      window.removeEventListener("pointerdown", onPress, true);
      window.removeEventListener("click", onPress, true);
    };
  }, [scanning, stopScan]);

  // Abort any running scan when the provider unmounts.
  useEffect(
    () => () => {
      abortRef.current = true;
      cancel();
    },
    [cancel],
  );

  // Memoized so the busy/config props — which change on every agent turn — can
  // never re-render the whole subtree under this provider. Only the six values
  // consumers actually read move it.
  const value = useMemo(
    () => ({ highlightEl, highlight, scanning, toggleScan, stopScan, lastSpoken }),
    [highlightEl, highlight, scanning, toggleScan, stopScan, lastSpoken],
  );

  return (
    <BoardAudioContext.Provider value={value}>
      {autoArmed && (
        <AutoScanSensor
          delayMs={autoDelayMs}
          huntRef={huntRef}
          scanningRef={scanningRef}
          aiBusyRef={aiBusyRef}
          onFire={fireAutoScan}
        />
      )}
      {children}
    </BoardAudioContext.Provider>
  );
}

/**
 * Watches the gaze hunt and starts the scan when it looks like the student is
 * lost. Its own component for one reason that matters: the dwell target it
 * subscribes to changes ~20 times a second, and a context provider that
 * re-rendered at that rate would re-render everything beneath it. This renders
 * nothing, so the churn stops here.
 *
 * The signal it reads is the SAME hover the dwell engine already computes for
 * selection — not a separate hit-test, and not a poll of the DOM. Which button
 * the student is looking at is a question this app already answers continuously;
 * hunting is just that answer changing without a selection ever landing.
 */
function AutoScanSensor({
  delayMs,
  huntRef,
  scanningRef,
  aiBusyRef,
  onFire,
}: {
  delayMs: number;
  huntRef: MutableRefObject<HuntState>;
  scanningRef: MutableRefObject<boolean>;
  aiBusyRef: MutableRefObject<boolean>;
  onFire: () => void;
}) {
  const { dwellTarget, mode } = useEyeTrackingDwell();
  // Dwell input is live: gaze, or a gaze-driven cursor (Tobii Computer Control
  // is a supported setup and drives the Windows pointer). "off" also covers the
  // student not being in front of the camera at all.
  const active = mode !== "off";
  const target = dwellTarget?.element ?? null;

  // Fires only when the gaze ARRIVES somewhere new: `dwellTarget` is a fresh
  // object every tick, but `target` is the same node until the gaze moves.
  useEffect(() => {
    if (!active || !target) return;
    huntRef.current = noteHover(huntRef.current, huntIdOf(target), Date.now());
  }, [active, target, huntRef]);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      const stuck = shouldAutoScan(huntRef.current, {
        now: Date.now(),
        delayMs,
        scanning: scanningRef.current,
        boardPresent: boardHasButtons(),
        aiBusy: aiBusyRef.current,
      });
      if (stuck) onFire();
    }, AUTO_SCAN_EVAL_MS);
    return () => clearInterval(timer);
  }, [active, delayMs, onFire, huntRef, scanningRef, aiBusyRef]);

  return null;
}
