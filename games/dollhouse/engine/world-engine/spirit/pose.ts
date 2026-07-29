/**
 * SpiritPose — one camera pose the spirit ladder blends between.
 *
 * Every level handler (flight drone, town orbit, structure dollhouse,
 * ground glide) EXPRESSES its camera as a pose source: a function that
 * fills a SpiritPose each frame, in the CURRENT rebase frame, relative to
 * whatever origin the ladder is streaming on. Level transitions are then
 * one mechanism — smoothstep-blend two LIVE pose sources — instead of a
 * camera-ownership handoff (the old orbit→dollhouse cut, the "jump").
 */
import * as THREE from "three";

export interface SpiritPose {
  pos: THREE.Vector3;
  look: THREE.Vector3;
  up: THREE.Vector3;
  /** Vertical field of view, degrees. */
  fov: number;
}

export function createSpiritPose(): SpiritPose {
  return {
    pos: new THREE.Vector3(),
    look: new THREE.Vector3(),
    up: new THREE.Vector3(0, 1, 0),
    fov: 60,
  };
}

/** A live pose evaluator — re-computed every frame so blends track moving
 *  targets (planet spin, easing focus, a walking dollhouse frame). */
export type PoseSource = (out: SpiritPose) => void;

export function copyPose(from: SpiritPose, to: SpiritPose): void {
  to.pos.copy(from.pos);
  to.look.copy(from.look);
  to.up.copy(from.up);
  to.fov = from.fov;
}

/** Hermite smoothstep on [0,1]. */
export function smoothstep01(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

/** Blend two poses (t=0 → a, t=1 → b) into `out`. Positions/looks lerp;
 *  up re-normalizes (degenerate opposite ups fall back to b's). */
export function blendPose(a: SpiritPose, b: SpiritPose, t: number, out: SpiritPose): void {
  const s = smoothstep01(t);
  out.pos.lerpVectors(a.pos, b.pos, s);
  out.look.lerpVectors(a.look, b.look, s);
  out.up.lerpVectors(a.up, b.up, s);
  if (out.up.lengthSq() < 1e-8) out.up.copy(b.up);
  out.up.normalize();
  out.fov = a.fov + (b.fov - a.fov) * s;
}

/** Write a pose to the shared camera (position, up, lookAt, fov). */
export function applyPose(pose: SpiritPose, camera: THREE.PerspectiveCamera): void {
  camera.position.copy(pose.pos);
  camera.up.copy(pose.up);
  camera.lookAt(pose.look);
  if (Math.abs(camera.fov - pose.fov) > 1e-3) {
    camera.fov = pose.fov;
    camera.updateProjectionMatrix();
  }
}
