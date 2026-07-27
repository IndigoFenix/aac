// PLANET LOD VISIBILITY — the quadtree's contract with its mesh host: the
// set of VISIBLE chunks the host renders must equal the tree's own leaf set
// after every update, no matter what happened to the meshes in between.
//
// The load-bearing pin is SELF-HEALING. `setVisible` used to early-return
// when the tree's cached flag already matched, so anything outside the tree
// that re-showed a chunk mesh (a debug show-all sweep, a traverse gone wide)
// desynced mesh from flag PERMANENTLY: every LOD ancestor of the camera's
// branch drew at once, the near-surface camera slipped UNDER a coarse
// ancestor's skin, and the whole screen filled with unlit terrain at near
// depth — the ground blackout, and the depth-fail that hid the gaze spark.
// The tree now re-asserts visibility on every node it visits each update.

import { describe, it, expect } from "@jest/globals";
import { createPlanetLod } from "@shared/world-engine/planet/lod.js";
import type { PlanetSurface } from "@shared/world-engine/planet/surface.js";

const surface: PlanetSurface = {
  radius: 1000,
  heightAt: () => 0,
  colorAt: (_dir, rgb: [number, number, number]) => { rgb[0] = 0.5; rgb[1] = 0.5; rgb[2] = 0.5; },
} as unknown as PlanetSurface;

function makeHost() {
  const shown = new Map<number, boolean>();
  return {
    shown,
    addChunk(id: number) { shown.set(id, true); },
    setChunkVisible(id: number, visible: boolean) {
      if (shown.has(id)) shown.set(id, visible);
    },
    removeChunk(id: number) { shown.delete(id); },
  };
}

const visibleInHost = (host: ReturnType<typeof makeHost>) =>
  [...host.shown.entries()].filter(([, v]) => v).map(([id]) => id).sort((a, b) => a - b);

describe("planet LOD visibility contract", () => {
  it("subdivides toward a surface camera and hides every subdivided parent", () => {
    const host = makeHost();
    const lod = createPlanetLod(surface, host, { resolution: 5, maxDepth: 4 });
    lod.update([1000, 0, 0]); // standing on the surface
    // The tree deepened (more than the 6 face roots live).
    expect(lod.chunkCount()).toBeGreaterThan(6);
    // The host renders exactly the tree's visible set — parents hidden.
    expect(visibleInHost(host)).toEqual([...lod.visibleIds()].sort((a, b) => a - b));
    // And the visible set is a strict subset of the live set (ancestors kept
    // hidden for cheap re-show on merge).
    expect(lod.visibleIds().length).toBeLessThan(lod.chunkCount());
    lod.dispose();
  });

  it("SELF-HEALS: an external show-all sweep is re-culled by the next update", () => {
    const host = makeHost();
    const lod = createPlanetLod(surface, host, { resolution: 5, maxDepth: 4 });
    lod.update([1000, 0, 0]);
    const healthy = visibleInHost(host);
    // A debug sweep (or any stray traverse) re-shows EVERY mesh behind the
    // tree's back — the exact desync that buried the camera under coarse skins.
    for (const id of host.shown.keys()) host.shown.set(id, true);
    expect(visibleInHost(host).length).toBe(lod.chunkCount());
    // One update with the unchanged camera must re-assert the tree's state.
    lod.update([1000, 0, 0]);
    expect(visibleInHost(host)).toEqual(healthy);
    lod.dispose();
  });

  it("re-culls even when the camera moved and the tree reshapes", () => {
    const host = makeHost();
    const lod = createPlanetLod(surface, host, { resolution: 5, maxDepth: 4 });
    lod.update([1000, 0, 0]);
    for (const id of host.shown.keys()) host.shown.set(id, true);
    // Camera flies to altitude on the far side — subtrees merge, roots coarsen.
    lod.update([-5000, 0, 0]);
    expect(visibleInHost(host)).toEqual([...lod.visibleIds()].sort((a, b) => a - b));
    lod.dispose();
  });
});
