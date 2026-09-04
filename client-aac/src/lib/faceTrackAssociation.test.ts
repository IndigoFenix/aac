// client-aac/src/lib/faceTrackAssociation.test.ts
//
// FACE TRACK CONTINUITY — the evidence quality layer under the presence ledger
// (planning-docs/aac-presence-ledger.md §7).
//
// What these pin, and why each one matters to a child sitting in front of the
// camera:
//   * a face that drifts keeps its id      → the server can accumulate evidence
//   * a face that JUMPS gets a new id      → one track never holds two people
//   * two faces stay distinct across frames → the parent isn't merged into the child
//   * a face gone longer than lostAfterMs comes back as somebody new
//   * the mean descriptor beats every single sample it was built from — the
//     whole reason for averaging: single frames of this student sit 0.40–0.59
//     from her own other poses, well past the 0.6 match threshold's comfort
//   * low-quality frames stay OUT of the mean, so a blurred profile shot can't
//     drag the anchor off the person

import { describe, it, expect } from "@jest/globals";
import {
  FaceTrackAssociator,
  boxIou,
  normalizedCenterDistance,
  type TrackedFaceBox,
} from "./faceTrackAssociation";

const box = (x: number, y: number, w = 100, h = 100): TrackedFaceBox => ({ x, y, w, h });

// A deterministic pseudo-random so "noise" is reproducible run to run.
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function euclidean(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

describe("geometry helpers", () => {
  it("scores identical boxes as full overlap and disjoint boxes as zero", () => {
    expect(boxIou(box(0, 0), box(0, 0))).toBeCloseTo(1, 6);
    expect(boxIou(box(0, 0), box(500, 500))).toBe(0);
  });

  it("normalises centre distance by box size, so far faces aren't punished", () => {
    // Same displacement in "face widths", different pixel scale.
    const near = normalizedCenterDistance(box(0, 0, 100, 100), box(50, 0, 100, 100));
    const far = normalizedCenterDistance(box(0, 0, 20, 20), box(10, 0, 20, 20));
    expect(near).toBeCloseTo(far, 6);
  });

  it("returns Infinity rather than NaN for a degenerate box", () => {
    expect(normalizedCenterDistance(box(0, 0, 0, 0), box(0, 0, 0, 0))).toBe(Infinity);
  });
});

describe("FaceTrackAssociator — continuity", () => {
  it("keeps one id while a face drifts slowly", () => {
    const a = new FaceTrackAssociator();
    let now = 1000;
    const first = a.associate("cam", [{ box: box(100, 100) }], now)[0];

    let last = first;
    for (let i = 1; i <= 10; i++) {
      now += 2000; // the real identification cadence
      last = a.associate("cam", [{ box: box(100 + i * 12, 100 + i * 6) }], now)[0];
      expect(last.trackId).toBe(first.trackId);
    }

    expect(last.frames).toBe(11);
    expect(last.firstSeenAt).toBe(1000);
    expect(last.lastSeenAt).toBe(now);
    expect(a.tracks("cam")).toHaveLength(1);
  });

  it("opens a new id when a face jumps past BOTH thresholds", () => {
    const a = new FaceTrackAssociator();
    const first = a.associate("cam", [{ box: box(100, 100) }], 1000)[0];
    // Far enough that IoU is 0 and the centres are ~4 face widths apart.
    const second = a.associate("cam", [{ box: box(500, 100) }], 3000)[0];

    expect(second.trackId).not.toBe(first.trackId);
    expect(second.frames).toBe(1);
    // The old track is still alive (within lostAfterMs), just unmatched.
    expect(a.tracks("cam")).toHaveLength(2);
  });

  it("holds a face that jumps far enough to break IoU but stays close in centre", () => {
    const a = new FaceTrackAssociator();
    const first = a.associate("cam", [{ box: box(100, 100) }], 1000)[0];
    // 70px displacement on a 100px face: IoU ≈ 0.18 (< 0.3), centre distance
    // 0.7 (< 0.75). This is the fast-motion case the fallback exists for.
    const moved = a.associate("cam", [{ box: box(170, 100) }], 2000)[0];
    expect(moved.trackId).toBe(first.trackId);
  });

  it("keeps two faces in one frame distinct across frames", () => {
    const a = new FaceTrackAssociator();
    const t0 = a.associate("cam", [{ box: box(0, 0) }, { box: box(400, 0) }], 1000);
    expect(t0[0].trackId).not.toBe(t0[1].trackId);

    // Both drift, and the input ORDER flips — association must go by geometry,
    // not by index, or the two people swap identities every other frame.
    const t1 = a.associate("cam", [{ box: box(410, 15) }, { box: box(15, 10) }], 3000);
    expect(t1[0].trackId).toBe(t0[1].trackId);
    expect(t1[1].trackId).toBe(t0[0].trackId);
    expect(a.tracks("cam")).toHaveLength(2);
  });

  it("gives a face lost for longer than lostAfterMs a NEW id", () => {
    const a = new FaceTrackAssociator({ lostAfterMs: 4000 });
    const first = a.associate("cam", [{ box: box(100, 100) }], 1000)[0];

    // Same position, but the gap exceeds the window: we cannot claim this is
    // the same person, so the server must not inherit the old track's identity.
    const back = a.associate("cam", [{ box: box(100, 100) }], 1000 + 4001)[0];
    expect(back.trackId).not.toBe(first.trackId);
    expect(a.tracks("cam")).toHaveLength(1);
  });

  it("keeps a face across a gap SHORTER than lostAfterMs", () => {
    const a = new FaceTrackAssociator({ lostAfterMs: 4000 });
    const first = a.associate("cam", [{ box: box(100, 100) }], 1000)[0];
    a.associate("cam", [], 2000); // a blink: no detections at all
    const back = a.associate("cam", [{ box: box(100, 100) }], 4500)[0];
    expect(back.trackId).toBe(first.trackId);
    expect(back.frames).toBe(2);
  });

  it("namespaces ids and tracks per camera", () => {
    const a = new FaceTrackAssociator();
    const user = a.associate("cam:user", [{ box: box(0, 0) }], 1000)[0];
    const env = a.associate("cam:env", [{ box: box(0, 0) }], 1000)[0];

    expect(user.trackId).toBe("cam:user#0");
    expect(env.trackId).toBe("cam:env#0");
    expect(a.tracks("cam:user")).toHaveLength(1);
    expect(a.tracks("cam:env")).toHaveLength(1);
  });

  it("reset drops tracks but never RECYCLES an id", () => {
    const a = new FaceTrackAssociator();
    const first = a.associate("cam", [{ box: box(0, 0) }], 1000)[0];
    a.reset("cam");
    expect(a.tracks("cam")).toHaveLength(0);

    const afterReset = a.associate("cam", [{ box: box(0, 0) }], 1200)[0];
    expect(afterReset.trackId).not.toBe(first.trackId);
  });

  it("bare reset clears every source", () => {
    const a = new FaceTrackAssociator();
    a.associate("one", [{ box: box(0, 0) }], 1000);
    a.associate("two", [{ box: box(0, 0) }], 1000);
    a.reset();
    expect(a.tracks("one")).toHaveLength(0);
    expect(a.tracks("two")).toHaveLength(0);
  });
});

describe("FaceTrackAssociator — descriptor mean", () => {
  const DIM = 16;
  const truth = Array.from({ length: DIM }, (_, i) => Math.sin(i) * 0.5);

  it("converges closer to the true vector than any single noisy sample", () => {
    const a = new FaceTrackAssociator({ meanWindow: 8 });
    const rng = makeRng(42);
    let now = 1000;
    let track = a.associate("cam", [{ box: box(0, 0), descriptor: truth, quality: 0.9 }], now)[0];

    const sampleDistances: number[] = [euclidean(truth, truth)];
    for (let i = 0; i < 7; i++) {
      now += 2000;
      const noisy = truth.map(v => v + (rng() - 0.5) * 0.4);
      sampleDistances.push(euclidean(noisy, truth));
      track = a.associate("cam", [{ box: box(0, 0), descriptor: noisy, quality: 0.9 }], now)[0];
    }

    expect(track.meanDescriptor).not.toBeNull();
    expect(track.descriptorCount).toBe(8);

    const meanDistance = euclidean(track.meanDescriptor!, truth);
    // Strictly better than every noisy sample (the first, exact sample aside —
    // that one is the truth itself, so compare against the noisy ones).
    for (const d of sampleDistances.slice(1)) {
      expect(meanDistance).toBeLessThan(d);
    }
  });

  it("keeps only the last meanWindow descriptors", () => {
    const a = new FaceTrackAssociator({ meanWindow: 3 });
    let now = 1000;
    let track = a.associate("cam", [{ box: box(0, 0), descriptor: [0, 0], quality: 1 }], now)[0];
    for (const v of [10, 20, 30]) {
      now += 1000;
      track = a.associate("cam", [{ box: box(0, 0), descriptor: [v, v], quality: 1 }], now)[0];
    }
    // The leading zero sample has been evicted: mean of 10/20/30, not 15.
    expect(track.descriptorCount).toBe(3);
    expect(track.meanDescriptor![0]).toBeCloseTo(20, 6);
  });

  it("excludes below-quality frames from the mean", () => {
    const a = new FaceTrackAssociator({ minQualityForMean: 0.35 });
    let now = 1000;
    let track = a.associate("cam", [{ box: box(0, 0), descriptor: [1, 1], quality: 0.9 }], now)[0];
    now += 1000;
    // A blurred profile shot: it moves the box (so the track lives on) but it
    // must not touch the anchor.
    track = a.associate("cam", [{ box: box(5, 5), descriptor: [99, 99], quality: 0.1 }], now)[0];

    expect(track.frames).toBe(2);
    expect(track.descriptorCount).toBe(1);
    expect(track.meanDescriptor).toEqual([1, 1]);
  });

  it("leaves meanDescriptor null until a qualifying descriptor arrives", () => {
    const a = new FaceTrackAssociator();
    const track = a.associate("cam", [{ box: box(0, 0), quality: 0.9 }], 1000)[0];
    expect(track.meanDescriptor).toBeNull();
    expect(track.descriptorCount).toBe(0);
  });

  it("accepts a descriptor with no quality reading at all", () => {
    // Some sources measure quality for every face or for none; refusing the
    // unmeasured case would leave the mean permanently empty.
    const a = new FaceTrackAssociator();
    const track = a.associate("cam", [{ box: box(0, 0), descriptor: [2, 2] }], 1000)[0];
    expect(track.meanDescriptor).toEqual([2, 2]);
  });

  it("does not average across a descriptor dimension change", () => {
    const a = new FaceTrackAssociator();
    let track = a.associate("cam", [{ box: box(0, 0), descriptor: [1, 1, 1], quality: 1 }], 1000)[0];
    track = a.associate("cam", [{ box: box(0, 0), descriptor: [5, 5], quality: 1 }], 2000)[0];
    expect(track.meanDescriptor).toEqual([5, 5]);
    expect(track.descriptorCount).toBe(1);
  });

  it("hands out copies — a caller mutating the result cannot poison the track", () => {
    const a = new FaceTrackAssociator();
    const track = a.associate("cam", [{ box: box(0, 0), descriptor: [1, 1], quality: 1 }], 1000)[0];
    track.meanDescriptor![0] = 999;
    track.box.x = 999;
    const again = a.tracks("cam")[0];
    expect(again.meanDescriptor).toEqual([1, 1]);
    expect(again.box.x).toBe(0);
  });

  it("keeps separate means for two faces in the same frame", () => {
    const a = new FaceTrackAssociator();
    let now = 1000;
    a.associate(
      "cam",
      [
        { box: box(0, 0), descriptor: [1, 1], quality: 1 },
        { box: box(400, 0), descriptor: [9, 9], quality: 1 },
      ],
      now,
    );
    now += 2000;
    const out = a.associate(
      "cam",
      [
        { box: box(10, 5), descriptor: [3, 3], quality: 1 },
        { box: box(405, 5), descriptor: [11, 11], quality: 1 },
      ],
      now,
    );
    expect(out[0].meanDescriptor).toEqual([2, 2]);
    expect(out[1].meanDescriptor).toEqual([10, 10]);
  });
});
