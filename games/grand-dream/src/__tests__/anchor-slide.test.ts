/**
 * ACTIVITY ANCHOR SLIDE — the root transform that lies a sleeper on its bed /
 * sits a diner on its chair (creature-model.ts), pinned at the two seams that
 * produced field teleports:
 *
 *   • anchorSlideLevel: movement must dissolve the SLIDE with the same dial
 *     that dissolves the pose (animation.ts `1 - clamp01(speed/0.2)`). Without
 *     it a body dragged off mid-activity stayed glued to the toilet at full
 *     strength while its pose faded, then teleported to the sim body.
 *   • createAnchorLatch: the sim clears `state.activity` the instant a dwell
 *     ends, so the per-frame anchor goes null while the animator is still
 *     easing the pose OUT — the root snapped from the bed to the stand point
 *     in one frame. The latch keeps the last anchor until the blend hits zero.
 */
import { describe, it, expect } from "vitest";
import { anchorSlideLevel, createAnchorLatch, type ActivityAnchor } from "@shared/world-engine/creatures/creature-model";

describe("anchorSlideLevel — movement dissolves the slide like the pose", () => {
  it("a body at rest slides at the full pose level", () => {
    expect(anchorSlideLevel(1, 0)).toBe(1);
    expect(anchorSlideLevel(0.4, 0)).toBe(0.4);
  });

  it("the walk dial fully dissolves it — a dragged body is never glued to the fixture", () => {
    // 0.2 on the speed01 dial is the same threshold animation.ts uses for the
    // pose itself; at or past it the slide is gone entirely.
    expect(anchorSlideLevel(1, 0.2)).toBe(0);
    expect(anchorSlideLevel(1, 1)).toBe(0);
  });

  it("dissolves proportionally below the dial", () => {
    expect(anchorSlideLevel(1, 0.1)).toBeCloseTo(0.5, 10);
    expect(anchorSlideLevel(0.8, 0.05)).toBeCloseTo(0.6, 10);
  });

  it("never goes negative on odd inputs", () => {
    expect(anchorSlideLevel(1, -0.5)).toBe(1); // clamped, not amplified
    expect(anchorSlideLevel(0, 0)).toBe(0);
  });
});

describe("createAnchorLatch — the anchor survives the pose's wind-down", () => {
  const bed: ActivityAnchor = { x: 3, y: 0.5, z: 7, yaw: 1.2 };
  const chair: ActivityAnchor = { x: 9, y: 0.4, z: 2, yaw: -0.6 };

  it("REGRESSION: activity cleared mid-blend keeps sliding against the LAST anchor", () => {
    const latch = createAnchorLatch();
    latch(bed, 1); // asleep, fully blended
    // The dwell ends: sim deletes state.activity → per-frame anchor is null,
    // but the pose is still easing out. The old code snapped the root to the
    // stand point here — the teleport OFF the bed.
    expect(latch(null, 0.6)).toEqual(bed);
    expect(latch(null, 0.2)).toEqual(bed);
  });

  it("releases the latch only once the blend reaches zero", () => {
    const latch = createAnchorLatch();
    latch(bed, 1);
    latch(null, 0.3);
    expect(latch(null, 0)).toBeNull();
    // ...and it stays released: a later blend-in with no anchor is a plain
    // pose-in-place, not a slide back to the stale bed.
    expect(latch(null, 0.5)).toBeNull();
  });

  it("first frame of a fresh activity returns null until the blend starts", () => {
    const latch = createAnchorLatch();
    // level is 0 on the very first frame — the slide begins as the blend
    // rises, never as a jump.
    expect(latch(bed, 0)).toBeNull();
    expect(latch(bed, 0.1)).toEqual(bed);
  });

  it("a new anchor replaces the old one", () => {
    const latch = createAnchorLatch();
    latch(bed, 1);
    latch(null, 0); // released
    expect(latch(chair, 0.4)).toEqual(chair);
  });
});
