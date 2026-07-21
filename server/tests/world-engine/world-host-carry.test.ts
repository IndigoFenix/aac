// The carry dwell-UX in runWorldHost: dwell on a nearby carryable object to pick
// it up; while carrying, dwell on a spot to place it (here, onto a container).
// Driven headless via a mock WorldView (screenToWorld = identity, so a pointer
// px IS a world point) and a hand-stepped clock. No GL.

import { describe, it, expect } from "@jest/globals";
import { runWorldHost } from "@shared/world-engine/world-host.js";
import type { WorldView } from "@shared/world-engine/world-view.js";
import type { ObjectSpec, WorldSpec } from "@shared/world-engine/types.js";

function mockView(): WorldView {
  return {
    screenToWorld: (px, py) => ({ x: px, y: py }),
    render: () => {},
    resize: () => {},
    dispose: () => {},
  };
}

const crate: ObjectSpec = { id: "crate", x: 6, y: 5, shape: "box", radius: 0.5, interactions: ["carry"] };
const table: ObjectSpec = {
  id: "table", x: 15, y: 15, shape: "box", radius: 1.2, interactions: [],
  contains: [{ relation: "on" }],
};
const spec: WorldSpec = {
  engine: "world", engineVersion: 1, meta: { title: "t", locale: "en", theme: "t" },
  manifold: { kind: "flat", width: 40, height: 40 }, terrain: { kind: "flat" },
  spawns: [{ id: "s", x: 5, y: 5, facing: 0 }], // avatar spawns next to the crate
  objects: [crate, table], multiplayer: { maxPlayers: 4, authority: "distributed" },
  content: { kind: "sandbox" },
};

describe("runWorldHost carry dwell-UX", () => {
  it("dwell picks up a nearby crate, then dwell places it on the table", () => {
    let frameCb: ((now: number) => void) | null = null;
    let now = 0;
    const host = runWorldHost({
      view: mockView(),
      spec,
      localId: "me",
      spawnIndex: 0,
      carry: { reach: 2, dwellMs: 300 },
      scheduleFrame: (cb) => {
        frameCb = cb;
        return () => {};
      },
      now: () => now,
    });
    host.start();

    let pickedUp = false;
    // Step ~5s of frames at 40ms. Look at the crate until carried, then look at
    // the table center to place it there.
    for (let i = 0; i < 125; i++) {
      const carrying = !!Object.values(host.state.objects).find((o) => o.carriedBy === "me");
      if (carrying) pickedUp = true;
      const p = carrying ? { x: 15, y: 15 } : { x: 6, y: 5 };
      host.setPointer(p.x, p.y);
      now += 40;
      frameCb?.(now);
    }

    expect(pickedUp).toBe(true); // the crate was carried at some point
    expect(host.state.objects.crate.carriedBy).toBeNull(); // …and put down
    expect(host.state.objects.crate.containedIn).toEqual({ objectId: "table", relation: "on" });

    host.stop();
  });
});
