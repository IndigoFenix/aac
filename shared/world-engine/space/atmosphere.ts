// shared/space/atmosphere.ts
//
// Body-surface polish, ported from seagull's celestial-body.ts rendering:
//   • buildAtmosphereShell — a BackSide slant-path limb glow (the "fuzzy
//     halo" around a planet's silhouette). Line-of-sight integral of an
//     exponential atmosphere: bright where the view ray skims the surface,
//     fading with altitude; horizon tint on grazing rays, zenith tint on the
//     outer fuzz. Fades out as the camera descends below the atmosphere top.
//   • buildAtmosphereVeil — a FrontSide haze painted OVER the planet disc
//     (the BackSide shell can't — its back fragments are depth-occluded). Alpha
//     follows slant optical depth 1 − exp(−τ/μ): thin looking straight down,
//     thick toward the limb, opaque for Venus-class τ.
//   • buildGasBandMaterial — a MeshStandardMaterial patched (onBeforeCompile)
//     with the banded gas-giant shader (latitude bands + value-noise wobble).
//
// Framework note: these are THREE-only, self-contained. Seagull ramps each
// mesh's opacity in from the streaming world; this port has no such ramp, so
// `uOpacity` is fixed at full (1) and the shaders' own camera-altitude fades
// do the transition work. The lab renderer uses a LOGARITHMIC depth buffer, so
// the custom shaders MUST include the logdepthbuf chunks or their depth test
// against the (log-encoded) terrain is garbage and the glow flickers.

import * as THREE from "three";

/** Glow scale height as a fraction of atmosphere thickness (seagull GFX.atmFuzz). */
const ATM_FUZZ = 0.35;

export interface AtmosphereShellOpts {
  radiusM: number;
  atmosphereTopM: number;
  zenithColor: THREE.Color;
  horizonColor: THREE.Color;
}

/** The exterior limb glow — a BackSide additive shell above the atmosphere top. */
export function buildAtmosphereShell(opts: AtmosphereShellOpts): THREE.Mesh {
  const { radiusM, atmosphereTopM, zenithColor, horizonColor } = opts;
  // Geometry well above the visible glow so crossing the mesh is invisible.
  const shellRadius = radiusM + atmosphereTopM * 4;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uPlanetRadius: { value: radiusM },
      uAtmThickness: { value: atmosphereTopM },
      uZenith: { value: zenithColor.clone() },
      uHorizon: { value: horizonColor.clone() },
      uOpacity: { value: 1 },
      uFuzz: { value: ATM_FUZZ },
      // World-space unit vector planet→star. Driven each frame by the body's
      // update (celestial-body.ts). Left pointing +X until set — a body whose
      // owner never updates it just keeps a fixed "sun" rather than breaking.
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
    },
    // Planet center is read from modelMatrix so floating-origin rebases and
    // orbital motion (both move the group in world space) stay correct.
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vWorldPos;
      varying vec3 vPlanetCenter;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vPlanetCenter = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: `
      #include <logdepthbuf_pars_fragment>
      uniform float uPlanetRadius;
      uniform float uAtmThickness;
      uniform vec3 uZenith;
      uniform vec3 uHorizon;
      uniform float uOpacity;
      uniform float uFuzz;
      uniform vec3 uSunDir;
      varying vec3 vWorldPos;
      varying vec3 vPlanetCenter;

      void main() {
        #include <logdepthbuf_fragment>

        // Camera-altitude fade — the glow is the EXTERIOR view of the
        // atmosphere; inside it the sky background owns the look.
        vec3 ro = cameraPosition - vPlanetCenter;
        float camAlt = length(ro) - uPlanetRadius;
        float exteriorT = smoothstep(uAtmThickness * 0.3, uAtmThickness * 1.6, camAlt);
        if (exteriorT < 0.002) discard;

        // Closest approach of the view ray to the planet center.
        vec3 dv = vWorldPos - cameraPosition;
        float dvLen = length(dv);
        if (dvLen < 1.0) discard;
        vec3 rd = dv / dvLen;
        float tca = -dot(ro, rd);
        vec3 closest = ro + rd * max(tca, 0.0);
        float closestAlt = length(closest) - uPlanetRadius;

        // Exponential atmosphere: glow dominated by the ray's lowest point.
        float H = max(1.0, uAtmThickness * uFuzz);
        float glow = exp(-max(closestAlt, 0.0) / H);

        // Grazing rays carry the horizon tint; outer fuzz the zenith tint.
        float vT = clamp(closestAlt / max(1.0, uAtmThickness), 0.0, 1.0);
        vec3 atmColor = mix(uHorizon, uZenith, vT);

        // ── Sunrise / sunset ──────────────────────────────────────────────
        // limbDir is which part of the limb this fragment glows over (the ray's
        // closest point, from planet center). Its dot with the sun direction
        // says day / terminator / night. The old halo was radially symmetric —
        // it lit the midnight limb as brightly as noon; keying on the sun turns
        // the glow into a day-side crescent with a bright dawn/dusk edge, and is
        // what makes a sunrise visible from orbit at all.
        vec3 limbDir = normalize(closest);
        float lit = dot(limbDir, uSunDir);            // -1 night · 0 term · +1 day
        float dayFactor = mix(0.05, 1.0, smoothstep(-0.25, 0.15, lit));
        // Warm the glow across the terminator. The reddening is Rayleigh
        // extinction of the long slant path; the fixed channel weights (R>G>B
        // survival) are a STAND-IN until the shared scattering model derives the
        // colour for real — scaled by the planet's own atmosphere colour so an
        // alien sky reddens in its own palette rather than a forced Earth orange.
        float term = smoothstep(0.45, 0.0, abs(lit));
        atmColor = mix(atmColor, atmColor * vec3(1.35, 0.75, 0.45), term);

        float a = glow * uOpacity * 0.85 * exteriorT * dayFactor;
        if (a < 0.004) discard;
        gl_FragColor = vec4(atmColor, a);
      }
    `,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(shellRadius, 96, 64), material);
  mesh.name = "atmosphere_halo";
  mesh.frustumCulled = false;
  mesh.renderOrder = 1; // after the body so the limb glow overdraws the edge
  return mesh;
}

export interface AtmosphereVeilOpts {
  radiusM: number;
  atmosphereTopM: number;
  /** Haze color — the body's zenith sky color. */
  color: THREE.Color;
  /** Vertical optical depth: ~0.25 Earth (subtle), ≫1 Venus (opaque). */
  hazeTau: number;
}

/** The disc haze — a FrontSide sphere painting slant-path haze over the planet. */
export function buildAtmosphereVeil(opts: AtmosphereVeilOpts): THREE.Mesh {
  const { radiusM, atmosphereTopM, color, hazeTau } = opts;
  const veilRadius = radiusM + atmosphereTopM;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uPlanetRadius: { value: radiusM },
      uAtmThickness: { value: atmosphereTopM },
      uColor: { value: color.clone() },
      uHazeTau: { value: hazeTau },
      uOpacity: { value: 1 },
      // World-space unit vector planet→star — see buildAtmosphereShell.
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
    },
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vWorldPos;
      varying vec3 vPlanetCenter;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vPlanetCenter = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: `
      #include <logdepthbuf_pars_fragment>
      uniform float uPlanetRadius;
      uniform float uAtmThickness;
      uniform vec3 uColor;
      uniform float uHazeTau;
      uniform float uOpacity;
      uniform vec3 uSunDir;
      varying vec3 vWorldPos;
      varying vec3 vPlanetCenter;

      void main() {
        #include <logdepthbuf_fragment>

        vec3 ro = cameraPosition - vPlanetCenter;
        float camAlt = length(ro) - uPlanetRadius;
        // Fade out on approach — gone when the camera reaches the geometry.
        float fade = smoothstep(uAtmThickness, uAtmThickness * 1.5, camAlt);
        if (fade < 0.002) discard;

        vec3 dv = vWorldPos - cameraPosition;
        float dvLen = length(dv);
        if (dvLen < 1.0) discard;
        vec3 rd = dv / dvLen;
        float tca = -dot(ro, rd);
        vec3 closest = ro + rd * max(tca, 0.0);

        // Slant cosine μ: 1 straight down → 0 at the limb; optical depth ~1/μ.
        float veilR = uPlanetRadius + uAtmThickness;
        float sinI = clamp(length(closest) / veilR, 0.0, 1.0);
        float mu = sqrt(max(1.0 - sinI * sinI, 0.0));
        float a = (1.0 - exp(-uHazeTau / max(mu, 0.08))) * fade * uOpacity;

        // Day-side haze only: the veil scatters sunlight toward you, so the
        // NIGHT half of the disc has nothing to scatter and must fall dark —
        // otherwise the haze washes a uniform tint over the terminator the
        // shell just carved. Warm it across the terminator to match the shell's
        // dawn/dusk edge (same Rayleigh stand-in; see buildAtmosphereShell).
        vec3 surfDir = normalize(vWorldPos - vPlanetCenter);
        float lit = dot(surfDir, uSunDir);
        float dayFactor = smoothstep(-0.1, 0.2, lit);
        float term = smoothstep(0.4, 0.0, abs(lit));
        vec3 hazeColor = mix(uColor, uColor * vec3(1.35, 0.75, 0.45), term);

        a *= dayFactor;
        if (a < 0.004) discard;
        gl_FragColor = vec4(hazeColor, a);
      }
    `,
    side: THREE.FrontSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
  });

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(veilRadius, 96, 64), material);
  mesh.name = "atmosphere_veil";
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  return mesh;
}

/** Vertical haze optical depth from surface pressure. Earth (1 bar) → ~0.25;
 *  Venus (92 bar) → ~23 (opaque); Mars (0.006) → invisible. */
export function hazeTauFromPressure(surfacePressureBar: number): number {
  return surfacePressureBar / 4;
}

/** Two tints off the resolved base color + a band divisor from the feature
 *  band count — the saturated look comes from the shader's noise, not the pair. */
export function selectGasBandColors(
  baseColor: THREE.Color,
  atmosphericBandCount: number,
): { colorA: THREE.Color; colorB: THREE.Color; bandFrequency: number } {
  const colorA = baseColor.clone();
  const colorB = baseColor.clone().multiplyScalar(0.78);
  const n = atmosphericBandCount;
  const bandFrequency = n > 0 ? 5000 + 10000 * Math.min(1, n / 25) : 8000;
  return { colorA, colorB, bandFrequency };
}

/** A small deterministic hash for the per-body band-noise seed. */
function bodyHash(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

export interface GasBandOpts {
  bodyId: string;
  baseColor: THREE.Color;
  atmosphericBandCount: number;
}

/** The banded gas-giant material — MeshStandard patched with latitude bands +
 *  value-noise wobble. Opaque (this port has no opacity ramp). */
export function buildGasBandMaterial(opts: GasBandOpts): THREE.MeshStandardMaterial {
  const { colorA, colorB, bandFrequency } = selectGasBandColors(opts.baseColor, opts.atmosphericBandCount);
  const seed = bodyHash(opts.bodyId);

  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSeed = { value: seed };
    shader.uniforms.uBandFreq = { value: bandFrequency };
    shader.uniforms.uColorA = { value: colorA };
    shader.uniforms.uColorB = { value: colorB };

    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\n varying vec3 vLocalPos;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\n vLocalPos = position;");

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
         uniform float uSeed;
         uniform float uBandFreq;
         uniform vec3 uColorA;
         uniform vec3 uColorB;
         varying vec3 vLocalPos;

         float gasHash(vec3 p) {
           p = fract(p * 0.3183099 + uSeed * 0.1);
           p *= 17.0;
           return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
         }
         float gasValueNoise(vec3 p) {
           vec3 i = floor(p);
           vec3 f = fract(p);
           f = f * f * (3.0 - 2.0 * f);
           float n000 = gasHash(i);
           float n100 = gasHash(i + vec3(1.0, 0.0, 0.0));
           float n010 = gasHash(i + vec3(0.0, 1.0, 0.0));
           float n110 = gasHash(i + vec3(1.0, 1.0, 0.0));
           float n001 = gasHash(i + vec3(0.0, 0.0, 1.0));
           float n101 = gasHash(i + vec3(1.0, 0.0, 1.0));
           float n011 = gasHash(i + vec3(0.0, 1.0, 1.0));
           float n111 = gasHash(i + vec3(1.0, 1.0, 1.0));
           return mix(
             mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
             mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
             f.z
           );
         }`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
         float lat = vLocalPos.y / uBandFreq;
         float horizontalWobble = gasValueNoise(vLocalPos * 0.0008) * 2.0 - 1.0;
         float bandT = sin(lat + horizontalWobble * 1.5) * 0.5 + 0.5;
         vec3 bandColor = mix(uColorA, uColorB, bandT);
         float fineN = gasValueNoise(vLocalPos * 0.003);
         bandColor *= 1.0 + (fineN - 0.5) * 0.2;
         diffuseColor.rgb = bandColor;`,
      );
  };
  return material;
}
