// client-aac/src/hooks/useSeizureWatch.ts
// Runs the seizure-signature DSP over the live pose-landmark stream: keeps a
// rolling window of pose frames + a per-student motion baseline, calls
// analyzeWindow, and renders the [MOTION SIGNATURE] line the Observer reads. The
// output is a coarse HINT the Observer adjudicates against the student's
// alarm_conditions — never an auto-alarm (mirrors usePoseEvents' fall hint).
//
// It tracks two things analyzeWindow (a pure per-window function) can't: how long
// the current event has PERSISTED (duration is the clearest status-epilepticus
// cue) and whether a flat window is POST-ICTAL (flat shortly after a convulsive
// pattern) vs. a plain atonic/still reading.
//
// fps caveat: clonic is 2–5 Hz, so this only resolves it when the pose stream
// runs ≥10 fps. The default tracker cadence is coarser; a future "seizure watch"
// state should bump the pose rate. Until then this reliably surfaces sustained
// rhythmic/atonic motion but may under-resolve fast clonic frequency.

import { useEffect, useRef, useState } from "react";
import type { RawTrackedPose } from "@/lib/poseTrackingTypes";
import type { SeizureSceneInfo } from "@shared/aac/scene-state";
import {
  analyzeWindow, updateBaseline, emptyBaseline, summarizeSignature, suspectSeizure,
  recentDownwardSlump, DEFAULT_THRESHOLDS,
  type PoseFrame, type MotionBaseline, type SeizureSignature,
} from "@shared/aac/seizure-signature";
import type { SeizureThresholds } from "@shared/aac/seizure-config";

export interface UseSeizureWatchOptions {
  poses: RawTrackedPose[];
  enabled?: boolean;
  /** Per-student resolved DSP thresholds (from clientConfig.seizure). Defaults
   *  to the built-in "medium" thresholds when omitted. */
  thresholds?: SeizureThresholds;
  /** Long-term baseline persisted across sessions — seeds the detector so it
   *  starts tuned to the student instead of re-learning from scratch. */
  initialBaseline?: MotionBaseline | null;
  /** Called when the watch state flips. The host raises the POSE tracker rate
   *  while active so the DSP can resolve the 2–5 Hz clonic band (the cheap
   *  continuous rate can't). Fires only on change. */
  onWatchActiveChange?: (active: boolean) => void;
}

export interface UseSeizureWatchReturn {
  /** Latest raw signature (for debug/telemetry), or null when idle. */
  signature: SeizureSignature | null;
  /** Compact scene payload to attach to the SceneSnapshot, or null when there's
   *  nothing worth surfacing. Drives the "seizure" frame escalation. */
  seizureInfo: SeizureSceneInfo | null;
  /** True while the pose rate should be bumped for a closer look. */
  watchActive: boolean;
  /** How many windows the baseline has learned (0 = cold; detection is inert
   *  until the student's habitual motion is established). For the debugger. */
  baselineSamples: number;
}

// Rolling window the DSP analyzes. Long enough to see rhythm + duration, short
// enough to stay responsive.
const WINDOW_MS = 4000;
const MIN_FRAMES = 6;        // ~10 frames at the 2.5 fps cheap rate; keep margin
const MIN_SPAN_MS = 2500;
// A flat window within this long after a convulsive pattern reads as post-ictal.
const POSTICTAL_WINDOW_MS = 60_000;
// Convulsive motion must be absent this long before we consider the event over
// (so brief drops mid-seizure don't reset the duration clock).
const EVENT_RESET_MS = 3000;
// Once suspicion fires, hold the high pose rate at least this long so a single
// settled window doesn't drop us back to the rate that can't resolve clonic.
const WATCH_HOLD_MS = 20_000;

export function useSeizureWatch(options: UseSeizureWatchOptions): UseSeizureWatchReturn {
  const { poses, enabled = true, thresholds = DEFAULT_THRESHOLDS, initialBaseline, onWatchActiveChange } = options;

  const [signature, setSignature] = useState<SeizureSignature | null>(null);
  const [seizureInfo, setSeizureInfo] = useState<SeizureSceneInfo | null>(null);
  const [watchActive, setWatchActive] = useState(false);
  const [baselineSamples, setBaselineSamples] = useState(0);

  const bufferRef = useRef<PoseFrame[]>([]);
  const baselineRef = useRef<MotionBaseline>(initialBaseline ?? emptyBaseline());
  const eventStartRef = useRef<number | null>(null);   // when the ongoing convulsive event began
  const lastClonicTsRef = useRef<number | null>(null); // last convulsive window (for post-ictal)
  const watchUntilRef = useRef(0);                     // hold the bumped rate until this ts
  const posePresentRef = useRef(false);                // was a body in view last tick?
  const onWatchRef = useRef(onWatchActiveChange);
  onWatchRef.current = onWatchActiveChange;
  const thresholdsRef = useRef(thresholds);
  thresholdsRef.current = thresholds;

  // Seed the baseline from the persisted long-term value when it arrives (the
  // server config can land after mount), as long as we haven't learned one yet.
  useEffect(() => {
    if (initialBaseline && baselineRef.current.samples === 0 && initialBaseline.samples > 0) {
      baselineRef.current = initialBaseline;
    }
  }, [initialBaseline]);

  // Drive watchActive off watchUntilRef on a steady timer (NOT the pose ticks) so
  // it stands down on time even if poses stop arriving. Cheap.
  useEffect(() => {
    if (!enabled) {
      watchUntilRef.current = 0;
      setWatchActive(prev => { if (prev) onWatchRef.current?.(false); return false; });
      return;
    }
    const id = setInterval(() => {
      const active = Date.now() < watchUntilRef.current;
      setWatchActive(prev => { if (prev !== active) onWatchRef.current?.(active); return active; });
    }, 250);
    return () => clearInterval(id);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      bufferRef.current = [];
      eventStartRef.current = null;
      lastClonicTsRef.current = null;
      if (signature || seizureInfo) { setSignature(null); setSeizureInfo(null); }
      return;
    }

    const now = Date.now();
    const raw = poses[0];
    if (!raw) {
      // Body just left view. If a downward slump immediately preceded the loss,
      // flag ELEVATED risk: the student may have collapsed out of frame, which
      // the normal atonic detector can't catch (it needs the body to persist).
      // Even a SMALL slump-then-loss is treated as higher-risk on purpose.
      if (posePresentRef.current) {
        posePresentRef.current = false;
        if (thresholdsRef.current.atonic.enabled && recentDownwardSlump(bufferRef.current, now)) {
          setSignature(null);
          setSeizureInfo({
            phase: "atonic",
            confidence: 0.85,
            summary: "[MOTION SIGNATURE] a downward slump immediately preceded the body/face leaving the camera view — the student may have collapsed out of frame. HIGHER RISK: look now and check on the student; the motion detector can no longer see them.",
          });
        }
      }
      return; // keep the buffer, just don't extend it
    }
    // Body (re)appeared — clear any lingering slump-loss flag so normal detection
    // (below) takes over. setState(null) is a no-op when already null.
    const justReturned = !posePresentRef.current;
    posePresentRef.current = true;
    if (justReturned) setSeizureInfo(null);

    // Extend the rolling window.
    const buf = bufferRef.current;
    buf.push({ ts: now, landmarks: raw.landmarks });
    while (buf.length && now - buf[0].ts > WINDOW_MS) buf.shift();

    const span = buf.length >= 2 ? buf[buf.length - 1].ts - buf[0].ts : 0;
    if (buf.length < MIN_FRAMES || span < MIN_SPAN_MS) return;

    const th = thresholdsRef.current;
    const sig = analyzeWindow(buf, baselineRef.current, th);

    // Tiered watch: a clonic call OR a low-fps suspicion (broad anomalous motion)
    // holds the bumped pose rate so the DSP can resolve / confirm the rhythm.
    if (sig.phase === "clonic" || suspectSeizure(sig, th.rhythmic.involvementMult)) {
      watchUntilRef.current = now + WATCH_HOLD_MS;
    }

    // Resolve the effective phase + ongoing duration the pure DSP can't.
    let effective: SeizureSignature = sig;
    if (sig.phase === "clonic") {
      if (eventStartRef.current === null) eventStartRef.current = now;
      lastClonicTsRef.current = now;
    } else {
      // End the convulsive event only after a sustained gap.
      if (eventStartRef.current !== null && lastClonicTsRef.current !== null
          && now - lastClonicTsRef.current > EVENT_RESET_MS) {
        eventStartRef.current = null;
      }
      // A flat window soon after a convulsive pattern → post-ictal.
      if (sig.phase === "atonic" && lastClonicTsRef.current !== null
          && now - lastClonicTsRef.current < POSTICTAL_WINDOW_MS) {
        effective = { ...sig, phase: "postictal" };
      }
      // Learn the student's habitual motion ONLY from genuinely quiet windows —
      // never during a candidate event, or the baseline absorbs the seizure.
      if (sig.phase === "none" && sig.confidence === 0) {
        baselineRef.current = updateBaseline(baselineRef.current, sig.regionEnergy);
      }
    }

    const ongoingMs = eventStartRef.current !== null ? now - eventStartRef.current : 0;
    const summary = summarizeSignature(effective, ongoingMs, th.rhythmic.escalateConfidence);
    const info: SeizureSceneInfo | null = summary
      ? { phase: effective.phase as SeizureSceneInfo["phase"], confidence: effective.confidence, summary }
      : null;

    setSignature(effective);
    setSeizureInfo(info);
    setBaselineSamples(baselineRef.current.samples);
  }, [poses, enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  return { signature, seizureInfo, watchActive, baselineSamples };
}

export default useSeizureWatch;
