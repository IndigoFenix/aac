// client-aac/src/hooks/useSeizureWatch.ts
//
// Runs the seizure-signature DSP over the live tracker streams: keeps a rolling
// window of fused MotionFrames + a per-student motion baseline, calls
// analyzeWindow, and renders the [MOTION SIGNATURE] line the Observer reads. The
// output is a coarse HINT the Observer adjudicates against the student's
// alarm_conditions — never an auto-alarm (mirrors usePoseEvents' fall hint).
//
// THE FACE TRACKER IS THE CLOCK. It ticks reliably at this camera distance, it
// carries the subject scale and anchor, and its rigid motion is the axial
// channel the convulsive gate needs; hands, pose and the dense motion field are
// sampled from refs at each face tick. That is the inversion this rework is
// about — the old version was driven by the POSE stream, which at a kiosk
// camera distance frequently resolves nothing at all, so the DSP simply never
// ran. Nothing here requires pose any more.
//
// It also tracks two things analyzeWindow (a pure per-window function) can't:
// how long the current event has PERSISTED (duration is the clearest
// status-epilepticus cue) and whether a flat window is POST-ICTAL (flat shortly
// after a convulsive pattern) vs. a plain atonic/still reading.

import { useEffect, useRef, useState } from "react";
import type { RawTrackedFace } from "@/lib/faceTrackingTypes";
import type { RawTrackedHand } from "@/lib/handGestureTypes";
import type { RawTrackedPose } from "@/lib/poseTrackingTypes";
import type { SeizureSceneInfo } from "@shared/aac/scene-state";
import {
  analyzeWindow, updateBaseline, emptyBaseline, summarizeSignature, suspectSeizure,
  recentDownwardSlump, DEFAULT_THRESHOLDS,
  type MotionBaseline, type SeizureSignature,
} from "@shared/aac/seizure-signature";
import type { MotionFrame, MotionFieldSample } from "@shared/aac/motion-types";
import type { SeizureThresholds } from "@shared/aac/seizure-config";
import type { SeizureMarker } from "@shared/aac/seizure-markers";
import { buildMotionFrame } from "@/lib/seizureMotionSource";

export interface UseSeizureWatchOptions {
  /** All tracked faces; the hook picks the student's (see pickSubjectFace). */
  faces: RawTrackedFace[];
  /** Hand landmarks, when the hand tracker is running. Optional. */
  hands?: RawTrackedHand[];
  /** Body pose — strictly ADDITIVE. Contributes torso/arm regions when it
   *  resolves and is simply absent otherwise. Never gates detection. */
  poses?: RawTrackedPose[];
  /** Non-reactive sampler for the dense frame-difference channel. */
  getMotionField?: () => MotionFieldSample | null;
  enabled?: boolean;
  /** Per-student resolved DSP thresholds (from clientConfig.seizure). */
  thresholds?: SeizureThresholds;
  /** Per-student motor markers — the specific presentation a clinician recorded
   *  for this student. A `strong` one can escalate on its own. */
  markers?: SeizureMarker[];
  /** Long-term baseline persisted across sessions — seeds the detector so it
   *  starts tuned to the student instead of re-learning from scratch. */
  initialBaseline?: MotionBaseline | null;
  /** Called when the watch state flips. The host raises the FACE and HAND
   *  tracker rates while active so the DSP can resolve the 2–5 Hz clonic band
   *  (the default ~300ms cadence aliases it). Fires only on change. */
  onWatchActiveChange?: (active: boolean) => void;
}

export interface UseSeizureWatchReturn {
  /** Latest raw signature (for debug/telemetry), or null when idle. */
  signature: SeizureSignature | null;
  /** Compact scene payload to attach to the SceneSnapshot, or null when there's
   *  nothing worth surfacing. Drives the "seizure" frame escalation. */
  seizureInfo: SeizureSceneInfo | null;
  /** True while the tracker rates should be bumped for a closer look. */
  watchActive: boolean;
  /** How many windows the baseline has learned (0 = cold; detection is inert
   *  until the student's habitual motion is established). For the debugger. */
  baselineSamples: number;
  /** Whether a subject was in view on the last tick. For the debugger — the
   *  first thing to check when "nothing ever fires". */
  subjectPresent: boolean;
}

// Rolling window the DSP analyzes. Long enough to see rhythm + duration, short
// enough to stay responsive.
const WINDOW_MS = 4000;
const MIN_FRAMES = 6;
const MIN_SPAN_MS = 2500;
// A flat window within this long after a convulsive pattern reads as post-ictal.
const POSTICTAL_WINDOW_MS = 60_000;
// Convulsive motion must be absent this long before we consider the event over
// (so brief drops mid-seizure don't reset the duration clock).
const EVENT_RESET_MS = 3000;
// Once suspicion fires, hold the high tracker rate at least this long so a
// single settled window doesn't drop us back to a rate that can't resolve clonic.
const WATCH_HOLD_MS = 20_000;
// How many consecutive marker-ONLY windows may escalate before we go quiet.
//
// A convulsion should keep escalating for as long as it lasts — duration IS the
// emergency cue, and the context re-fires a frame every 4s while a seizure is
// active. But a marker-only event has no generic pattern behind it: the student
// may simply be holding a posture voluntarily. Once the Observer has looked a
// few times and judged it benign, further frames teach it nothing and cost
// money on every one. So marker-only escalation is budgeted, and the budget
// resets the moment the markers clear. If the situation actually deteriorates,
// the generic detectors (which are not budgeted) take over.
const MARKER_ONLY_MAX_ESCALATIONS = 3;

/**
 * The student's face among all tracked faces: the LARGEST box. At an AAC screen
 * the student is by definition the person closest to the camera; a caregiver
 * leaning in behind them reads smaller. Deliberately not faces[0] — MediaPipe's
 * index order is not stable, and detecting a seizure on the wrong person's face
 * is both a miss and a false alarm at once.
 */
function pickSubjectFace(faces: RawTrackedFace[]): RawTrackedFace | null {
  let best: RawTrackedFace | null = null;
  let bestArea = 0;
  for (const f of faces) {
    const b = f.boundingBox;
    const area = b ? b.width * b.height : 0;
    if (!best || area > bestArea) { best = f; bestArea = area; }
  }
  return best;
}

export function useSeizureWatch(options: UseSeizureWatchOptions): UseSeizureWatchReturn {
  const {
    faces, hands, poses, getMotionField, enabled = true,
    thresholds = DEFAULT_THRESHOLDS, markers, initialBaseline, onWatchActiveChange,
  } = options;

  const [signature, setSignature] = useState<SeizureSignature | null>(null);
  const [seizureInfo, setSeizureInfo] = useState<SeizureSceneInfo | null>(null);
  const [watchActive, setWatchActive] = useState(false);
  const [baselineSamples, setBaselineSamples] = useState(0);
  const [subjectPresent, setSubjectPresent] = useState(false);

  const bufferRef = useRef<MotionFrame[]>([]);
  const baselineRef = useRef<MotionBaseline>(initialBaseline ?? emptyBaseline());
  const eventStartRef = useRef<number | null>(null);   // when the ongoing convulsive event began
  const lastClonicTsRef = useRef<number | null>(null); // last convulsive window (for post-ictal)
  const watchUntilRef = useRef(0);                     // hold the bumped rate until this ts
  const presentRef = useRef(false);                    // was a subject in view last tick?
  const markerOnlyBudgetRef = useRef(0);               // consecutive marker-only escalations spent
  const onWatchRef = useRef(onWatchActiveChange);
  onWatchRef.current = onWatchActiveChange;
  const thresholdsRef = useRef(thresholds);
  thresholdsRef.current = thresholds;
  const markersRef = useRef(markers);
  markersRef.current = markers;
  // Secondary sensors are read at the face tick rather than driving their own
  // ticks — one clock keeps the window's dt uniform, which the autocorrelation
  // depends on.
  const handsRef = useRef(hands);
  handsRef.current = hands;
  const posesRef = useRef(poses);
  posesRef.current = poses;
  const fieldRef = useRef(getMotionField);
  fieldRef.current = getMotionField;

  // Seed the baseline from the persisted long-term value when it arrives (the
  // server config can land after mount), as long as we haven't learned one yet.
  useEffect(() => {
    if (initialBaseline && baselineRef.current.samples === 0 && initialBaseline.samples > 0) {
      baselineRef.current = initialBaseline;
    }
  }, [initialBaseline]);

  // Drive watchActive off watchUntilRef on a steady timer (NOT the tracker
  // ticks) so it stands down on time even if the trackers stop arriving.
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
      presentRef.current = false;
      if (signature || seizureInfo) { setSignature(null); setSeizureInfo(null); }
      return;
    }

    const now = Date.now();
    const face = pickSubjectFace(faces);
    const frame = buildMotionFrame({
      ts: now,
      face,
      hands: handsRef.current ?? [],
      pose: posesRef.current?.[0] ?? null,
      field: fieldRef.current?.() ?? null,
    });

    if (!frame) {
      // Subject just left view. If a downward slump immediately preceded the
      // loss, flag ELEVATED risk: the student may have collapsed out of frame,
      // which the normal atonic detector can't catch (it needs the subject to
      // persist in view). Even a SMALL slump-then-loss is treated as
      // higher-risk on purpose. Losing the FACE is a much stronger signal than
      // losing the body was — at this camera distance a stably-tracked face is
      // the normal state, so its abrupt disappearance is genuinely anomalous.
      if (presentRef.current) {
        presentRef.current = false;
        setSubjectPresent(false);
        if (thresholdsRef.current.atonic.enabled && recentDownwardSlump(bufferRef.current, now)) {
          setSignature(null);
          setSeizureInfo({
            phase: "atonic",
            confidence: 0.85,
            summary: "[MOTION SIGNATURE] a downward slump immediately preceded the student's face leaving the camera view — they may have collapsed out of frame. HIGHER RISK: look now and check on the student; the motion detector can no longer see them.",
          });
        }
      }
      return; // keep the buffer, just don't extend it
    }

    // Subject (re)appeared — clear any lingering slump-loss flag so normal
    // detection takes over. setState(null) is a no-op when already null.
    const justReturned = !presentRef.current;
    presentRef.current = true;
    if (justReturned) { setSubjectPresent(true); setSeizureInfo(null); }

    // Extend the rolling window.
    const buf = bufferRef.current;
    buf.push(frame);
    while (buf.length && now - buf[0].ts > WINDOW_MS) buf.shift();

    const span = buf.length >= 2 ? buf[buf.length - 1].ts - buf[0].ts : 0;
    if (buf.length < MIN_FRAMES || span < MIN_SPAN_MS) return;

    const th = thresholdsRef.current;
    const sig = analyzeWindow(buf, baselineRef.current, th, markersRef.current ?? []);

    // Tiered watch: a clonic call OR a low-bar suspicion (broad anomalous
    // motion, a matched marker, or a couple of facial signs) holds the bumped
    // tracker rate so the DSP can resolve / confirm the rhythm.
    if (sig.phase === "clonic" || sig.markerOnly || suspectSeizure(sig, th.rhythmic.involvementMult)) {
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
      // A matched marker or any facial sign disqualifies the window too: those
      // are the moments we least want folded into "normal for this student".
      if (sig.phase === "none" && sig.confidence === 0
          && !sig.matchedMarkers.length && !sig.facialSigns.length) {
        baselineRef.current = updateBaseline(baselineRef.current, sig.regionEnergy);
      }
    }

    // A marker-only event has no phase clock of its own; start one so a
    // sustained posture still reports how long it has been held.
    if (effective.markerOnly && eventStartRef.current === null) eventStartRef.current = now;

    const ongoingMs = eventStartRef.current !== null ? now - eventStartRef.current : 0;
    // Marker-only escalation is budgeted (see MARKER_ONLY_MAX_ESCALATIONS); the
    // budget refills as soon as no marker matches.
    if (!effective.matchedMarkers.length) markerOnlyBudgetRef.current = 0;
    const markerOnlyExhausted =
      effective.markerOnly && markerOnlyBudgetRef.current >= MARKER_ONLY_MAX_ESCALATIONS;

    const summary = markerOnlyExhausted
      ? null
      : summarizeSignature(effective, ongoingMs, th.rhythmic.escalateConfidence);
    if (summary && effective.markerOnly) markerOnlyBudgetRef.current += 1;

    // A marker-only event has DSP phase "none" — report it as its own phase
    // rather than dressing it up as a convulsion the detector did not see.
    const scenePhase: SeizureSceneInfo["phase"] = effective.markerOnly
      ? "marker"
      : (effective.phase as SeizureSceneInfo["phase"]);
    const info: SeizureSceneInfo | null = summary
      ? { phase: scenePhase, confidence: effective.confidence, summary }
      : null;

    setSignature(effective);
    setSeizureInfo(info);
    setBaselineSamples(baselineRef.current.samples);
  }, [faces, enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  return { signature, seizureInfo, watchActive, baselineSamples, subjectPresent };
}

export default useSeizureWatch;
