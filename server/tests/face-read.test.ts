/**
 * L4 + L5 — episodes, and what the decoder is allowed to claim.
 *
 * The load-bearing assertions here are the negative ones. This module's whole
 * job is to say LESS than the decoder it replaces:
 *   * it must say "unreadable" instead of "neutral" (D4);
 *   * it must not emit a channel per tick (D5);
 *   * it must not name a discrete emotion (§3.3/§3.4);
 *   * it must not GATE a composite on a channel this model attenuates (D2);
 *   * and it must not report a personal deviation it has no baseline for.
 */

import { describe, it, expect } from "@jest/globals";
import {
  createFaceReadTracker, faceReadPhrases, describeFaceRead, noChangePhrase,
  DEFAULT_FACE_READ_CONFIG,
  type FaceSample, type FaceRead,
} from "../../shared/aac/face-read.js";
import {
  createFaceBaselineAccumulator, mergeFaceBaseline, emptyHistogram, observeChannel,
  type ChannelHistogram, type FaceBaselineProfile,
} from "../../shared/aac/face-baseline.js";
import { auChannel } from "../../shared/aac/face-aus.js";
import { QUALITY_MIN_READ } from "../../shared/aac/face-features.js";

const TICK = 300;   // the tracker's real cadence
const ISO = "2026-09-02T00:00:00.000Z";

const GOOD_BOX = { x: 0.3, y: 0.2, width: 0.3, height: 0.4 };
const FRONTAL = { yaw: 0, pitch: 0, roll: 0 };

/** A readable sample carrying the given blendshapes. */
function sample(bs: Record<string, number> = {}, over: Partial<FaceSample> = {}): FaceSample {
  return {
    present: true,
    blendshapes: new Map(Object.entries(bs)),
    boundingBox: GOOD_BOX,
    headPose: FRONTAL,
    aspect: 16 / 9,
    ...over,
  };
}

/** A stored profile in which the student rests at `rest` on every listed AU. */
function profileAt(rest: Record<string, number>, samples = 800): FaceBaselineProfile {
  const channels: Record<string, ChannelHistogram> = {};
  for (const [au, v] of Object.entries(rest)) {
    const ch = auChannel(au as never);
    const h = emptyHistogram();
    // A little jitter, so the channel is not marked dead.
    for (let i = 0; i < samples; i++) observeChannel(h, ch, v + ((i % 5) - 2) * 0.004);
    channels[ch] = h;
  }
  return mergeFaceBaseline(undefined, { channels, n: samples }, ISO)!;
}

/** Drive the tracker for `ticks` frames of the same sample, returning the last
 *  read. Starts at t=1000 so `startedAt` is never confusable with 0. */
function run(
  tracker: ReturnType<typeof createFaceReadTracker>,
  baseline: ReturnType<typeof createFaceBaselineAccumulator>,
  s: FaceSample,
  ticks: number,
  t0 = 1000,
): { last: FaceRead; reads: FaceRead[]; endT: number } {
  const reads: FaceRead[] = [];
  let t = t0;
  for (let i = 0; i < ticks; i++) {
    reads.push(tracker.update(s, baseline, t));
    t += TICK;
  }
  return { last: reads[reads.length - 1], reads, endT: t };
}

// ---------------------------------------------------------------------------

describe("unreadable is not neutral (D4)", () => {
  it("asserts nothing when there is no face, and says why", () => {
    const tr = createFaceReadTracker();
    const b = createFaceBaselineAccumulator(null);
    const r = tr.update({ present: false }, b, 1000);
    expect(r.readable).toBe(false);
    expect(r.affect).toBeNull();
    expect(r.engagement).toBeNull();
    expect(r.active).toEqual([]);
    expect(r.qualityReasons).toContain("no face detected");
    expect(describeFaceRead(r)).toContain("unreadable");
    expect(describeFaceRead(r)).not.toContain("neutral");
  });

  it("asserts nothing when the face is turned too far to read", () => {
    const tr = createFaceReadTracker();
    const b = createFaceBaselineAccumulator(null);
    const r = tr.update(sample({ mouthSmileLeft: 0.9, mouthSmileRight: 0.9 }, {
      headPose: { yaw: 0.6, pitch: 0, roll: 0 },
    }), b, 1000);
    expect(r.readable).toBe(false);
    expect(r.quality).toBeLessThan(QUALITY_MIN_READ);
    // Even an unmistakable smile is NOT reported off an unreadable frame.
    expect(r.active).toEqual([]);
  });

  it("does not feed the baseline from frames it refused to read", () => {
    const tr = createFaceReadTracker();
    const b = createFaceBaselineAccumulator(null);
    for (let i = 0; i < 200; i++) {
      tr.update(sample({ jawOpen: 0.9 }, { headPose: { yaw: 0.7, pitch: 0, roll: 0 } }), b, 1000 + i * TICK);
    }
    // Nothing learned — otherwise the baseline would encode what a badly-turned
    // face looks like and every later z would be measured against that.
    expect(b.sessionObservation()).toBeNull();
  });

  it("says 'no expression change', never 'neutral', on a readable resting face", () => {
    const tr = createFaceReadTracker();
    const b = createFaceBaselineAccumulator(profileAt({ AU12: 0.05, AU26: 0.05 }));
    const { last } = run(tr, b, sample({ mouthSmileLeft: 0.05, mouthSmileRight: 0.05, jawOpen: 0.05 }), 10);
    expect(last.readable).toBe(true);
    const text = describeFaceRead(last);
    expect(text).not.toMatch(/\bneutral\b/);
    expect(noChangePhrase(last)).toContain("no expression change");
  });
});

describe("episodes, not ticks (D5)", () => {
  it("needs DWELL before it commits — one noisy frame is not an expression", () => {
    const tr = createFaceReadTracker();
    const b = createFaceBaselineAccumulator(profileAt({ AU12: 0.05 }));
    const rest = sample({ mouthSmileLeft: 0.05, mouthSmileRight: 0.05 });
    run(tr, b, rest, 5);
    // One frame of a big smile, then back to rest.
    const spike = tr.update(sample({ mouthSmileLeft: 0.9, mouthSmileRight: 0.9 }), b, 3000);
    expect(spike.active).toEqual([]);
    const after = tr.update(rest, b, 3300);
    expect(after.active).toEqual([]);
    expect(after.episodes).toEqual([]);
  });

  it("commits a SUSTAINED deviation and reports it once, not once per tick", () => {
    const tr = createFaceReadTracker();
    const b = createFaceBaselineAccumulator(profileAt({ AU12: 0.05 }));
    run(tr, b, sample({ mouthSmileLeft: 0.05, mouthSmileRight: 0.05 }), 5);
    const { reads } = run(tr, b, sample({ mouthSmileLeft: 0.5, mouthSmileRight: 0.5 }), 8, 3000);
    const smiling = reads.filter((r) => r.active.some((c) => c.channel === auChannel("AU12")));
    expect(smiling.length).toBeGreaterThan(0);
    // ONE episode boundary across the whole run, not one event per frame.
    expect(reads.reduce((n, r) => n + r.episodes.length, 0)).toBe(0);
    expect(smiling[0].active[0].durationMs).toBe(0);
  });

  it("emits the episode when the expression ENDS, with its peak and duration", () => {
    const tr = createFaceReadTracker();
    const b = createFaceBaselineAccumulator(profileAt({ AU12: 0.05 }));
    const rest = sample({ mouthSmileLeft: 0.05, mouthSmileRight: 0.05 });
    run(tr, b, rest, 5);
    const { endT } = run(tr, b, sample({ mouthSmileLeft: 0.5, mouthSmileRight: 0.5 }), 8, 3000);
    const { reads } = run(tr, b, rest, 6, endT);
    const ended = reads.flatMap((r) => r.episodes);
    expect(ended.length).toBe(1);
    expect(ended[0].channel).toBe(auChannel("AU12"));
    expect(ended[0].durationMs).toBeGreaterThan(TICK * 4);
    expect(ended[0].peakZ).toBeGreaterThan(DEFAULT_FACE_READ_CONFIG.enterZ);
  });

  it("HYSTERESIS: a channel hovering at the enter threshold does not oscillate", () => {
    const tr = createFaceReadTracker();
    const b = createFaceBaselineAccumulator(profileAt({ AU12: 0.05 }));
    run(tr, b, sample({ mouthSmileLeft: 0.05, mouthSmileRight: 0.05 }), 5);
    // Drive it up, then dither just under the enter threshold.
    run(tr, b, sample({ mouthSmileLeft: 0.5, mouthSmileRight: 0.5 }), 6, 3000);
    let t = 6000, flips = 0, prev: boolean | null = null;
    for (let i = 0; i < 20; i++) {
      const v = i % 2 === 0 ? 0.30 : 0.26;
      const r = tr.update(sample({ mouthSmileLeft: v, mouthSmileRight: v }), b, t);
      const on = r.active.some((c) => c.channel === auChannel("AU12"));
      if (prev !== null && on !== prev) flips++;
      prev = on;
      t += TICK;
    }
    // At most one transition across 20 dithering frames. Without hysteresis this
    // is the "turned left / turned right in the same window" failure again.
    expect(flips).toBeLessThanOrEqual(1);
  });

  it("does not end an episode because the face blinked out for a tick", () => {
    const tr = createFaceReadTracker();
    const b = createFaceBaselineAccumulator(profileAt({ AU12: 0.05 }));
    const smile = sample({ mouthSmileLeft: 0.5, mouthSmileRight: 0.5 });
    run(tr, b, sample({ mouthSmileLeft: 0.05, mouthSmileRight: 0.05 }), 5);
    run(tr, b, smile, 6, 3000);
    const gap = tr.update({ present: false }, b, 5000);
    expect(gap.episodes).toEqual([]);
    const back = tr.update(smile, b, 5300);
    expect(back.active.some((c) => c.channel === auChannel("AU12"))).toBe(true);
  });
});

describe("the personal baseline is what makes the read (D8)", () => {
  it("does NOT report a resting-open mouth as an event", () => {
    // The measured case: a student whose mouth rests open. A global
    // `jawOpen > 0.5` reports "mouth open" continuously and forever.
    const tr = createFaceReadTracker();
    const b = createFaceBaselineAccumulator(profileAt({ AU26: 0.62, AU25: 0.62 }));
    const { last } = run(tr, b, sample({ jawOpen: 0.62 }), 12);
    expect(last.readable).toBe(true);
    expect(last.active.some((c) => c.channel === auChannel("AU26"))).toBe(false);
  });

  it("DOES report the same student closing their mouth past their usual", () => {
    const tr = createFaceReadTracker();
    const b = createFaceBaselineAccumulator(profileAt({ AU26: 0.62 }));
    run(tr, b, sample({ jawOpen: 0.62 }), 6);
    const { last } = run(tr, b, sample({ jawOpen: 0.95 }), 8, 3000);
    expect(last.active.some((c) => c.channel === auChannel("AU26"))).toBe(true);
  });

  it("reports a modest movement on a student whose channel usually rests low", () => {
    // The other half: 0.35 is nowhere near a global 0.5 threshold, but it is a
    // large deviation for someone who rests at 0.03.
    const tr = createFaceReadTracker();
    const b = createFaceBaselineAccumulator(profileAt({ AU04: 0.03 }));
    run(tr, b, sample({ browDownLeft: 0.03, browDownRight: 0.03 }), 6);
    const { last } = run(tr, b, sample({ browDownLeft: 0.35, browDownRight: 0.35 }), 8, 3000);
    const brow = last.active.find((c) => c.channel === auChannel("AU04"));
    expect(brow).toBeDefined();
    expect(brow!.viaAbsolute).toBe(false);
    expect(brow!.z).toBeGreaterThan(DEFAULT_FACE_READ_CONFIG.enterZ);
  });

  it("names a high resting channel as a resting state, once the baseline is trusted", () => {
    const trusted: FaceBaselineProfile = { ...profileAt({ AU26: 0.6 }), sessions: 5 };
    const tr = createFaceReadTracker();
    const b = createFaceBaselineAccumulator(trusted);
    const { last } = run(tr, b, sample({ jawOpen: 0.6 }), 10);
    expect(last.baselineTrust).toBe(1);
    expect(last.notes.join(" ")).toMatch(/usual resting state/);
  });

  it("does NOT claim a resting state off a baseline it cannot trust yet", () => {
    const tr = createFaceReadTracker();
    const b = createFaceBaselineAccumulator(null);
    const { last } = run(tr, b, sample({ jawOpen: 0.6 }), 60);
    expect(last.baselineTrust).toBeLessThan(0.5);
    expect(last.notes).toEqual([]);
  });
});

describe("the absolute escape hatch", () => {
  it("still reports an unmistakable intensity with NO baseline at all", () => {
    const tr = createFaceReadTracker();
    const b = createFaceBaselineAccumulator(null);
    const { last } = run(tr, b, sample({ mouthSmileLeft: 0.85, mouthSmileRight: 0.85 }), 8);
    const smile = last.active.find((c) => c.channel === auChannel("AU12"));
    expect(smile).toBeDefined();
    // …and it SAYS it is an absolute reading rather than implying a personal
    // comparison that never happened.
    expect(smile!.viaAbsolute).toBe(true);
    expect(faceReadPhrases(last).expression.join(" ")).toContain("strong");
    expect(faceReadPhrases(last).expression.join(" ")).not.toContain("her usual");
  });

  it("stays quiet about a middling value it has no baseline for", () => {
    const tr = createFaceReadTracker();
    const b = createFaceBaselineAccumulator(null);
    const { last } = run(tr, b, sample({ mouthSmileLeft: 0.3, mouthSmileRight: 0.3 }), 8);
    expect(last.active).toEqual([]);
  });

  it("does NOT offer the absolute path to unbounded geometry channels", () => {
    // A geometry ratio has no meaningful absolute scale, so "0.55 of full" is
    // not a claim anyone can make about it.
    const tr = createFaceReadTracker();
    const b = createFaceBaselineAccumulator(null);
    const { last } = run(tr, b, sample({}, {
      landmarks: null,
    }), 8);
    expect(last.active.every((c) => c.channel.startsWith("au:"))).toBe(true);
  });
});

describe("affect (L5) — hedged by construction", () => {
  it("never names a discrete emotion", () => {
    const tr = createFaceReadTracker();
    const b = createFaceBaselineAccumulator({ ...profileAt({ AU12: 0.05, AU06: 0.02 }), sessions: 5 });
    run(tr, b, sample({ mouthSmileLeft: 0.05, mouthSmileRight: 0.05 }), 6);
    const { last } = run(tr, b, sample({
      mouthSmileLeft: 0.7, mouthSmileRight: 0.7, cheekSquintLeft: 0.5, cheekSquintRight: 0.5,
    }), 8, 3000);
    const text = describeFaceRead(last);
    for (const word of ["happy", "sad", "angry", "afraid", "disgust", "surprised"]) {
      expect(text.toLowerCase()).not.toContain(word);
    }
  });

  it("reads AU12 as positive valence and AU15+AU4 as negative", () => {
    const mk = (bs: Record<string, number>, rest: Record<string, number>) => {
      const tr = createFaceReadTracker();
      const b = createFaceBaselineAccumulator({ ...profileAt(rest), sessions: 5 });
      run(tr, b, sample(Object.fromEntries(Object.keys(bs).map((k) => [k, 0.03]))), 6);
      return run(tr, b, sample(bs), 8, 3000).last;
    };
    const happy = mk({ mouthSmileLeft: 0.7, mouthSmileRight: 0.7 }, { AU12: 0.03 });
    const sad = mk({ mouthFrownLeft: 0.7, mouthFrownRight: 0.7, browDownLeft: 0.5, browDownRight: 0.5 },
      { AU15: 0.03, AU04: 0.03 });
    expect(happy.affect!.valence).toBeGreaterThan(0.3);
    expect(sad.affect!.valence).toBeLessThan(-0.3);
  });

  it("does NOT gate on the Duchenne marker — an attenuated channel must not veto (D2)", () => {
    // AU6 (cheekSquint) may be pinned near zero by this model. Requiring it
    // would make a smile structurally unreportable, which is D2 exactly.
    const tr = createFaceReadTracker();
    const b = createFaceBaselineAccumulator({ ...profileAt({ AU12: 0.03 }), sessions: 5 });
    run(tr, b, sample({ mouthSmileLeft: 0.03, mouthSmileRight: 0.03 }), 6);
    const { last } = run(tr, b, sample({ mouthSmileLeft: 0.7, mouthSmileRight: 0.7 }), 8, 3000);
    expect(last.affect).not.toBeNull();
    expect(last.affect!.valence).toBeGreaterThan(0.3);
  });

  it("keeps confidence low, and capped", () => {
    const tr = createFaceReadTracker();
    const b = createFaceBaselineAccumulator({ ...profileAt({ AU12: 0.03 }), sessions: 20 });
    run(tr, b, sample({ mouthSmileLeft: 0.03, mouthSmileRight: 0.03 }), 6);
    const { last } = run(tr, b, sample({ mouthSmileLeft: 0.95, mouthSmileRight: 0.95 }), 10, 3000);
    expect(last.affect!.confidence).toBeLessThanOrEqual(DEFAULT_FACE_READ_CONFIG.maxAffectConfidence);
  });

  it("earns LESS confidence from a thin baseline than from an established one", () => {
    const mk = (sessions: number, n: number) => {
      const p = { ...profileAt({ AU12: 0.03 }, n), sessions };
      const tr = createFaceReadTracker();
      const b = createFaceBaselineAccumulator(p);
      run(tr, b, sample({ mouthSmileLeft: 0.03, mouthSmileRight: 0.03 }), 6);
      return run(tr, b, sample({ mouthSmileLeft: 0.8, mouthSmileRight: 0.8 }), 8, 3000).last;
    };
    expect(mk(1, 100).affect!.confidence).toBeLessThan(mk(10, 800).affect!.confidence);
  });

  it("earns LESS confidence from a poorer frame", () => {
    const mk = (box: typeof GOOD_BOX) => {
      const tr = createFaceReadTracker();
      const b = createFaceBaselineAccumulator({ ...profileAt({ AU12: 0.03 }), sessions: 10 });
      run(tr, b, sample({ mouthSmileLeft: 0.03, mouthSmileRight: 0.03 }, { boundingBox: box }), 6);
      return run(tr, b, sample({ mouthSmileLeft: 0.8, mouthSmileRight: 0.8 }, { boundingBox: box }), 8, 3000).last;
    };
    const small = { x: 0.4, y: 0.4, width: 0.1, height: 0.12 };
    expect(mk(small).affect!.confidence).toBeLessThan(mk(GOOD_BOX).affect!.confidence);
  });
});

describe("engagement, reported separately from affect (§3.3)", () => {
  it("reads eyes closed from the blink channel when there is no geometry", () => {
    const tr = createFaceReadTracker();
    const b = createFaceBaselineAccumulator(null);
    const { last } = run(tr, b, sample({ eyeBlinkLeft: 0.95, eyeBlinkRight: 0.95 }), 6);
    expect(last.engagement!.eyeOpenness).toBeLessThan(0.25);
    expect(faceReadPhrases(last).engagement).toContain("eyes closed");
  });

  it("drops gaze-on-screen to zero when the head is committed away", () => {
    const tr = createFaceReadTracker();
    const b = createFaceBaselineAccumulator(null);
    const away = run(tr, b, sample({}, { attentionAway: true }), 4).last;
    const here = run(createFaceReadTracker(), createFaceBaselineAccumulator(null), sample({}), 4).last;
    expect(away.engagement!.gazeOnScreen).toBe(0);
    expect(here.engagement!.gazeOnScreen).toBeGreaterThan(0.5);
  });

  it("reports a moving head as unstable and a still one as stable", () => {
    const still = createFaceReadTracker();
    const b1 = createFaceBaselineAccumulator(null);
    const r1 = run(still, b1, sample({}), 12).last;
    expect(r1.engagement!.headStability).toBeGreaterThan(0.9);

    const moving = createFaceReadTracker();
    const b2 = createFaceBaselineAccumulator(null);
    let t = 1000, last: FaceRead | null = null;
    for (let i = 0; i < 12; i++) {
      last = moving.update(sample({}, {
        headPose: { yaw: (i % 2 ? 0.2 : -0.2), pitch: 0, roll: 0 },
      }), b2, t);
      t += TICK;
    }
    expect(last!.engagement!.headStability).toBeLessThan(0.4);
  });
});

describe("rendering", () => {
  it("splits engagement from expression so a caller can take one half", () => {
    const tr = createFaceReadTracker();
    const b = createFaceBaselineAccumulator(null);
    const { last } = run(tr, b, sample({ mouthSmileLeft: 0.85, mouthSmileRight: 0.85 }), 8);
    const p = faceReadPhrases(last);
    expect(p.unreadable).toBeNull();
    expect(p.expression.join(" ")).toContain("smiling");
    expect(p.engagement.join(" ")).not.toContain("smiling");
  });

  it("names the basis of every claim", () => {
    const tr = createFaceReadTracker();
    const b = createFaceBaselineAccumulator({ ...profileAt({ AU04: 0.03 }), sessions: 5 });
    run(tr, b, sample({ browDownLeft: 0.03, browDownRight: 0.03 }), 6);
    const { last } = run(tr, b, sample({ browDownLeft: 0.4, browDownRight: 0.4 }), 8, 3000);
    expect(faceReadPhrases(last).expression.join(" ")).toMatch(/beyond her usual/);
  });

  it("reports a UNILATERAL movement as sided rather than averaging it away", () => {
    const tr = createFaceReadTracker();
    const b = createFaceBaselineAccumulator(null);
    const { last } = run(tr, b, sample({ mouthSmileLeft: 0.95, mouthSmileRight: 0.2 }), 8);
    const phrase = faceReadPhrases(last).expression.join(" ");
    expect(phrase).toContain("left side more");
  });

  it("renders nothing at all for a null read", () => {
    expect(describeFaceRead(null)).toBe("");
    expect(faceReadPhrases(undefined).expression).toEqual([]);
  });

  it("caps how many channels one read reports", () => {
    const tr = createFaceReadTracker();
    const b = createFaceBaselineAccumulator(null);
    const { last } = run(tr, b, sample({
      mouthSmileLeft: 0.9, mouthSmileRight: 0.9,
      browDownLeft: 0.9, browDownRight: 0.9,
      jawOpen: 0.9, mouthPucker: 0.9, mouthShrugLower: 0.9,
      eyeSquintLeft: 0.9, eyeSquintRight: 0.9,
    }), 8);
    expect(last.active.length).toBeLessThanOrEqual(DEFAULT_FACE_READ_CONFIG.maxReported);
  });
});
