// shared/space/scattering.ts
//
// The shared atmospheric-scattering model — ONE physical function that every
// altitude and every consumer derives from, so a sunrise looks like the same
// sunrise whether you are standing on the ground, skimming the top of the air,
// or watching the terminator from orbit. The alternative (a ground sky-dome
// gradient, a separate limb shell, a separate fog tint, each hand-tuned) drifts
// apart exactly at the transitions between them; this does not, because they all
// read the same integral.
//
// WHAT IT COMPUTES. `inScatterRef` is single-scattering along a view ray through
// an exponential-density spherical shell: Rayleigh (molecular, ∝ λ⁻⁴ → blue sky,
// red sun) + Mie (aerosol/dust, forward-scattering → the bright glow around the
// sun and hazy horizons). It is the classic Nishita / O'Neil integral. Two facts
// make it "right" where a gradient is not:
//   • ALTITUDE-AGNOSTIC — the ray's near/far bounds come from ray–sphere
//     intersection, so the same code serves a camera on the ground (ray starts
//     at the camera) and one in orbit (ray starts where it enters the air). That
//     seam is where naive sky models break; here it does not exist.
//   • PER-PLANET — the look is entirely in the coefficients (`deriveScattering`):
//     Rayleigh β from air density + composition, Mie β/g from dust, the radii and
//     scale heights, the star's colour. Earthlike thin clean air gives a blue
//     sky with a red sun; crank Mie for a dusty world and it shifts toward the
//     butterscotch-with-blue-glow Mars look. No per-planet art, just physics.
//
// WHY CPU, NOT A PER-PIXEL GPU MARCH (for now). The sky-colour field is smooth
// and low-frequency, so the renderer samples it on the CPU at a handful of basis
// directions each frame (`sampleSky`) and the dome shader interpolates — far
// cheaper on the low-power fleet (iPad/Capacitor) than a ray-march per sky pixel,
// and it keeps ALL the physics in this file where it is unit-testable without a
// GL context. A GLSL port of `inScatterRef` is the upgrade path if per-pixel
// aerial-perspective (reddened sunlight scattered between camera and terrain)
// needs it later; the coefficients from `deriveScattering` feed either.

import * as THREE from "three";

/** Earth sea-level scattering coefficients (per metre) — the canonical values
 *  (Bruneton/Preetham). Rayleigh is wavelength-split (R<G<B → the sky is blue
 *  and the setting sun red); Mie is grey (aerosols scatter all colours alike). */
const EARTH_RAYLEIGH = new THREE.Vector3(5.8e-6, 13.5e-6, 33.1e-6);
const EARTH_MIE = 21e-6;
/** Earth's sea-level air density (kg/m³) — the reference the per-planet density
 *  ratio is taken against. */
const RHO_EARTH = 1.225;

export interface ScatteringParams {
  planetRadiusM: number;
  /** Top of the scattering shell (planet radius + atmosphere thickness). */
  atmRadiusM: number;
  /** Rayleigh extinction per metre at the surface, RGB. */
  rayleighBeta: THREE.Vector3;
  /** Mie extinction per metre at the surface (grey). */
  mieBeta: number;
  /** Density e-folding heights (m). Mie hugs the surface far tighter than air. */
  rayleighH: number;
  mieH: number;
  /** Mie asymmetry, 0..~0.95 — how forward-biased the aerosol glow is. */
  mieG: number;
  /** Star colour (linear, ~1 per channel) and overall brightness dial. */
  sunColor: THREE.Vector3;
  sunIntensity: number;
}

export interface DeriveInputs {
  planetRadiusM: number;
  /** Visible atmosphere thickness above the surface (m). */
  atmosphereTopM: number;
  /** Air-density scale height (m) — the body's `atmosphereScaleHeight`. */
  scaleHeightM: number;
  /** Surface air density (kg/m³) — the body's `surfaceAirDensity`. Scales β, so
   *  a thin Mars-pressure world scatters little and a Venus one saturates. */
  surfaceAirDensity: number;
  /** Star colour (linear). Defaults to white. */
  sunColor?: THREE.Color;
  /** Aerosol/dust load as a multiple of Earth's Mie (1 = clean Earthlike, >1 a
   *  dusty world). The main knob for an alien, Mie-dominated sky. */
  mieStrength?: number;
  /** Optional per-composition tint multiplying the Earth Rayleigh β (e.g. a CO₂
   *  world). Defaults to Earth's air. */
  rayleighTint?: THREE.Vector3;
}

/** Turn a body's resolved atmosphere physics into scattering coefficients. */
export function deriveScattering(inp: DeriveInputs): ScatteringParams {
  const densRel = Math.max(0, inp.surfaceAirDensity) / RHO_EARTH;
  const tint = inp.rayleighTint ?? new THREE.Vector3(1, 1, 1);
  const c = inp.sunColor;
  return {
    planetRadiusM: inp.planetRadiusM,
    atmRadiusM: inp.planetRadiusM + Math.max(1, inp.atmosphereTopM),
    rayleighBeta: EARTH_RAYLEIGH.clone().multiply(tint).multiplyScalar(densRel),
    mieBeta: EARTH_MIE * densRel * (inp.mieStrength ?? 1),
    rayleighH: Math.max(1, inp.scaleHeightM),
    // Mie hugs the ground: Earth's aerosol scale height is ~1/7 the air's.
    mieH: Math.max(1, inp.scaleHeightM * 0.15),
    mieG: 0.76,
    sunColor: c ? new THREE.Vector3(c.r, c.g, c.b) : new THREE.Vector3(1, 1, 1),
    // Calibrated so a clear Earthlike zenith tone-maps to a natural blue; this is
    // the master brightness dial for the whole sky.
    sunIntensity: 22,
  };
}

/** Ray–sphere intersection (sphere centred at the origin, radius R). Returns
 *  the two roots [near, far] as ray parameters; `far < near` means a miss. */
function raySphere(ro: THREE.Vector3, rd: THREE.Vector3, R: number): [number, number] {
  const b = ro.dot(rd);
  const c = ro.dot(ro) - R * R;
  const disc = b * b - c;
  if (disc < 0) return [1, -1];
  const s = Math.sqrt(disc);
  return [-b - s, -b + s];
}

// Grazing horizon rays have a sharp density spike at their lowest point; too few
// samples miss it and the reddening spikes at whatever altitude the geometry
// lines up (the "intense red band at 10–30 km" artifact). `sampleSky` runs only
// 4 rays per frame on the CPU, so we can afford a fine march.
const VIEW_SAMPLES = 24;
const LIGHT_SAMPLES = 8;
const _sp = new THREE.Vector3();
const _lp = new THREE.Vector3();

/** Single-scattering sky radiance along a view ray.
 *
 *  `origin` is the camera position RELATIVE TO THE PLANET CENTRE; `dir` and
 *  `sunDir` are unit vectors in that same planet-centred, world-aligned frame.
 *  Returns LINEAR radiance (HDR) — the caller tone-maps. */
export function inScatterRef(
  origin: THREE.Vector3, dir: THREE.Vector3, sunDir: THREE.Vector3,
  p: ScatteringParams, out: THREE.Vector3 = new THREE.Vector3(),
): THREE.Vector3 {
  out.set(0, 0, 0);

  const [a0, a1] = raySphere(origin, dir, p.atmRadiusM);
  if (a1 < 0) return out; // ray never crosses the atmosphere
  const start = Math.max(a0, 0);
  let end = a1;
  // Clamp to the ground if the view ray hits the planet ahead of the far exit.
  const pb = origin.dot(dir);
  const pdisc = pb * pb - (origin.dot(origin) - p.planetRadiusM * p.planetRadiusM);
  if (pdisc > 0) {
    const pnear = -pb - Math.sqrt(pdisc);
    if (pnear > start) end = Math.min(end, pnear);
  }
  const seg = (end - start) / VIEW_SAMPLES;
  if (seg <= 0) return out;

  const rB = p.rayleighBeta;
  let odR = 0, odM = 0;             // accumulated optical depth camera→sample
  let rr = 0, rg = 0, rb = 0;       // Rayleigh in-scatter, RGB
  let mr = 0, mg = 0, mb = 0;       // Mie in-scatter, RGB (grey β, but the

  for (let i = 0; i < VIEW_SAMPLES; i++) {
    const t = start + (i + 0.5) * seg;
    _sp.copy(dir).multiplyScalar(t).add(origin);
    const h = _sp.length() - p.planetRadiusM;
    const hr = Math.exp(-h / p.rayleighH) * seg;
    const hm = Math.exp(-h / p.mieH) * seg;
    odR += hr; odM += hm;

    // Optical depth from this sample toward the sun — unless the planet occludes
    // the sun (the sample is in its own shadow), which is what makes the night
    // side dark and carves the terminator.
    const lb = _sp.dot(sunDir);
    const ldisc = lb * lb - (_sp.dot(_sp) - p.planetRadiusM * p.planetRadiusM);
    if (ldisc > 0 && -lb - Math.sqrt(ldisc) > 0) continue; // shadowed
    const lexit = raySphere(_sp, sunDir, p.atmRadiusM)[1];
    if (lexit <= 0) continue;
    const lseg = lexit / LIGHT_SAMPLES;
    let odRs = 0, odMs = 0;
    for (let j = 0; j < LIGHT_SAMPLES; j++) {
      _lp.copy(sunDir).multiplyScalar((j + 0.5) * lseg).add(_sp);
      const lh = _lp.length() - p.planetRadiusM;
      odRs += Math.exp(-lh / p.rayleighH) * lseg;
      odMs += Math.exp(-lh / p.mieH) * lseg;
    }
    // Transmittance = exp(−(β_R·(odR+odRs) + β_M·1.1·(odM+odMs))). The 1.1 on Mie
    // is the usual extinction/scattering fudge (aerosols also absorb).
    const mTau = p.mieBeta * 1.1 * (odM + odMs);
    const tr = rB.x * (odR + odRs) + mTau;
    const tg = rB.y * (odR + odRs) + mTau;
    const tb = rB.z * (odR + odRs) + mTau;
    const trR = Math.exp(-tr), trG = Math.exp(-tg), trB = Math.exp(-tb);
    rr += trR * hr; rg += trG * hr; rb += trB * hr;
    mr += trR * hm; mg += trG * hm; mb += trB * hm;
  }

  // Phase functions weight the in-scatter by the view↔sun angle.
  const mu = THREE.MathUtils.clamp(dir.dot(sunDir), -1, 1);
  const phaseR = (3 / (16 * Math.PI)) * (1 + mu * mu);
  const g = p.mieG;
  const phaseM = (3 / (8 * Math.PI)) * ((1 - g * g) * (1 + mu * mu))
    / ((2 + g * g) * Math.pow(Math.max(1e-4, 1 + g * g - 2 * g * mu), 1.5));

  const I = p.sunIntensity;
  out.x = I * p.sunColor.x * (rB.x * phaseR * rr + p.mieBeta * phaseM * mr);
  out.y = I * p.sunColor.y * (rB.y * phaseR * rg + p.mieBeta * phaseM * mg);
  out.z = I * p.sunColor.z * (rB.z * phaseR * rb + p.mieBeta * phaseM * mb);
  return out;
}

const TRANSMITTANCE_SAMPLES = 8;

/** How much of the sun's light survives the atmosphere between `point` and the
 *  sun — the fraction per channel, so it carries HUE (blue is stripped first, so
 *  a long slant path comes back red). This is the ONE quantity that reddens the
 *  sun's disc AND warms the sunlight on the ground: both are the sun seen/entered
 *  through the same air.
 *
 *  `point` is relative to the planet centre. Returns black when the planet
 *  itself blocks the sun (the point is in its own shadow → night), and ~white
 *  from above the atmosphere (nothing left to scatter through). */
export function sunTransmittance(
  point: THREE.Vector3, sunDir: THREE.Vector3, p: ScatteringParams,
  out: THREE.Color = new THREE.Color(),
): THREE.Color {
  // Planet occludes the sun → hard shadow (this is what makes night dark).
  const lb = point.dot(sunDir);
  const ldisc = lb * lb - (point.dot(point) - p.planetRadiusM * p.planetRadiusM);
  if (ldisc > 0 && -lb - Math.sqrt(ldisc) > 0) return out.setRGB(0, 0, 0);

  const lexit = raySphere(point, sunDir, p.atmRadiusM)[1];
  if (lexit <= 0) return out.setRGB(1, 1, 1); // already above the air

  const seg = lexit / TRANSMITTANCE_SAMPLES;
  let odR = 0, odM = 0;
  for (let j = 0; j < TRANSMITTANCE_SAMPLES; j++) {
    _lp.copy(sunDir).multiplyScalar((j + 0.5) * seg).add(point);
    const h = _lp.length() - p.planetRadiusM;
    odR += Math.exp(-h / p.rayleighH) * seg;
    odM += Math.exp(-h / p.mieH) * seg;
  }
  const mTau = p.mieBeta * 1.1 * odM;
  return out.setRGB(
    Math.exp(-(p.rayleighBeta.x * odR + mTau)),
    Math.exp(-(p.rayleighBeta.y * odR + mTau)),
    Math.exp(-(p.rayleighBeta.z * odR + mTau)),
  );
}

/** Reinhard tone-map + gamma-ish compression of HDR radiance to a display colour
 *  in [0,1). The sky's one brightness mapping — kept here so `sampleSky` and any
 *  other consumer agree on how radiance becomes a pixel. */
export function toneMapSky(radiance: THREE.Vector3, out: THREE.Color = new THREE.Color()): THREE.Color {
  out.setRGB(
    1 - Math.exp(-radiance.x),
    1 - Math.exp(-radiance.y),
    1 - Math.exp(-radiance.z),
  );
  return out;
}

export interface SkySamples {
  /** Straight up. */
  zenith: THREE.Color;
  /** Horizon toward the sun's azimuth — the sunrise/sunset band. */
  horizonSun: THREE.Color;
  /** Horizon 90° from the sun. */
  horizonSide: THREE.Color;
  /** Horizon away from the sun. */
  horizonOpp: THREE.Color;
}

const _up = new THREE.Vector3();
const _sunH = new THREE.Vector3();
const _side = new THREE.Vector3();
const _tmpDir = new THREE.Vector3();
const _rad = new THREE.Vector3();

/** Sample the sky at the four basis directions the dome shader interpolates
 *  between. `origin` is the camera position relative to the planet centre. */
export function sampleSky(
  origin: THREE.Vector3, sunDir: THREE.Vector3, p: ScatteringParams,
): SkySamples {
  _up.copy(origin).normalize();
  // Sun projected onto the local horizontal — the azimuth the sunset sits on.
  // Degenerate when the sun is near the zenith; fall back to any horizontal axis.
  _sunH.copy(sunDir).addScaledVector(_up, -sunDir.dot(_up));
  if (_sunH.lengthSq() < 1e-8) {
    _sunH.set(1, 0, 0).addScaledVector(_up, -_up.x);
  }
  _sunH.normalize();
  _side.crossVectors(_up, _sunH).normalize();

  const sample = (dir: THREE.Vector3): THREE.Color =>
    toneMapSky(inScatterRef(origin, dir, sunDir, p, _rad));

  return {
    zenith: sample(_up),
    horizonSun: sample(_sunH),
    horizonSide: sample(_side),
    horizonOpp: sample(_tmpDir.copy(_sunH).negate()),
  };
}
