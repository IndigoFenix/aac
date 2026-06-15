import { createCloudSystem, type CloudSystem, type CloudSystemOpts } from "./cloud-system";
import { createBlobCloudSystem, createBillboardCloudSystem } from "./cloud-blobs";
import { createSurfaceNetsCloudSystem } from "./cloud-surfacenets";
import { createDeckCloudSystem } from "./cloud-deck";
import { createStructuredCloudSystem } from "./cloud-structured";

// One entry point so the game (and debug menu) can pick a cloud renderer by the
// GFX.cloudRenderer index. All implement the same CloudSystem interface, so the
// only thing that varies is which factory builds it. Order MUST match
// CLOUD_RENDERER_NAMES in config.ts.
const FACTORIES: Array<(o: CloudSystemOpts) => CloudSystem> = [
  createCloudSystem,            // 0 billboards (legacy)
  createBlobCloudSystem,        // 1 blobs (3-D icosphere)
  createBillboardCloudSystem,   // 2 blob-billboard (angle-stretch sprites)
  createSurfaceNetsCloudSystem, // 3 surfacenets (isosurface mesh)
  createDeckCloudSystem,        // 4 deck (v3 heightmap base)
  createStructuredCloudSystem,  // 5 structured (v3 deck + gated towers)
];

export function createCloudByIndex(index: number, opts: CloudSystemOpts): CloudSystem {
  const f = FACTORIES[Math.round(index)] ?? FACTORIES[0];
  return f(opts);
}
