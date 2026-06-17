import * as THREE from "three";
import { buildWeatherMap, type CloudFieldParams } from "./cloud-field";
import type { WeatherMap } from "./weather-map";
import { createDeckCloudSystem } from "./cloud-deck";
import type {
  CloudSystem,
  CloudSystemOpts,
  CloudSystemRuntimeOpts,
} from "./cloud-system";

// ── Cloud Renderer v3: the STRUCTURED system ───────────────────────────────
//
// See instructions/clouds-renderer-v3-plan.md. The weather decides the
// representation per region, all reading ONE shared field so forms can't
// disagree. v1 composes two passes that ADD (compose, not partition → no
// in-patch seam):
//
//   • BASE deck (cloud-deck "base")   — the thin flat condensation-level base.
//     Owns the shared map's bake, the orbital shell + texture, the crossfade.
//     This is the underside you see from the ground.
//   • MOUND deck (cloud-deck "mound") — the hill bulk: the same heightmap but
//     tracking the full cloud top, so it rises into hills where the column
//     towers. A MESH, so the tower interior costs zero overdraw — flying
//     through is a surface, not a wall of blobs. Shell disabled (base owns it).
//   • EDGE blobs (Phase 2b, pending)  — cauliflower overhang on the mound's
//     high-curvature flanks (the one thing a single-valued hill can't do).
//
// Replaces the earlier gated VOLUME blobs, which re-created the fly-through
// overdraw inside each tower. Phase 3 (billboard fuzz) layers on top.

export function createStructuredCloudSystem(opts: CloudSystemOpts): CloudSystem {
  let field = opts.field;
  const timeSeconds = opts.timeSeconds ?? 0;

  // ONE weather map, shared. The base deck owns its bake + shell; the mound
  // reads the same map (no bake, no shell of its own).
  let map: WeatherMap = buildWeatherMap(field, timeSeconds);

  // v3: one deck — an opaque off-white stratocumulus base wearing white-topped
  // bubble-cluster bumps (cloud-deck owns the bumps + shell + bake).
  let base = createDeckCloudSystem({
    field, timeSeconds, sharedMap: map, deckMode: "base",
  });

  let opacity = 0;
  const runtime: CloudSystemRuntimeOpts = {};

  const group = new THREE.Group();
  group.name = "cloud_structured_system";
  group.add(base.group);

  function update(
    cameraLocalPos: THREE.Vector3,
    t: number,
    cameraLocalForward?: THREE.Vector3,
  ): void {
    base.update(cameraLocalPos, t, cameraLocalForward);
  }

  function setOpacity(o: number): void {
    opacity = o;
    base.setOpacity(o);
  }
  function setRuntimeOpts(o: CloudSystemRuntimeOpts): void {
    Object.assign(runtime, o);
    base.setRuntimeOpts(o);
    if (o.opacity !== undefined) opacity = o.opacity;
  }
  function setSunWorldPos(pos: THREE.Vector3 | null): void {
    base.setSunWorldPos(pos);
  }
  function setProjection(p: number, v: number): void {
    base.setProjection(p, v);
  }
  function fogContribution(
    cameraLocalPos: THREE.Vector3, out: { density: number; color: THREE.Color },
  ): void {
    base.fogContribution(cameraLocalPos, out);
  }
  function setField(f: CloudFieldParams): void {
    field = f;
    base.dispose();
    group.remove(base.group);
    map = buildWeatherMap(field, 0);
    base = createDeckCloudSystem({ field, sharedMap: map, deckMode: "base" });
    group.add(base.group);
    setRuntimeOpts(runtime);
    setOpacity(opacity);
  }
  function dispose(): void {
    base.dispose();
  }

  return {
    group, setField, update, setOpacity, setRuntimeOpts,
    setSunWorldPos, setProjection, fogContribution, dispose,
  };
}
