import * as THREE from "three";
import { createNoise3D } from "simplex-noise";
import { deriveCloudField, cloudFieldStats } from "../cloud-field";
import {
  createCloudSystem,
  computeCloudPixelsPerUnit,
  cloudSystemStats,
  type CloudSystem,
} from "../cloud-system";
import { createBlobCloudSystem, cloudBlobStats } from "../cloud-blobs";
import type { Atmosphere } from "../physics-system/features";

// Renderer selection — A/B the shipping billboards vs experimental renderers
// (instructions/clouds-renderer-v2-plan.md). Switchable live in the panel and
// via ?renderer=blobs / window.__labSetRenderer for the screenshot harness.
type RendererMode = "billboards" | "blobs";
const RENDERER_FACTORY: Record<RendererMode, (o: { field: any; timeSeconds?: number }) => CloudSystem> = {
  billboards: createCloudSystem,
  blobs: createBlobCloudSystem,
};
const RENDERER_STATS: Record<RendererMode, typeof cloudSystemStats> = {
  billboards: cloudSystemStats,
  blobs: cloudBlobStats,
};
let rendererMode: RendererMode =
  new URLSearchParams(location.search).get("renderer") === "blobs" ? "blobs" : "billboards";
function activeStats(): typeof cloudSystemStats {
  return RENDERER_STATS[rendererMode];
}

// Cloud Lab — standalone viewer for the cloud/weather system
// (instructions/clouds.md). Renders authored scenarios: different cloud
// chemistries, coverages, planets, altitudes, sun angles, and fog
// conditions, with the same fog pipeline world.ts uses, so cloud/fog/
// terrain interactions can be inspected and screenshotted outside the
// game. Served at /cloud-lab.html; shot-clouds.cjs captures every
// scenario headlessly.
//
// The planet center is offset so the CAMERA SITE sits at the world
// origin — full-radius Float32 vertex coords would otherwise jitter.
// The cloud system itself works in planet-local coords (its group is a
// child of planetGroup), exactly like in the game.

// ── Scenario definitions ───────────────────────────────────────────────────

type LabCloudType = Atmosphere["cloudType"];

interface LabScenario {
  name: string;
  desc: string;
  radiusM: number;
  seed: number;
  cloudType: LabCloudType;
  coverage: number;
  baseKm: number;
  thickKm: number;
  bandCount: number;
  banding: number;
  rotationHours: number;
  /** Passed to deriveCloudField as skyZenithColor → cloud zone color. */
  cloudTint: number;
  skyColor: number;
  nightColor: number;
  groundColor: number;
  /** "earth" = water/grass/snow palette, "rust" = Mars-like, null = none. */
  terrain: "earth" | "rust" | null;
  visibilityKm: number;
  atmTopKm: number;
  camLatDeg: number;
  camLonDeg: number;
  camAltM: number;
  camYawDeg: number;   // 0 = north, 90 = east
  camPitchDeg: number; // + = up
  sunAzDeg: number;    // azimuth at the camera site (0 = north)
  sunElDeg: number;    // elevation above the site horizon; 90 = zenith
  /** Auto-relocate the site after the map bakes: "in-cloud" parks the
   *  camera longitude/latitude on the densest weather; "near-cloud"
   *  finds dense weather, then nudges to a low-density gap so in-layer
   *  flight isn't a guaranteed whiteout. undefined = use lat/lon as-is. */
  findSite?: "in-cloud" | "near-cloud";
}

const EARTH = {
  radiusM: 6_371_000,
  seed: 1337,
  cloudType: "water" as LabCloudType,
  baseKm: 2,
  thickKm: 5,
  bandCount: 0,
  banding: 0.2,
  rotationHours: 24,
  cloudTint: 0xf2f4f7,
  skyColor: 0x87ceeb,
  nightColor: 0x0a0e1a,
  groundColor: 0x2a5a8a,
  terrain: "earth" as const,
  visibilityKm: 60,
  atmTopKm: 60,
  camLatDeg: 14,
  camLonDeg: 40,
  camYawDeg: 0,
  sunAzDeg: 140,
  sunElDeg: 55,
};

const SCENARIOS: LabScenario[] = [
  {
    ...EARTH, name: "fair-weather-ground",
    desc: "Scattered cumulus from the ground — the lone-sphere test",
    coverage: 0.3, camAltM: 30, camPitchDeg: 16, findSite: "in-cloud",
  },
  {
    ...EARTH, name: "broken-flight",
    desc: "Flying inside a broken deck (in a gap, not inside a puff)",
    coverage: 0.55, camAltM: 3500, camPitchDeg: 2, findSite: "near-cloud",
  },
  {
    ...EARTH, name: "above-deck",
    desc: "Above the deck, horizon view — deck top + terrain below",
    coverage: 0.55, camAltM: 12_000, camPitchDeg: -8, findSite: "in-cloud",
  },
  {
    ...EARTH, name: "fog-stress",
    desc: "Low visibility, below cloud base — distant clouds must fade INTO the fog",
    coverage: 0.6, visibilityKm: 18, camAltM: 1200, camPitchDeg: -2, findSite: "in-cloud",
  },
  {
    ...EARTH, name: "stratus-underside",
    desc: "Solid low deck seen from underneath",
    coverage: 0.95, baseKm: 1, thickKm: 1.4, camAltM: 250, camPitchDeg: 28,
  },
  {
    ...EARTH, name: "deck-top",
    desc: "Skimming the top of a near-solid deck",
    coverage: 0.9, camAltM: 8500, camPitchDeg: -10,
  },
  {
    ...EARTH, name: "crossfade-climb",
    desc: "Shell/billboard blend band (~35 km)",
    coverage: 0.55, camAltM: 35_000, camPitchDeg: -25,
  },
  {
    ...EARTH, name: "orbit",
    desc: "Low orbit, day side",
    coverage: 0.55, camAltM: 500_000, camPitchDeg: -55,
  },
  {
    ...EARTH, name: "orbit-terminator",
    desc: "Low orbit over the terminator — lighting check",
    coverage: 0.55, camAltM: 500_000, camPitchDeg: -55, sunElDeg: 2,
  },
  {
    ...EARTH, name: "night-flight",
    desc: "Night side — clouds must go dark, not glow",
    coverage: 0.5, camAltM: 3000, camPitchDeg: 4, sunElDeg: -30,
    findSite: "near-cloud",
  },
  {
    name: "jupiter-disc", desc: "Banded giant, full disc",
    radiusM: 7e7, seed: 4242, cloudType: "ammonia",
    coverage: 0.85, baseKm: 0, thickKm: 50,
    bandCount: 14, banding: 0.85, rotationHours: 10,
    cloudTint: 0xd8b890, skyColor: 0xc9a36a, nightColor: 0x14100a,
    groundColor: 0x8a6a4a, terrain: null,
    visibilityKm: 200, atmTopKm: 300,
    camLatDeg: 8, camLonDeg: 0, camAltM: 1.6e8,
    camYawDeg: 0, camPitchDeg: -90, sunAzDeg: 120, sunElDeg: 60,
  },
  {
    name: "jupiter-close", desc: "Skimming the ammonia deck",
    radiusM: 7e7, seed: 4242, cloudType: "ammonia",
    coverage: 0.85, baseKm: 0, thickKm: 50,
    bandCount: 14, banding: 0.85, rotationHours: 10,
    cloudTint: 0xd8b890, skyColor: 0xc9a36a, nightColor: 0x14100a,
    groundColor: 0x8a6a4a, terrain: null,
    visibilityKm: 200, atmTopKm: 300,
    camLatDeg: 8, camLonDeg: 0, camAltM: 120_000,
    camYawDeg: 0, camPitchDeg: -10, sunAzDeg: 140, sunElDeg: 45,
  },
  {
    name: "venus-deck", desc: "Unbroken sulfuric deck from orbit",
    radiusM: 6_052_000, seed: 777, cloudType: "sulfuric_acid",
    coverage: 1.0, baseKm: 45, thickKm: 25,
    bandCount: 2, banding: 0.4, rotationHours: 243 * 24,
    cloudTint: 0xe8d9a8, skyColor: 0xd8c080, nightColor: 0x14100a,
    groundColor: 0x8a6a3a, terrain: null,
    visibilityKm: 25, atmTopKm: 120,
    camLatDeg: 10, camLonDeg: 30, camAltM: 700_000,
    camYawDeg: 0, camPitchDeg: -60, sunAzDeg: 140, sunElDeg: 50,
  },
  {
    name: "mars-wisps", desc: "Thin CO2-ice wisps over rust terrain",
    radiusM: 3_390_000, seed: 99, cloudType: "co2_ice",
    coverage: 0.18, baseKm: 12, thickKm: 6,
    bandCount: 0, banding: 0.1, rotationHours: 24.6,
    cloudTint: 0xf0e8e2, skyColor: 0xc8966a, nightColor: 0x100a08,
    groundColor: 0x9a5a32, terrain: "rust",
    visibilityKm: 140, atmTopKm: 40,
    camLatDeg: 5, camLonDeg: 70, camAltM: 4000,
    camYawDeg: 0, camPitchDeg: 12, sunAzDeg: 150, sunElDeg: 40,
    findSite: "in-cloud",
  },
];

// ── Lab runtime options (mirrors the GFX cloud sliders) ────────────────────

const OPTS = {
  cloudMult: 1.0,
  spriteOversize: 1.0,
  windMult: 1.0,
  detailMult: 1.0,
  vigorMult: 1.0,
  fogBoost: 0.6,
  fogDensityMult: 1.0,
  skyFogKm: 16,
  shellDetailMult: 1.0,
  shellDebug: 0,
  bakeMs: 0.5,
  timeScale: 1.0,
};

// ── Small helpers ──────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEG = Math.PI / 180;

interface SiteBasis {
  up: THREE.Vector3;
  east: THREE.Vector3;
  north: THREE.Vector3;
}

function siteBasis(latDeg: number, lonDeg: number): SiteBasis {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  const up = new THREE.Vector3(
    Math.cos(lat) * Math.cos(lon),
    Math.sin(lat),
    Math.cos(lat) * Math.sin(lon),
  );
  const east = new THREE.Vector3(0, 1, 0).cross(up).normalize();
  const north = new THREE.Vector3().crossVectors(up, east).normalize();
  return { up, east, north };
}

// ── Scene setup ────────────────────────────────────────────────────────────

const canvas = document.getElementById("lab-scene") as HTMLCanvasElement;
// logarithmicDepthBuffer matches the game renderer — the cloud shaders
// include logdepthbuf chunks and MUST be depth-tested the same way here,
// or the lab wouldn't reproduce in-game clipping behavior.
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  logarithmicDepthBuffer: true,
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.7;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
scene.fog = new THREE.FogExp2(0x87ceeb, 0);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 1, 4e9);

const sunLight = new THREE.DirectionalLight(0xffffff, 2.4);
scene.add(sunLight);
scene.add(sunLight.target);
const ambient = new THREE.AmbientLight(0xffffff, 0.35);
scene.add(ambient);

window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

// ── Per-scenario state ─────────────────────────────────────────────────────

let planetGroup: THREE.Group | null = null;
let cloudSystem: CloudSystem | null = null;
let scenario: LabScenario = SCENARIOS[0];
let basis: SiteBasis = siteBasis(0, 0);
let camAltM = 1000;
let yawDeg = 0;
let pitchDeg = 0;
let labTime = 100;
let smoothedCloudFog = 0;
const smoothedCloudFogColor = new THREE.Color(1, 1, 1);
let ready = false;
let framesSinceLoad = 0;

const _sunDir = new THREE.Vector3();
const _sunPos = new THREE.Vector3();
const _camLocal = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _cloudFog = { density: 0, color: new THREE.Color() };
const _bg = new THREE.Color();
const _fogCol = new THREE.Color();
const _sky = new THREE.Color();
const _night = new THREE.Color();
const SPACE_COLOR = new THREE.Color(0x000000);

// ── Terrain patch ──────────────────────────────────────────────────────────
// A displaced grid around the camera site (verts stored SITE-relative so
// Float32 stays precise), plus a smooth globe sphere for the planet at
// large. Gas worlds get the globe only.

function buildTerrainPatch(s: LabScenario, b: SiteBasis): THREE.Mesh {
  const noise = createNoise3D(mulberry32((s.seed ^ 0x7e11aa) >>> 0));
  const N = 160;            // grid cells per side
  const SPAN = 240_000;     // meters, patch width
  const verts = new Float32Array((N + 1) * (N + 1) * 3);
  const cols = new Float32Array((N + 1) * (N + 1) * 3);
  const R = s.radiusM;
  const siteCenter = b.up.clone().multiplyScalar(R);
  const c = new THREE.Color();

  const heightAt = (dir: THREE.Vector3): number => {
    const f1 = R / 60_000; // ~60 km features
    const f2 = R / 9_000;  // ~9 km detail
    let h = noise(dir.x * f1, dir.y * f1, dir.z * f1) * 0.72
      + noise(dir.x * f2 + 17.3, dir.y * f2, dir.z * f2) * 0.28;
    h *= 1600; // amplitude (m)
    return h;
  };

  let vi = 0;
  for (let gy = 0; gy <= N; gy++) {
    for (let gx = 0; gx <= N; gx++) {
      const ox = (gx / N - 0.5) * SPAN;
      const oy = (gy / N - 0.5) * SPAN;
      _tmp.copy(siteCenter)
        .addScaledVector(b.east, ox)
        .addScaledVector(b.north, oy)
        .normalize();
      let h = heightAt(_tmp);
      if (s.terrain === "earth" && h < 0) h = 0; // sea level
      const p = _tmp.clone().multiplyScalar(R + h).sub(siteCenter);
      verts[vi * 3 + 0] = p.x;
      verts[vi * 3 + 1] = p.y;
      verts[vi * 3 + 2] = p.z;

      if (s.terrain === "rust") {
        const t = THREE.MathUtils.clamp((h + 2400) / 4800, 0, 1);
        c.setHex(0x6a3a22).lerp(new THREE.Color(0xc28a5a), t);
      } else if (h <= 0) {
        c.setHex(0x2a5a8a);
      } else if (h < 150) {
        c.setHex(0xc2b280);
      } else if (h < 1000) {
        c.setHex(0x4a7a3a).lerp(new THREE.Color(0x6a8a4a), h / 1000);
      } else if (h < 1900) {
        c.setHex(0x8a7a6a);
      } else {
        c.setHex(0xeeeeee);
      }
      cols[vi * 3 + 0] = c.r;
      cols[vi * 3 + 1] = c.g;
      cols[vi * 3 + 2] = c.b;
      vi++;
    }
  }

  const idx: number[] = [];
  for (let gy = 0; gy < N; gy++) {
    for (let gx = 0; gx < N; gx++) {
      const a = gy * (N + 1) + gx;
      idx.push(a, a + 1, a + N + 1, a + 1, a + N + 2, a + N + 1);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(verts, 3));
  geom.setAttribute("color", new THREE.BufferAttribute(cols, 3));
  geom.setIndex(idx);
  geom.computeVertexNormals();

  const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
    metalness: 0,
  }));
  mesh.position.copy(siteCenter); // planet-local
  mesh.name = "terrain_patch";
  return mesh;
}

// ── Scenario lifecycle ─────────────────────────────────────────────────────

function disposeScenario(): void {
  if (cloudSystem) {
    cloudSystem.dispose();
    cloudSystem = null;
  }
  if (planetGroup) {
    planetGroup.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | undefined;
      if (mat && !Array.isArray(mat)) mat.dispose();
    });
    scene.remove(planetGroup);
    planetGroup = null;
  }
}

/** Re-anchor the world to the current basis: planet center placed so the
 *  camera SITE sits at the world origin, sun rebuilt from the site's
 *  az/el spec. */
function applySite(s: LabScenario): void {
  planetGroup!.position.copy(basis.up).multiplyScalar(-s.radiusM);
  const az = s.sunAzDeg * DEG;
  const el = s.sunElDeg * DEG;
  _sunDir.copy(basis.up).multiplyScalar(Math.sin(el))
    .addScaledVector(basis.north, Math.cos(el) * Math.cos(az))
    .addScaledVector(basis.east, Math.cos(el) * Math.sin(az))
    .normalize();
  // Star "world position" ≈ 1 AU along the sun direction — far enough
  // that the planet-center vs site-origin distinction is negligible.
  _sunPos.copy(_sunDir).multiplyScalar(1.5e11);
  sunLight.position.copy(_sunDir).multiplyScalar(s.radiusM * 4);
  sunLight.target.position.set(0, 0, 0);
  scene.updateMatrixWorld(true);
  placeCamera();
}

/** Cloud density at a lat/lon/alt via the system's own fog sampler. */
function densityAt(latDeg: number, lonDeg: number, altM: number): number {
  if (!cloudSystem) return 0;
  const b = siteBasis(latDeg, lonDeg);
  _tmp.copy(b.up).multiplyScalar(scenario.radiusM + altM);
  cloudSystem.fogContribution(_tmp, _cloudFog);
  return _cloudFog.density;
}

/** Scan the (baked) weather for a representative site. "in-cloud" parks
 *  on the densest weather; "near-cloud" finds dense weather then nudges
 *  to the thinnest spot within ~0.6° so the camera floats in a gap. */
function findCloudySite(s: LabScenario, mode: "in-cloud" | "near-cloud"): { lat: number; lon: number } {
  const alts = [0.35, 0.55, 0.75].map((t) => (s.baseKm + t * s.thickKm) * 1000);
  let bestLat = s.camLatDeg;
  let bestLon = s.camLonDeg;
  let bestScore = -1;
  for (let lat = -42; lat <= 42; lat += 7) {
    for (let lon = -180; lon < 180; lon += 6) {
      let score = 0;
      for (const a of alts) score += densityAt(lat, lon, a);
      for (const a of alts) score += 0.5 * densityAt(lat, lon + 1.5, a);
      if (score > bestScore) {
        bestScore = score;
        bestLat = lat;
        bestLon = lon;
      }
    }
  }
  if (mode === "near-cloud") {
    let gapLat = bestLat;
    let gapLon = bestLon;
    let gapD = Infinity;
    for (let dla = -0.6; dla <= 0.6; dla += 0.15) {
      for (let dlo = -0.6; dlo <= 0.6; dlo += 0.15) {
        const d = densityAt(bestLat + dla, bestLon + dlo, s.camAltM);
        if (d < gapD) {
          gapD = d;
          gapLat = bestLat + dla;
          gapLon = bestLon + dlo;
        }
      }
    }
    return { lat: gapLat, lon: gapLon };
  }
  return { lat: bestLat, lon: bestLon };
}

function warmUpdates(n: number): void {
  if (!cloudSystem || !planetGroup) return;
  for (let i = 0; i < n; i++) {
    labTime += 0.06;
    _camLocal.copy(camera.position).sub(planetGroup.position);
    cloudSystem.update(_camLocal, labTime);
  }
}

function loadScenario(s: LabScenario): void {
  ready = false;
  framesSinceLoad = 0;
  disposeScenario();
  scenario = s;
  basis = siteBasis(s.camLatDeg, s.camLonDeg);
  camAltM = s.camAltM;
  yawDeg = s.camYawDeg;
  pitchDeg = s.camPitchDeg;
  smoothedCloudFog = 0;

  planetGroup = new THREE.Group();
  planetGroup.name = "planet";
  scene.add(planetGroup);

  // Globe — coarse sphere; the patch supplies near-field detail.
  const globe = new THREE.Mesh(
    new THREE.SphereGeometry(s.radiusM - 100, 128, 96),
    new THREE.MeshStandardMaterial({ color: s.groundColor, roughness: 0.95 }),
  );
  globe.name = "globe";
  planetGroup.add(globe);

  // Cloud field + system — exactly the game's derivation path.
  const atmosphere = {
    cloudType: s.cloudType,
    cloudCoverage: s.coverage,
    cloudBaseAltitudeKm: s.baseKm,
    cloudThicknessKm: s.thickKm,
    skyZenithColor: new THREE.Color(s.cloudTint),
  } as unknown as Atmosphere;
  const field = deriveCloudField({
    atmosphere,
    planetRadiusM: s.radiusM,
    bandCount: s.bandCount,
    bandingIntensity: s.banding,
    rotationPeriodHours: s.rotationHours,
    seed: s.seed,
  });
  if (field.layers.length > 0) {
    cloudSystem = RENDERER_FACTORY[rendererMode]({ field, timeSeconds: labTime });
    planetGroup.add(cloudSystem.group);
  }

  applySite(s);

  // Warm-up 1: force the initial map sweep synchronously (~1 s) so the
  // weather exists before site probing / screenshots. 40 updates × 16
  // rows covers even the 512-row maps of giant planets.
  if (cloudSystem) {
    cloudSystem.setSunWorldPos(_sunPos);
    cloudSystem.setRuntimeOpts({ bakeBudgetMs: 60, updateInterval: 1 });
    warmUpdates(40);
  }

  // Relocate to representative weather, then re-anchor everything.
  if (s.findSite && cloudSystem) {
    const site = findCloudySite(s, s.findSite);
    basis = siteBasis(site.lat, site.lon);
    applySite(s);
  }

  // Terrain patch at the FINAL site.
  if (s.terrain) planetGroup.add(buildTerrainPatch(s, basis));
  scene.updateMatrixWorld(true);

  // Warm-up 2: fill the sprite cache for the final camera position.
  warmUpdates(8);
  ready = true;
}

// ── Camera ─────────────────────────────────────────────────────────────────

/** Extra world-space camera translation used by the flicker test. */
const camTestOffset = new THREE.Vector3();

function placeCamera(): void {
  camera.position.copy(basis.up).multiplyScalar(camAltM); // site at origin
  camera.position.add(camTestOffset);
  const yaw = yawDeg * DEG;
  const pitch = pitchDeg * DEG;
  _fwd.copy(basis.north).multiplyScalar(Math.cos(yaw))
    .addScaledVector(basis.east, Math.sin(yaw));
  _fwd.multiplyScalar(Math.cos(pitch)).addScaledVector(basis.up, Math.sin(pitch));
  camera.up.copy(basis.up);
  _tmp.copy(camera.position).add(_fwd);
  camera.lookAt(_tmp);
  camera.near = Math.max(0.5, camAltM * 0.001);
  camera.far = 4e9;
  camera.updateProjectionMatrix();
}

let dragging = false;
canvas.addEventListener("mousedown", () => { dragging = true; });
window.addEventListener("mouseup", () => { dragging = false; });
window.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  yawDeg += e.movementX * 0.25;
  pitchDeg = THREE.MathUtils.clamp(pitchDeg - e.movementY * 0.25, -89, 89);
});
canvas.addEventListener("wheel", (e) => {
  camAltM = THREE.MathUtils.clamp(camAltM * (e.deltaY > 0 ? 1.12 : 1 / 1.12), 10, 1e9);
  e.preventDefault();
}, { passive: false });

// ── Fog (mirrors world.ts) ─────────────────────────────────────────────────

function updateFogAndSky(dt: number): void {
  const s = scenario;
  const fog = scene.fog as THREE.FogExp2;
  const atmTopM = s.atmTopKm * 1000;
  const atmosphereT = THREE.MathUtils.clamp(
    (camAltM - atmTopM * 0.2) / Math.max(1, atmTopM * 0.8), 0, 1,
  );

  // Day/night from the sun elevation at the camera position's up.
  const sunDot = basis.up.dot(_sunDir);
  const dayT = THREE.MathUtils.smoothstep(sunDot, -0.15, 0.15);
  const nightT = 1 - dayT;

  _sky.setHex(s.skyColor);
  _night.setHex(s.nightColor);
  _fogCol.copy(_sky).lerp(_night, nightT).lerp(SPACE_COLOR, atmosphereT);
  fog.color.copy(_fogCol);

  const baseDensity = 0.833 / (s.visibilityKm * 1000);
  const linearT = 1 - atmosphereT;
  const tail = 0.5 * Math.exp(-Math.max(0, camAltM - atmTopM) / (0.3 * atmTopM));
  fog.density = baseDensity * Math.max(linearT, tail) * OPTS.fogDensityMult;

  // Cloud envelope boost — same smoothing as world.ts.
  let rawCloudFog = 0;
  if (cloudSystem && planetGroup && OPTS.fogBoost > 0) {
    _camLocal.copy(camera.position).sub(planetGroup.position);
    cloudSystem.fogContribution(_camLocal, _cloudFog);
    if (_cloudFog.density > 0.01) {
      rawCloudFog = _cloudFog.density * OPTS.fogBoost * 0.01;
      // Night-shade the cloud interior — matches world.ts.
      _cloudFog.color.multiplyScalar(0.1 + 0.9 * dayT);
      smoothedCloudFogColor.lerp(_cloudFog.color, Math.min(1, dt * 3.5));
    }
  }
  smoothedCloudFog += (rawCloudFog - smoothedCloudFog) * Math.min(1, dt * 3.5);
  if (smoothedCloudFog > 1e-7) {
    fog.density += smoothedCloudFog;
    const t = THREE.MathUtils.clamp(smoothedCloudFog / Math.max(1e-6, fog.density), 0, 1);
    fog.color.lerp(smoothedCloudFogColor, t);
  }

  // Sky fogging — background blends toward fog color so fog covers the
  // sky, not just terrain pixels.
  const skyDist = fog.density * OPTS.skyFogKm * 1000;
  const skyFogT = 1 - Math.exp(-skyDist * skyDist);

  _bg.copy(_sky).lerp(_night, nightT).lerp(SPACE_COLOR, atmosphereT);
  if (skyFogT > 0) _bg.lerp(fog.color, skyFogT);
  (scene.background as THREE.Color).copy(_bg);

  ambient.intensity = THREE.MathUtils.lerp(0.06, 0.35, dayT);
  sunLight.intensity = 2.4;
}

// ── UI ─────────────────────────────────────────────────────────────────────

const controls = document.getElementById("lab-controls")!;
const statsEl = document.getElementById("lab-stats")!;

// Renderer A/B selector.
const rendererSelect = document.createElement("select");
for (const mode of ["billboards", "blobs"] as RendererMode[]) {
  const o = document.createElement("option");
  o.value = mode;
  o.textContent = `renderer: ${mode}`;
  rendererSelect.appendChild(o);
}
rendererSelect.value = rendererMode;
rendererSelect.addEventListener("change", () => {
  rendererMode = rendererSelect.value as RendererMode;
  loadScenario(scenario);
});
controls.appendChild(rendererSelect);

const select = document.createElement("select");
for (const s of SCENARIOS) {
  const o = document.createElement("option");
  o.value = s.name;
  o.textContent = s.name;
  select.appendChild(o);
}
select.addEventListener("change", () => {
  const s = SCENARIOS.find((x) => x.name === select.value);
  if (s) loadScenario(s);
});
controls.appendChild(select);

function slider(label: string, key: keyof typeof OPTS, min: number, max: number, step: number): void {
  const row = document.createElement("div");
  row.className = "row";
  const lab = document.createElement("label");
  lab.textContent = label;
  const inp = document.createElement("input");
  inp.type = "range";
  inp.min = String(min);
  inp.max = String(max);
  inp.step = String(step);
  inp.value = String(OPTS[key]);
  const val = document.createElement("span");
  val.className = "val";
  val.textContent = String(OPTS[key]);
  inp.addEventListener("input", () => {
    (OPTS[key] as number) = parseFloat(inp.value);
    val.textContent = inp.value;
  });
  row.appendChild(lab);
  row.appendChild(inp);
  row.appendChild(val);
  controls.appendChild(row);
}

slider("opacity", "cloudMult", 0, 2, 0.05);
slider("oversize", "spriteOversize", 0.5, 2.5, 0.05);
slider("wind", "windMult", 0, 5, 0.1);
slider("detail", "detailMult", 0, 2, 0.05);
slider("vigor", "vigorMult", 0, 2, 0.05);
slider("fog boost", "fogBoost", 0, 2, 0.05);
slider("fog density", "fogDensityMult", 0, 5, 0.05);
slider("time scale", "timeScale", 0, 20, 0.5);

const hint = document.createElement("div");
hint.id = "lab-hint";
hint.textContent = "drag = look · wheel = altitude";
document.body.appendChild(hint);

// Headless hooks for shot-clouds.cjs.
declare global {
  interface Window {
    __labGoto(name: string): void;
    __labReady(): boolean;
    __labSet(key: string, value: number): void;
    __labLook(yaw: number, pitch: number): void;
    __labStats(): string;
    __labFlicker(steps?: number, strideM?: number): number[];
    __labSetRenderer(mode: string): void;
  }
}
window.__labSetRenderer = (mode: string) => {
  if (mode === "billboards" || mode === "blobs") {
    rendererMode = mode;
    rendererSelect.value = mode;
    loadScenario(scenario);
  }
};
window.__labGoto = (name: string) => {
  select.value = name;
  const s = SCENARIOS.find((x) => x.name === name);
  if (s) loadScenario(s);
};
// Ready only after several frames have RENDERED for the current
// scenario — guarantees the canvas and the stats overlay both show the
// scenario the harness asked for (swiftshader frames are slow).
window.__labReady = () => ready && framesSinceLoad >= 6;
window.__labSet = (key: string, value: number) => {
  if (key in OPTS) (OPTS as Record<string, number>)[key] = value;
};
window.__labLook = (yaw: number, pitch: number) => {
  yawDeg = yaw;
  pitchDeg = pitch;
};
window.__labStats = () => JSON.stringify({
  scenario: scenario.name,
  renderer: rendererMode,
  altM: camAltM,
  pitchDeg,
  sprites: activeStats().sprites,
  tierSprites: activeStats().tierSprites,
  cellsIterated: activeStats().cellsIterated,
  cellsPassed: activeStats().cellsPassed,
});
// Flicker metric: advance the camera forward `strideM` per rendered
// frame with wind + weather evolution frozen, pixel-diffing consecutive
// frames. Smooth motion = a few % of pixels change; sprite popping /
// blend-order flips show up as large jumps. Returns the per-step
// changed-pixel fractions.
window.__labFlicker = (steps = 8, strideM = 3) => {
  const W = 320;
  const H = 180;
  const cvs = document.createElement("canvas");
  cvs.width = W;
  cvs.height = H;
  const cctx = cvs.getContext("2d")!;
  const savedWind = OPTS.windMult;
  const savedBake = OPTS.bakeMs;
  const savedTime = OPTS.timeScale;
  OPTS.windMult = 0;
  OPTS.bakeMs = 0;
  OPTS.timeScale = 0;
  const scores: number[] = [];
  let prev: Uint8ClampedArray | null = null;
  for (let i = 0; i < steps; i++) {
    camTestOffset.addScaledVector(_fwd, strideM);
    stepFrame(1 / 60);
    cctx.drawImage(renderer.domElement, 0, 0, W, H);
    const d = cctx.getImageData(0, 0, W, H).data;
    if (prev) {
      let changed = 0;
      for (let p = 0; p < d.length; p += 4) {
        const dd = Math.abs(d[p] - prev[p]) + Math.abs(d[p + 1] - prev[p + 1])
          + Math.abs(d[p + 2] - prev[p + 2]);
        if (dd > 30) changed++;
      }
      scores.push(changed / (W * H));
    }
    prev = d.slice();
  }
  camTestOffset.set(0, 0, 0);
  OPTS.windMult = savedWind;
  OPTS.bakeMs = savedBake;
  OPTS.timeScale = savedTime;
  return scores;
};

// ── Main loop ──────────────────────────────────────────────────────────────

const clock = new THREE.Clock();
let frame = 0;

/** One synchronous frame — used by both the rAF loop and __labFlicker. */
function stepFrame(dt: number): void {
  labTime += dt * OPTS.timeScale;

  placeCamera();

  if (cloudSystem && planetGroup) {
    cloudSystem.setRuntimeOpts({
      opacity: OPTS.cloudMult,
      spriteOversize: OPTS.spriteOversize,
      windMult: OPTS.windMult,
      detailMult: OPTS.detailMult,
      vigorMult: OPTS.vigorMult,
      bakeBudgetMs: OPTS.bakeMs,
      updateInterval: 1,
      shellDetailMult: OPTS.shellDetailMult,
      shellDebug: OPTS.shellDebug,
    });
    const vpH = renderer.domElement.height;
    cloudSystem.setProjection(computeCloudPixelsPerUnit(camera, vpH), vpH);
    cloudSystem.setSunWorldPos(_sunPos);
    _camLocal.copy(camera.position).sub(planetGroup.position);
    cloudSystem.update(_camLocal, labTime);
  }

  updateFogAndSky(dt);
  renderer.render(scene, camera);
  framesSinceLoad++;
}

function animate(): void {
  requestAnimationFrame(animate);
  stepFrame(Math.min(0.1, clock.getDelta()));

  if (++frame % 1 === 0 && cloudSystem) {
    const st = activeStats();
    statsEl.textContent =
      `${scenario.name} — ${scenario.desc}\n`
      + `[${rendererMode}] alt ${(camAltM / 1000).toFixed(2)} km · pitch ${pitchDeg.toFixed(0)}° · yaw ${yawDeg.toFixed(0)}°\n`
      + `sprites ${st.sprites} · walk ${st.walkMs.toFixed(2)} ms · `
      + `bake ${st.bakeMs.toFixed(2)} ms · sort ${st.sortMs.toFixed(2)} ms\n`
      + `cells ${st.cellsIterated} → ${st.cellsPassed} · `
      + `field samples ${cloudFieldStats.samples}`;
  }
}

loadScenario(SCENARIOS[0]);
animate();
