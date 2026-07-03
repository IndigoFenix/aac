// shared/world-engine/object-models.ts
//
// Procedural 3D models for world objects. The renderer used to draw every
// physical object as a bare box/sphere with the object's emoji floating over it
// (render3d.ts). That reads as "a generic blob wearing a sticker" — fine as a
// fallback, poor as a world. This module turns the object's IDENTITY (its emoji
// `iconRef`, or the head symbol of a composed `glyph`) into a small, recognizable
// mesh built from primitives: an apple looks like an apple, a car like a car.
//
// The model also reflects the composed glyph's DESCRIPTORS physically, so the
// floating icon is no longer needed on a modeled object (render3d hides it):
//   • color_*  → the object's body is tinted that color,
//   • big/small (and long/tall/wide/thin) → the object is scaled, exaggerated so
//     the difference is obvious at a glance,
//   • hot/cold → a rising warm ember / drifting cool frost particle effect.
// Descriptors are re-read whenever the glyph changes live (a fire station turns
// `apple.cold` → `apple.hot`), so the effect tracks the simulation.
//
// FAILSAFE by design: `buildObjectModel` returns null for anything it doesn't
// have a recipe for, and the caller falls back to the old box/sphere + icon
// path. So a brand-new object type (or a queued glyph with no model yet) still
// renders — just with the generic shape + its emoji — until a recipe is added
// here. Nothing in the world can fail to draw for lack of a model.
//
// Conventions every builder follows so the caller needs zero per-model math:
//   • The model is sized to the object's `radius` (world units).
//   • Its local origin is the object's CENTER at height `radius` — i.e. the base
//     sits at local y = -radius — matching how a sphere/box was positioned, so
//     containment ("on"/"in") and floor lifting keep working unchanged. Size
//     descriptors preserve this (the base stays on the ground when it grows).
//   • The outer `object` node is what the renderer positions AND yaws (so a held
//     object turns to face the way its carrier is facing); an inner group holds
//     the parts and takes the descriptor scale.

import * as THREE from "three";

export interface ObjectModel {
  /** Root to add to the scene, position, and YAW (carries `userData.pick`). */
  object: THREE.Group;
  /** Every standard material in the model — for emissive highlight + floor-fade. */
  materials: THREE.MeshStandardMaterial[];
  /** Apply the composed glyph's descriptors (color/size/temperature). Idempotent
   *  — call on creation and again whenever `glyph` changes. */
  applyDescriptors(glyph: string | undefined): void;
  /** Advance any temperature particle effect. No-op when the object has none. */
  update(timeSeconds: number): void;
  /** Release every geometry/material/texture this model owns. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Recipe build context
// ---------------------------------------------------------------------------

interface Ctx {
  r: number;
  /** Parts group (takes the descriptor scale). */
  content: THREE.Group;
  materials: THREE.MeshStandardMaterial[];
  /** Body materials a color descriptor recolors (wheels/stems/eyes stay fixed). */
  tintable: THREE.MeshStandardMaterial[];
  /** Each tintable material's original color, to restore when the tint clears. */
  tintBase: THREE.Color[];
  disposables: Array<{ dispose(): void }>;
}

function mat(
  ctx: Ctx,
  color: THREE.ColorRepresentation,
  opts: { roughness?: number; metalness?: number; tint?: boolean } = {},
): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    roughness: opts.roughness ?? 0.6,
    metalness: opts.metalness ?? 0,
  });
  ctx.materials.push(m);
  ctx.disposables.push(m);
  if (opts.tint) {
    ctx.tintable.push(m);
    ctx.tintBase.push(m.color.clone());
  }
  return m;
}

function part(
  ctx: Ctx,
  geom: THREE.BufferGeometry,
  material: THREE.Material,
  pos: [number, number, number] = [0, 0, 0],
  rot?: [number, number, number],
): THREE.Mesh {
  ctx.disposables.push(geom);
  const mesh = new THREE.Mesh(geom, material);
  mesh.position.set(pos[0], pos[1], pos[2]);
  if (rot) mesh.rotation.set(rot[0], rot[1], rot[2]);
  ctx.content.add(mesh);
  return mesh;
}

// ---------------------------------------------------------------------------
// Recipes. Coordinates are fractions of the radius `r`, base at y = -r. Low-poly
// on purpose — these are background props. The `tint: true` material is the body
// a color descriptor recolors; everything else keeps its natural color. A
// recipe's "forward" is +X, so a carried object yaws to face its carrier.
// ---------------------------------------------------------------------------

type Recipe = (ctx: Ctx) => void;

const RECIPES: Record<string, Recipe> = {
  ball: (ctx) => {
    const { r } = ctx;
    part(ctx, new THREE.SphereGeometry(r, 24, 18), mat(ctx, "#f8fafc", { roughness: 0.35, tint: true }), [0, 0, 0]);
    const spot = mat(ctx, "#1f2937", { roughness: 0.4 });
    const dirs: [number, number, number][] = [
      [0, 1, 0], [0.9, 0.2, 0.4], [-0.8, 0.1, 0.5], [0.3, -0.3, -0.9], [-0.5, -0.4, -0.6],
    ];
    for (const d of dirs) {
      const v = new THREE.Vector3(d[0], d[1], d[2]).normalize().multiplyScalar(r * 0.98);
      const disc = part(ctx, new THREE.CircleGeometry(r * 0.34, 5), spot, [v.x, v.y, v.z]);
      disc.lookAt(v.clone().multiplyScalar(2));
    }
  },

  apple: (ctx) => {
    const { r } = ctx;
    const body = part(ctx, new THREE.SphereGeometry(r * 0.92, 24, 18), mat(ctx, "#dc2626", { roughness: 0.35, tint: true }), [0, -r * 0.05, 0]);
    body.scale.set(1, 0.92, 1);
    part(ctx, new THREE.CylinderGeometry(r * 0.06, r * 0.06, r * 0.5, 6), mat(ctx, "#7c4a1e"), [0, r * 0.9, 0]);
    const leaf = part(ctx, new THREE.SphereGeometry(r * 0.28, 10, 6), mat(ctx, "#16a34a"), [r * 0.25, r * 0.95, 0]);
    leaf.scale.set(1.4, 0.4, 0.8);
    leaf.rotation.z = -0.5;
  },

  banana: (ctx) => {
    const { r } = ctx;
    const R = r * 0.85;
    const sweep = Math.PI * 0.95;
    const arc = part(
      ctx,
      new THREE.TorusGeometry(R, r * 0.26, 12, 24, sweep),
      mat(ctx, "#facc15", { roughness: 0.5, tint: true }),
      [0, r * 0.1, 0],
      [0, 0, Math.PI * 0.5 + 0.25],
    );
    arc.scale.set(1, 1, 0.85);
    // Brown tips anchored to the torus's actual endpoints (LOCAL torus space, at
    // sweep angles 0 and `sweep`), so they sit exactly on the ends under the arc's
    // rotation/scale instead of floating beside it.
    const tip = mat(ctx, "#78350f");
    for (const a of [0, sweep]) {
      const g = new THREE.SphereGeometry(r * 0.2, 8, 6);
      ctx.disposables.push(g);
      const s = new THREE.Mesh(g, tip);
      s.position.set(R * Math.cos(a), R * Math.sin(a), 0);
      arc.add(s);
    }
  },

  grapes: (ctx) => {
    const { r } = ctx;
    const skin = mat(ctx, "#7c3aed", { roughness: 0.3, tint: true });
    const rows: [number, number][] = [[3, 0.55], [2, 0.05], [2, -0.45], [1, -0.9]];
    let idx = 0;
    for (const [count, y] of rows) {
      for (let i = 0; i < count; i++) {
        const x = count === 1 ? 0 : (i - (count - 1) / 2) * r * 0.5;
        const z = (idx % 2 === 0 ? 1 : -1) * r * 0.18;
        part(ctx, new THREE.SphereGeometry(r * 0.3, 12, 8), skin, [x, y * r, z]);
        idx++;
      }
    }
    part(ctx, new THREE.CylinderGeometry(r * 0.05, r * 0.05, r * 0.4, 5), mat(ctx, "#4d7c0f"), [0, r * 0.95, 0]);
    const leaf = part(ctx, new THREE.SphereGeometry(r * 0.3, 10, 6), mat(ctx, "#65a30d"), [r * 0.2, r * 1.0, 0]);
    leaf.scale.set(1.3, 0.35, 0.9);
  },

  cookie: (ctx) => {
    const { r } = ctx;
    part(ctx, new THREE.CylinderGeometry(r * 0.95, r * 0.95, r * 0.5, 24), mat(ctx, "#c8964f", { roughness: 0.8, tint: true }), [0, -r * 0.6, 0]);
    const chip = mat(ctx, "#4a2c17", { roughness: 0.6 });
    const chips: [number, number][] = [[0.35, 0.25], [-0.4, 0.1], [0.1, -0.45], [-0.15, 0.5], [0.5, -0.3]];
    for (const [cx, cz] of chips) {
      part(ctx, new THREE.SphereGeometry(r * 0.14, 8, 6), chip, [cx * r, -r * 0.32, cz * r]);
    }
  },

  car: (ctx) => {
    const { r } = ctx;
    const body = mat(ctx, "#ef4444", { roughness: 0.35, metalness: 0.1, tint: true });
    part(ctx, new THREE.BoxGeometry(r * 2.0, r * 0.7, r * 1.1), body, [0, -r * 0.25, 0]);
    part(ctx, new THREE.BoxGeometry(r * 1.0, r * 0.6, r * 0.9), body, [-r * 0.15, r * 0.3, 0]);
    part(ctx, new THREE.BoxGeometry(r * 1.02, r * 0.42, r * 0.7), mat(ctx, "#bae6fd", { roughness: 0.1, metalness: 0.2 }), [-r * 0.15, r * 0.3, 0]);
    const tyre = mat(ctx, "#111827", { roughness: 0.7 });
    const wheelGeom = () => new THREE.CylinderGeometry(r * 0.36, r * 0.36, r * 0.24, 14);
    for (const wx of [-r * 0.65, r * 0.7]) {
      for (const wz of [-r * 0.55, r * 0.55]) {
        part(ctx, wheelGeom(), tyre, [wx, -r * 0.62, wz], [Math.PI / 2, 0, 0]);
      }
    }
  },

  train: (ctx) => {
    const { r } = ctx;
    const body = mat(ctx, "#2563eb", { roughness: 0.4, metalness: 0.15, tint: true });
    part(ctx, new THREE.CylinderGeometry(r * 0.55, r * 0.55, r * 1.5, 16), body, [r * 0.2, -r * 0.1, 0], [0, 0, Math.PI / 2]);
    part(ctx, new THREE.BoxGeometry(r * 0.8, r * 0.9, r * 1.0), body, [-r * 0.95, r * 0.05, 0]);
    part(ctx, new THREE.CylinderGeometry(r * 0.22, r * 0.28, r * 0.6, 10), mat(ctx, "#1f2937"), [r * 0.75, r * 0.6, 0]);
    const tyre = mat(ctx, "#111827", { roughness: 0.7 });
    for (const wx of [-r * 0.7, r * 0.1, r * 0.85]) {
      part(ctx, new THREE.CylinderGeometry(r * 0.34, r * 0.34, r * 0.2, 14), tyre, [wx, -r * 0.7, r * 0.6], [Math.PI / 2, 0, 0]);
      part(ctx, new THREE.CylinderGeometry(r * 0.34, r * 0.34, r * 0.2, 14), tyre, [wx, -r * 0.7, -r * 0.6], [Math.PI / 2, 0, 0]);
    }
  },

  blocks: (ctx) => {
    const { r } = ctx;
    // Three stacked cubes; all count as body so a color descriptor paints the set.
    const cubes: [string, number, number, number][] = [
      ["#ef4444", -r * 0.35, -r * 0.55, r * 0.15],
      ["#22c55e", r * 0.4, -r * 0.55, -r * 0.2],
      ["#3b82f6", 0, r * 0.15, 0],
    ];
    for (const [color, x, y, z] of cubes) {
      part(ctx, new THREE.BoxGeometry(r * 0.85, r * 0.85, r * 0.85), mat(ctx, color, { roughness: 0.5, tint: true }), [x, y, z]);
    }
  },

  teddy: (ctx) => {
    const { r } = ctx;
    const fur = mat(ctx, "#a16207", { roughness: 0.85, tint: true });
    part(ctx, new THREE.SphereGeometry(r * 0.62, 16, 12), fur, [0, -r * 0.25, 0]);
    part(ctx, new THREE.SphereGeometry(r * 0.45, 16, 12), fur, [0, r * 0.55, 0]);
    for (const ex of [-r * 0.35, r * 0.35]) {
      part(ctx, new THREE.SphereGeometry(r * 0.18, 10, 8), fur, [ex, r * 0.9, 0]);
    }
    for (const ax of [-r * 0.55, r * 0.55]) {
      part(ctx, new THREE.SphereGeometry(r * 0.22, 10, 8), fur, [ax, -r * 0.1, 0]);
      part(ctx, new THREE.SphereGeometry(r * 0.26, 10, 8), fur, [ax * 0.6, -r * 0.8, 0]);
    }
    const snout = mat(ctx, "#f5deb3", { roughness: 0.8 });
    part(ctx, new THREE.SphereGeometry(r * 0.2, 10, 8), snout, [0, r * 0.45, r * 0.38]);
    const dark = mat(ctx, "#1f2937", { roughness: 0.5 });
    part(ctx, new THREE.SphereGeometry(r * 0.07, 8, 6), dark, [-r * 0.16, r * 0.62, r * 0.4]);
    part(ctx, new THREE.SphereGeometry(r * 0.07, 8, 6), dark, [r * 0.16, r * 0.62, r * 0.4]);
  },

  crate: (ctx) => {
    const { r } = ctx;
    part(ctx, new THREE.BoxGeometry(r * 1.7, r * 1.7, r * 1.7), mat(ctx, "#b98a4b", { roughness: 0.85, tint: true }), [0, -r * 0.15, 0]);
    part(ctx, new THREE.BoxGeometry(r * 0.4, r * 0.04, r * 1.72), mat(ctx, "#d6b77e", { roughness: 0.7 }), [0, r * 0.72, 0]);
  },

  basket: (ctx) => {
    const { r } = ctx;
    const wicker = mat(ctx, "#a8712f", { roughness: 0.9, tint: true });
    const wall = part(ctx, new THREE.CylinderGeometry(r * 0.95, r * 0.7, r * 1.4, 20, 1, true), wicker, [0, -r * 0.2, 0]);
    wicker.side = THREE.DoubleSide;
    part(ctx, new THREE.TorusGeometry(r * 0.95, r * 0.09, 8, 20), wicker, [0, r * 0.5, 0], [Math.PI / 2, 0, 0]);
    part(ctx, new THREE.TorusGeometry(r * 0.85, r * 0.07, 8, 20, Math.PI), wicker, [0, r * 0.5, 0], [0, 0, 0]);
    void wall;
  },

  boat: (ctx) => {
    const { r } = ctx;
    part(ctx, new THREE.BoxGeometry(r * 1.8, r * 0.7, r * 0.9), mat(ctx, "#b45309", { roughness: 0.6, tint: true }), [0, -r * 0.5, 0]);
    part(ctx, new THREE.CylinderGeometry(r * 0.05, r * 0.05, r * 1.6, 8), mat(ctx, "#78350f"), [0, r * 0.45, 0]);
    const sailShape = new THREE.Shape();
    sailShape.moveTo(0, 0);
    sailShape.lineTo(0, r * 1.4);
    sailShape.lineTo(r * 0.9, 0);
    sailShape.lineTo(0, 0);
    const sailMat = mat(ctx, "#f1f5f9", { roughness: 0.7 });
    sailMat.side = THREE.DoubleSide;
    part(ctx, new THREE.ShapeGeometry(sailShape), sailMat, [r * 0.05, -r * 0.35, 0]);
  },
};

// ---------------------------------------------------------------------------
// Descriptor vocabulary (mirrors shared/glyph-registry.ts)
// ---------------------------------------------------------------------------

/** Composed-glyph size modifiers → a per-axis scale multiplier. Exaggerated so
 *  the difference reads instantly. Multiple modifiers compose. */
const SIZE_SCALE: Record<string, [number, number, number]> = {
  big: [1.7, 1.7, 1.7],
  small: [0.5, 0.5, 0.5],
  tall_high: [1, 1.8, 1],
  short_low: [1, 0.55, 1],
  length_long: [1.8, 1, 1],
  length_short: [0.55, 1, 1],
  wide: [1, 1, 1.8],
  thin: [1, 1, 0.5],
};

/** Color-modifier key → hex (from the registry's `colorValue`). */
const COLOR_HEX: Record<string, string> = {
  color_red: "#DC2626", color_orange: "#EA580C", color_yellow: "#FACC15",
  color_green: "#16A34A", color_blue: "#2563EB", color_purple: "#9333EA",
  color_pink: "#EC4899", color_brown: "#92400E", color_black: "#111827",
  color_white: "#F3F4F6", color_gray: "#6B7280",
};

const TEMPERATURE = new Set(["hot", "cold"]);

export interface Descriptors {
  scale: [number, number, number];
  colorHex?: string;
  temperature?: "hot" | "cold";
}

/** Read the descriptor modifiers off a composed glyph string
 *  (`head.mod1.mod2…`). Unknown modifiers are ignored. */
export function parseDescriptors(glyph: string | undefined): Descriptors {
  const scale: [number, number, number] = [1, 1, 1];
  let colorHex: string | undefined;
  let temperature: "hot" | "cold" | undefined;
  if (glyph) {
    const mods = glyph.split(".").slice(1);
    for (const m of mods) {
      const s = SIZE_SCALE[m];
      if (s) {
        scale[0] *= s[0];
        scale[1] *= s[1];
        scale[2] *= s[2];
      }
      if (COLOR_HEX[m]) colorHex = COLOR_HEX[m];
      if (TEMPERATURE.has(m)) temperature = m as "hot" | "cold";
    }
  }
  return { scale, colorHex, temperature };
}

// ---------------------------------------------------------------------------
// Temperature particles — a rising warm ember (hot) / drifting cool frost (cold)
// ---------------------------------------------------------------------------

let sharedDot: THREE.DataTexture | null = null;
/** A soft round alpha dot, built once (headless/worker-safe DataTexture). */
function dotTexture(): THREE.DataTexture {
  if (sharedDot) return sharedDot;
  const S = 16;
  const data = new Uint8Array(S * S * 4);
  const c = (S - 1) / 2;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (x - c) / c;
      const dy = (y - c) / c;
      const a = Math.max(0, 1 - Math.hypot(dx, dy));
      const i = (y * S + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(a * a * 255);
    }
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.needsUpdate = true;
  sharedDot = tex;
  return tex;
}

const frac = (x: number): number => x - Math.floor(x);

interface Particles {
  points: THREE.Points;
  update(time: number): void;
  dispose(): void;
}

/** A small particle cloud around an object of radius `r`. Hot embers rise and
 *  converge; cold flecks sink and orbit. Deterministic (seeded by index). */
function makeParticles(kind: "hot" | "cold", r: number): Particles {
  const N = 16;
  const seeds = Array.from({ length: N }, (_, i) => ({
    angle: i * 2.399,
    rad: r * (0.2 + 0.6 * frac(i * 0.618)),
    phase: frac(i * 0.618),
    speed: 0.25 + 0.2 * frac(i * 0.35),
  }));
  const positions = new Float32Array(N * 3);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    size: r * 0.55,
    map: dotTexture(),
    transparent: true,
    depthWrite: false,
    color: new THREE.Color(kind === "hot" ? "#ff7a1a" : "#a5d8ff"),
    blending: kind === "hot" ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  const points = new THREE.Points(geom, material);
  points.renderOrder = 5;

  const update = (time: number): void => {
    for (let i = 0; i < N; i++) {
      const s = seeds[i]!;
      const p = frac(time * s.speed + s.phase);
      let x: number, y: number, z: number;
      if (kind === "hot") {
        y = (-0.2 + 1.6 * p) * r;
        const shrink = 1 - 0.6 * p;
        const a = s.angle + time * 0.6;
        x = Math.cos(a) * s.rad * shrink;
        z = Math.sin(a) * s.rad * shrink;
      } else {
        y = (1.2 - 1.5 * p) * r;
        const a = s.angle + time * 0.8;
        x = Math.cos(a) * s.rad;
        z = Math.sin(a) * s.rad;
      }
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
    }
    geom.attributes.position.needsUpdate = true;
    material.opacity = kind === "hot" ? 0.7 + 0.2 * Math.sin(time * 12) : 0.75;
  };
  update(0);

  return {
    points,
    update,
    dispose: () => {
      geom.dispose();
      material.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Identity → recipe resolution
// ---------------------------------------------------------------------------

const EMOJI_TO_KEY: Record<string, string> = {
  "⚽": "ball", "🏀": "ball", "🎾": "ball", "🏐": "ball", "🎱": "ball", "🔴": "ball",
  "🍎": "apple", "🍏": "apple",
  "🍌": "banana",
  "🍇": "grapes",
  "🍪": "cookie",
  "🚗": "car", "🚙": "car", "🏎": "car",
  "🚂": "train", "🚆": "train", "🚋": "train",
  "🧱": "blocks",
  "🧸": "teddy",
  "📦": "crate",
  "🧺": "basket",
  "⛵": "boat", "🚤": "boat", "🛶": "boat",
};

const SYMBOL_TO_KEY: Record<string, string> = {
  ball: "ball", apple: "apple", banana: "banana", grape: "grapes", cookie: "cookie",
  car: "car", train: "train", blocks: "blocks", teddy: "teddy", box: "crate",
  basket: "basket", boat: "boat",
};

/** Strip emoji variation selectors (U+FE0x), skin-tone modifiers, and ZWJ so a
 *  decorated emoji still matches its plain key. */
function normalizeEmoji(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const variationSelector = cp >= 0xfe00 && cp <= 0xfe0f;
    const skinTone = cp >= 0x1f3fb && cp <= 0x1f3ff;
    const zwj = cp === 0x200d;
    if (!variationSelector && !skinTone && !zwj) out += ch;
  }
  return out.trim();
}

function keyFor(iconRef?: string, glyph?: string): string | undefined {
  if (glyph) {
    const head = glyph.split(".")[0]!.trim().toLowerCase();
    if (SYMBOL_TO_KEY[head]) return SYMBOL_TO_KEY[head];
  }
  if (iconRef) {
    const key = EMOJI_TO_KEY[normalizeEmoji(iconRef)];
    if (key) return key;
  }
  return undefined;
}

/**
 * Build a procedural 3D model for a world object from its identity, or return
 * null if there's no recipe — the FAILSAFE the caller uses to fall back to the
 * generic box/sphere + floating icon.
 */
export function buildObjectModel(opts: {
  iconRef?: string;
  glyph?: string;
  radius: number;
}): ObjectModel | null {
  const key = keyFor(opts.iconRef, opts.glyph);
  if (!key) return null;
  const recipe = RECIPES[key];
  if (!recipe) return null;

  const r = opts.radius;
  const content = new THREE.Group();
  const ctx: Ctx = { r, content, materials: [], tintable: [], tintBase: [], disposables: [] };
  recipe(ctx);

  const object = new THREE.Group();
  object.add(content);

  let particles: Particles | null = null;
  let temperature: "hot" | "cold" | undefined;

  const applyDescriptors = (glyph: string | undefined): void => {
    const d = parseDescriptors(glyph);
    // Size — scale the parts, then lift so the base stays on the ground.
    content.scale.set(d.scale[0], d.scale[1], d.scale[2]);
    content.position.y = r * (d.scale[1] - 1);
    // Color — recolor body materials, or restore their natural color.
    ctx.tintable.forEach((m, i) => {
      if (d.colorHex) m.color.set(d.colorHex);
      else m.color.copy(ctx.tintBase[i]!);
    });
    // Temperature — (re)build the particle effect only when it changes.
    if (d.temperature !== temperature) {
      if (particles) {
        object.remove(particles.points);
        particles.dispose();
        particles = null;
      }
      temperature = d.temperature;
      if (temperature) {
        particles = makeParticles(temperature, r);
        object.add(particles.points);
      }
    }
  };

  applyDescriptors(opts.glyph);

  return {
    object,
    materials: ctx.materials,
    applyDescriptors,
    update: (time) => particles?.update(time),
    dispose: () => {
      if (particles) {
        object.remove(particles.points);
        particles.dispose();
      }
      for (const d of ctx.disposables) d.dispose();
    },
  };
}

/** Whether the engine has a real 3D model for an object of this identity. */
export function hasObjectModel(iconRef?: string, glyph?: string): boolean {
  return keyFor(iconRef, glyph) !== undefined;
}
