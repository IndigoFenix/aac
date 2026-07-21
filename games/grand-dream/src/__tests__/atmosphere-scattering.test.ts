/**
 * The shared atmospheric-scattering model (shared/space/scattering.ts). Pure
 * physics, no GL — so the look the dome shader renders is validated HERE, where
 * a broken coefficient or a flipped phase term fails a test instead of shipping
 * a grey sky nobody can debug without a GPU.
 */
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  deriveScattering, inScatterRef, sampleSky, sunTransmittance, type ScatteringParams,
} from "@shared/world-engine/space/scattering";

const R = 6.371e6;
function earthlike(over: Partial<Parameters<typeof deriveScattering>[0]> = {}): ScatteringParams {
  return deriveScattering({
    planetRadiusM: R,
    atmosphereTopM: 60_000,
    scaleHeightM: 8_000,
    surfaceAirDensity: 1.225,
    ...over,
  });
}

/** Camera 2 m above the surface, "up" = +Y. */
const groundOrigin = new THREE.Vector3(0, R + 2, 0);
const UP = new THREE.Vector3(0, 1, 0);

describe("deriveScattering — per-planet coefficients", () => {
  it("scales β with air density and zeroes it for a vacuum", () => {
    const thin = earthlike({ surfaceAirDensity: 0.2 });
    const thick = earthlike({ surfaceAirDensity: 2.45 }); // 2× Earth
    expect(thick.rayleighBeta.z).toBeGreaterThan(thin.rayleighBeta.z);
    const vac = earthlike({ surfaceAirDensity: 0 });
    expect(vac.rayleighBeta.length()).toBe(0);
    expect(vac.mieBeta).toBe(0);
  });

  it("keeps Rayleigh blue-biased (β_b > β_r) — the reason the sky is blue", () => {
    const p = earthlike();
    expect(p.rayleighBeta.z).toBeGreaterThan(p.rayleighBeta.x);
  });

  it("puts the atmosphere shell above the surface", () => {
    expect(earthlike().atmRadiusM).toBeGreaterThan(R);
  });
});

describe("inScatterRef — the sky radiance integral", () => {
  const p = earthlike();

  it("is blue overhead but reddens toward the horizon at midday (path length)", () => {
    // Zenith looks through the least air → Rayleigh's blue bias wins. A grazing
    // horizon ray is a long slant path even at noon, so it reddens (which is why
    // a midday horizon is pale, not deep blue). Both must hold at once.
    const sunHigh = new THREE.Vector3(0.2, 0.98, 0).normalize();
    const zen = inScatterRef(groundOrigin, UP, sunHigh, p);
    const horiz = inScatterRef(groundOrigin, new THREE.Vector3(1, 0.02, 0).normalize(), sunHigh, p);
    expect(zen.z).toBeGreaterThan(zen.x); // zenith is blue
    expect(zen.x + zen.y + zen.z).toBeGreaterThan(0); // not black
    // Redness (r/b) grows from zenith to horizon.
    expect(horiz.x / Math.max(1e-6, horiz.z)).toBeGreaterThan(zen.x / Math.max(1e-6, zen.z));
  });

  it("reddens the horizon toward a setting sun (red > blue)", () => {
    // Sun just above the horizon in +X. Looking toward it, the slant path is
    // long and strips blue first → the sunset is red. This is THE signature.
    const sunLow = new THREE.Vector3(1, 0.03, 0).normalize();
    const towardSun = new THREE.Vector3(1, 0.02, 0).normalize();
    const c = inScatterRef(groundOrigin, towardSun, sunLow, p);
    expect(c.x).toBeGreaterThan(c.z);
  });

  it("is brighter toward the setting sun than away from it", () => {
    const sunLow = new THREE.Vector3(1, 0.03, 0).normalize();
    const toward = inScatterRef(groundOrigin, new THREE.Vector3(1, 0.02, 0).normalize(), sunLow, p);
    const away = inScatterRef(groundOrigin, new THREE.Vector3(-1, 0.02, 0).normalize(), sunLow, p);
    const lum = (c: THREE.Vector3) => c.x + c.y + c.z;
    expect(lum(toward)).toBeGreaterThan(lum(away));
  });

  it("goes dark at night (sun on the far side of the planet)", () => {
    const sunNight = new THREE.Vector3(0, -1, 0); // opposite the camera's up
    const day = inScatterRef(groundOrigin, UP, UP, p);
    const night = inScatterRef(groundOrigin, UP, sunNight, p);
    expect(night.x + night.y + night.z).toBeLessThan((day.x + day.y + day.z) * 0.05);
  });

  it("returns zero when the ray never enters the atmosphere (from deep space, looking out)", () => {
    const highUp = new THREE.Vector3(0, R + 200_000, 0); // well above the 60 km shell
    const c = inScatterRef(highUp, UP, UP, p);
    expect(c.x + c.y + c.z).toBeCloseTo(0, 10);
  });

  it("is deterministic", () => {
    const sun = new THREE.Vector3(0.3, 0.9, 0).normalize();
    const a = inScatterRef(groundOrigin, new THREE.Vector3(1, 0.1, 0).normalize(), sun, p);
    const b = inScatterRef(groundOrigin, new THREE.Vector3(1, 0.1, 0).normalize(), sun, p);
    expect(a.equals(b)).toBe(true);
  });

  it("a dustier world (more Mie) glows brighter toward the sun", () => {
    const clean = earthlike({ mieStrength: 1 });
    const dusty = earthlike({ mieStrength: 6 });
    const sunLow = new THREE.Vector3(1, 0.05, 0).normalize();
    const near = new THREE.Vector3(1, 0.12, 0).normalize(); // just off the sun
    const cl = inScatterRef(groundOrigin, near, sunLow, clean);
    const du = inScatterRef(groundOrigin, near, sunLow, dusty);
    const lum = (c: THREE.Vector3) => c.x + c.y + c.z;
    expect(lum(du)).toBeGreaterThan(lum(cl));
  });
});

describe("sampleSky — the four dome basis colours", () => {
  it("at sunset the sunward horizon is warmer than the opposite horizon", () => {
    const p = earthlike();
    const sunLow = new THREE.Vector3(1, 0.04, 0).normalize();
    const s = sampleSky(groundOrigin, sunLow, p);
    // "Warmer" = higher red-minus-blue.
    const warmth = (c: THREE.Color) => c.r - c.b;
    expect(warmth(s.horizonSun)).toBeGreaterThan(warmth(s.horizonOpp));
    // And every sample is a valid display colour.
    for (const c of [s.zenith, s.horizonSun, s.horizonSide, s.horizonOpp]) {
      for (const ch of [c.r, c.g, c.b]) {
        expect(ch).toBeGreaterThanOrEqual(0);
        expect(ch).toBeLessThan(1);
      }
    }
  });

  it("gives a blue-biased zenith under a high sun", () => {
    const p = earthlike();
    const s = sampleSky(groundOrigin, new THREE.Vector3(0.2, 0.98, 0).normalize(), p);
    expect(s.zenith.b).toBeGreaterThan(s.zenith.r);
  });
});

describe("sunTransmittance — the sun's light through the air (disc + sunlight colour)", () => {
  const p = earthlike();

  it("is bright and near-neutral with the sun overhead", () => {
    const t = sunTransmittance(groundOrigin, UP, p);
    expect(t.r).toBeGreaterThan(0.8);
    expect(t.b).toBeGreaterThan(0.6);
    expect(t.r).toBeGreaterThanOrEqual(t.b); // faintly warm even at noon
  });

  it("reddens hard toward a low sun (blue stripped first)", () => {
    const low = new THREE.Vector3(1, 0.03, 0).normalize();
    const t = sunTransmittance(groundOrigin, low, p);
    expect(t.r).toBeGreaterThan(t.b);
    expect(t.b).toBeLessThan(0.3);
  });

  it("reddens further the lower the sun sits", () => {
    const ratio = (elevY: number): number => {
      const t = sunTransmittance(groundOrigin, new THREE.Vector3(1, elevY, 0).normalize(), p);
      return t.r / Math.max(1e-6, t.b);
    };
    expect(ratio(0.03)).toBeGreaterThan(ratio(0.15)); // ~1.7° redder than ~8.5°
  });

  it("is black when the planet occludes the sun (night)", () => {
    const t = sunTransmittance(groundOrigin, new THREE.Vector3(0, -1, 0), p);
    expect(t.r + t.g + t.b).toBe(0);
  });

  it("is ~white from above the atmosphere (nothing left to cross)", () => {
    const high = new THREE.Vector3(0, R + 200_000, 0);
    const t = sunTransmittance(high, UP, p);
    expect(t.r).toBeCloseTo(1, 5);
    expect(t.g).toBeCloseTo(1, 5);
    expect(t.b).toBeCloseTo(1, 5);
  });
});
