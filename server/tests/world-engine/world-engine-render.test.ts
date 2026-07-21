// Pure camera-math tests for the Render2D view. The draw call itself is DOM and
// device-tested; the world↔screen transform is the only part with a correctness
// obligation (steering input rides the same transform, so a bug here would make
// the avatar chase the wrong point).

import { describe, it, expect } from "@jest/globals";
import {
  fitCamera,
  followCamera,
  worldToScreen,
  screenToWorld,
} from "@shared/world-engine/render2d.js";

describe("Render2D camera", () => {
  const world = { width: 40, height: 30 };

  it("round-trips world ↔ screen", () => {
    const cam = fitCamera(800, 600, world);
    for (const p of [{ x: 0, y: 0 }, { x: 40, y: 30 }, { x: 13.5, y: 7.2 }]) {
      const s = worldToScreen(cam, p.x, p.y);
      const back = screenToWorld(cam, s.sx, s.sy);
      expect(back.x).toBeCloseTo(p.x, 6);
      expect(back.y).toBeCloseTo(p.y, 6);
    }
  });

  it("centers the field and preserves aspect", () => {
    const cam = fitCamera(800, 600, world, 0);
    // 40×30 into 800×600: width-bound at scale 20 → field is 800×600, centered.
    expect(cam.scale).toBeCloseTo(20, 6);
    const tl = worldToScreen(cam, 0, 0);
    const br = worldToScreen(cam, 40, 30);
    expect(tl.sx).toBeCloseTo(0, 6);
    expect(br.sx).toBeCloseTo(800, 6);
    // A wider view letterboxes horizontally (field centered, equal margins).
    const wide = fitCamera(1000, 600, world, 0);
    const o = worldToScreen(wide, 0, 0);
    expect(o.sx).toBeCloseTo((1000 - 40 * wide.scale) / 2, 6);
  });

  it("followCamera centers on the target at a fixed zoom", () => {
    const center = { x: 40, y: 30 };
    const cam = followCamera(800, 600, center, 30); // 30 units across the smaller (600) dim
    expect(cam.scale).toBeCloseTo(600 / 30, 6); // 20 px/unit
    // The followed point sits at the exact screen centre.
    const c = worldToScreen(cam, center.x, center.y);
    expect(c.sx).toBeCloseTo(400, 6);
    expect(c.sy).toBeCloseTo(300, 6);
    // The pointer→world mapping the avatar steers by stays an exact inverse.
    const back = screenToWorld(cam, 520, 300);
    expect(back.x).toBeCloseTo(center.x + 120 / cam.scale, 6); // 6 units right of centre
  });
});
