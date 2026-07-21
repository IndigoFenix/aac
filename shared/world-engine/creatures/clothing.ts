// Clothing — garments as DATA over the creature's own anatomy.
//
// A garment never names a species or a limb ROLE (the blueprint doctrine: every
// limb is a leg, role EMERGES). It names BODY REGIONS: a span of the spine
// (rear 0 → front 1) plus partial coverage of whatever limbs happen to ROOT
// inside that span. So the same shirt puts sleeves on a human's arms, a bird's
// wings, or a quadruped's forelegs; pants dress the rear span and its limbs; a
// dress is a bodice plus a skirt cone hung from its hem; a hat sits on the
// skull landmarks (and is simply skipped on the headless). Designed mainly for
// the human, flexible for everything.
//
// The MESH side (mesh.ts `buildCreatureMesh`) re-emits the covered body rings
// slightly inflated with fabric colors — the garment is lofted over the SAME
// bones as the skin, so it follows every gait/pose for free, dynamic or baked,
// and the whole dressed creature stays ONE draw call.
//
// This module is the THREE-free DATA layer: types, ranges (the lab's sliders),
// clamp (the same lenient contract clampBlueprint gives every section).

import type { FieldRange } from "./blueprint";

export type GarmentKind = "shirt" | "pants" | "dress" | "hat";
export const GARMENT_KINDS: readonly GarmentKind[] = ["shirt", "pants", "dress", "hat"];

export interface GarmentBlueprint {
  kind: GarmentKind;
  /** Main fabric color (hex). */
  color: string;
  /** Trim color — collar / waistband / cuffs / hatband. */
  accentColor: string;
  /**
   * How much body the garment covers, 0..1 — kind-interpreted:
   *   shirt/dress: spine span from the FRONT end backward (0.4 = chest-crop,
   *                0.7 = hip-length);
   *   pants:       spine span from the REAR end forward (the rise);
   *   hat:         crown height as a fraction of skull radius.
   */
  coverage: number;
  /**
   * Coverage of the limbs rooted in the garment's span, 0..1 of limb length —
   * sleeves (shirt/dress), pant legs (pants). Unused by hats.
   */
  limbCoverage: number;
  /**
   * Looseness / spread, 0..1 — kind-interpreted: dress skirt flare; hat brim
   * width; shirt hem + cuff looseness; pants cuff width.
   */
  flare: number;
  /** Dress only: skirt drop, 0..1 of the hem-to-ground distance. */
  skirtLength: number;
}

export interface OutfitBlueprint {
  garments: GarmentBlueprint[];
}

/** Garments one outfit can stack (shirt+pants+hat is 3; dress+hat is 2). */
export const MAX_GARMENTS = 4;

/** Slider ranges — the single source clamp enforces and the lab renders. */
export const GARMENT_RANGES: Record<"coverage" | "limbCoverage" | "flare" | "skirtLength", FieldRange> = {
  coverage: { min: 0.1, max: 1 },
  limbCoverage: { min: 0, max: 1 },
  flare: { min: 0, max: 1 },
  skirtLength: { min: 0.1, max: 1 },
};

/** Sensible starting points per kind — what the lab's "add" button drops in. */
export function defaultGarment(kind: GarmentKind): GarmentBlueprint {
  switch (kind) {
    case "shirt":
      return { kind, color: "#3f6db4", accentColor: "#2c3e50", coverage: 0.55, limbCoverage: 0.45, flare: 0.25, skirtLength: 0.1 };
    case "pants":
      return { kind, color: "#4a4a55", accentColor: "#2c2c33", coverage: 0.45, limbCoverage: 0.85, flare: 0.15, skirtLength: 0.1 };
    case "dress":
      return { kind, color: "#b44a6d", accentColor: "#7d2c47", coverage: 0.5, limbCoverage: 0.25, flare: 0.6, skirtLength: 0.6 };
    case "hat":
      return { kind, color: "#8a6d3f", accentColor: "#5c4726", coverage: 0.5, limbCoverage: 0, flare: 0.5, skirtLength: 0.1 };
  }
}

// ── Outfit presets ──────────────────────────────────────────────────────────
// A small tasteful wardrobe for town residents: shirt+pants combos in varied
// colors, a couple of dresses, two hats. Deterministic — `outfitPresetFor`
// maps ANY integer hash to the same preset forever, so a resident keeps their
// clothes across sessions, and a whole town wears at most OUTFIT_PRESET_COUNT
// distinct outfits (= that many bakes, not hundreds).

const presetGarment = (
  kind: GarmentKind,
  color: string,
  accentColor: string,
  over: Partial<GarmentBlueprint> = {},
): GarmentBlueprint => ({ ...defaultGarment(kind), color, accentColor, ...over });

const OUTFIT_PRESETS: ReadonlyArray<OutfitBlueprint> = [
  // 0: the default blues — blue shirt, slate pants.
  { garments: [presetGarment("shirt", "#3f6db4", "#2c3e50"), presetGarment("pants", "#4a4a55", "#2c2c33")] },
  // 1: sage shirt, brown pants.
  { garments: [presetGarment("shirt", "#5b8a4e", "#3a5c33"), presetGarment("pants", "#6d5a43", "#4a3d2c")] },
  // 2: terracotta shirt, navy pants, straw hat.
  { garments: [presetGarment("shirt", "#b4643f", "#7d3f24"), presetGarment("pants", "#39465e", "#242e40"), presetGarment("hat", "#c9b06a", "#8a7442")] },
  // 3: mustard shirt, olive pants.
  { garments: [presetGarment("shirt", "#c9a83f", "#8a7226"), presetGarment("pants", "#55603f", "#39422a")] },
  // 4: rose dress.
  { garments: [presetGarment("dress", "#b44a6d", "#7d2c47")] },
  // 5: plum dress, cream sun hat.
  { garments: [presetGarment("dress", "#6d4a8a", "#47305c"), presetGarment("hat", "#e0d7c4", "#b3a488")] },
];

/** Number of distinct outfit presets `outfitPresetFor` can return. */
export const OUTFIT_PRESET_COUNT = OUTFIT_PRESETS.length;

/** Deterministic preset picker: the SAME hash returns the SAME outfit,
 *  forever (any integer, negative fine). Returns a fresh copy so callers may
 *  tweak colors without corrupting the shared preset. */
export function outfitPresetFor(hash: number): OutfitBlueprint {
  const n = OUTFIT_PRESETS.length;
  const h = Number.isFinite(hash) ? Math.floor(hash) : 0;
  const preset = OUTFIT_PRESETS[((h % n) + n) % n];
  return { garments: preset.garments.map((g) => ({ ...g })) };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const clampNum = (v: unknown, r: FieldRange, fallback: number): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return Math.min(r.max, Math.max(r.min, n));
};

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const clampColor = (v: unknown, fallback: string): string =>
  typeof v === "string" && HEX_RE.test(v) ? v : fallback;

/** Lenient per-garment clamp — the clampBlueprint contract: any shape in,
 *  a valid garment out (unknown kind falls back to a shirt). */
export function clampGarment(value: unknown): GarmentBlueprint {
  const g = isRecord(value) ? value : {};
  const kind = GARMENT_KINDS.includes(g.kind as GarmentKind) ? (g.kind as GarmentKind) : "shirt";
  const d = defaultGarment(kind);
  return {
    kind,
    color: clampColor(g.color, d.color),
    accentColor: clampColor(g.accentColor, d.accentColor),
    coverage: clampNum(g.coverage, GARMENT_RANGES.coverage, d.coverage),
    limbCoverage: clampNum(g.limbCoverage, GARMENT_RANGES.limbCoverage, d.limbCoverage),
    flare: clampNum(g.flare, GARMENT_RANGES.flare, d.flare),
    skirtLength: clampNum(g.skirtLength, GARMENT_RANGES.skirtLength, d.skirtLength),
  };
}

/** Clamp a whole outfit; undefined/absent stays undefined (a bare creature —
 *  older stored blueprints keep working byte-for-byte). */
export function clampOutfit(value: unknown): OutfitBlueprint | undefined {
  if (!isRecord(value)) return undefined;
  const list = Array.isArray(value.garments) ? value.garments.slice(0, MAX_GARMENTS) : [];
  return { garments: list.map(clampGarment) };
}
