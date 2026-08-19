/**
 * Client-side pre-upload downscale geometry (client/src/lib/downscale-image.ts).
 *
 * Only `fitWithin` is testable without a DOM — and it is the part worth pinning,
 * because the rounding is where this goes wrong: a 1px drift in one axis
 * produces a visibly squashed photo of somebody's family, and nobody reviews
 * upload code by eyeballing aspect ratios.
 *
 * See planning-docs/aac-photos-plan.md §5.
 */

import { describe, it, expect } from "@jest/globals";
import {
  UPLOAD_MAX_EDGE,
  fitWithin,
} from "../../client/src/lib/downscale-image.js";

describe("fitWithin", () => {
  it("leaves an image already inside the cap untouched", () => {
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600, resized: false });
  });

  it("treats an image exactly at the cap as not needing a resize", () => {
    // Re-encoding here would cost quality for zero byte savings.
    expect(fitWithin(1600, 1200, 1600)).toEqual({ width: 1600, height: 1200, resized: false });
  });

  it("scales a landscape original by its long edge", () => {
    const out = fitWithin(4032, 3024, 1600);
    expect(out.width).toBe(1600);
    expect(out.height).toBe(1200);
    expect(out.resized).toBe(true);
  });

  it("scales a portrait original by its long edge", () => {
    // The long edge is the HEIGHT here — capping width instead would leave a
    // portrait photo far larger than intended.
    const out = fitWithin(3024, 4032, 1600);
    expect(out.height).toBe(1600);
    expect(out.width).toBe(1200);
  });

  it("preserves aspect ratio for awkward ratios", () => {
    const cases: Array<[number, number]> = [
      [4032, 3024],
      [3000, 2000],
      [2576, 1932],
      [1920, 1080],
      [5000, 1000], // panorama
    ];
    for (const [w, h] of cases) {
      const out = fitWithin(w, h, 1600);
      // Within half a percent — rounding to whole pixels cannot do better.
      expect(out.width / out.height).toBeCloseTo(w / h, 1);
      expect(Math.max(out.width, out.height)).toBe(1600);
    }
  });

  it("never produces a zero dimension for an extreme panorama", () => {
    // 20000x10 scaled to a 1600 long edge rounds the short edge toward zero;
    // a 0-height canvas throws in the browser, so it must clamp to 1.
    const out = fitWithin(20000, 10, 1600);
    expect(out.width).toBe(1600);
    expect(out.height).toBeGreaterThanOrEqual(1);
  });

  it("uses a transport cap above the server's display render", () => {
    // The server re-renders to 1024px anyway. Uploading at or below that would
    // make the server's own downscale a second lossy pass over an already
    // degraded image, for no bandwidth gain.
    expect(UPLOAD_MAX_EDGE).toBeGreaterThan(1024);
  });
});
