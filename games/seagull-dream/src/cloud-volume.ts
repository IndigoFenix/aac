import * as THREE from "three";
import { Pass, FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";

// ── Volumetric cloud post-process pass ─────────────────────────────────────
//
// Adapted (heavily simplified) from the three-volumetric-clouds library
// (Guerrilla Games "Nubis Evolved" approach) under games/seagull-dream/src/
// clouds/. The library does precomputed 3D Perlin-Worley textures, envelope
// textures, and a multi-pass FBO pipeline; here we collapse it to a single
// post-process pass that ray-marches procedural noise.
//
// Rendering model:
//   1. Reads the scene color + depth from the previous pass (RenderPass).
//   2. For each pixel, computes a view ray from the camera through that
//      pixel's world direction.
//   3. Intersects the ray with the cloud SHELL — a spherical layer between
//      `uPlanetRadius + uCloudInnerKm` and `uPlanetRadius + uCloudOuterKm`
//      around `uPlanetCenter`. Clamps the march segment to the scene depth
//      so clouds behind solid geometry don't show through.
//   4. Marches N samples through the segment. At each sample, density is
//      `dimensional_profile(altitude) * fbm(samplePos, time)`. Dimensional
//      profile is a smoothstep against altitude inside the shell (puffy
//      in the middle, thin at edges).
//   5. Lighting per sample: marches K steps toward the sun, accumulating
//      light-extinction depth. Final luminance = multi-scattering
//      Beer's-law × dual-lobe Henyey-Greenstein phase function.
//   6. Accumulates Beer's-law transmittance front-to-back; the final
//      composite blends `clouds × (1 − transmittance) + scene ×
//      transmittance`.
//
// The procedural noise is a stack of value-noise + worley octaves —
// cheaper than the library's true Perlin-Worley but visually similar
// at the march resolution we use here (~32 view steps × 4 light steps).
//
// Sun direction is updated externally per-frame from the world's primary
// star direction. Cloud color, coverage, inner/outer altitude are pushed
// from the dominant body's atmospheric properties.

export interface CloudPassParams {
  /** Planet center in world coordinates. */
  planetCenter: THREE.Vector3;
  /** Planet radius (meters). */
  planetRadius: number;
  /** Inner altitude of the cloud layer (meters above planet surface). */
  cloudInner: number;
  /** Outer altitude of the cloud layer (meters above planet surface). */
  cloudOuter: number;
  /** Cloud color (linear RGB). */
  color: THREE.Color;
  /** Coverage 0..1 — drives the noise threshold. */
  coverage: number;
  /** Density multiplier applied on top of coverage. */
  densityMult: number;
  /** Sun direction in world space (pointing from cloud TO sun, normalized). */
  sunDirection: THREE.Vector3;
  /** Sun color (linear RGB). */
  sunColor: THREE.Color;
  /** Ambient light color contributed when cloud is in shadow. */
  ambientColor: THREE.Color;
  /** Camera projection-inverse + matrixWorld for world-ray reconstruction. */
  cameraProjectionInverse: THREE.Matrix4;
  cameraMatrixWorld: THREE.Matrix4;
  cameraPosition: THREE.Vector3;
  cameraNear: number;
  cameraFar: number;
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Fragment shader. Comments inline. Procedural noise + ray march.
const FRAG = /* glsl */ `
precision highp float;
precision highp sampler2D;

varying vec2 vUv;

uniform sampler2D uSceneColor;
uniform sampler2D uSceneDepth;

uniform vec3 uCameraPosition;
uniform mat4 uProjectionInverse;
uniform mat4 uCameraMatrixWorld;
uniform vec2 uCameraNearFar;

uniform vec3 uPlanetCenter;
uniform float uPlanetRadius;
uniform float uCloudInner;
uniform float uCloudOuter;

uniform vec3 uCloudColor;
uniform float uCoverage;
uniform float uDensityMult;

uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform vec3 uAmbientColor;

uniform float uTime;

uniform int uMarchSteps;
uniform int uLightSteps;
uniform float uEnabled;
// Debug mode:
//   0 = normal volumetric clouds
//   1 = normal, but skip the scene-depth clip (clouds render even when
//       behind opaque geometry — useful to tell whether the depth clip
//       is what's making clouds invisible)
//   2 = paint the ray-shell intersection as solid red. Every pixel
//       where the camera ray enters the cloud shell shows red. Tests
//       whether ray↔shell math + camera-position pipe is working.
//   3 = paint cloud density along the ray as grayscale luminance.
//       Bypasses lighting and composition. Shows whether the noise
//       field is producing visible density.
//   4 = constant density 1.0 inside the shell (no noise). Tests
//       composite + lighting path without depending on noise.
uniform int uDebugMode;

// ── Hash + noise ───────────────────────────────────────────────────────────
// Simple value-noise hash. Cheap, deterministic, no texture lookups.
float hash3(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float valueNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash3(i);
  float n100 = hash3(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash3(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash3(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash3(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash3(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash3(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash3(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z
  );
}

// Value-only fbm (2 octaves). Dropped the worley octave — worley does
// 27 hash lookups per sample, and at 32 view steps × 4 light steps it
// was the dominant per-frame cost. Two octaves of value noise gives
// puffy-enough cloud patches for the look we need; the worley cell
// shape becomes visible only on close-up inspection anyway.
float fbm(vec3 p) {
  float n = 0.0;
  float amp = 0.6;
  float freq = 1.0;
  for (int i = 0; i < 2; i++) {
    n += amp * valueNoise(p * freq);
    freq *= 2.31;
    amp *= 0.5;
  }
  return n;
}

// ── Ray-sphere shell intersection ──────────────────────────────────────────
// Returns vec2(tNear, tFar) — the parameter range along the ray inside the
// shell between rInner and rOuter centered at center. Returns vec2(-1, -1)
// if the ray misses both spheres.
vec2 raySphere(vec3 ro, vec3 rd, vec3 center, float radius) {
  vec3 oc = ro - center;
  float b = dot(oc, rd);
  float c = dot(oc, oc) - radius * radius;
  float h = b * b - c;
  if (h < 0.0) return vec2(-1.0);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

vec2 raysShell(vec3 ro, vec3 rd, vec3 center, float rInner, float rOuter) {
  vec2 outer = raySphere(ro, rd, center, rOuter);
  if (outer.y < 0.0) return vec2(-1.0);
  vec2 inner = raySphere(ro, rd, center, rInner);

  vec3 oc = ro - center;
  float distFromCenter = length(oc);

  if (distFromCenter > rOuter) {
    // Outside the outer shell — enter and exit through outer sphere.
    if (inner.x > 0.0) {
      // Ray clips the inner sphere on its way through; the visible cloud
      // segment is from outer.x (enter outer) to inner.x (enter inner).
      return vec2(max(0.0, outer.x), max(0.0, inner.x));
    }
    return vec2(max(0.0, outer.x), outer.y);
  } else if (distFromCenter > rInner) {
    // Inside the cloud shell — start at 0, end at the first sphere hit
    // (either entering the inner planet sphere or exiting the outer
    // shell).
    if (inner.x > 0.0) return vec2(0.0, inner.x);
    return vec2(0.0, outer.y);
  } else {
    // Inside the planet (below cloud inner) — start at inner.y (exit
    // inner sphere into the cloud shell) and end at outer.y (exit
    // outer shell).
    if (inner.y > 0.0) return vec2(inner.y, outer.y);
    return vec2(-1.0);
  }
}

// ── View ray reconstruction ────────────────────────────────────────────────
// Reconstruct the world-space view direction for the current pixel from
// uv + projectionInverse + cameraMatrixWorld.
//
// IMPORTANT: clip.z is 0 (NOT 1). NDC.z = 1 corresponds to the far
// plane at "infinity" in the perspective formula, which produces
// view.w = (1 + c)/d where c → -1 for far >> near → view.w = 0.
// Division by zero → NaN → every pixel gets the same garbage value
// (solid color). NDC.z = 0 unprojects mid-frustum and gives a
// well-defined view-space point whose direction (after normalize) is
// the correct camera→pixel ray.
vec3 computeViewRay(vec2 uv) {
  vec4 clip = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
  vec4 view = uProjectionInverse * clip;
  view /= view.w;
  vec4 world = uCameraMatrixWorld * vec4(view.xyz, 0.0);
  return normalize(world.xyz);
}

// Convert non-linear depth (0..1) to linear view-space depth (meters).
float linearizeDepth(float z) {
  float n = uCameraNearFar.x;
  float f = uCameraNearFar.y;
  // Standard perspective inverse — assumes a perspective camera and a
  // non-log depth buffer. logarithmicDepthBuffer changes the layout but
  // for the purpose of "is there scene geometry in front of the cloud
  // sample?" the relative ordering is what matters; we use a coarse
  // linear conversion that's good enough for the cutoff test.
  return (2.0 * n * f) / (f + n - (z * 2.0 - 1.0) * (f - n));
}

// ── Lighting ───────────────────────────────────────────────────────────────
float beersLaw(float depth) {
  return exp(-depth);
}

float henyeyGreenstein(float g, float cosTheta) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * 3.14159265 * pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5));
}

float dualLobeHG(float g, float cosTheta, float k) {
  return mix(henyeyGreenstein(g, cosTheta), henyeyGreenstein(-g * 0.5, cosTheta), k);
}

// Ray-sphere first-intersection helper (returns smallest positive t,
// or negative if no hit).
float raySpherePositive(vec3 ro, vec3 rd, vec3 center, float radius) {
  vec3 oc = ro - center;
  float b = dot(oc, rd);
  float c = dot(oc, oc) - radius * radius;
  float h = b * b - c;
  if (h < 0.0) return -1.0;
  h = sqrt(h);
  float t1 = -b - h;
  float t2 = -b + h;
  if (t1 > 0.0) return t1;   // outside, ahead
  if (t2 > 0.0) return t2;   // inside (or behind near), ahead
  return -1.0;
}

// ── Main pass ──────────────────────────────────────────────────────────────
//
// SINGLE-SPHERE-SAMPLE cloud shader. No ray marching. Cloud layer is
// rendered as a SHEET wrapped around the planet at one altitude
// (midpoint of inner/outer). For each pixel we:
//
//   1. Intersect camera ray with the cloud sphere.
//   2. Sample two-tier noise at the surface direction:
//      - MACRO noise = "is there a cloud cluster here?" (continent-
//        scale wavelength, ~5000 km features). Threshold gives big
//        clear regions and big stormy regions.
//      - DETAIL noise = "what's the cloud shape inside the cluster?"
//        (~500 km features). Adds variety within stormy regions.
//   3. Multiply macro × detail with thresholds for lumpy variety.
//   4. Shade with sphere normal · sun direction (simple lambertian).
//   5. Composite with scene.
//
// Per-pixel cost: ~1 sphere test + 2 fbm calls (4 noise lookups total).
// Versus ray-march version: 16 march × 2 light × ~8 noise = 256 lookups.
// ~30× faster.
//
// Trade-off: no volumetric depth. Clouds look like a painted sheet at
// one altitude. Fits the "abstract, low-poly" aesthetic.
void main() {
  vec4 sceneColor = texture2D(uSceneColor, vUv);

  if (uEnabled < 0.5) {
    gl_FragColor = sceneColor;
    return;
  }

  vec3 ro = uCameraPosition;
  vec3 rd = computeViewRay(vUv);

  // Debug 2: visualize world-space view ray as RGB.
  if (uDebugMode == 2) {
    gl_FragColor = vec4(rd * 0.5 + 0.5, 1.0);
    return;
  }

  // Cloud sheet at midpoint of declared inner/outer altitudes.
  float cloudR = uPlanetRadius + (uCloudInner + uCloudOuter) * 0.5;
  float t = raySpherePositive(ro, rd, uPlanetCenter, cloudR);
  if (t < 0.0) {
    gl_FragColor = sceneColor;
    return;
  }

  vec3 worldPt = ro + rd * t;

  // PLANET-OCCLUSION CLIP. The camera ray may hit the cloud sphere
  // either on the visible (near) hemisphere or on the far hemisphere
  // (behind the planet from the camera's POV). Without this clip the
  // far-hemisphere intersection renders against the horizon and below,
  // looking like "a second layer painted on the ground in the distance".
  //
  // We test whether the camera→cloud-point line passes through the
  // planet sphere: parameterize ray, find the closest approach to
  // planet center, and if that closest point is INSIDE the planet
  // sphere AND in front of the camera, the cloud point is occluded.
  //
  // This does NOT account for terrain elevation above the planet base
  // (e.g. mountains taller than the cloud altitude). The previous
  // depth-buffer clip would have, but it was broken — the renderer
  // uses logarithmicDepthBuffer which my linearizeDepth formula does
  // not handle correctly. Trade-off: mountains > cloud altitude can
  // poke through the cloud sheet visually until log-depth handling
  // is added.
  if (uDebugMode != 1) {
    vec3 d = worldPt - ro;
    float dLenSq = dot(d, d);
    float tMinPlanet = dot(uPlanetCenter - ro, d) / max(dLenSq, 1e-6);
    if (tMinPlanet > 0.0 && tMinPlanet < 1.0) {
      vec3 closestPt = ro + tMinPlanet * d;
      if (length(closestPt - uPlanetCenter) < uPlanetRadius) {
        gl_FragColor = sceneColor;
        return;
      }
    }
  }

  // Sample direction on the cloud sphere (point where the ray hits).
  vec3 sphereDir = normalize(worldPt - uPlanetCenter);

  // Two-tier noise — defined in spherical-direction space so it wraps
  // smoothly around the planet without seam artifacts.
  vec3 timeDrift = vec3(uTime * 0.003, 0.0, uTime * 0.001);
  float macroScale = 4.0;   // ~continent-sized (4 cycles around planet hemisphere)
  float detailScale = 25.0; // ~few hundred km (25 cycles around hemisphere)

  float macroN = fbm(sphereDir * macroScale + timeDrift);
  float detailN = fbm(sphereDir * detailScale + timeDrift * 4.0);

  // Cluster mask: smoothstep so the boundary between clear/stormy is
  // soft. Threshold controlled by uCoverage — higher coverage = lower
  // threshold = more cloud.
  float clusterThresh = mix(0.65, 0.25, uCoverage);
  float cluster = smoothstep(clusterThresh, clusterThresh + 0.12, macroN);

  // Detail mask inside cluster regions.
  float shape = smoothstep(0.35, 0.65, detailN);

  // Combined density. Multiplication gives "lumpy" character:
  // clear regions stay clear (cluster ~ 0), stormy regions vary
  // internally (cluster ~ 1 modulated by shape).
  float density = cluster * shape * uDensityMult;

  // Debug 3: paint raw density as grayscale.
  if (uDebugMode == 3) {
    gl_FragColor = vec4(mix(sceneColor.rgb, vec3(density), 0.85), 1.0);
    return;
  }
  // Debug 4: constant density inside the shell (skip noise).
  if (uDebugMode == 4) {
    density = 0.6 * uDensityMult;
  }

  if (density < 0.01) {
    gl_FragColor = sceneColor;
    return;
  }
  density = clamp(density, 0.0, 0.95);

  // Simple lighting: sphere normal dotted with direction TO sun. Bias
  // toward ambient so unlit clouds still read against dark night sky.
  float litDot = max(0.0, dot(sphereDir, -uSunDirection));
  vec3 lit = uSunColor * (0.35 + 0.65 * litDot) + uAmbientColor;
  lit *= uCloudColor;

  // Composite: clouds over scene (NormalBlending equivalent done
  // manually).
  vec3 finalRgb = sceneColor.rgb * (1.0 - density) + lit * density;
  gl_FragColor = vec4(finalRgb, 1.0);
}
`;

export class VolumetricCloudPass extends Pass {
  fsQuad: FullScreenQuad;
  material: THREE.ShaderMaterial;
  /** External scene render target we read color + depth from. Set via
   *  setSceneTarget — we use this fixed reference instead of the
   *  composer's swap buffer to avoid feedback loops. */
  private sceneTarget: THREE.WebGLRenderTarget | null = null;

  constructor() {
    super();

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uSceneColor: { value: null },
        uSceneDepth: { value: null },
        uCameraPosition: { value: new THREE.Vector3() },
        uProjectionInverse: { value: new THREE.Matrix4() },
        uCameraMatrixWorld: { value: new THREE.Matrix4() },
        uCameraNearFar: { value: new THREE.Vector2(0.1, 1e9) },
        uPlanetCenter: { value: new THREE.Vector3() },
        uPlanetRadius: { value: 6_371_000 },
        uCloudInner: { value: 1500 },
        uCloudOuter: { value: 4000 },
        uCloudColor: { value: new THREE.Color(0.95, 0.95, 0.97) },
        uCoverage: { value: 0.5 },
        uDensityMult: { value: 1.0 },
        uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color(1.4, 1.3, 1.15) },
        uAmbientColor: { value: new THREE.Color(0.25, 0.3, 0.4) },
        uTime: { value: 0 },
        uMarchSteps: { value: 16 },
        // Light steps drop from 4 → 2. Lighting goes from quad-loop
        // accurate to "rough estimate" but the per-pixel cost
        // (16 view × 2 light = 32 noise calls) is half of before.
        uLightSteps: { value: 2 },
        // Treat as a boolean: 1 = render clouds, 0 = pass-through.
        uEnabled: { value: 1 },
        uDebugMode: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.fsQuad = new FullScreenQuad(this.material);

    // This pass needs the input renderTarget's color AND depth textures —
    // the EffectComposer wires `readBuffer.texture` for us, but the depth
    // texture has to be attached to the composer's source target by the
    // caller (we set composer.renderTarget1.depthTexture in main.ts).
    this.needsSwap = true;
  }

  setParams(params: Partial<CloudPassParams>): void {
    const u = this.material.uniforms;
    if (params.planetCenter) u.uPlanetCenter.value.copy(params.planetCenter);
    if (params.planetRadius !== undefined) u.uPlanetRadius.value = params.planetRadius;
    if (params.cloudInner !== undefined) u.uCloudInner.value = params.cloudInner;
    if (params.cloudOuter !== undefined) u.uCloudOuter.value = params.cloudOuter;
    if (params.color) u.uCloudColor.value.copy(params.color);
    if (params.coverage !== undefined) u.uCoverage.value = params.coverage;
    if (params.densityMult !== undefined) u.uDensityMult.value = params.densityMult;
    if (params.sunDirection) u.uSunDirection.value.copy(params.sunDirection);
    if (params.sunColor) u.uSunColor.value.copy(params.sunColor);
    if (params.ambientColor) u.uAmbientColor.value.copy(params.ambientColor);
    if (params.cameraPosition) u.uCameraPosition.value.copy(params.cameraPosition);
    if (params.cameraProjectionInverse) u.uProjectionInverse.value.copy(params.cameraProjectionInverse);
    if (params.cameraMatrixWorld) u.uCameraMatrixWorld.value.copy(params.cameraMatrixWorld);
    if (params.cameraNear !== undefined && params.cameraFar !== undefined) {
      u.uCameraNearFar.value.set(params.cameraNear, params.cameraFar);
    }
  }

  setEnabled(enabled: boolean): void {
    this.material.uniforms.uEnabled.value = enabled ? 1 : 0;
  }

  setDebugMode(mode: number): void {
    this.material.uniforms.uDebugMode.value = Math.max(0, Math.min(4, Math.floor(mode)));
  }

  setMarchSteps(steps: number): void {
    this.material.uniforms.uMarchSteps.value = Math.max(4, Math.min(128, Math.floor(steps)));
  }

  setCloudAltitudes(innerM: number, outerM: number): void {
    this.material.uniforms.uCloudInner.value = innerM;
    this.material.uniforms.uCloudOuter.value = Math.max(innerM + 100, outerM);
  }

  setTime(timeSeconds: number): void {
    this.material.uniforms.uTime.value = timeSeconds;
  }

  /** Set the fixed scene-render target whose color + depth we sample. */
  setSceneTarget(target: THREE.WebGLRenderTarget | null): void {
    this.sceneTarget = target;
    if (target) {
      this.material.uniforms.uSceneColor.value = target.texture;
      this.material.uniforms.uSceneDepth.value = target.depthTexture ?? null;
    } else {
      this.material.uniforms.uSceneColor.value = null;
      this.material.uniforms.uSceneDepth.value = null;
    }
  }

  render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    _readBuffer: THREE.WebGLRenderTarget,
  ): void {
    // We deliberately IGNORE readBuffer — color + depth come from the
    // fixed sceneTarget set via setSceneTarget. This breaks the
    // composer's swap-chain feedback loop where readBuffer can end up
    // being the same target as writeBuffer's depth source.
    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(writeBuffer);
    }
    this.fsQuad.render(renderer);
  }

  dispose(): void {
    this.material.dispose();
    this.fsQuad.dispose();
  }
}
