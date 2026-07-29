/**
 * The ONE turntable law (shared/world-engine/spirit/corner-orbit.ts): the
 * screen CORNERS circle whatever the spirit frames — a structure, a district,
 * a city, a region — and which corner picks the direction.
 *
 *   lower-left / upper-right → azimuth UP   (camera counter-clockwise)
 *   upper-left / lower-right → azimuth DOWN (clockwise)
 *
 * Pure screen-space, so these hold identically on a flat region and on a
 * planet; the ladder pins the wiring end-to-end (grand-dream spirit-ladder).
 */
import {
  cornerOrbitDelta, inOrbitBand, ORBIT_BAND, ORBIT_EDGE, ORBIT_RATE,
} from "@shared/world-engine/spirit/corner-orbit";

const DT = 1 / 60;
/** Deep in a corner: past the side edge and past the vertical ramp. */
const X = 0.95;
const Y = 0.9;

describe("corner orbit — direction", () => {
  it("lower-left and upper-right circle the SAME way (counter-clockwise)", () => {
    const ll = cornerOrbitDelta(-X, -Y, DT);
    const ur = cornerOrbitDelta(X, Y, DT);
    expect(ll).toBeGreaterThan(0);
    expect(ur).toBeGreaterThan(0);
    expect(ur).toBeCloseTo(ll, 12); // mirror-symmetric: the same rate
  });

  it("upper-left and lower-right circle the OTHER way (clockwise)", () => {
    const ul = cornerOrbitDelta(-X, Y, DT);
    const lr = cornerOrbitDelta(X, -Y, DT);
    expect(ul).toBeLessThan(0);
    expect(lr).toBeLessThan(0);
    expect(lr).toBeCloseTo(ul, 12);
    expect(ul).toBeCloseTo(-cornerOrbitDelta(-X, -Y, DT), 12);
  });

  it("cares about the vertical half — the old x-only law is gone", () => {
    // Same screen side, opposite halves ⇒ opposite spins. (Before, both sides
    // spun the same way whatever the height.)
    expect(cornerOrbitDelta(-X, -Y, DT) * cornerOrbitDelta(-X, Y, DT)).toBeLessThan(0);
    expect(cornerOrbitDelta(X, -Y, DT) * cornerOrbitDelta(X, Y, DT)).toBeLessThan(0);
  });
});

describe("corner orbit — the dead zones", () => {
  it("the middle of the screen never orbits (it is for aiming)", () => {
    for (const y of [-1, -0.5, 0, 0.5, 1]) {
      expect(cornerOrbitDelta(0, y, DT)).toBe(0);
      expect(cornerOrbitDelta(ORBIT_EDGE, y, DT)).toBe(0);
      expect(cornerOrbitDelta(-ORBIT_EDGE, y, DT)).toBe(0);
    }
    expect(inOrbitBand(0)).toBe(false);
    expect(inOrbitBand(ORBIT_EDGE)).toBe(false);
    expect(inOrbitBand(-X)).toBe(true);
    expect(inOrbitBand(X)).toBe(true);
  });

  it("the crossover row eases through zero — a resting gaze there can't chatter", () => {
    // Exactly on the row: nothing. Just off it: a fraction of full rate, the
    // direction ramping (not flipping) as it crosses.
    expect(cornerOrbitDelta(-X, 0, DT)).toBeCloseTo(0, 12);
    const nudge = cornerOrbitDelta(-X, -ORBIT_BAND * 0.05, DT);
    const full = cornerOrbitDelta(-X, -ORBIT_BAND, DT);
    expect(nudge).toBeGreaterThan(0);
    expect(nudge).toBeCloseTo(full * 0.05, 12);
    // …and past the band it saturates rather than growing without bound.
    expect(cornerOrbitDelta(-X, -1, DT)).toBeCloseTo(full, 12);
  });

  it("ramps with how far past the side edge the spark reaches", () => {
    const shallow = cornerOrbitDelta(-(ORBIT_EDGE + 0.1), -Y, DT);
    const deep = cornerOrbitDelta(-1, -Y, DT);
    expect(shallow).toBeGreaterThan(0);
    expect(shallow).toBeLessThan(deep);
    // Full deflection = the quoted rate, in radians per SECOND.
    expect(deep).toBeCloseTo(ORBIT_RATE * DT, 12);
    expect(cornerOrbitDelta(-1, -Y, 2 * DT)).toBeCloseTo(2 * deep, 12);
  });

  it("survives a garbage projection (a point behind the camera)", () => {
    expect(cornerOrbitDelta(NaN, -Y, DT)).toBe(0);
    expect(cornerOrbitDelta(-X, Infinity, DT)).toBe(0);
    expect(cornerOrbitDelta(-1, -Y, -DT)).toBe(0);
  });
});
