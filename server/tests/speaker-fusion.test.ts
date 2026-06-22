/**
 * Audio-visual speaker attribution — fusing voice-embedding matches with
 * lip-sync (mouth moving / still / hidden). Pins the cross-modal rules:
 * a moving mouth confirms, a visible-still mouth RULES OUT (even with a voice
 * match), a hidden mouth falls back to voice-only. See shared/aac/speaker-fusion.ts.
 */

import { describe, it, expect } from "@jest/globals";
import {
  bboxIoU,
  mouthVerdict,
  fuseSpeakerLikelihood,
  renderSpeakerLikelihood,
  MOUTH_MOVING_MIN,
  type BBox,
} from "../../shared/aac/speaker-fusion.js";

const box = (x: number, y: number, w: number, h: number): BBox => ({ x, y, w, h });

describe("bboxIoU", () => {
  it("is 1 for identical boxes, 0 for disjoint", () => {
    expect(bboxIoU(box(0, 0, 10, 10), box(0, 0, 10, 10))).toBeCloseTo(1, 6);
    expect(bboxIoU(box(0, 0, 10, 10), box(20, 20, 10, 10))).toBe(0);
  });
  it("is partial for overlap", () => {
    // 10x10 and 10x10 offset by 5,0 → intersection 5x10=50, union 150 → 1/3.
    expect(bboxIoU(box(0, 0, 10, 10), box(5, 0, 10, 10))).toBeCloseTo(1 / 3, 4);
  });
});

describe("mouthVerdict", () => {
  it("hidden when not visible / no lip face", () => {
    expect(mouthVerdict(null)).toBe("hidden");
    expect(mouthVerdict({ bbox: box(0, 0, 1, 1), mouthActivity: 9, visible: false })).toBe("hidden");
  });
  it("moving above threshold, still below", () => {
    expect(mouthVerdict({ bbox: box(0, 0, 1, 1), mouthActivity: MOUTH_MOVING_MIN + 1, visible: true })).toBe("moving");
    expect(mouthVerdict({ bbox: box(0, 0, 1, 1), mouthActivity: 0, visible: true })).toBe("still");
  });
});

describe("fuseSpeakerLikelihood", () => {
  const momFace = { entityId: "mom", name: "Mom", bbox: box(0, 0, 10, 10) };
  const dadFace = { entityId: "dad", name: "Dad", bbox: box(50, 0, 10, 10) };

  it("a moving mouth + voice match ranks highest", () => {
    const out = fuseSpeakerLikelihood({
      voiceCandidates: [{ entityId: "mom", name: "Mom", similarity: 0.7 }],
      identifiedFaces: [momFace],
      lipFaces: [{ bbox: box(0, 0, 10, 10), mouthActivity: 4, visible: true }],
    });
    expect(out[0]).toMatchObject({ name: "Mom", mouth: "moving", ruledOut: false });
    expect(out[0].likelihood).toBeGreaterThan(0.7);
  });

  it("RULES OUT a person whose visible mouth was still — even with a voice match", () => {
    const out = fuseSpeakerLikelihood({
      voiceCandidates: [{ entityId: "dad", name: "Dad", similarity: 0.85 }],
      identifiedFaces: [dadFace],
      lipFaces: [{ bbox: box(50, 0, 10, 10), mouthActivity: 0, visible: true }],
    });
    const dad = out.find(s => s.name === "Dad")!;
    expect(dad.ruledOut).toBe(true);
    expect(dad.mouth).toBe("still");
    expect(dad.likelihood).toBeLessThan(0.15);
  });

  it("falls back to voice-only (uncertain) when the matched person isn't visible", () => {
    const out = fuseSpeakerLikelihood({
      voiceCandidates: [{ entityId: "mom", name: "Mom", similarity: 0.6 }],
      identifiedFaces: [],
      lipFaces: [],
    });
    expect(out[0]).toMatchObject({ name: "Mom", mouth: "hidden", ruledOut: false });
    expect(out[0].likelihood).toBeCloseTo(0.6, 6);
  });

  it("correlates faces↔lips by IoU, not order", () => {
    // Two faces; the MOVING lip overlaps Dad's box, not Mom's.
    const out = fuseSpeakerLikelihood({
      voiceCandidates: [],
      identifiedFaces: [momFace, dadFace],
      lipFaces: [
        { bbox: box(0, 0, 10, 10), mouthActivity: 0, visible: true },   // Mom still
        { bbox: box(50, 0, 10, 10), mouthActivity: 5, visible: true },  // Dad moving
      ],
    });
    expect(out.find(s => s.name === "Dad")!.mouth).toBe("moving");
    expect(out.find(s => s.name === "Mom")!.mouth).toBe("still");
    expect(out[0].name).toBe("Dad");
  });

  it("surfaces a talking but unidentified face", () => {
    const out = fuseSpeakerLikelihood({
      voiceCandidates: [],
      identifiedFaces: [],
      lipFaces: [{ bbox: box(0, 0, 10, 10), mouthActivity: 6, visible: true }],
    });
    expect(out.some(s => s.name.includes("unidentified") && s.mouth === "moving")).toBe(true);
  });
});

describe("renderSpeakerLikelihood", () => {
  it("renders ruled-out and percentages", () => {
    const line = renderSpeakerLikelihood([
      { name: "Mom", voiceSim: 0.7, mouth: "moving", likelihood: 0.85, ruledOut: false },
      { name: "Dad", voiceSim: 0.85, mouth: "still", likelihood: 0.08, ruledOut: true },
    ]);
    expect(line).toContain("[SPEAKER LIKELIHOOD]");
    expect(line).toContain("Mom — 85% (voice 70%, mouth moving)");
    expect(line).toContain("Dad — RULED OUT");
  });
  it("empty for no candidates", () => {
    expect(renderSpeakerLikelihood([])).toBe("");
  });
});
