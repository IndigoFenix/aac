/**
 * corner-orbit.ts — the ONE turntable law.
 *
 * Whatever the spirit currently frames — a structure, a district, a city, a
 * whole region — is circled the SAME way: park the spark in a CORNER of the
 * screen and the camera swings around the target.
 *
 *   lower-left  / upper-right → counter-clockwise (seen from above)
 *   upper-left  / lower-right → clockwise
 *
 * Why the corners, and not just the sides: the rotation centre projects to the
 * screen middle (every framing rig looks straight at its target), so the
 * spark's VERTICAL half says which RIM of the turntable it sits on. BELOW
 * centre is the NEAR rim; ABOVE centre is the FAR one, where the same screen
 * side is the OPPOSITE rim of the circle — so the spin reverses. Either way the
 * gazed point swings toward centre, which is the only reading that feels like
 * pushing the object rather than fighting it.
 *
 * That crossover row is NOT fixed on screen, though: the target's projection
 * slides as the camera orbits. A hard sign flip there chatters (rapid
 * vibration) when the gaze rests near it. So the direction RAMPS smoothly
 * through zero across a band — vertical position still reverses the spin (and
 * scales its rate), but right at the crossover the rate eases to nothing, so
 * jitter there barely moves the world.
 *
 * Pure SCREEN-space math on purpose: it is identical on a flat region and on a
 * planet, and identical for every rung that frames a target (the spirit
 * ladder's town/district orbit and structure dollhouse, and the standalone
 * dollhouse rig in render3d). Callers differ only in where their NDC comes from
 * (raw pointer vs. a re-projected ground point) and which azimuth they add to.
 */

/** |ndcX| dead-zone: inside it the spark is aiming/interacting, not orbiting. */
export const ORBIT_EDGE = 0.45;
/** Radians per second at full deflection. */
export const ORBIT_RATE = 1.3;
/** ndcY span over which the near/far direction eases through zero. */
export const ORBIT_BAND = 0.28;

/** True while `ndcX` sits in a side band — i.e. the spark is orbiting, not
 *  aiming. The dwell/exit zones read this so a corner never double-books as a
 *  pick or a rung change. */
export function inOrbitBand(ndcX: number): boolean {
  return Math.abs(ndcX) > ORBIT_EDGE;
}

/**
 * The azimuth change (radians) this frame, to ADD to the rig's orbit azimuth.
 * `ndcX`/`ndcY` are NDC about the framed target (+y up, +x right); 0 outside
 * the side bands, and 0 along the vertical crossover.
 */
export function cornerOrbitDelta(ndcX: number, ndcY: number, dt: number): number {
  if (!Number.isFinite(ndcX) || !Number.isFinite(ndcY)) return 0;
  // Which rim: −1 (far, above centre) … +1 (near, below centre), ramped.
  const dir = -Math.max(-1, Math.min(1, ndcY / ORBIT_BAND));
  // Which side, ramped by how far past the dead-zone edge it reaches. Left
  // winds the azimuth up, right winds it down.
  let side = 0;
  if (ndcX < -ORBIT_EDGE) side = (-ORBIT_EDGE - ndcX) / (1 - ORBIT_EDGE);
  else if (ndcX > ORBIT_EDGE) side = -(ndcX - ORBIT_EDGE) / (1 - ORBIT_EDGE);
  else return 0;
  return dir * side * ORBIT_RATE * Math.max(0, dt);
}
