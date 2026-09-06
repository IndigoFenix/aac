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
import { propMaterial, type LitMaterial } from "./materials";
import { appearanceOf, stateFacetsOf, headOf } from "./variations";
import { isDollGlyph } from "./toys";
import { furnitureKindOfGlyph } from "./kernel/town/stations";

export interface ObjectModel {
  /** Root to add to the scene, position, and YAW (carries `userData.pick`). */
  object: THREE.Group;
  /** Every lit material in the model — for emissive highlight + floor-fade. */
  materials: LitMaterial[];
  /** Apply the composed glyph's descriptors (color/size/temperature). Idempotent
   *  — call on creation and again whenever `glyph` changes. */
  applyDescriptors(glyph: string | undefined): void;
  /** Advance any temperature particle effect. No-op when the object has none. */
  update(timeSeconds: number): void;
  /** Drive an opening part (a chest lid, cupboard doors) to frac 0..1.
   *  Absent when the recipe has nothing that opens. */
  setOpen?: (frac: number) => void;
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
  materials: LitMaterial[];
  /** Body materials a color descriptor recolors (wheels/stems/eyes stay fixed). */
  tintable: LitMaterial[];
  /** Each tintable material's original color, to restore when the tint clears. */
  tintBase: THREE.Color[];
  disposables: Array<{ dispose(): void }>;
  /** PER-INSTANCE SHAPE SEED (see `seedOf`). Recipes for things that come in
   *  no fixed form — a boulder — draw their jitter from this instead of
   *  hard-coded numbers, so two of them in one view are two different ones.
   *  0 for a caller that named no instance: a recipe must still build. */
  seed: number;
  /** A recipe with an OPENING part (a chest lid, cupboard doors) registers
   *  its swing here; `setOpen(frac)` on the model drives it, 0..1. */
  setOpen?: (frac: number) => void;
}

/** The per-instance shape seed for an object id — fnv1a, the hash this engine
 *  keys ids with everywhere else. NEVER Math.random(): a model is rebuilt
 *  every time its object streams back into view, and a shape that rerolls on
 *  a rebuild is a rock that changes shape when you look away. Same id ⇒ same
 *  rock, in every session, on every peer. */
function seedOf(id: string | undefined): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < (id?.length ?? 0); i++) {
    h ^= id!.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A tiny deterministic stream off a seed (mulberry32 — the same generator the
 *  wilderness scatter uses, for the same reason). */
function jitter(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mat(
  ctx: Ctx,
  color: THREE.ColorRepresentation,
  opts: { roughness?: number; metalness?: number; tint?: boolean } = {},
): LitMaterial {
  const m = propMaterial(color, { roughness: opts.roughness, metalness: opts.metalness });
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

/** A table's tabletop height, world meters — a realistic ~waist-low
 *  table, decoupled from its (wide) collision footprint. The table
 *  RECIPE builds its top here and render3d's "on"-containment lift rests
 *  items on the same height, so what's on a table sits ON it. */
export const TABLE_TOP_Y = 0.8;

/** A bed's sleeping surface, as a fraction of its footprint radius above the
 *  ground: the bed RECIPE's blanket top sits at local −0.16r with the mesh
 *  lifted by r (base at y = −r), i.e. 0.84r up. render3d rests a SLEEPING
 *  body (AvatarState.activity "sleep") on the same height. */
export const BED_TOP_FRAC = 0.84;

/** A SEAT's sitting surface, per fixture kind, as a fraction of its footprint
 *  radius above the ground — the same contract as BED_TOP_FRAC (every recipe is
 *  drawn with its base at local −r and the mesh lifted by r, so a local height
 *  h reads as (1 + h/r)·r off the floor). render3d rests a SITTING body
 *  (AvatarState.activity "sit") on this height.
 *
 *    chair — seat box centred at 1.05r, half-height 0.15r → top 1.2r → 2.2r
 *            (≈ 0.48 m at the standard r = 0.22: a chair).
 *    toilet — bench seat centred at −0.05r, half-height 0.06r → top 0.01r → 1.01r
 *            (≈ 0.5 m at r = 0.5: a toilet).
 *    bath  — NOT a seat you perch on: the bather settles INSIDE the tub, so the
 *            height is the basin itself. The shell's inner base sits at 0.2r
 *            (its feet) and the water surface at ~1.12r; 0.4r (≈ 0.3 m at
 *            r = 0.75) drops the hips into the water without clipping the base.
 *
 *  A kind ABSENT here has no seat the renderer can resolve (a workbench), so its
 *  body performs the crouch where it stands. */
export const SEAT_TOP_FRAC: Readonly<Record<string, number>> = { chair: 2.2, toilet: 1.01, bath: 0.4 };

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

  // THE PLUSH FIGURE — the stand-in body for a DOLL of something the engine has
  // no model of (world-engine/toys.ts). A doll is a miniature of a real thing, so
  // a doll of a car IS the car recipe wearing the `toy` form facet, which shrinks
  // it; this recipe is what a doll of a CREATURE falls back to, because nothing
  // here can build a rabbit. It reads as a stuffed animal, which is what a rag
  // doll of an animal is. Per-species doll bodies want the baked creature mesh
  // (createBakedCreature) adapted to the ObjectModel contract — see the planning
  // doc's follow-up; until then every animal doll is this plush shape, tinted.
  doll: (ctx) => {
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

  // A PUZZLE: a flat tray of coloured pieces lying on the floor, one piece set
  // proud of the rest so it reads as unfinished rather than as a printed board.
  puzzle: (ctx) => {
    const { r } = ctx;
    const tray = mat(ctx, "#a8a29e", { roughness: 0.9, tint: true });
    part(ctx, new THREE.BoxGeometry(r * 1.7, r * 0.14, r * 1.7), tray, [0, -r * 0.9, 0]);
    // Four quadrant pieces, each a slightly different shade so the grid reads.
    const shades = ["#dc2626", "#2563eb", "#facc15", "#16a34a"];
    const half = r * 0.4;
    const spots: [number, number][] = [[-half, -half], [half, -half], [-half, half], [half, half]];
    spots.forEach(([px, pz], i) => {
      const piece = mat(ctx, shades[i]!, { roughness: 0.6 });
      // The last piece sits lifted and turned — the one still to go in.
      const loose = i === spots.length - 1;
      part(
        ctx,
        new THREE.BoxGeometry(r * 0.74, r * 0.12, r * 0.74),
        piece,
        [px, -r * 0.77 + (loose ? r * 0.16 : 0), pz],
        loose ? [0, 0.5, 0] : undefined,
      );
      // The knob that makes a puzzle piece a puzzle piece.
      part(ctx, new THREE.SphereGeometry(r * 0.12, 8, 6), piece, [px + r * 0.37, -r * 0.77, pz]);
    });
  },

  // ---- FIXTURES: archetypal furniture (chest / cupboard / table). ----
  // Solid in the engine (square footprint of `radius`); lidded ones ease
  // open while someone stands close. Forward (+X) faces INTO the room.

  "fixture:chest": (ctx) => {
    const { r } = ctx;
    const wood = mat(ctx, "#8a6238", { roughness: 0.85, tint: true });
    const band = mat(ctx, "#5b3d22", { roughness: 0.7 });
    // Body: an open-topped box (slightly under the collision half-extent).
    part(ctx, new THREE.BoxGeometry(r * 1.8, r * 1.1, r * 1.8), wood, [0, -r * 0.45, 0]);
    part(ctx, new THREE.BoxGeometry(r * 1.86, r * 0.16, r * 1.86), band, [0, -r * 0.05, 0]);
    // Lid: hinged along the BACK edge (-X side), swings up and back.
    const hinge = new THREE.Group();
    hinge.position.set(-r * 0.9, r * 0.1, 0);
    const lid = new THREE.Mesh(new THREE.BoxGeometry(r * 1.84, r * 0.18, r * 1.84), wood);
    ctx.disposables.push(lid.geometry);
    lid.position.set(r * 0.92, 0, 0); // extends forward from the hinge
    hinge.add(lid);
    ctx.content.add(hinge);
    ctx.setOpen = (frac) => {
      hinge.rotation.z = frac * (Math.PI * 0.55); // up and over the back
    };
  },

  // The FOOD box (goods corner, `food` good). A tall upright cabinet with one
  // front door hinged at its side — the silhouette differs from the chest at a
  // glance, which is the point: the pantry should be findable across the room.
  // Matte enamel only; per the seizure-safety law nothing here goes glossy.
  "fixture:refrigerator": (ctx) => {
    const { r } = ctx;
    const enamel = mat(ctx, "#dfe4e8", { roughness: 0.85, tint: true });
    const trim = mat(ctx, "#9aa5ad", { roughness: 0.8 });
    // Body — a tall box against the wall, front facing +X.
    part(ctx, new THREE.BoxGeometry(r * 1.3, r * 3.0, r * 1.7), enamel, [0, r * 0.5, 0]);
    // Freezer/fridge split line across the front.
    part(ctx, new THREE.BoxGeometry(r * 0.06, r * 0.1, r * 1.72), trim, [r * 0.66, r * 1.15, 0]);
    // Door hinged along the far side (-Z), swinging open toward +X.
    const hinge = new THREE.Group();
    hinge.position.set(r * 0.65, r * 0.5, -r * 0.85);
    const door = new THREE.Mesh(new THREE.BoxGeometry(r * 0.12, r * 2.9, r * 1.66), enamel);
    ctx.disposables.push(door.geometry);
    door.position.set(0, 0, r * 0.83); // extends across the front from the hinge
    hinge.add(door);
    // Handle — a vertical bar on the swinging edge.
    const handle = new THREE.Mesh(new THREE.BoxGeometry(r * 0.1, r * 0.9, r * 0.1), trim);
    ctx.disposables.push(handle.geometry);
    handle.position.set(r * 0.12, r * 0.3, r * 1.5);
    hinge.add(handle);
    ctx.content.add(hinge);
    ctx.setOpen = (frac) => {
      // The leaf extends toward +Z from a hinge on the door's -Z edge, so a
      // POSITIVE yaw swings its free edge toward +X — OUT into the room the
      // fixture faces, the way a real fridge door opens. (A negative yaw
      // swung it toward −X, back through the body into the wall — the
      // "opens the wrong way" bug.)
      hinge.rotation.y = frac * (Math.PI * 0.6);
    };
  },

  "fixture:cupboard": (ctx) => {
    const { r } = ctx;
    const wood = mat(ctx, "#6f4e2f", { roughness: 0.8, tint: true });
    const panel = mat(ctx, "#8a6238", { roughness: 0.75 });
    // Tall body — a wardrobe against the wall (front is +X).
    part(ctx, new THREE.BoxGeometry(r * 1.2, r * 3.2, r * 1.9), wood, [0, r * 0.6, 0]);
    // Two front doors hinged at the outer edges, swinging outward.
    const doorGeom = new THREE.BoxGeometry(r * 0.1, r * 2.8, r * 0.88);
    ctx.disposables.push(doorGeom);
    const mkDoor = (side: 1 | -1): THREE.Group => {
      const hinge = new THREE.Group();
      hinge.position.set(r * 0.62, r * 0.55, side * r * 0.92);
      const leaf = new THREE.Mesh(doorGeom, panel);
      leaf.position.set(0, 0, -side * r * 0.45);
      hinge.add(leaf);
      ctx.content.add(hinge);
      return hinge;
    };
    const left = mkDoor(1);
    const right = mkDoor(-1);
    ctx.setOpen = (frac) => {
      left.rotation.y = frac * (Math.PI * 0.6);
      right.rotation.y = -frac * (Math.PI * 0.6);
    };
  },

  "fixture:table": (ctx) => {
    const { r } = ctx;
    const wood = mat(ctx, "#9a7248", { roughness: 0.8, tint: true });
    const leg = mat(ctx, "#7a5a38", { roughness: 0.8 });
    // A LOW, wide table: the top spans 2.1r but sits at a realistic
    // TABLE_TOP_Y (world) — DECOUPLED from the footprint radius, so a
    // wide table isn't a tall one. The mesh sits at world y = r, so the
    // top's LOCAL height is TABLE_TOP_Y − r. Items placed "on" it rest on
    // this surface (render3d's containment lift keys the same constant).
    const topThick = 0.08;
    const surfaceLocal = TABLE_TOP_Y - r; // local y of the top FACE
    part(ctx, new THREE.BoxGeometry(r * 2.1, topThick, r * 2.1), wood, [0, surfaceLocal - topThick / 2, 0]);
    const legBase = -r; // the ground
    const legTop = surfaceLocal - topThick; // underside of the top
    const legH = Math.max(0.1, legTop - legBase);
    const legGeom = new THREE.BoxGeometry(r * 0.18, legH, r * 0.18);
    ctx.disposables.push(legGeom);
    const legCy = (legBase + legTop) / 2;
    for (const sx of [1, -1]) {
      for (const sz of [1, -1]) {
        part(ctx, legGeom, leg, [sx * r * 0.85, legCy, sz * r * 0.85]);
      }
    }
  },

  // ---- The household STATIONS (bed / chair / box): the furniture
  // Sims-mode needs are satisfied AT. Same conventions as the fixtures
  // above: forward (+X) faces INTO the room, base at y = -r, sized to be
  // readable at dollhouse camera distance. Nothing opens.

  "fixture:bed": (ctx) => {
    const { r } = ctx;
    const wood = mat(ctx, "#8a6238", { roughness: 0.85 });
    const linen = mat(ctx, "#efe9dc", { roughness: 0.9 });
    const blanket = mat(ctx, "#7d92b8", { roughness: 0.9, tint: true });
    // Low platform frame, headboard against the wall (-X — the piece
    // faces into the room, so the wall is behind it).
    part(ctx, new THREE.BoxGeometry(r * 1.95, r * 0.5, r * 1.45), wood, [0, -r * 0.75, 0]);
    part(ctx, new THREE.BoxGeometry(r * 0.12, r * 1.1, r * 1.45), wood, [-r * 0.94, -r * 0.45, 0]);
    // Mattress, blanket over the foot end, pillow at the head.
    part(ctx, new THREE.BoxGeometry(r * 1.8, r * 0.3, r * 1.3), linen, [0, -r * 0.35, 0]);
    part(ctx, new THREE.BoxGeometry(r * 1.15, r * 0.34, r * 1.38), blanket, [r * 0.3, -r * 0.33, 0]);
    part(ctx, new THREE.BoxGeometry(r * 0.42, r * 0.18, r * 0.9), linen, [-r * 0.62, -r * 0.11, 0]);
  },

  "fixture:chair": (ctx) => {
    const { r } = ctx;
    const wood = mat(ctx, "#9a7248", { roughness: 0.8, tint: true });
    const leg = mat(ctx, "#7a5a38", { roughness: 0.8 });
    // Seat at sitting height (~0.45 m at the standard 0.22 m half-extent).
    const seatY = r * 1.05;
    part(ctx, new THREE.BoxGeometry(r * 1.7, r * 0.3, r * 1.7), wood, [0, seatY, 0]);
    const legH = seatY - r * 0.15 + r; // ground to seat underside
    const legGeom = new THREE.BoxGeometry(r * 0.22, legH, r * 0.22);
    ctx.disposables.push(legGeom);
    for (const sx of [1, -1]) {
      for (const sz of [1, -1]) {
        part(ctx, legGeom, leg, [sx * r * 0.65, -r + legH / 2, sz * r * 0.65]);
      }
    }
    // Back rest — the chair FACES the table (+X), so the back is at -X.
    part(ctx, new THREE.BoxGeometry(r * 0.2, r * 2.3, r * 1.7), wood, [-r * 0.75, seatY + r * 1.3, 0]);
  },

  // A plain lidded BOX — the generic personal container (every household member
  // owns one). Deliberately EMPTY: what makes a box a "toy box" is only what
  // happens to be inside it, so nothing is baked into the model. Squarer and
  // plainer than the chest (domed lid + bands) so the two read apart.
  "fixture:box": (ctx) => {
    const { r } = ctx;
    const wood = mat(ctx, "#b98a4b", { roughness: 0.85, tint: true });
    const edge = mat(ctx, "#8a6238", { roughness: 0.8 });
    // Body, with a darker base rim.
    part(ctx, new THREE.BoxGeometry(r * 1.7, r * 1.2, r * 1.7), wood, [0, -r * 0.4, 0]);
    part(ctx, new THREE.BoxGeometry(r * 1.78, r * 0.14, r * 1.78), edge, [0, -r * 0.95, 0]);
    // Flat lid, hinged along the BACK edge (-X — the piece faces into the room).
    const hinge = new THREE.Group();
    hinge.position.set(-r * 0.85, r * 0.22, 0);
    const lid = new THREE.Mesh(new THREE.BoxGeometry(r * 1.74, r * 0.16, r * 1.74), edge);
    ctx.disposables.push(lid.geometry);
    lid.position.set(r * 0.87, 0, 0); // extends forward from the hinge
    hinge.add(lid);
    ctx.content.add(hinge);
    ctx.setOpen = (frac) => {
      hinge.rotation.z = frac * (Math.PI * 0.55); // up and over the back
    };
  },

  // ---- Sims-mode ROUND 2 stations: bath (hygiene) / toilet (waste) /
  // water barrel (thirst) / trash bin / pet bowl. Same conventions.

  "fixture:bath": (ctx) => {
    const { r } = ctx;
    const tub = mat(ctx, "#eae6dc", { roughness: 0.35, tint: true });
    const rim = mat(ctx, "#d3ccbc", { roughness: 0.45 });
    const water = mat(ctx, "#7db8d4", { roughness: 0.12 });
    const chrome = mat(ctx, "#b9c0c8", { roughness: 0.25, metalness: 0.85 });
    // A CLAWFOOT TUB. The old recipe was a slab and four straight walls, which
    // at house scale read as a plain open crate — nothing said "bath". What
    // makes a tub legible is the silhouette: it stands OFF the floor on feet,
    // its shell is rounded, and it carries taps at one end. Built from those.
    const OVAL_Z = 0.62; // squashed across Z — a tub is long, not round
    const FEET_H = r * 0.2;
    const floorY = -r + FEET_H;
    const wallH = r * 0.92;
    const shellY = floorY + wallH / 2;
    const topY = shellY + wallH / 2;
    // Four squat FEET, so the tub stands off the floor instead of sitting on it
    // like a crate.
    const footGeom = new THREE.CylinderGeometry(r * 0.1, r * 0.13, FEET_H, 10);
    for (const [fx, fz] of [[0.62, 0.3], [0.62, -0.3], [-0.62, 0.3], [-0.62, -0.3]] as const) {
      const foot = part(ctx, footGeom.clone(), rim, [r * fx, -r + FEET_H / 2, r * fz]);
      foot.scale.set(1, 1, 1);
    }
    footGeom.dispose();
    // The SHELL — a wide cylinder squashed along Z. The old recipe was a slab
    // and four straight walls, which at house scale read as a plain open crate;
    // a rolled oval body reads as a tub from every angle the camera takes.
    const body = part(ctx, new THREE.CylinderGeometry(r * 0.95, r * 0.78, wallH, 22), tub, [0, shellY, 0]);
    body.scale.set(1, 1, OVAL_Z);
    // WATER inset just proud of the shell's top face, so the surface shows
    // INSIDE the rim rather than the tub reading as a solid lump.
    const surface = part(ctx, new THREE.CylinderGeometry(r * 0.82, r * 0.82, r * 0.06, 22), water, [0, topY + r * 0.01, 0]);
    surface.scale.set(1, 1, OVAL_Z);
    // The rolled RIM — the single clearest "this is a tub" cue.
    const rimMesh = part(ctx, new THREE.TorusGeometry(r * 0.93, r * 0.085, 8, 24), rim, [0, topY, 0], [Math.PI / 2, 0, 0]);
    rimMesh.scale.set(1, OVAL_Z, 1); // pre-rotation Y is the world Z
    // TAPS at the −X end: a riser, a spout arching in over the water, two
    // handles either side of it.
    part(ctx, new THREE.CylinderGeometry(r * 0.05, r * 0.05, r * 0.36, 8), chrome, [-r * 0.86, topY + r * 0.18, 0]);
    part(ctx, new THREE.CylinderGeometry(r * 0.04, r * 0.04, r * 0.26, 8), chrome, [-r * 0.74, topY + r * 0.34, 0], [0, 0, Math.PI / 2]);
    for (const hz of [0.2, -0.2]) {
      part(ctx, new THREE.CylinderGeometry(r * 0.06, r * 0.06, r * 0.05, 8), chrome, [-r * 0.86, topY + r * 0.06, r * hz]);
    }
  },

  "fixture:toilet": (ctx) => {
    const { r } = ctx;
    const wood = mat(ctx, "#8a6238", { roughness: 0.85, tint: true });
    const seat = mat(ctx, "#a88960", { roughness: 0.8 });
    const dark = mat(ctx, "#2b2119", { roughness: 0.9 });
    // An outhouse-style bench seat: box with a dark hole, low back panel.
    part(ctx, new THREE.BoxGeometry(r * 1.5, r * 0.9, r * 1.5), wood, [0, -r * 0.55, 0]);
    part(ctx, new THREE.BoxGeometry(r * 1.55, r * 0.12, r * 1.55), seat, [0, -r * 0.05, 0]);
    part(ctx, new THREE.CylinderGeometry(r * 0.34, r * 0.34, r * 0.06, 16), dark, [r * 0.1, r * 0.03, 0]);
    part(ctx, new THREE.BoxGeometry(r * 0.14, r * 1.4, r * 1.5), wood, [-r * 0.7, r * 0.6, 0]);
  },

  "fixture:barrel": (ctx) => {
    const { r } = ctx;
    const wood = mat(ctx, "#7a5a38", { roughness: 0.85, tint: true });
    const band = mat(ctx, "#4a4a52", { roughness: 0.5, metalness: 0.4 });
    const water = mat(ctx, "#6fb0cf", { roughness: 0.15 });
    // A staved water barrel: bulged cylinder, two iron bands, water disc up top.
    part(ctx, new THREE.CylinderGeometry(r * 0.8, r * 0.8, r * 1.9, 14), wood, [0, -r * 0.05, 0]);
    part(ctx, new THREE.CylinderGeometry(r * 0.86, r * 0.86, r * 0.12, 14), band, [0, r * 0.55, 0]);
    part(ctx, new THREE.CylinderGeometry(r * 0.86, r * 0.86, r * 0.12, 14), band, [0, -r * 0.65, 0]);
    part(ctx, new THREE.CylinderGeometry(r * 0.72, r * 0.72, r * 0.05, 14), water, [0, r * 0.88, 0]);
  },

  "fixture:bin": (ctx) => {
    const { r } = ctx;
    const metal = mat(ctx, "#8a919c", { roughness: 0.45, metalness: 0.5, tint: true });
    const dark = mat(ctx, "#5c636e", { roughness: 0.5, metalness: 0.4 });
    // A lidded trash can; the lid eases up while someone stands close.
    part(ctx, new THREE.CylinderGeometry(r * 0.75, r * 0.62, r * 1.6, 14), metal, [0, -r * 0.2, 0]);
    const hinge = new THREE.Group();
    hinge.position.set(-r * 0.75, r * 0.6, 0);
    const lid = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.82, r * 0.82, r * 0.14, 14), dark);
    ctx.disposables.push(lid.geometry);
    lid.position.set(r * 0.75, 0, 0);
    hinge.add(lid);
    ctx.content.add(hinge);
    part(ctx, new THREE.CylinderGeometry(r * 0.1, r * 0.1, r * 0.16, 8), dark, [0, r * 0.75, 0]);
    ctx.setOpen = (frac) => {
      hinge.rotation.z = frac * (Math.PI * 0.45);
    };
  },

  "fixture:bowl": (ctx) => {
    const { r } = ctx;
    const dish = mat(ctx, "#c0504d", { roughness: 0.5, tint: true });
    const inner = mat(ctx, "#9c3a37", { roughness: 0.6 });
    // The pet's floor dish: squat truncated cone with a darker inside.
    part(ctx, new THREE.CylinderGeometry(r * 0.95, r * 0.7, r * 0.6, 16), dish, [0, -r * 0.7, 0]);
    part(ctx, new THREE.CylinderGeometry(r * 0.8, r * 0.8, r * 0.06, 16), inner, [0, -r * 0.44, 0]);
  },

  "fixture:oven": (ctx) => {
    const { r } = ctx;
    const iron = mat(ctx, "#3c3a38", { roughness: 0.6, metalness: 0.35, tint: true });
    const top = mat(ctx, "#26241f", { roughness: 0.5, metalness: 0.4 });
    const brass = mat(ctx, "#a8834a", { roughness: 0.45, metalness: 0.5 });
    const ember = mat(ctx, "#ff7a1a", { roughness: 0.3 });
    ember.emissive = new THREE.Color("#c94f10");
    ember.emissiveIntensity = 0.9;
    // A squat cast-iron cook oven: body on stubby feet, a dark cooktop
    // with two burner rings, a brass-latched fire door with an ember glow.
    part(ctx, new THREE.BoxGeometry(r * 1.8, r * 1.2, r * 1.5), iron, [0, -r * 0.3, 0]);
    part(ctx, new THREE.BoxGeometry(r * 1.9, r * 0.14, r * 1.6), top, [0, r * 0.35, 0]);
    part(ctx, new THREE.CylinderGeometry(r * 0.34, r * 0.34, r * 0.05, 14), iron, [-r * 0.42, r * 0.44, 0]);
    part(ctx, new THREE.CylinderGeometry(r * 0.26, r * 0.26, r * 0.05, 14), iron, [r * 0.42, r * 0.44, 0]);
    // The fire door on the FRONT (+x — `facing` turns it into the room).
    part(ctx, new THREE.BoxGeometry(r * 0.08, r * 0.6, r * 0.7), top, [r * 0.92, -r * 0.35, 0]);
    part(ctx, new THREE.BoxGeometry(r * 0.06, r * 0.3, r * 0.4), ember, [r * 0.95, -r * 0.35, 0]);
    part(ctx, new THREE.CylinderGeometry(r * 0.05, r * 0.05, r * 0.25, 8), brass, [r * 0.97, -r * 0.1, r * 0.42], [0, 0, Math.PI / 2]);
    // Feet + a flue elbow rising at the back.
    for (const [fx, fz] of [[-0.75, -0.6], [-0.75, 0.6], [0.75, -0.6], [0.75, 0.6]] as const) {
      part(ctx, new THREE.CylinderGeometry(r * 0.09, r * 0.12, r * 0.35, 8), top, [r * fx, -r * 1.05, r * fz]);
    }
    part(ctx, new THREE.CylinderGeometry(r * 0.16, r * 0.16, r * 1.1, 10), iron, [-r * 0.65, r * 0.9, -r * 0.45]);
  },

  "fixture:workbench": (ctx) => {
    const { r } = ctx;
    // The carpenter's bench (construction v1): a heavy slab on trestle
    // legs, a vice block at one end, tools resting on the top.
    const slabWood = mat(ctx, "#8f6a3e", { roughness: 0.85, tint: true });
    const legWood = mat(ctx, "#6b4d2b", { roughness: 0.85 });
    const iron = mat(ctx, "#4b4a48", { roughness: 0.55, metalness: 0.3 });
    const slabTop = r * 0.55;
    part(ctx, new THREE.BoxGeometry(r * 1.9, r * 0.22, r * 1.3), slabWood, [0, slabTop, 0]);
    for (const [sx, sz] of [[-0.7, -0.45], [-0.7, 0.45], [0.7, -0.45], [0.7, 0.45]] as const) {
      part(ctx, new THREE.BoxGeometry(r * 0.18, r * (1 + 0.55), r * 0.18), legWood, [r * sx, (slabTop - r) / 2, r * sz]);
    }
    // A low stretcher shelf with stacked offcuts.
    part(ctx, new THREE.BoxGeometry(r * 1.5, r * 0.08, r * 0.9), legWood, [0, -r * 0.45, 0]);
    part(ctx, new THREE.BoxGeometry(r * 1.0, r * 0.18, r * 0.35), slabWood, [-r * 0.1, -r * 0.32, 0]);
    // The vice block on the +x end, a mallet + saw resting on the top.
    part(ctx, new THREE.BoxGeometry(r * 0.32, r * 0.3, r * 0.5), iron, [r * 0.85, slabTop + r * 0.22, -r * 0.3]);
    part(ctx, new THREE.CylinderGeometry(r * 0.07, r * 0.07, r * 0.55, 8), legWood, [-r * 0.35, slabTop + r * 0.16, r * 0.25], [0, 0, Math.PI / 2]);
    part(ctx, new THREE.BoxGeometry(r * 0.2, r * 0.22, r * 0.2), slabWood, [-r * 0.05, slabTop + r * 0.18, r * 0.25]);
    part(ctx, new THREE.BoxGeometry(r * 0.7, r * 0.04, r * 0.16), iron, [r * 0.25, slabTop + r * 0.14, -r * 0.05]);
  },

  // ── THE PLACE-MAKING FIXTURES ─────────────────────────────────────────
  // The four stations that make a room a forge / shrine / weaving room /
  // study (stations.ts). No emissive fire on any of them: a forge's glow and
  // an altar's candles are exactly the bright-moving-highlight class we keep
  // out of a child's field of view, and none of these pieces needs light to
  // read as itself. The oven's static ember is the one existing exception and
  // it stays the exception.

  "fixture:anvil": (ctx) => {
    const { r } = ctx;
    // A smith's anvil on its stump: the classic waisted body with the horn
    // reaching out over the FRONT (+x), set on a sawn log.
    const iron = mat(ctx, "#3a3936", { roughness: 0.5, metalness: 0.45 });
    const face = mat(ctx, "#55534e", { roughness: 0.35, metalness: 0.5 });
    const log = mat(ctx, "#6b4d2b", { roughness: 0.9, tint: true });
    const stumpTop = -r * 0.15;
    // The stump — a squat log with a couple of tools leaning on it.
    part(ctx, new THREE.CylinderGeometry(r * 0.62, r * 0.7, r * 1.5, 14), log, [0, -r * 0.9, 0]);
    // The anvil: waisted base, narrow throat, broad face.
    part(ctx, new THREE.BoxGeometry(r * 0.95, r * 0.18, r * 0.8), iron, [0, stumpTop + r * 0.09, 0]);
    part(ctx, new THREE.BoxGeometry(r * 0.5, r * 0.28, r * 0.45), iron, [0, stumpTop + r * 0.32, 0]);
    part(ctx, new THREE.BoxGeometry(r * 1.25, r * 0.22, r * 0.62), face, [0, stumpTop + r * 0.57, 0]);
    // The HORN, tapering forward off the face; the square heel behind it.
    part(ctx, new THREE.ConeGeometry(r * 0.28, r * 0.6, 12), face,
      [r * 0.88, stumpTop + r * 0.57, 0], [0, 0, -Math.PI / 2]);
    part(ctx, new THREE.BoxGeometry(r * 0.2, r * 0.2, r * 0.5), face, [-r * 0.7, stumpTop + r * 0.57, 0]);
    // A hammer resting on the face and a pair of tongs hung off the stump.
    part(ctx, new THREE.CylinderGeometry(r * 0.05, r * 0.05, r * 0.5, 8), log,
      [-r * 0.1, stumpTop + r * 0.7, r * 0.18], [Math.PI / 2, 0, 0]);
    part(ctx, new THREE.BoxGeometry(r * 0.14, r * 0.14, r * 0.3), iron, [-r * 0.1, stumpTop + r * 0.72, -r * 0.1]);
    part(ctx, new THREE.BoxGeometry(r * 0.06, r * 0.9, r * 0.05), iron, [-r * 0.55, -r * 0.6, r * 0.5], [0.2, 0, 0.25]);
  },

  "fixture:altar": (ctx) => {
    const { r } = ctx;
    // A stone altar table: a plinth, a broad slab, a runner of cloth over it,
    // and two unlit candles. Deliberately UNMARKED by any tradition — no
    // symbol is carved on it, because the world's cultures are authored, and a
    // shrine's meaning belongs to the people who gather at it, not the mesh.
    const stone = mat(ctx, "#a9a49a", { roughness: 0.85 });
    const shadowStone = mat(ctx, "#8d887e", { roughness: 0.9 });
    const cloth = mat(ctx, "#9c3f4a", { roughness: 0.95, tint: true });
    const wax = mat(ctx, "#e8e0cc", { roughness: 0.8 });
    const top = r * 0.5;
    part(ctx, new THREE.BoxGeometry(r * 0.9, r * 1.4, r * 1.3), shadowStone, [0, -r * 0.25, 0]);
    part(ctx, new THREE.BoxGeometry(r * 1.5, r * 0.18, r * 1.8), stone, [0, top, 0]);
    part(ctx, new THREE.BoxGeometry(r * 1.1, r * 0.26, r * 1.9), stone, [0, -r * 0.95, 0]);
    // The cloth runner hanging over the FRONT edge (+x).
    part(ctx, new THREE.BoxGeometry(r * 0.7, r * 0.03, r * 1.5), cloth, [r * 0.3, top + r * 0.11, 0]);
    part(ctx, new THREE.BoxGeometry(r * 0.03, r * 0.55, r * 1.5), cloth, [r * 0.74, top - r * 0.16, 0]);
    // Two candle stubs at the back corners — wax only, never a flame.
    for (const cz of [-0.55, 0.55] as const) {
      part(ctx, new THREE.CylinderGeometry(r * 0.09, r * 0.1, r * 0.45, 10), wax,
        [-r * 0.4, top + r * 0.32, r * cz]);
    }
  },

  "fixture:loom": (ctx) => {
    const { r } = ctx;
    // An upright warp-weighted loom: two posts, a top beam, the warp running
    // down it, and finished cloth rolled at the bottom. Faces +x (the weaver
    // stands at the front and works the shed).
    const frame = mat(ctx, "#7a5a34", { roughness: 0.85, tint: true });
    const beam = mat(ctx, "#5f451f", { roughness: 0.85 });
    const warp = mat(ctx, "#d8cba9", { roughness: 0.95 });
    const web = mat(ctx, "#b3765a", { roughness: 0.95, tint: true });
    for (const pz of [-0.8, 0.8] as const) {
      part(ctx, new THREE.BoxGeometry(r * 0.18, r * 2.6, r * 0.18), frame, [0, r * 0.3, r * pz]);
      part(ctx, new THREE.BoxGeometry(r * 0.7, r * 0.14, r * 0.14), frame, [r * 0.25, -r * 0.95, r * pz]);
    }
    part(ctx, new THREE.CylinderGeometry(r * 0.12, r * 0.12, r * 1.8, 10), beam,
      [0, r * 1.55, 0], [Math.PI / 2, 0, 0]);
    part(ctx, new THREE.CylinderGeometry(r * 0.1, r * 0.1, r * 1.7, 10), beam,
      [0, r * 0.15, 0], [Math.PI / 2, 0, 0]);
    // The warp threads — a few representative strands, not a full sley.
    for (const tz of [-0.62, -0.32, 0, 0.32, 0.62] as const) {
      part(ctx, new THREE.BoxGeometry(r * 0.03, r * 1.3, r * 0.03), warp, [0, r * 0.85, r * tz]);
    }
    // The woven web growing at the bottom, and its roll.
    part(ctx, new THREE.BoxGeometry(r * 0.06, r * 0.7, r * 1.5), web, [0, -r * 0.3, 0]);
    part(ctx, new THREE.CylinderGeometry(r * 0.19, r * 0.19, r * 1.5, 12), web,
      [0, -r * 0.78, 0], [Math.PI / 2, 0, 0]);
  },

  "fixture:shelf": (ctx) => {
    const { r } = ctx;
    // Open shelving against a wall (front +x): uprights, three boards, and a
    // row of books and boxes standing on them. The OPEN case is the point —
    // this is the container you can read the contents of at a glance, which is
    // what makes it a library's fixture and a market's display both.
    const wood = mat(ctx, "#7d5a35", { roughness: 0.85, tint: true });
    const board = mat(ctx, "#96703f", { roughness: 0.8 });
    const back = mat(ctx, "#5d4426", { roughness: 0.9 });
    const bookMats = [
      mat(ctx, "#7a3b3b", { roughness: 0.9 }),
      mat(ctx, "#39566b", { roughness: 0.9 }),
      mat(ctx, "#5c6b39", { roughness: 0.9 }),
      mat(ctx, "#6b5539", { roughness: 0.9 }),
    ];
    for (const sz of [-0.92, 0.92] as const) {
      part(ctx, new THREE.BoxGeometry(r * 0.6, r * 2.8, r * 0.16), wood, [0, r * 0.4, r * sz]);
    }
    part(ctx, new THREE.BoxGeometry(r * 0.08, r * 2.8, r * 1.85), back, [-r * 0.3, r * 0.4, 0]);
    const levels = [-0.85, 0.05, 0.95, 1.75] as const;
    for (const ly of levels) {
      part(ctx, new THREE.BoxGeometry(r * 0.6, r * 0.09, r * 1.85), board, [0, r * ly, 0]);
    }
    // Books leaning on the lower two shelves; a box on the top one.
    let pick = 0;
    for (const ly of [levels[0], levels[1]] as const) {
      for (let i = 0; i < 5; i++) {
        const h = 0.45 + ((i * 7) % 3) * 0.08;
        part(ctx, new THREE.BoxGeometry(r * 0.36, r * h, r * 0.12), bookMats[pick++ % bookMats.length]!,
          [r * 0.02, r * (ly + 0.045 + h / 2), r * (-0.66 + i * 0.33)]);
      }
    }
    part(ctx, new THREE.BoxGeometry(r * 0.42, r * 0.4, r * 0.5), wood, [0, r * (levels[2] + 0.25), -r * 0.4]);
  },

  "fixture:stonecutter": (ctx) => {
    const { r } = ctx;
    // The mason's bench (construction phase 5): a thick dressed slab on a squat
    // block base, a rough stone waiting on one end and a cut block stacked at
    // the other, with the chisel and mallet lying along the near edge. Faces +x
    // — a mason works ACROSS the slab from the front, which is the same reach
    // contract the anvil earns (STATION_PROPERTIES: furniture + appliance).
    //
    // All matte, all stone: the same #9a968f the `material_stone` facet paints
    // (variations.ts), so a stonecutter and the block it cuts read as the same
    // substance. Nothing here is polished — a shiny slab under an orbiting
    // camera is a moving highlight, and that is the one thing we never ship.
    const slab = mat(ctx, "#9a968f", { roughness: 0.95, tint: true });
    const base = mat(ctx, "#7f7b74", { roughness: 0.95 });
    const rough = mat(ctx, "#8b877f", { roughness: 1 });
    const iron = mat(ctx, "#4b4a48", { roughness: 0.6, metalness: 0.25 });
    const haft = mat(ctx, "#6b4d2b", { roughness: 0.9 });
    const slabTop = r * 0.45;
    // The base — two piers with a gap, so the bench reads as masonry rather
    // than as a solid crate.
    for (const bx of [-0.62, 0.62] as const) {
      part(ctx, new THREE.BoxGeometry(r * 0.5, r * 1.35, r * 1.2), base, [r * bx, -r * 0.35, 0]);
    }
    // The working slab, and a shallower ledge under its front lip.
    part(ctx, new THREE.BoxGeometry(r * 2, r * 0.34, r * 1.35), slab, [0, slabTop, 0]);
    part(ctx, new THREE.BoxGeometry(r * 1.7, r * 0.12, r * 1.1), base, [0, slabTop - r * 0.23, 0]);
    // The work in progress: a rough lump at the -x end (uncut), a squared
    // block at the +x end (dressed) — the transform, stated in geometry.
    const lump = part(ctx, new THREE.IcosahedronGeometry(r * 0.36, 0), rough,
      [-r * 0.62, slabTop + r * 0.34, r * 0.1], [0.4, 0.7, -0.3]);
    lump.scale.set(1, 0.75, 0.9);
    part(ctx, new THREE.BoxGeometry(r * 0.42, r * 0.34, r * 0.42), slab,
      [r * 0.66, slabTop + r * 0.34, -r * 0.05]);
    // Chisel + mallet resting on the near (+z) edge, where a hand finds them.
    part(ctx, new THREE.CylinderGeometry(r * 0.05, r * 0.03, r * 0.42, 8), iron,
      [0, slabTop + r * 0.2, r * 0.5], [0, 0, Math.PI / 2]);
    part(ctx, new THREE.CylinderGeometry(r * 0.05, r * 0.05, r * 0.4, 8), haft,
      [-r * 0.25, slabTop + r * 0.22, r * 0.24], [Math.PI / 2, 0, 0]);
    part(ctx, new THREE.CylinderGeometry(r * 0.13, r * 0.13, r * 0.26, 10), haft,
      [-r * 0.25, slabTop + r * 0.22, r * 0.5], [0, 0, Math.PI / 2]);
  },

  "fixture:door": (ctx) => {
    const { r } = ctx;
    // A ledged plank door, OFF ITS HINGES. This is the model you see while the
    // leaf is being carried to its opening or stacked in a store — a HUNG leaf
    // is drawn by render3d's door branch as part of its wall run, never as an
    // object, so this recipe only ever shows the furniture half of
    // construction-structures.md's law.
    //
    // Thin along +x (the recipe's forward, so a carried door is held edge-on
    // the way a real one has to be), tall in y, wide in z.
    const plank = mat(ctx, "#8a6238", { roughness: 0.9, tint: true });
    const ledge = mat(ctx, "#6b4d2b", { roughness: 0.9 });
    const iron = mat(ctx, "#4b4a48", { roughness: 0.6, metalness: 0.25 });
    // Five boards with a hairline between them — the leaf is BOARDS, which is
    // what makes it read as a door rather than as a panel of wall.
    for (let i = 0; i < 5; i++) {
      part(ctx, new THREE.BoxGeometry(r * 0.14, r * 2, r * 0.4), plank, [0, 0, r * (-0.88 + i * 0.44)]);
    }
    // The ledges holding the boards together, on the BACK face (-x).
    for (const ly of [-0.78, 0, 0.78] as const) {
      part(ctx, new THREE.BoxGeometry(r * 0.07, r * 0.22, r * 2.1), ledge, [-r * 0.1, r * ly, 0]);
    }
    // Two strap hinges down the hinge edge (-z), a ring pull on the other.
    for (const hy of [-0.62, 0.62] as const) {
      part(ctx, new THREE.BoxGeometry(r * 0.05, r * 0.16, r * 0.8), iron, [r * 0.09, r * hy, -r * 0.7]);
    }
    part(ctx, new THREE.TorusGeometry(r * 0.14, r * 0.035, 6, 14), iron,
      [r * 0.1, r * 0.05, r * 0.72], [0, Math.PI / 2, 0]);
  },

  rock: (ctx) => {
    const { r } = ctx;
    // A BOULDER — the wild mineral outcrop stone is quarried out of
    // (products.ts `feature: { icon: "🪨" }`), which until this recipe existed
    // rendered as a wooden treasure chest, because the spawner forced
    // `fixture: "chest"` and a fixture short-circuits icon resolution.
    //
    // SEVERAL rotated, unevenly scaled lumps rather than one sphere: the
    // silhouette is the entire job here. A smooth ball reads as a ball, and an
    // outcrop has to read as broken ground at a glance, from any angle, with no
    // icon floating over it. Low-poly icosahedra give flat facets that catch
    // the light as PLANES — which is also what keeps it honest as stone.
    //
    // Matte, and it must STAY matte: colour, roughness and metalness are the
    // `material_stone` facet's own (variations.ts — #9a968f, 0.95, 0). A glossy
    // rock in sunlight is a bright highlight sliding across the screen every
    // time the camera orbits, which is the one class of thing this project
    // keeps out of a child's field of view.
    // NO TWO ROCKS ALIKE: every number below is drawn from the instance seed
    // (ctx.seed — the object's own id, hashed), because a scatter of identical
    // boulders reads as a repeated prop, which is worse than a box. Seeded and
    // not random: the same outcrop rebuilds into the same outcrop forever.
    const rnd = jitter(ctx.seed);
    const span = (lo: number, hi: number): number => lo + rnd() * (hi - lo);
    const stone = mat(ctx, "#9a968f", { roughness: 0.95, tint: true });
    const shaded = mat(ctx, "#807c76", { roughness: 0.95 });
    // One lump: a low-poly ball, unevenly squashed and turned. `tilt` bounds
    // the lean off vertical — the CORE keeps a small one so its squash stays a
    // squash (a freely tumbled ellipsoid points its long axis anywhere, which
    // both un-flattens the boulder and sinks it through the floor, since the
    // library's contract is a base at exactly -radius); the small lumps tumble
    // freely, which is what makes the broken ground look broken.
    const lump = (
      m: LitMaterial,
      tilt: number,
      p: [number, number, number],
      s: [number, number, number],
    ): void => {
      const mesh = part(ctx, new THREE.IcosahedronGeometry(r, 0), m, p, [
        span(-tilt, tilt),
        span(-Math.PI, Math.PI), // yaw is free for every lump — it costs nothing
        span(-tilt, tilt),
      ]);
      mesh.scale.set(s[0], s[1], s[2]);
    };
    // THE MASS — one squat core, sunk so the boulder is wider than it is tall.
    // It carries the tint, so a coloured rock still reads as ONE rock.
    lump(
      stone,
      0.1,
      [span(-0.08, 0.08) * r, -r * 0.22, span(-0.08, 0.08) * r],
      [span(0.92, 1.06), span(0.58, 0.74), span(0.88, 1.02)],
    );
    // BROKEN GROUND — 3–5 smaller lumps ringed round the base on an even split
    // of the circle, each bearing nudged off true. An even split guarantees the
    // silhouette is broken from EVERY camera angle (a random ring leaves bald
    // sides); the nudge is what stops the ring reading as machined. They sit
    // low enough to bite slightly into the ground: an outcrop comes OUT of the
    // earth, it is not set down on it.
    const n = 3 + Math.floor(rnd() * 3);
    const turn = span(0, Math.PI * 2);
    for (let i = 0; i < n; i++) {
      const a = turn + (i / n) * Math.PI * 2 + span(-0.35, 0.35);
      const d = span(0.34, 0.52) * r;
      const k = span(0.34, 0.5);
      lump(
        i % 2 ? shaded : stone,
        Math.PI,
        [Math.cos(a) * d, -r * span(0.38, 0.48), Math.sin(a) * d],
        [k, k * span(0.72, 1), k * span(0.86, 1.08)],
      );
    }
    // THE SHOULDER — one off-centre lump riding the top. This is the piece
    // that makes the whole thing asymmetric in profile, which is the entire
    // difference between "a rock" and "a lumpy sphere".
    lump(
      stone,
      Math.PI,
      [span(-0.3, 0.3) * r, r * span(0.12, 0.26), span(-0.3, 0.3) * r],
      [span(0.36, 0.52), span(0.34, 0.48), span(0.38, 0.52)],
    );
    // GROUND IT. The library's contract is a base at -r (the renderer lifts an
    // object by its radius), and no amount of arithmetic on the jitter bounds
    // can promise that: a tumbled ellipsoid's vertical reach depends on which
    // facet the roll pointed down. So measure the cluster and drop it onto the
    // line — one box per BUILD, never per frame. It lands a hair BELOW the
    // line on purpose: an outcrop comes out of the earth, it is not set down
    // on it. Shifting the children (not `content`, whose y the descriptor pass
    // owns) keeps the size descriptors working untouched.
    const shell = new THREE.Box3().setFromObject(ctx.content);
    const drop = -r * 1.04 - shell.min.y;
    for (const child of ctx.content.children) child.position.y += drop;
  },

  block: (ctx) => {
    const { r } = ctx;
    // THE CONSTRUCTION BLOCK (phase 6) — the one primitive every building is
    // made of, as a thing you can hold. It had no recipe: the `block` head fell
    // through to the 🧱 emoji, which mapped to `blocks`, the TOY — so a mason's
    // dressed stone was three little red, green and blue cubes.
    //
    // A SQUARED UNIT, proportioned to BLOCK_SIZE_M (block-bill.ts — 0.8 × 0.4 ×
    // 0.4, roughly 2:1:1): long enough along the recipe's forward (+X) that a
    // carried block reads as a beam or an ashlar held across the body, not a
    // parcel. Deliberately ONE unit and not a stack — a stack of six blocks and
    // a stack of one are the same `ObjectSpec`, so a drawn stack would lie
    // about the count; the unit says "block", the number is the bubble's job.
    //
    // Matte and untextured, tinted by the `material_*` facet the stack carries
    // (`block.material_wood` → timber, `block.material_stone` → grey ashlar —
    // variations.ts owns both palettes). Nothing specular: this is an object a
    // builder carries at head height across the whole screen, which is the
    // worst possible place for a sliding highlight.
    const body = mat(ctx, "#8a6238", { roughness: 0.9, tint: true });
    const L = r * 1.6;
    const H = r * 0.8;
    const W = r * 0.8;
    // Base on the library's -1.04r line, like every grounded prop.
    const cy = -r * 1.04 + H / 2;
    part(ctx, new THREE.BoxGeometry(L, H, W), body, [0, cy, 0]);
    // THE DRESSED FACE: a shallow chamfer along the top edges, as two thin
    // slabs inset from the block's own footprint. Enough to catch the diffuse
    // light differently from the body and read as a WORKED face — the one
    // thing that separates a building block from a cardboard box.
    const edge = mat(ctx, "#6f4e2c", { roughness: 0.95 });
    part(ctx, new THREE.BoxGeometry(L * 0.94, H * 0.1, W * 0.62), edge, [0, cy + H * 0.5, 0]);
    part(ctx, new THREE.BoxGeometry(L * 0.08, H * 0.62, W * 0.9), edge, [-L * 0.5, cy, 0]);
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

  /** THE WORN CONTAINER (scope-unification ②) — the basket's sibling: a body
   *  carries a basket in its hands and WEARS a satchel, which is the whole
   *  difference between the two and the reason both exist. A flap bag with a
   *  shoulder strap, so it reads as worn even lying on the ground. */
  satchel: (ctx) => {
    const { r } = ctx;
    const leather = mat(ctx, "#8a5a2b", { roughness: 0.85, tint: true });
    const dark = mat(ctx, "#5c3a1a", { roughness: 0.85 });
    const brass = mat(ctx, "#c9a227", { roughness: 0.4, metalness: 0.7 });
    // Body — the bag itself, sitting on its base.
    part(ctx, new THREE.BoxGeometry(r * 1.5, r * 1.05, r * 0.62), leather, [0, -r * 0.4, 0]);
    // Flap over the front, hanging a little past the seam.
    part(ctx, new THREE.BoxGeometry(r * 1.56, r * 0.55, r * 0.1), dark, [0, r * 0.1, r * 0.33]);
    part(ctx, new THREE.BoxGeometry(r * 1.56, r * 0.12, r * 0.66), dark, [0, r * 0.14, 0]);
    // Buckle.
    part(ctx, new THREE.BoxGeometry(r * 0.22, r * 0.18, r * 0.06), brass, [0, -r * 0.14, r * 0.36]);
    // Shoulder strap — a half hoop standing up out of the body.
    part(
      ctx,
      new THREE.TorusGeometry(r * 0.62, r * 0.07, 6, 16, Math.PI),
      dark,
      [0, r * 0.12, 0],
      [0, 0, 0],
    );
  },

  /** THE HAND CART (user, 2026-09-05) — the third portable container and the
   *  only one a body can make. A plank BED with a low rim, two spoked wheels on
   *  a visible axle and two long handles reaching forward: read as a thing you
   *  PUSH, in one silhouette, at prop scale. Wood is the tintable body (it is
   *  cut from blocks); the ironwork and tyres stay their own colour, the same
   *  convention the car's wheels keep. Forward is +X, so the handles lead. */
  cart: (ctx) => {
    const { r } = ctx;
    const wood = mat(ctx, "#a9762f", { roughness: 0.85, tint: true });
    const iron = mat(ctx, "#3f3f46", { roughness: 0.6, metalness: 0.4 });
    const tyre = mat(ctx, "#27221c", { roughness: 0.8 });
    // The bed — a shallow open box: floor, two sides, a tail and a head board.
    part(ctx, new THREE.BoxGeometry(r * 1.5, r * 0.12, r * 1.0), wood, [-r * 0.1, -r * 0.05, 0]);
    part(ctx, new THREE.BoxGeometry(r * 1.5, r * 0.42, r * 0.09), wood, [-r * 0.1, r * 0.2, r * 0.46]);
    part(ctx, new THREE.BoxGeometry(r * 1.5, r * 0.42, r * 0.09), wood, [-r * 0.1, r * 0.2, -r * 0.46]);
    part(ctx, new THREE.BoxGeometry(r * 0.09, r * 0.42, r * 1.0), wood, [-r * 0.82, r * 0.2, 0]);
    part(ctx, new THREE.BoxGeometry(r * 0.09, r * 0.3, r * 1.0), wood, [r * 0.62, r * 0.14, 0]);
    // The axle, straight through under the bed, and the two wheels on it.
    part(ctx, new THREE.CylinderGeometry(r * 0.06, r * 0.06, r * 1.3, 8), iron, [-r * 0.15, -r * 0.34, 0], [Math.PI / 2, 0, 0]);
    for (const wz of [-r * 0.6, r * 0.6]) {
      part(ctx, new THREE.CylinderGeometry(r * 0.46, r * 0.46, r * 0.11, 16), tyre, [-r * 0.15, -r * 0.34, wz], [Math.PI / 2, 0, 0]);
      part(ctx, new THREE.TorusGeometry(r * 0.3, r * 0.045, 6, 12), wood, [-r * 0.15, -r * 0.34, wz]);
      // Two crossed spokes read as a wheel without a wheel's worth of triangles.
      part(ctx, new THREE.BoxGeometry(r * 0.62, r * 0.05, r * 0.05), wood, [-r * 0.15, -r * 0.34, wz]);
      part(ctx, new THREE.BoxGeometry(r * 0.05, r * 0.62, r * 0.05), wood, [-r * 0.15, -r * 0.34, wz]);
    }
    // Two handles, angled up out of the bed towards whoever is pushing.
    for (const hz of [-r * 0.38, r * 0.38]) {
      part(ctx, new THREE.BoxGeometry(r * 0.95, r * 0.08, r * 0.08), wood, [r * 1.05, r * 0.12, hz], [0, 0, 0.22]);
      part(ctx, new THREE.CylinderGeometry(r * 0.07, r * 0.07, r * 0.22, 8), iron, [r * 1.48, r * 0.22, hz], [Math.PI / 2, 0, 0]);
    }
    // A single leg at the head, so a parked cart stands level instead of tipping.
    part(ctx, new THREE.BoxGeometry(r * 0.09, r * 0.55, r * 0.09), wood, [-r * 0.78, -r * 0.38, 0]);
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

export interface Descriptors {
  scale: [number, number, number];
  colorHex?: string;
  /** PBR from a `material_*` facet (variations.ts material dimension). */
  roughness?: number;
  metalness?: number;
  temperature?: "hot" | "cold";
}

/** Read the descriptor modifiers off a composed glyph string
 *  (`head.mod1.mod2…`). Size/colour/material come from the canonical variation
 *  appearance (variations.ts `appearanceOf` — one palette, no local tables);
 *  temperature is a STATE facet (hot/cold) read separately for the particle
 *  effect. Unknown modifiers are ignored. */
export function parseDescriptors(glyph: string | undefined): Descriptors {
  const a = appearanceOf(glyph);
  const temp = stateFacetsOf(glyph ?? "").find((s) => s === "hot" || s === "cold") as
    | "hot"
    | "cold"
    | undefined;
  return {
    scale: a.scale,
    colorHex: a.hex,
    roughness: a.roughness,
    metalness: a.metalness,
    temperature: temp,
  };
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
  // 🧱 IS A BUILDING BRICK, not a toy set (phase 6). It pointed at `blocks`,
  // the nursery cubes, which is what made every construction block in the
  // world render as three coloured toys. The toy keeps its own route — its
  // glyph head is `blocks` (plural), matched by SYMBOL_TO_KEY below, which
  // `keyFor` consults BEFORE any icon — so nothing about the toy changes.
  "🧱": "block",
  // The wild outcrop's icon (products.ts `stone` source). Without this row the
  // 🪨 never resolved to anything and the feature fell back to whatever the
  // spawner had forced on it.
  "🪨": "rock",
  "🧸": "doll", "🪆": "doll",
  "🧩": "puzzle",
  "📦": "crate",
  "🧺": "basket",
  // The worn container. 🎒 stands in for the satchel until it has artwork of
  // its own — a placeholder for the ICON, never for the model: the recipe is a
  // real satchel, so it reads as one in the world whatever the board shows.
  "🎒": "satchel", "👜": "satchel",
  // The hand cart. Unicode has no barrow, so 🛒 (a shopping trolley) is the
  // closest there is — a stand-in for the ICON only: the recipe below builds a
  // real plank-and-wheels cart, exactly as 🎒 stands in over a real satchel.
  "🛒": "cart",
  "⛵": "boat", "🚤": "boat", "🛶": "boat",
};

const SYMBOL_TO_KEY: Record<string, string> = {
  ball: "ball", apple: "apple", banana: "banana", grape: "grapes", cookie: "cookie",
  car: "car", train: "train", blocks: "blocks", box: "crate",
  // The CONSTRUCTION block (phase 6) — singular, and a different object from
  // the plural toy `blocks` above it. Listed so the stack head resolves
  // directly, without ever depending on the icon.
  block: "block",
  basket: "basket", satchel: "satchel", cart: "cart", boat: "boat",
  // `teddy` is gone as a WORD (a teddy bear is `bear.toy` now); the plush body it
  // named lives on as the generic `doll` recipe, which the bare word also uses.
  doll: "doll", puzzle: "puzzle",
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
    // AN UNPLACED PIECE OF FURNITURE IS STILL A CHAIR. `furn.chair` is a stack
    // glyph whose HEAD is the bookkeeping prefix `furn`, so head lookup finds
    // nothing and the piece rendered as a bare sphere — the "furniture isn't
    // rendering as its model" bug. It has always had a recipe; it just wasn't
    // being asked for. Checked FIRST because `furn` must never reach the head
    // path. (The archetype is the same one the standing fixture uses, so a
    // carried chair and an installed chair look like the same object.)
    const furnKind = furnitureKindOfGlyph(headOf(glyph) === "furn" ? glyph : "");
    if (furnKind && RECIPES[`fixture:${furnKind}`]) return `fixture:${furnKind}`;
    const head = headOf(glyph).trim().toLowerCase();
    // THE HEAD'S OWN RECIPE WINS, which is the whole point of the doll design: a
    // toy car is the CAR model, and the `toy` form facet's scale (variations.ts)
    // shrinks it — one recipe serves the real thing and its miniature.
    if (SYMBOL_TO_KEY[head]) return SYMBOL_TO_KEY[head];
  }
  if (iconRef) {
    const key = EMOJI_TO_KEY[normalizeEmoji(iconRef)];
    if (key) return key;
  }
  // A DOLL of something with no model of its own is still a doll, never a bare
  // sphere wearing an emoji: fall back to the plush figure. Checked LAST so it
  // can only ever add a model where there wasn't one.
  if (glyph && isDollGlyph(glyph)) return "doll";
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
  /** A FIXTURE (furniture) renders its archetype regardless of icon. */
  fixture?: string;
  radius: number;
  /** THE OBJECT'S OWN ID, for recipes whose form varies per instance (the
   *  boulder). Hashed to a seed — same id, same shape, every rebuild. Omit
   *  and every instance of such a recipe is the same one. */
  id?: string;
}): ObjectModel | null {
  const key = opts.fixture ? `fixture:${opts.fixture}` : keyFor(opts.iconRef, opts.glyph);
  if (!key) return null;
  const recipe = RECIPES[key];
  if (!recipe) return null;

  const r = opts.radius;
  const content = new THREE.Group();
  const ctx: Ctx = {
    r,
    content,
    materials: [],
    tintable: [],
    tintBase: [],
    disposables: [],
    seed: seedOf(opts.id),
  };
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
    // Color/material — recolor body materials (a `material_*` facet also sets
    // PBR roughness/metalness), or restore their natural color.
    ctx.tintable.forEach((m, i) => {
      if (d.colorHex) m.color.set(d.colorHex);
      else m.color.copy(ctx.tintBase[i]!);
      if (d.roughness !== undefined && "roughness" in m) (m as THREE.MeshStandardMaterial).roughness = d.roughness;
      if (d.metalness !== undefined && "metalness" in m) (m as THREE.MeshStandardMaterial).metalness = d.metalness;
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
    setOpen: ctx.setOpen,
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

/**
 * WHICH RECIPE this identity resolves to — the same choice `buildObjectModel`
 * makes, without building anything. Undefined = no recipe (the icon failsafe).
 *
 * A renderer keys its live mesh on this to notice that an object has become a
 * DIFFERENT KIND OF THING under a live id (a mirror prop converting to a
 * carryable one, a stack unit that turns out to be furniture). Deliberately the
 * KEY and not the glyph: `apple.cold` → `apple.hot` is the same recipe wearing
 * different descriptors, and re-applying those is far cheaper than a rebuild.
 */
export function objectModelKey(opts: {
  iconRef?: string;
  glyph?: string;
  fixture?: string;
}): string | undefined {
  return opts.fixture ? `fixture:${opts.fixture}` : keyFor(opts.iconRef, opts.glyph);
}
