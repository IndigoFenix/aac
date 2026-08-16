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

// ── Garment colour palette + outfit index ───────────────────────────────────
// Clothing is a COLOURED ITEM (goods-kinds.ts `CLOTHING_KINDS` = these heads ×
// these colours): a garment glyph carries a `color_*` FACET (`shirt.color_red`),
// and a resident's worn outfit is one point in the bounded product below. The
// colours are the AAC board's discrete `color_*` glyphs (not free hex), so a
// whole town wears at most `OUTFIT_PRESET_COUNT` (= heads × colours) distinct
// outfits — that many bakes, warmed at boot, not hundreds. A culture can narrow
// the palette later (Phase 2); this is the default set.
//
// The index space is HEAD-MAJOR and STABLE: `i = head*colours + colour`. It is
// the integer carried on `AvatarState.wearing` (engine.ts) and reconstructed by
// the render factory via `outfitPresetFor(i)`, so the bijection here is the one
// contract the live change-of-clothes rides. `outfitIndexOf`/`garmentGlyphOf`
// are the two directions quest-host needs to bridge a worn GLYPH to that index.

const presetGarment = (
  kind: GarmentKind,
  color: string,
  accentColor: string,
  over: Partial<GarmentBlueprint> = {},
): GarmentBlueprint => ({ ...defaultGarment(kind), color, accentColor, ...over });

/** The garment HEADS that are both economy kinds (goods-kinds `CLOTHING_HEADS`)
 *  and the coloured "main" garment a body wears. A shirt renders over default
 *  slate pants; a dress renders alone. */
export const GARMENT_WEARABLE_HEADS = ["shirt", "dress"] as const;
export type WearableHead = (typeof GARMENT_WEARABLE_HEADS)[number];

/** The garment colour VOCABULARY — every `color_*` a garment CAN be, so a
 *  glyph of any of these is always a valid, countable, washable clothing kind
 *  (goods-kinds `CLOTHING_KINDS` = heads × these). It is a fixed superset, NOT
 *  the small set a given town wears: a culture's dress `palette` (Phase 2) is a
 *  SUBSET selected from here per session. Order is STABLE — it fixes the
 *  outfit-index space, and the curated default (below) is kept FIRST so the
 *  common colours keep low, warm-at-boot indices. Do not reorder without
 *  rebaking. */
export const GARMENT_COLORS = [
  "color_red", "color_blue", "color_green", "color_yellow", // the curated default, first
  "color_orange", "color_purple", "color_pink", "color_brown", "color_black", "color_white",
] as const;
export type GarmentColorGlyph = (typeof GARMENT_COLORS)[number];

/** A town's ACTIVE dress: the garment heads its residents wear and the colour
 *  palette they wear them in — a per-session SUBSET of the vocabulary above,
 *  set from `game.culture.dress` (Phase 2) or the curated default. This bounds
 *  what residents wear, what stores stock, and what gets baked at boot. */
export interface DressPalette {
  heads: readonly string[];
  colors: readonly string[];
}

/** The curated default a town wears when its world declares no culture dress —
 *  a small, tasteful set (keeps boot bakes ≈ heads × 4). */
export const DEFAULT_DRESS_PALETTE: DressPalette = {
  heads: GARMENT_WEARABLE_HEADS,
  colors: ["color_red", "color_blue", "color_green", "color_yellow"],
};

/** Colour glyph → the fabric + trim hexes the mesh lofts (clothing.ts is the
 *  garment-appearance owner; these are tasteful clothing shades, distinct from
 *  object-models' flat prop tints). Any `color_*` the palette lists must appear
 *  here. */
export const GARMENT_COLOR_HEX: Record<string, { fabric: string; accent: string }> = {
  color_red: { fabric: "#c43b3b", accent: "#7d2626" },
  color_blue: { fabric: "#3f6db4", accent: "#2c3e50" },
  color_green: { fabric: "#5b8a4e", accent: "#3a5c33" },
  color_yellow: { fabric: "#c9a83f", accent: "#8a7226" },
  color_orange: { fabric: "#b4643f", accent: "#7d3f24" },
  color_purple: { fabric: "#6d4a8a", accent: "#47305c" },
  color_pink: { fabric: "#b44a6d", accent: "#7d2c47" },
  color_brown: { fabric: "#6d5a43", accent: "#4a3d2c" },
  color_black: { fabric: "#2e2e33", accent: "#161619" },
  color_white: { fabric: "#e0dcd2", accent: "#b3ab99" },
};

/** Default trousers worn under any coloured shirt (the shirt carries the
 *  colour; the legs stay a neutral slate). */
const DEFAULT_PANTS = () => presetGarment("pants", "#4a4a55", "#2c2c33");

/** Number of distinct outfit presets `outfitPresetFor` can return (heads ×
 *  colours = the boot-bake count). */
export const OUTFIT_PRESET_COUNT = GARMENT_WEARABLE_HEADS.length * GARMENT_COLORS.length;

const wrap = (i: number, n: number): number => ((Math.floor(i) % n) + n) % n;

/** Split an outfit index into its (head, colour glyph). Head-major, stable. */
export function garmentOfIndex(index: number): { head: WearableHead; color: GarmentColorGlyph } {
  const nc = GARMENT_COLORS.length;
  const i = wrap(Number.isFinite(index) ? index : 0, OUTFIT_PRESET_COUNT);
  return { head: GARMENT_WEARABLE_HEADS[Math.floor(i / nc)]!, color: GARMENT_COLORS[i % nc]! };
}

/** The stable index for a (head, colour) — the inverse of `garmentOfIndex`.
 *  Unknown head/colour fall back to the first slot so the caller always gets a
 *  bake that exists. */
export function outfitIndexOf(head: string, colorGlyph: string): number {
  const hi = Math.max(0, GARMENT_WEARABLE_HEADS.indexOf(head as WearableHead));
  const ci = Math.max(0, GARMENT_COLORS.indexOf(colorGlyph as GarmentColorGlyph));
  return hi * GARMENT_COLORS.length + ci;
}

/** The item GLYPH a body at this outfit index wears — `shirt.color_red`. The
 *  worn-record and the doffed `.dirty` unit are built from this, so the laundry
 *  chain sees a colour-bearing key. */
export function garmentGlyphOfIndex(index: number): string {
  const { head, color } = garmentOfIndex(index);
  return `${head}.${color}`;
}

/** Build a valid ACTIVE dress from a culture's declared (kinds, palette): drop
 *  anything outside the garment vocabulary, and fall back to the curated default
 *  for an absent/empty selection. The one place culture dress meets the garment
 *  vocabulary — so an invalid or partial declaration can never yield an outfit
 *  slot that has no bake. */
export function dressPaletteFrom(kinds?: readonly string[], palette?: readonly string[]): DressPalette {
  const heads = (kinds ?? []).filter((h) => (GARMENT_WEARABLE_HEADS as readonly string[]).includes(h));
  const colors = (palette ?? []).filter((c) => (GARMENT_COLORS as readonly string[]).includes(c));
  return {
    heads: heads.length ? heads : DEFAULT_DRESS_PALETTE.heads,
    colors: colors.length ? colors : DEFAULT_DRESS_PALETTE.colors,
  };
}

/** A STABLE outfit index for a body within a town's ACTIVE dress — the culture
 *  palette drives which colours (and heads) residents actually wear, so the
 *  same body picks the same culture-appropriate garment forever. Empty facets
 *  fall back to the vocabulary/curated default so this never returns an invalid
 *  slot. */
export function outfitIndexForDress(hash: number, dress: DressPalette): number {
  const h = Number.isFinite(hash) ? Math.abs(Math.floor(hash)) : 0;
  const heads = dress.heads.length ? dress.heads : GARMENT_WEARABLE_HEADS;
  const colors = dress.colors.length ? dress.colors : DEFAULT_DRESS_PALETTE.colors;
  const head = heads[h % heads.length]!;
  // Divide out the head choice so head and colour vary independently.
  const color = colors[Math.floor(h / heads.length) % colors.length]!;
  return outfitIndexOf(head, color);
}

/** Deterministic preset picker: the SAME index (or hash) returns the SAME
 *  outfit forever. Returns a fresh copy so callers may tweak without corrupting
 *  the shared blueprint. A shirt slot renders the coloured shirt over default
 *  pants; a dress slot renders the coloured dress alone. */
export function outfitPresetFor(index: number): OutfitBlueprint {
  const { head, color } = garmentOfIndex(index);
  const hex = GARMENT_COLOR_HEX[color] ?? GARMENT_COLOR_HEX.color_blue!;
  const main = presetGarment(head, hex.fabric, hex.accent);
  return { garments: head === "shirt" ? [main, DEFAULT_PANTS()] : [main] };
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
