/**
 * Geologic-history scrubber (geo-scrub.ts) — §5b pointed backward.
 * Synthetic keyframes keep it unit-level: what must hold is the seam
 * math (position → straddling keyframes → blend), the ease (morph, not
 * snap; retarget mid-morph), and exact convergence at the endpoints.
 */
import { describe, it, expect } from "vitest";
import { createGeoScrubber } from "../geo-scrub";
import type { TectonicFrame } from "../tectonics";

const COLS = 8, ROWS = 4, N = COLS * ROWS;

function frameOf(epoch: number, h: number, ore = 0): TectonicFrame {
  return {
    epoch,
    height: new Uint8Array(N).fill(h),
    plate: new Int16Array(N),
    ore: new Uint8Array(N).fill(ore),
  };
}

const fakeImg = (): ImageData =>
  ({ data: new Uint8ClampedArray(N * 4), width: COLS, height: ROWS } as unknown as ImageData);

describe("geo scrubber", () => {
  it("starts at 'now', morphs toward a scrubbed epoch, and converges exactly", () => {
    const frames = [frameOf(0, 10), frameOf(100, 30), frameOf(200, 50)];
    const g = createGeoScrubber(frames, COLS, ROWS);
    const img = fakeImg();
    expect(g.pos()).toBe(1);
    expect(g.height(0)).toBe(50); // primed at the last keyframe
    expect(g.epoch()).toBe(200);

    g.setPos(0);
    expect(g.epoch()).toBe(0);
    g.paint(img, 0.05); // first paint primes the clock (dt 0)
    g.paint(img, 0.1);
    const mid = g.height(0);
    expect(mid).toBeLessThan(50); // moving...
    expect(mid).toBeGreaterThan(10); // ...but visibly a morph, not a snap
    let ts = 0.1;
    for (let i = 0; i < 100; i++) { ts += 0.1; g.paint(img, ts); }
    expect(g.height(0)).toBe(10); // landed exactly on the oldest keyframe
  });

  it("mid-position blends the straddling keyframes; retarget mid-morph bends", () => {
    const frames = [frameOf(0, 10), frameOf(100, 30), frameOf(200, 50)];
    const g = createGeoScrubber(frames, COLS, ROWS);
    const img = fakeImg();
    g.setPos(0.25); // halfway into the first segment: target height 20, epoch 50
    expect(g.epoch()).toBeCloseTo(50);
    let ts = 0;
    g.paint(img, (ts += 0.05));
    for (let i = 0; i < 10; i++) g.paint(img, (ts += 0.1));
    const near20 = g.height(0);
    expect(Math.abs(near20 - 20)).toBeLessThan(2);

    g.setPos(1); // yank back to now mid-morph: bends from where it is
    g.paint(img, (ts += 0.05));
    expect(g.height(0)).toBeGreaterThan(near20 - 1);
    for (let i = 0; i < 100; i++) g.paint(img, (ts += 0.1));
    expect(g.height(0)).toBe(50);
  });

  it("paints sea, land, and ore into the image without touching the frames", () => {
    const deep = frameOf(0, 0); // all sea
    const land = frameOf(100, 40, 8); // high ore-bearing land
    const g = createGeoScrubber([deep, land], COLS, ROWS);
    const img = fakeImg();
    let ts = 0;
    for (let i = 0; i < 100; i++) g.paint(img, (ts += 0.1)); // at pos 1: land
    expect(img.data[2]).toBeGreaterThan(0); // painted something
    g.setPos(0);
    for (let i = 0; i < 100; i++) g.paint(img, (ts += 0.1)); // now: sea
    expect(img.data[2]).toBeGreaterThan(img.data[0]); // blue over red = water
    expect(land.height[0]).toBe(40); // source keyframes untouched
    expect(deep.height[0]).toBe(0);
  });
});
