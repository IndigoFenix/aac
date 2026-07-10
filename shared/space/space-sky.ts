// shared/space/space-sky.ts
//
// The SPACE RENDER LAYER — ported faithfully from seagull-dream's world.ts
// (createSky + the halo system). Nothing here touches the world-engine
// geography seam; it's purely how the universe LOOKS:
//
//   • SKY — scene.background is never pure black: it's the dominant body's sky
//     colour near a planet, blending to a dark-navy spaceColor (#04060c) with
//     altitude, plus an altitude/visibility FogExp2 and a day/night ambient.
//   • STARFIELD — one camera-centred THREE.Points cloud, re-projected from the
//     player's galactic position each frame (galaxy.ts projectGalaxy), drawn as
//     a depth-testless background pass. Reads as glowing stars + a Milky-Way
//     band ONLY through the host's HDR bloom pass.
//   • HALOS + MARKERS — two more Points clouds: a small additive phase-lit dot
//     per body (so a planet reads as a point long before its mesh builds) and a
//     larger ring marker so planets are pickable out of the starfield. Both fade
//     out as the real mesh fades in (the mesh-opacity crossover).
//
// The host (a flight renderer) drives it once per frame via `update`, and MUST
// render the scene through an HDR bloom pipeline or the additive pinpricks stay
// flat and dim (that's what "stars barely visible / sun doesn't shine" was).

import * as THREE from "three";
import { GALAXY, projectGalaxy, type Universe } from "./galaxy.js";
import type { CelestialBody } from "./body.js";

// ── Sky palette + transition (seagull createSky) ──────────────────────────────
const DEFAULT_DAY = new THREE.Color("#87ceeb");
const DEFAULT_NIGHT = new THREE.Color("#070b1c");
const SPACE_COLOR = new THREE.Color("#04060c"); // deep space is navy, not black
const AMBIENT_DAY = 0.35;
const AMBIENT_NIGHT = 0.05;
const AMBIENT_DAY_COLOR = new THREE.Color(0xbcd4ff);
const AMBIENT_NIGHT_COLOR = new THREE.Color(0x1b2a4a);
const SKY_ATM_START = 500;   // airless-body fallback: thinning begins (m)
const SKY_SPACE_ALT = 3000;  // airless-body fallback: effectively space (m)
const STARFIELD_MULT = 1.0;
const FOG_DENSITY_MULT = 1.0;
const SKY_FOG_KM = 16;

// ── Halo constants (seagull) ──────────────────────────────────────────────────
const STARFIELD_RADIUS = 30000; // camera-relative; depthTest off so value is arbitrary
const HALO_FULL_BELOW_PX = 1.5;
const HALO_GONE_ABOVE_PX = 8;
const HALO_PLANET_BOOST = 4.0;
const HALO_PLANET_AMBIENT = 0.35;
const MESH_VISIBLE_THRESHOLD = 0.6;
const HALO_MULT = 1.0;
const ATM_SHELL_MULT = 1.0;

// The host renders through an HDR bloom pipeline whose OutputPass applies ACES
// tone-mapping (Narkowicz fit) at exposure ACES_EXPOSURE to the WHOLE image —
// so `toneMapped:false` on the sky-dome material is ignored and the sky greys.
// Pre-compensate: set the dome colour to inverseACES(target)/exposure so the
// OutputPass turns it back into exactly `target`. MUST match the host's
// BLOOM.exposure.
const ACES_EXPOSURE = 0.7;
/** Invert the Narkowicz ACES fit (per channel), so ACES(exposure·x) = y. Capped
 *  at 0.80 so the HDR pre-image stays BELOW the host's bloom threshold — else a
 *  bright sky would cross it and the whole sky would bloom/bleed. */
function inverseACESChannel(y: number): number {
  y = Math.max(0, Math.min(0.80, y));
  const A = 2.43 * y - 2.51, B = 0.59 * y - 0.03, C = 0.14 * y;
  const disc = B * B - 4 * A * C;
  if (A === 0 || disc < 0) return y;
  const x = (-B - Math.sqrt(disc)) / (2 * A);
  return (x > 0 ? x : (-B + Math.sqrt(disc)) / (2 * A)) / ACES_EXPOSURE;
}
function preCompensateACES(c: THREE.Color): void {
  c.r = inverseACESChannel(c.r);
  c.g = inverseACESChannel(c.g);
  c.b = inverseACESChannel(c.b);
}

/** Push a colour's saturation up around its luminance. The physics sky colour
 *  is cloud-desaturated (and would be ACES-muted); this restores the blue. */
function saturate(c: THREE.Color, k: number): void {
  const l = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
  c.r = Math.max(0, Math.min(1, l + (c.r - l) * k));
  c.g = Math.max(0, Math.min(1, l + (c.g - l) * k));
  c.b = Math.max(0, Math.min(1, l + (c.b - l) * k));
}

/** Night side of an atmosphere: dim + toward blue (seagull darkenForNight). */
function darkenForNight(color: THREE.Color): THREE.Color {
  const intensity = (color.r + color.g + color.b) / 3;
  if (intensity < 0.02) return new THREE.Color(0, 0, 0);
  return new THREE.Color(color.r * 0.08, color.g * 0.1, color.b * 0.14);
}

function makeStarfieldTexture(): THREE.CanvasTexture {
  const size = 64;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0.0, "rgba(255,255,255,1)");
  grad.addColorStop(0.25, "rgba(255,255,255,0.75)");
  grad.addColorStop(0.55, "rgba(255,255,255,0.25)");
  grad.addColorStop(1.0, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  // Mipmaps OFF — a 3-4px sprite otherwise samples a blurred mip that eats the
  // bright core, dropping stars below the bloom threshold (seagull's note).
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

/** Ring + central dot — the planet marker (distinct from a filled star dot). */
function makePlanetMarkerTexture(): THREE.CanvasTexture {
  const size = 64;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const cx = size / 2, cy = size / 2;
  g.strokeStyle = "rgba(255,255,255,0.95)";
  g.lineWidth = 4;
  g.beginPath(); g.arc(cx, cy, size * 0.36, 0, Math.PI * 2); g.stroke();
  const glow = g.createRadialGradient(cx, cy, size * 0.32, cx, cy, size * 0.5);
  glow.addColorStop(0, "rgba(255,255,255,0)");
  glow.addColorStop(0.4, "rgba(255,255,255,0.18)");
  glow.addColorStop(1.0, "rgba(255,255,255,0)");
  g.fillStyle = glow; g.fillRect(0, 0, size, size);
  g.fillStyle = "rgba(255,255,255,1)";
  g.beginPath(); g.arc(cx, cy, 2.5, 0, Math.PI * 2); g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

export interface SkyFrame {
  bodies: CelestialBody[];
  /** Active system primary — phase-lit halos + day/night. Null in deep space. */
  star: CelestialBody | null;
  /** Gravity-dominant body under the camera (sky tint). Null in deep space. */
  dominant: CelestialBody | null;
  /** Camera altitude above the dominant body (m). */
  altitude: number;
  cameraPos: THREE.Vector3;
  screenHeightPx: number;
  fovRad: number;
  sceneAnchorGalactic: THREE.Vector3;
  dt: number;
}

export interface SpaceSky {
  update(f: SkyFrame): void;
  dispose(): void;
}

/** Build the space render layer over `scene`. The host owns the scene and the
 *  HDR bloom pipeline; this manages background/fog/ambient + three Points clouds. */
export function createSpaceSky(scene: THREE.Scene, universe: Universe): SpaceSky {
  const prevBackground = scene.background;
  const prevFog = scene.fog;

  const dayColor = DEFAULT_DAY.clone();
  const nightColor = DEFAULT_NIGHT.clone();
  scene.fog = new THREE.FogExp2(SPACE_COLOR.clone(), 0);

  // Sky as a camera-centred BackSide DOME with a `toneMapped:false` material,
  // NOT scene.background — the ACES tone-mapping the bloom pipeline needs
  // desaturates a background Color to grey (the classic "can't get the sky
  // blue" problem), but a toneMapped:false mesh shows the exact colour we
  // compute. Drawn first (renderOrder −20, depth off) so it's the backdrop.
  scene.background = null;
  const domeMat = new THREE.MeshBasicMaterial({
    color: SPACE_COLOR.clone(), side: THREE.BackSide, fog: false,
    toneMapped: false, depthWrite: false, depthTest: false,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(20000, 32, 16), domeMat);
  dome.name = "sky-dome";
  dome.renderOrder = -20;
  dome.frustumCulled = false;
  scene.add(dome);

  const ambient = new THREE.AmbientLight(AMBIENT_DAY_COLOR.clone(), AMBIENT_NIGHT);
  scene.add(ambient);

  // ── Starfield: one camera-centred Points cloud, additive, no depth ─────────
  const starTex = makeStarfieldTexture();
  const galaxyMat = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: starTex }, uOpacity: { value: 1.0 } },
    vertexShader: `
      attribute float size;
      attribute vec3 color;
      varying vec3 vColor;
      void main() {
        vColor = color;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size;
      }`,
    fragmentShader: `
      uniform sampler2D uMap;
      uniform float uOpacity;
      varying vec3 vColor;
      void main() {
        vec4 t = texture2D(uMap, gl_PointCoord);
        if (t.a < 0.005) discard;
        gl_FragColor = vec4(vColor * t.rgb, t.a * uOpacity);
      }`,
    transparent: false,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const MAX_GALAXY_VERTS = 100000;
  const starPos = new Float32Array(MAX_GALAXY_VERTS * 3);
  const starCol = new Float32Array(MAX_GALAXY_VERTS * 3);
  const starSiz = new Float32Array(MAX_GALAXY_VERTS);
  const starGeom = new THREE.BufferGeometry();
  const starPosAttr = new THREE.BufferAttribute(starPos, 3);
  const starColAttr = new THREE.BufferAttribute(starCol, 3);
  const starSizAttr = new THREE.BufferAttribute(starSiz, 1);
  starGeom.setAttribute("position", starPosAttr);
  starGeom.setAttribute("color", starColAttr);
  starGeom.setAttribute("size", starSizAttr);
  const stars = new THREE.Points(starGeom, galaxyMat);
  stars.name = "galaxy-points";
  stars.renderOrder = -10;
  stars.frustumCulled = false;
  scene.add(stars);

  // ── Body halos (filled dots) + planet markers (rings) ──────────────────────
  const haloTex = makeStarfieldTexture();
  const haloGeom = new THREE.BufferGeometry();
  const halos = new THREE.Points(haloGeom, new THREE.PointsMaterial({
    size: 5, sizeAttenuation: false, vertexColors: true, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, map: haloTex, alphaTest: 0.01,
  }));
  halos.frustumCulled = false;
  halos.renderOrder = -5;
  scene.add(halos);

  const markerTex = makePlanetMarkerTexture();
  const markerGeom = new THREE.BufferGeometry();
  const markers = new THREE.Points(markerGeom, new THREE.PointsMaterial({
    size: 22, sizeAttenuation: false, vertexColors: true, transparent: true,
    blending: THREE.NormalBlending, depthWrite: false, depthTest: true,
    map: markerTex, alphaTest: 0.02,
  }));
  markers.frustumCulled = false;
  scene.add(markers);

  let haloPos = new Float32Array(0);
  let haloCol = new Float32Array(0);
  let markerPos = new Float32Array(0);
  let markerCol = new Float32Array(0);
  let builtCount = -1;
  function rebuildBuffers(n: number): void {
    haloPos = new Float32Array(n * 3);
    haloCol = new Float32Array(n * 3);
    haloGeom.setAttribute("position", new THREE.BufferAttribute(haloPos, 3));
    haloGeom.setAttribute("color", new THREE.BufferAttribute(haloCol, 3));
    haloGeom.setDrawRange(0, n);
    markerPos = new Float32Array(n * 3);
    markerCol = new Float32Array(n * 3);
    markerGeom.setAttribute("position", new THREE.BufferAttribute(markerPos, 3));
    markerGeom.setAttribute("color", new THREE.BufferAttribute(markerCol, 3));
    markerGeom.setDrawRange(0, n);
    builtCount = n;
  }

  // Show/hide a body's whole mesh group by apparent pixel size (BINARY, not a
  // fade — a translucent near-black unlit planet would subtract from the sky).
  // Stars are EXEMPT: hiding a star group would also cull its PointLight and
  // darken the whole system, so a distant sun stays a lit sub-pixel disc.
  function setBodyMeshOpacity(body: CelestialBody, opacity: number): void {
    const visible = body.type === "star" ? true : opacity >= MESH_VISIBLE_THRESHOLD;
    if (body.group.visible !== visible) body.group.visible = visible;
    if (!visible) return;
    body.group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      // Atmosphere shells stay translucent + additive (forcing them opaque
      // punches depth holes); their opacity rides ATM_SHELL_MULT.
      if (mesh.name === "atmosphere_halo" || mesh.name === "atmosphere_veil") {
        (mesh.material as THREE.Material).opacity = ATM_SHELL_MULT;
        return;
      }
      const mat = mesh.material;
      if (Array.isArray(mat)) {
        for (const m of mat) { m.opacity = 1; m.depthWrite = true; m.transparent = false; }
      } else if (mat) {
        mat.opacity = 1; mat.depthWrite = true; mat.transparent = false;
      }
    });
  }

  const _gal = new THREE.Vector3();
  const _bg = new THREE.Color();
  const _atm = new THREE.Color();
  const _fog = new THREE.Color();
  const _up = new THREE.Vector3();
  const _sunDir = new THREE.Vector3();
  const _toCamera = new THREE.Vector3();
  const _toSun = new THREE.Vector3();
  const _haloBuf = new THREE.Color();
  const _white = new THREE.Color(1, 1, 1);

  function updateSky(f: SkyFrame): void {
    const { dominant, star, altitude, cameraPos } = f;
    const atm = dominant?.resolvedPhysics?.features.atmosphere;
    dayColor.copy(atm?.skyZenithColor ?? DEFAULT_DAY);
    if (dayColor.r + dayColor.g + dayColor.b < 0.02) dayColor.copy(DEFAULT_DAY);
    nightColor.copy(darkenForNight(dayColor));
    const horizon = atm?.skyHorizonColor ?? dayColor;
    const atmTopM = (atm?.atmosphereTopKm ?? 0) * 1000;
    const visRangeM = (atm?.visibilityKm ?? 0) * 1000;

    let atmStart: number, atmEnd: number;
    if (atmTopM > 100) { atmEnd = atmTopM; atmStart = atmEnd * 0.2; }
    else { atmStart = SKY_ATM_START; atmEnd = SKY_SPACE_ALT; }
    const atmosphereT = !dominant
      ? 1
      : THREE.MathUtils.clamp((altitude - atmStart) / Math.max(1, atmEnd - atmStart), 0, 1);

    let dayT = 0;
    if (dominant && star) {
      _up.subVectors(cameraPos, dominant.worldPosition).normalize();
      _sunDir.subVectors(star.worldPosition, dominant.worldPosition).normalize();
      dayT = THREE.MathUtils.smoothstep(_up.dot(_sunDir), -0.15, 0.15);
    }
    const nightT = 1 - dayT;

    _atm.copy(dayColor).lerp(nightColor, nightT);
    // Restore saturation lost to cloud-desaturation (only in daylit air, where a
    // colourful sky belongs — not the near-black night/space sky). The dome is
    // toneMapped:false, so this shows through instead of being greyed by ACES.
    if (dayT > 0.05 && atmosphereT < 1) saturate(_atm, 1 + 1.4 * dayT * (1 - atmosphereT));
    _bg.copy(_atm).lerp(SPACE_COLOR, atmosphereT);

    let skyFogT = 0;
    const fog = scene.fog as THREE.FogExp2 | null;
    if (fog) {
      _fog.copy(horizon).lerp(nightColor, nightT).lerp(SPACE_COLOR, atmosphereT);
      fog.color.copy(_fog);
      if (visRangeM > 100) {
        const baseDensity = 0.833 / visRangeM;
        const linearT = 1 - atmosphereT;
        const tail = 0.5 * Math.exp(-Math.max(0, altitude - atmEnd) / (0.3 * Math.max(1, atmEnd)));
        fog.density = baseDensity * Math.max(linearT, tail) * FOG_DENSITY_MULT;
      } else {
        fog.density = 0;
      }
      const skyDist = fog.density * SKY_FOG_KM * 1000;
      skyFogT = 1 - Math.exp(-skyDist * skyDist);
      if (skyFogT > 0) _bg.lerp(fog.color, skyFogT);
    }
    // The sky dome IS the background, centred on the camera. Pre-compensate for
    // the OutputPass's ACES so the dome shows `_bg` exactly (not greyed).
    domeMat.color.copy(_bg);
    preCompensateACES(domeMat.color);
    dome.position.copy(cameraPos);

    galaxyMat.uniforms.uOpacity.value =
      Math.max(atmosphereT, nightT * 0.85) * (1 - skyFogT) * STARFIELD_MULT;

    ambient.intensity = THREE.MathUtils.lerp(AMBIENT_NIGHT, AMBIENT_DAY, dayT);
    ambient.color.copy(AMBIENT_NIGHT_COLOR).lerp(AMBIENT_DAY_COLOR, dayT);
  }

  function updateStarfield(f: SkyFrame): void {
    stars.position.copy(f.cameraPos);
    _gal.copy(f.cameraPos).divideScalar(GALAXY.lyToSceneMeters).add(f.sceneAnchorGalactic);
    const count = projectGalaxy(universe, _gal, STARFIELD_RADIUS, null, starPos, starCol, starSiz);
    starGeom.setDrawRange(0, count);
    starPosAttr.needsUpdate = true;
    starColAttr.needsUpdate = true;
    starSizAttr.needsUpdate = true;
  }

  function updateHalos(f: SkyFrame): void {
    const { bodies, star, cameraPos, screenHeightPx, fovRad } = f;
    if (bodies.length !== builtCount) rebuildBuffers(bodies.length);
    const pxPerRad = screenHeightPx / fovRad;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      const dist = b.worldPosition.distanceTo(cameraPos);
      const safeDist = Math.max(dist, b.radius);
      const pixelSize = 2 * Math.atan(b.radius / safeDist) * pxPerRad;
      const meshOpacity = THREE.MathUtils.smoothstep(pixelSize, HALO_FULL_BELOW_PX, HALO_GONE_ABOVE_PX);
      setBodyMeshOpacity(b, meshOpacity);

      haloPos[i * 3] = b.worldPosition.x;
      haloPos[i * 3 + 1] = b.worldPosition.y;
      haloPos[i * 3 + 2] = b.worldPosition.z;
      markerPos[i * 3] = b.worldPosition.x;
      markerPos[i * 3 + 1] = b.worldPosition.y;
      markerPos[i * 3 + 2] = b.worldPosition.z;

      // Stars carry no haloColor — their sub-pixel dot is the starfield
      // projection + the HDR disc; no halo/marker.
      if (!b.haloColor) {
        haloCol[i * 3] = haloCol[i * 3 + 1] = haloCol[i * 3 + 2] = 0;
        markerCol[i * 3] = markerCol[i * 3 + 1] = markerCol[i * 3 + 2] = 0;
        continue;
      }

      const haloOpacity = 1 - meshOpacity;
      // Planet marker — bright white baseline + a tint of the body colour so
      // the ring stays visible against any sky; no phase dimming.
      if (haloOpacity > 0) {
        const baseline = 0.7, tint = 0.5;
        markerCol[i * 3] = (baseline + tint * b.haloColor.r) * haloOpacity;
        markerCol[i * 3 + 1] = (baseline + tint * b.haloColor.g) * haloOpacity;
        markerCol[i * 3 + 2] = (baseline + tint * b.haloColor.b) * haloOpacity;
      } else {
        markerCol[i * 3] = markerCol[i * 3 + 1] = markerCol[i * 3 + 2] = 0;
        haloCol[i * 3] = haloCol[i * 3 + 1] = haloCol[i * 3 + 2] = 0;
        continue;
      }

      // Phase-lit dot: phase = lit², small ambient floor keeps the silhouette
      // readable; lerp toward white on the lit side (distant lit planet = pale dot).
      _toCamera.copy(cameraPos).sub(b.worldPosition);
      const tcl = _toCamera.length();
      if (tcl > 0) _toCamera.divideScalar(tcl);
      let lit = 0;
      if (star) {
        _toSun.copy(star.worldPosition).sub(b.worldPosition);
        const tsl = _toSun.length();
        if (tsl > 0) _toSun.divideScalar(tsl);
        lit = Math.max(0, _toCamera.dot(_toSun));
      }
      const phase = lit * lit;
      const intensity = HALO_PLANET_BOOST * (HALO_PLANET_AMBIENT + (1 - HALO_PLANET_AMBIENT) * phase) * HALO_MULT;
      _haloBuf.copy(b.haloColor).lerp(_white, lit * 0.5).multiplyScalar(haloOpacity * intensity);
      haloCol[i * 3] = _haloBuf.r;
      haloCol[i * 3 + 1] = _haloBuf.g;
      haloCol[i * 3 + 2] = _haloBuf.b;
    }
    (haloGeom.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (haloGeom.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
    (markerGeom.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (markerGeom.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
  }

  return {
    update(f) {
      updateSky(f);
      updateStarfield(f);
      updateHalos(f);
    },
    dispose() {
      scene.remove(stars, halos, markers, ambient, dome);
      starGeom.dispose(); galaxyMat.dispose(); starTex.dispose();
      haloGeom.dispose(); (halos.material as THREE.Material).dispose(); haloTex.dispose();
      markerGeom.dispose(); (markers.material as THREE.Material).dispose(); markerTex.dispose();
      dome.geometry.dispose(); domeMat.dispose();
      scene.background = prevBackground;
      scene.fog = prevFog;
    },
  };
}
