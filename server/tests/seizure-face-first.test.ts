/**
 * The face-first seizure DSP + per-student markers.
 *
 * These tests exist because of a specific field failure: at the AAC's real
 * camera distance (a screen an arm's length from the child) the pose model's
 * arms collapse to their shoulder points, the bilateral-symmetry correlation
 * goes to ~0, and the old detector could not call a convulsion no matter what
 * the student did. So the headline case here is "NO POSE AT ALL, and it still
 * works" — everything else is guarding the discriminators that make the signal
 * specific rather than merely sensitive.
 *
 * All frames are synthesized in normalized coords (y down) at 15 fps, so the
 * 2–5 Hz clonic band is resolvable (Nyquist).
 */

import { describe, it, expect } from "@jest/globals";
import {
  analyzeWindow, updateBaseline, emptyBaseline, summarizeSignature, suspectSeizure,
  deriveFacialSigns, POSE_SPAN_PER_FACE_WIDTH,
} from "../../shared/aac/seizure-signature.js";
import {
  evaluateCue, coerceSeizureMarkers, ELEVATION_MARGIN,
  type SeizureMarker,
} from "../../shared/aac/seizure-markers.js";
import type { FacialSample, MotionBaseline, MotionFrame } from "../../shared/aac/motion-types.js";

const FPS = 15;
const DT = 1000 / FPS;
const FACE_W = 0.2;              // face width in frame units — the subject scale
const FACE_CX = 0.5, FACE_CY = 0.3;

const neutralFace = (): FacialSample => ({
  yaw: 0, pitch: 0, roll: 0, jawOpen: 0.05,
  eyeBlinkLeft: 0.1, eyeBlinkRight: 0.1, gazeX: 0, gazeY: 0, asymmetry: 0.02,
});

interface FrameOpts {
  /** Head (nose) offset from the face centre, in FRAME units. */
  head?: { dx: number; dy: number };
  /** Whole-face translation (anchor moves with it — a real head movement). */
  anchor?: { dx: number; dy: number };
  leftHand?: { x: number; y: number } | null;
  rightHand?: { x: number; y: number } | null;
  facial?: Partial<FacialSample>;
}

/** One face-sourced MotionFrame: no pose, which is the whole point. */
function faceFrame(ts: number, o: FrameOpts = {}): MotionFrame {
  const ax = FACE_CX + (o.anchor?.dx ?? 0);
  const ay = FACE_CY + (o.anchor?.dy ?? 0);
  const regions: MotionFrame["regions"] = {
    head: { x: ax + (o.head?.dx ?? 0), y: ay + (o.head?.dy ?? 0) },
  };
  if (o.leftHand !== null) regions.leftHand = o.leftHand ?? { x: 0.38, y: 0.55 };
  if (o.rightHand !== null) regions.rightHand = o.rightHand ?? { x: 0.62, y: 0.55 };
  return {
    ts,
    regions,
    anchor: { x: ax, y: ay },
    scale: FACE_W,
    facial: { ...neutralFace(), ...o.facial },
  };
}

function series(n: number, fn: (t: number) => FrameOpts): MotionFrame[] {
  return Array.from({ length: n }, (_, i) => faceFrame(i * DT, fn(i * DT)));
}

const quiet = () => series(60, () => ({}));

/** Warm a baseline on quiet face-only windows. */
function warmBaseline(builder: () => MotionFrame[] = quiet): MotionBaseline {
  let b = emptyBaseline();
  for (let k = 0; k < 8; k++) b = updateBaseline(b, analyzeWindow(builder(), b).regionEnergy);
  return b;
}

/**
 * Convulsive: head jerking at 3.3 Hz with the hands jerking HARDER, in phase
 * with each other. The extra limb amplitude matters — a tonic-clonic moves the
 * limbs RELATIVE to the trunk, whereas a body translating as one rigid mass is
 * rocking (see the en-bloc test below). A fixture where the hands track the
 * head exactly would be modelling the wrong thing.
 */
const clonicFaceOnly = () => series(60, (t) => {
  const j = 0.02 * Math.sin(2 * Math.PI * 3.3 * (t / 1000));
  return {
    anchor: { dx: j, dy: j },                             // the head itself jerks
    leftHand: { x: 0.38 + j * 3, y: 0.55 + j * 3 },
    rightHand: { x: 0.62 + j * 3, y: 0.55 + j * 3 },      // in phase → symmetric
  };
});

/** Rocking: the whole subject sways as one rigid mass — hands stationary
 *  relative to the trunk. A common self-soothing movement here, and the false
 *  positive that the en-bloc test exists to reject. */
const rockingEnBloc = () => series(60, (t) => {
  const s = 0.03 * Math.sin(2 * Math.PI * 1.8 * (t / 1000));
  return {
    anchor: { dx: s, dy: 0 },
    leftHand: { x: 0.38 + s, y: 0.55 },
    rightHand: { x: 0.62 + s, y: 0.55 },
  };
});

/** Rett-like hand-wringing: both hands anti-phase, head perfectly still. */
const stereotypyFaceOnly = () => series(60, (t) => {
  const a = 0.02 * Math.sin(2 * Math.PI * 2.5 * (t / 1000));
  return {
    leftHand: { x: 0.46 + a, y: 0.55 },
    rightHand: { x: 0.54 - a, y: 0.55 },
  };
});

describe("face-first DSP — works with NO pose data at all", () => {
  it("calls clonic from head + hands alone (the regression the rework fixes)", () => {
    const sig = analyzeWindow(clonicFaceOnly(), warmBaseline());
    expect(sig.phase).toBe("clonic");
  });

  it("uses the HEAD as the axial region (there is no torso in view)", () => {
    const sig = analyzeWindow(clonicFaceOnly(), warmBaseline());
    expect(sig.involvedRegions).toContain("head");
    expect(sig.involvedRegions).not.toContain("torso");
  });

  it("recovers the frequency from head motion — the anchor must not cancel it", () => {
    // Regression guard: the anchor is the face centre, so a naive
    // anchor-relative head series is CONSTANT and reports 0 Hz.
    const sig = analyzeWindow(clonicFaceOnly(), warmBaseline());
    expect(sig.dominantHz).toBeGreaterThan(2);
    expect(sig.dominantHz).toBeLessThan(5);
  });

  it("still rejects distal anti-phase hand-wringing (specificity survives)", () => {
    const sig = analyzeWindow(stereotypyFaceOnly(), warmBaseline());
    expect(sig.phase).not.toBe("clonic");
    expect(summarizeSignature(sig)).toBeNull();
  });
});

describe("bilateral symmetry — unmeasurable is NOT the same as absent", () => {
  it("reports symmetryEvaluable:false when only one hand is in view", () => {
    const oneHand = () => series(60, (t) => {
      const j = 0.02 * Math.sin(2 * Math.PI * 3.3 * (t / 1000));
      return { anchor: { dx: j, dy: j }, leftHand: { x: 0.38 + j, y: 0.55 + j }, rightHand: null };
    });
    const sig = analyzeWindow(oneHand(), warmBaseline());
    expect(sig.symmetryEvaluable).toBe(false);
  });

  it("does NOT block a convulsive call when symmetry cannot be measured", () => {
    // The old code reported 0 here and the gate read that as "asymmetric",
    // which is precisely how a one-sided view disabled the detector.
    const oneHand = () => series(60, (t) => {
      const j = 0.02 * Math.sin(2 * Math.PI * 3.3 * (t / 1000));
      return { anchor: { dx: j, dy: j }, leftHand: { x: 0.38 + j, y: 0.55 + j }, rightHand: null };
    });
    const sig = analyzeWindow(oneHand(), warmBaseline());
    expect(sig.phase).toBe("clonic");
  });

  it("still applies the symmetry gate when BOTH sides are visible", () => {
    const sig = analyzeWindow(stereotypyFaceOnly(), warmBaseline());
    expect(sig.symmetryEvaluable).toBe(true);
    expect(sig.phase).not.toBe("clonic");
  });

  it("distinguishes 'a side is missing' from 'nothing moved relative to the body'", () => {
    const missing = analyzeWindow(
      series(60, (t) => {
        const j = 0.02 * Math.sin(2 * Math.PI * 3.3 * (t / 1000));
        return { anchor: { dx: j, dy: j }, leftHand: { x: 0.38 + j * 3, y: 0.55 }, rightHand: null };
      }), warmBaseline());
    expect(missing.symmetryState).toBe("unobserved");
    expect(analyzeWindow(rockingEnBloc(), warmBaseline()).symmetryState).toBe("en_bloc");
  });
});

describe("rocking must not read as a convulsion", () => {
  it("rejects rigid whole-body sway even though it is rhythmic and axial", () => {
    // Rocking clears frequency, rhythmicity, axial involvement AND the region
    // count. En-bloc motion is the only thing separating it from a convulsion:
    // a tonic-clonic jerks the limbs relative to the trunk, rocking does not.
    const sig = analyzeWindow(rockingEnBloc(), warmBaseline());
    expect(sig.dominantHz).toBeGreaterThan(1.5);
    expect(sig.involvedRegions.some(r => r === "head")).toBe(true);
    expect(sig.phase).not.toBe("clonic");
    expect(summarizeSignature(sig)).toBeNull();
  });

  it("still raises suspicion (worth a closer look, not an interruption)", () => {
    expect(suspectSeizure(analyzeWindow(rockingEnBloc(), warmBaseline()))).toBe(true);
  });
});

// ── Per-student markers ──────────────────────────────────────────────────────

const armUpMarker = (weight: "strong" | "supportive"): SeizureMarker => ({
  id: "m1", label: "holds her left arm up", weight,
  cue: { kind: "limb_elevation", side: "left" },
});

/** Sustained left-arm elevation, no rhythm, no bilateral involvement — the
 *  presentation the generic gate is structurally incapable of calling. */
const leftArmRaised = () => series(60, () => ({
  leftHand: { x: 0.38, y: FACE_CY - (ELEVATION_MARGIN + 0.4) * FACE_W },
}));

describe("per-student markers — the presentation the generic gate cannot see", () => {
  it("the generic detector finds NOTHING in a sustained one-sided arm raise", () => {
    const sig = analyzeWindow(leftArmRaised(), warmBaseline());
    expect(sig.phase).toBe("none");
    expect(summarizeSignature(sig)).toBeNull();
  });

  it("a STRONG marker escalates the same window on its own", () => {
    const sig = analyzeWindow(leftArmRaised(), warmBaseline(), undefined, [armUpMarker("strong")]);
    expect(sig.markerOnly).toBe(true);
    expect(sig.matchedMarkers.map(m => m.label)).toContain("holds her left arm up");
    expect(summarizeSignature(sig)).toContain("holds her left arm up");
  });

  it("a SUPPORTIVE marker does NOT escalate on its own", () => {
    const sig = analyzeWindow(leftArmRaised(), warmBaseline(), undefined, [armUpMarker("supportive")]);
    expect(sig.matchedMarkers).toHaveLength(1);
    expect(sig.markerOnly).toBe(false);
    expect(summarizeSignature(sig)).toBeNull();
  });

  it("matches the configured SIDE only", () => {
    const rightMarker: SeizureMarker = {
      id: "m2", label: "right arm up", weight: "strong",
      cue: { kind: "limb_elevation", side: "right" },
    };
    const sig = analyzeWindow(leftArmRaised(), warmBaseline(), undefined, [rightMarker]);
    expect(sig.matchedMarkers).toHaveLength(0);
  });

  it("does not match a hand merely raised to the face (the common stereotypy)", () => {
    const handToFace = () => series(60, () => ({ leftHand: { x: 0.46, y: FACE_CY } }));
    const sig = analyzeWindow(handToFace(), warmBaseline(), undefined, [armUpMarker("strong")]);
    expect(sig.matchedMarkers).toHaveLength(0);
  });

  it("does not match a BRIEF raise — sustain is the guard against voluntary reaching", () => {
    const reach = () => series(60, (t) => ({
      leftHand: t > 400 && t < 900
        ? { x: 0.38, y: FACE_CY - (ELEVATION_MARGIN + 0.4) * FACE_W }
        : { x: 0.38, y: 0.55 },
    }));
    const sig = analyzeWindow(reach(), warmBaseline(), undefined, [armUpMarker("strong")]);
    expect(sig.matchedMarkers).toHaveLength(0);
  });

  it("escalates a HELD posture even though stillness lands in the flat/atonic branch", () => {
    // Regression guard. A tonic posture barely moves, so for a student whose
    // baseline has motion it lands in the non-escalating "flat" atonic branch —
    // not phase "none". Gating the marker path on `phase === "none"` let that
    // swallow the marker for exactly the presentation it exists to catch.
    const fidgety = () => series(60, (t) => {
      const w = 0.012 * Math.sin(2 * Math.PI * 2.2 * (t / 1000));
      return { leftHand: { x: 0.46 + w, y: 0.55 }, rightHand: { x: 0.54 - w, y: 0.55 } };
    });
    const activeBaseline = warmBaseline(fidgety);
    const held = () => series(60, () => ({
      leftHand: { x: 0.38, y: FACE_CY - (ELEVATION_MARGIN + 0.4) * FACE_W },
      rightHand: { x: 0.54, y: 0.55 },
    }));

    const withoutMarker = analyzeWindow(held(), activeBaseline);
    expect(withoutMarker.phase).toBe("atonic");      // flat, not "none"
    expect(withoutMarker.atonicDrop).toBeFalsy();
    expect(summarizeSignature(withoutMarker)).toBeNull();

    const withMarker = analyzeWindow(held(), activeBaseline, undefined, [armUpMarker("strong")]);
    expect(withMarker.markerOnly).toBe(true);
    expect(summarizeSignature(withMarker)).toContain("holds her left arm up");
  });

  it("corroborates rather than replaces when a generic pattern also fired", () => {
    const withMarker = analyzeWindow(clonicFaceOnly(), warmBaseline(), undefined, [
      { id: "m3", label: "head turns right", weight: "strong", cue: { kind: "head_turn", side: "right" } },
    ]);
    expect(withMarker.phase).toBe("clonic");
    expect(withMarker.markerOnly).toBe(false);
  });

  it("an absent sensor yields null (unknown), never a false 'no match'", () => {
    // A hand out of frame must not read as "her arm is not raised" — for a
    // student whose marker IS an arm, that would be the worst possible failure.
    const noHands = () => series(60, () => ({ leftHand: null, rightHand: null }));
    const frames = noHands();
    const ctx = {
      frames, relPos: {}, regionEnergy: {}, facial: [],
      dominantFrequency: () => ({ hz: 0, rhythmicity: 0 }), meanDtMs: DT,
    };
    expect(evaluateCue({ kind: "limb_elevation", side: "left" }, ctx)).toBeNull();
  });
});

describe("facial semiology — annotation and suspicion, never a standalone call", () => {
  const deviatedGaze = (): MotionFrame[] => series(60, () => ({
    facial: { gazeX: 0.8, yaw: 0.5, jawOpen: 0.7 },
  }));

  it("derives sustained signs from the face channel", () => {
    const facial = deviatedGaze().map(f => f.facial!);
    const signs = deriveFacialSigns(facial, DT, 4000);
    expect(signs).toEqual(expect.arrayContaining(["eye_deviation", "head_version", "jaw_forced_open"]));
  });

  it("does NOT escalate on facial signs alone", () => {
    const sig = analyzeWindow(deviatedGaze(), warmBaseline());
    expect(sig.phase).toBe("none");
    expect(summarizeSignature(sig)).toBeNull();
  });

  it("DOES raise suspicion, which buys a closer look at a higher frame rate", () => {
    const sig = analyzeWindow(deviatedGaze(), warmBaseline());
    expect(sig.facialSigns.length).toBeGreaterThanOrEqual(2);
    expect(suspectSeizure(sig)).toBe(true);
  });

  it("annotates the summary once a real detector fires", () => {
    const clonicWithFace = () => series(60, (t) => {
      const j = 0.02 * Math.sin(2 * Math.PI * 3.3 * (t / 1000));
      return {
        anchor: { dx: j, dy: j },
        leftHand: { x: 0.38 + j * 3, y: 0.55 + j * 3 },
        rightHand: { x: 0.62 + j * 3, y: 0.55 + j * 3 },
        facial: { gazeX: 0.8, jawOpen: 0.7 },
      };
    });
    const sig = analyzeWindow(clonicWithFace(), warmBaseline());
    expect(sig.phase).toBe("clonic");
    expect(summarizeSignature(sig)).toContain("Face also shows");
  });
});

describe("scale normalization — the same real movement at two camera distances", () => {
  /** A collapse of `dropFaceWidths`, rendered at a given face size in frame. */
  function collapseAt(faceW: number, dropFaceWidths: number): MotionFrame[] {
    const drop = dropFaceWidths * faceW;
    return Array.from({ length: 60 }, (_, i) => {
      const t = i * DT;
      const dy = t > 1100 ? drop : t > 500 ? (drop * (t - 500)) / 600 : 0;
      const ay = FACE_CY + dy;
      return {
        ts: t,
        regions: { head: { x: FACE_CX, y: ay } },
        anchor: { x: FACE_CX, y: ay },
        scale: faceW,
        facial: neutralFace(),
      };
    });
  }

  it("flags the same collapse whether the child is close or far from the camera", () => {
    const b = warmBaseline();
    const close = analyzeWindow(collapseAt(0.35, 1.2), b);   // large face in frame
    const far = analyzeWindow(collapseAt(0.12, 1.2), b);     // small face in frame
    expect(close.atonicDrop).toBe(true);
    expect(far.atonicDrop).toBe(true);
  });

  it("does not flag a small movement just because the child sat closer", () => {
    // In FRAME units this is a bigger displacement than the far-away collapse
    // above; in body units it is a twitch. The old frame-fraction threshold got
    // this backwards.
    const sig = analyzeWindow(collapseAt(0.35, 0.2), warmBaseline());
    expect(sig.atonicDrop).toBeFalsy();
  });

  it("pose-sourced scale is converted to face widths so one threshold means one thing", () => {
    expect(POSE_SPAN_PER_FACE_WIDTH).toBeGreaterThan(1);
  });
});

describe("coerceSeizureMarkers — stored config is untrusted", () => {
  it("drops entries with an unknown cue kind rather than keeping a dead marker", () => {
    expect(coerceSeizureMarkers([{ id: "a", label: "x", cue: { kind: "telepathy" } }])).toHaveLength(0);
  });

  it("drops unlabelled entries (the label is what the Observer reads)", () => {
    expect(coerceSeizureMarkers([{ id: "a", label: "  ", cue: { kind: "jaw_open" } }])).toHaveLength(0);
  });

  it("defaults an unknown weight to supportive, never strong", () => {
    const [m] = coerceSeizureMarkers([{ id: "a", label: "x", cue: { kind: "jaw_open" }, weight: "critical" }]);
    expect(m.weight).toBe("supportive");
  });

  it("keeps a valid sided marker intact", () => {
    const [m] = coerceSeizureMarkers([
      { id: "a", label: "left arm up", cue: { kind: "limb_elevation", side: "left" }, weight: "strong" },
    ]);
    expect(m).toEqual({
      id: "a", label: "left arm up", weight: "strong",
      cue: { kind: "limb_elevation", side: "left" },
    });
  });

  it("tolerates a non-array", () => {
    expect(coerceSeizureMarkers(null)).toEqual([]);
    expect(coerceSeizureMarkers("nope")).toEqual([]);
  });
});
