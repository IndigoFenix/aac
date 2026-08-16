// shared/numeral-glyph.ts
//
// Pure, framework-agnostic generator for the constructed NUMERAL glyph — the
// world-engine's way of drawing an exact quantity so a child reads it as a
// count first and grows into digits. It replaces the old "1/2/many dots".
//
// The system (see the design mockup it was ported from):
//   • a stroke is 1, a hand is 5, a spoked wheel is 10;
//   • every ring around a mark multiplies it by ten (hand+ring = 50, +2 = 500,
//     +3 = 5000; wheel+ring = 100, +2 = 1000);
//   • counting stays loose up to 100 (ones fold into their own space at 20);
//   • at 100 it turns positional — hundreds / tens / ones each take a column;
//   • inside a column a lone mark is full and extra marks shrink to fit, and
//     each column is CAPPED so it can never draw larger than the one to its
//     left (a lone ten beside two hundreds shrinks to match them);
//   • a place that lands on zero keeps its column as a held slot;
//   • at 10,000 it hands over to plain digits.
//
// Server-safe: NO React, NO DOM. Emits low-level shapes (lines, stroked rings,
// filled dots, digit text) in a natural viewBox; the caller (the React
// compositor, or any SVG-string builder) scales that box into its target rect.

export const NUMERAL_MAX = 99999;

export type NumeralShape =
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number; w: number }
  | { kind: "ring"; cx: number; cy: number; r: number; w: number; faint?: boolean } // stroke-only circle
  | { kind: "dot"; cx: number; cy: number; r: number } // filled circle
  | { kind: "text"; x: number; y: number; size: number; text: string }; // digit fallback

export interface NumeralGlyph {
  /** Shapes in a coordinate box anchored top-left at (0,0). */
  shapes: NumeralShape[];
  /** Natural width / height of the box (arbitrary units; caller scales). */
  width: number;
  height: number;
}

export interface NumeralOptions {
  /** Reserve a small trailing column with the arabic digits alongside the marks. */
  showDigit?: boolean;
}

/** True for a bare non-negative integer key in range (`"0".."99999"`). */
export function isNumeralKey(key: string): boolean {
  return /^\d{1,5}$/.test(key.trim());
}

/** Parse a numeral key/count token; null when it isn't a whole number in range. */
export function parseNumeralValue(key: string): number | null {
  const t = key.trim();
  if (!/^\d{1,5}$/.test(t)) return null;
  const n = parseInt(t, 10);
  return Number.isFinite(n) && n >= 0 && n <= NUMERAL_MAX ? n : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Base marks — each returns shapes in its own local coordinates.
// ─────────────────────────────────────────────────────────────────────────────

function shLine(cx: number, cy: number, h: number): NumeralShape[] {
  const w = Math.max(2.4, h * 0.13);
  return [{ kind: "line", x1: cx, y1: cy - h / 2, x2: cx, y2: cy + h / 2, w }];
}

function shWheel(cx: number, cy: number, R: number): NumeralShape[] {
  // ten spokes at 36° — "four above, four below, one on each side"
  const w = Math.max(1.8, R * 0.2);
  const out: NumeralShape[] = [];
  for (let i = 0; i < 10; i++) {
    const a = (i * 36 * Math.PI) / 180;
    out.push({ kind: "line", x1: cx, y1: cy, x2: cx + Math.cos(a) * R, y2: cy + Math.sin(a) * R, w });
  }
  out.push({ kind: "dot", cx, cy, r: Math.max(1.5, R * 0.16) });
  return out;
}

function shHand(cx: number, baseY: number, s: number): NumeralShape[] {
  const angs = [40, 20, 0, -20, -40];
  const Ls = [0.6, 0.76, 0.86, 0.76, 0.6];
  const w = Math.max(2.2, s * 0.12);
  const out: NumeralShape[] = [{ kind: "dot", cx, cy: baseY, r: s * 0.15 }]; // palm
  for (let i = 0; i < 5; i++) {
    const r = (angs[i] * Math.PI) / 180;
    const L = Ls[i] * s;
    out.push({ kind: "line", x1: cx, y1: baseY, x2: cx + Math.sin(r) * L, y2: baseY - Math.cos(r) * L, w });
  }
  return out;
}

function ring(cx: number, cy: number, r: number, w: number): NumeralShape {
  return { kind: "ring", cx, cy, r, w };
}

/** A hand ringed `rings` times — 0 = five, 1 = fifty, 2 = five-hundred, 3 = five-thousand. */
function ringHand(cx: number, cy: number, R: number, rings: number): NumeralShape[] {
  const w = Math.max(1.9, R * 0.095);
  const out: NumeralShape[] = [];
  for (let i = 0; i < rings; i++) out.push(ring(cx, cy, R * (1 - i * 0.24), w));
  const inner = rings > 0 ? R * (1 - (rings - 1) * 0.24) : R;
  const handS = inner * (rings > 0 ? 1.5 : 1.75);
  const baseY = cy + inner * (rings > 0 ? 0.52 : 0.6);
  return out.concat(shHand(cx, baseY, handS));
}

/** A wheel ringed `rings` times — 0 = ten, 1 = hundred, 2 = thousand. */
function ringWheel(cx: number, cy: number, R: number, rings: number): NumeralShape[] {
  const w = Math.max(1.9, R * 0.095);
  const out: NumeralShape[] = [];
  for (let i = 0; i < rings; i++) out.push(ring(cx, cy, R * (1 - i * 0.24), w));
  const inner = rings > 0 ? R * (1 - (rings - 1) * 0.24) : R;
  const Rw = rings > 0 ? inner * 0.66 : R * 0.98;
  return out.concat(shWheel(cx, cy, Rw));
}

// place → how many rings its unit-marks / hand carry
const FIVE_RINGS: Record<Place, number> = { ones: 0, tens: 1, hundreds: 2, thousands: 3 };
const UNIT_RINGS: Record<Place, number> = { ones: 0, tens: 0, hundreds: 1, thousands: 2 };

type Place = "ones" | "tens" | "hundreds" | "thousands";

// ─────────────────────────────────────────────────────────────────────────────
// Positional cells (60 × 82) — count-shrink within a column, capped left→right.
// ─────────────────────────────────────────────────────────────────────────────

const CELL_R = 25; // radius of a full (scale 1.0) folded wheel-mark
const NAT: Record<number, number> = { 1: 1.0, 2: 0.58, 3: 0.5, 4: 0.46 };
function natScale(d: number): number {
  return d >= 1 && d <= 4 ? NAT[d] : 1.0; // a hand (5–9) is a full unit
}
const MARK_POS: Record<number, Array<[number, number]>> = {
  1: [[30, 43]],
  2: [[16, 44], [44, 44]],
  3: [[18, 33], [42, 33], [30, 59]], // two up, one down
  4: [[19, 34], [41, 34], [19, 60], [41, 60]], // 2×2 square
};

function cellMarks(d: number, place: Place, s: number): NumeralShape[] {
  if (place === "ones") {
    const xs = { 1: [30], 2: [20, 40], 3: [16, 30, 44], 4: [13, 25, 37, 49] }[d as 1 | 2 | 3 | 4];
    const h = 40 + 16 * s;
    return xs.flatMap((x) => shLine(x, 44, h));
  }
  const rings = UNIT_RINGS[place];
  const R = CELL_R * s;
  return MARK_POS[d].flatMap(([cx, cy]) => ringWheel(cx, cy, R, rings));
}

function cellLower(d: number, place: Place): NumeralShape[] {
  const xs = { 1: [30], 2: [23, 37], 3: [19, 30, 41], 4: [15, 25, 35, 45] }[d as 1 | 2 | 3 | 4];
  if (place === "ones") return xs.flatMap((x) => shLine(x, 66, 17));
  const rings = UNIT_RINGS[place];
  return xs.flatMap((x) => ringWheel(x, 64, 7, rings));
}

function emptyCellShapes(): NumeralShape[] {
  return [ring(30, 52, 7, 2)]; // faint held slot; caller dims it
}

function digitCellShapes(d: number, place: Place, s: number): NumeralShape[] {
  if (d === 0) return emptyCellShapes();
  if (d >= 1 && d <= 4) return cellMarks(d, place, s);
  if (d === 5) return ringHand(30, 44, CELL_R * s, FIVE_RINGS[place]);
  return ringHand(30, 34, 18 * s, FIVE_RINGS[place]).concat(cellLower(d - 5, place)); // 6–9
}

// ─────────────────────────────────────────────────────────────────────────────
// Column model — a sub-glyph with its own viewBox and a height multiplier,
// laid out left→right and bottom-aligned (mirrors the mockup's flex row).
// ─────────────────────────────────────────────────────────────────────────────

interface Sub {
  shapes: NumeralShape[];
  vbW: number;
  vbH: number;
  hMul: number; // target height = BASE_H * hMul
  faint?: boolean; // held zero slot — rendered dimmed by the caller (marked via a tag shape)
}

const BASE_H = 92;
const GAP = 7;

const subLine = (): Sub => ({ shapes: shLine(10, 42, 56), vbW: 20, vbH: 72, hMul: 0.8 });
const subHand = (): Sub => ({ shapes: shHand(30, 64, 56), vbW: 60, vbH: 74, hMul: 0.82 });
const subWheel = (): Sub => ({ shapes: shWheel(30, 31, 25), vbW: 60, vbH: 62, hMul: 1.0 });
const subFifty = (): Sub => ({ shapes: ringHand(33, 33, 27, 1), vbW: 66, vbH: 66, hMul: 1.14 });
const subCell = (d: number, place: Place, s: number): Sub => ({
  shapes: digitCellShapes(d, place, s),
  vbW: 60,
  vbH: 82,
  hMul: 1.18,
  faint: d === 0,
});

/** Compose a run of positional columns high→low, capping each place by the one on its left. */
function positional(cols: Array<{ d: number; place: Place }>): Sub[] {
  let cap = 1.0;
  const out: Sub[] = [];
  for (const { d, place } of cols) {
    if (d === 0) {
      out.push(subCell(0, place, 1));
      continue; // a zero holds its slot; cap unchanged
    }
    const s = Math.min(natScale(d), cap);
    out.push(subCell(d, place, s));
    cap = Math.min(cap, s); // hands (natScale 1) leave the cap as-is
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage selection.
// ─────────────────────────────────────────────────────────────────────────────

function stageA(n: number): Sub[] {
  // 1..19 — additive count
  const w = Math.floor(n / 10);
  const o = n % 10;
  const out: Sub[] = [];
  for (let i = 0; i < w; i++) out.push(subWheel());
  if (o >= 5) out.push(subHand());
  const ex = o >= 5 ? o - 5 : o;
  for (let i = 0; i < ex; i++) out.push(subLine());
  return out;
}

function stageB(n: number): Sub[] {
  // 20..99 — ones folded; tens stay full-size
  const f = Math.floor(n / 50);
  const tt = Math.floor((n % 50) / 10);
  const o = n % 10;
  const out: Sub[] = [];
  if (f) out.push(subFifty());
  for (let i = 0; i < tt; i++) out.push(subWheel());
  if (o > 0) out.push(subCell(o, "ones", natScale(o)));
  return out;
}

function stageC(n: number): Sub[] {
  return positional([
    { d: Math.floor(n / 100), place: "hundreds" },
    { d: Math.floor((n % 100) / 10), place: "tens" },
    { d: n % 10, place: "ones" },
  ]);
}

function stageD(n: number): Sub[] {
  return positional([
    { d: Math.floor(n / 1000), place: "thousands" },
    { d: Math.floor((n % 1000) / 100), place: "hundreds" },
    { d: Math.floor((n % 100) / 10), place: "tens" },
    { d: n % 10, place: "ones" },
  ]);
}

function subDigits(n: number): Sub {
  const text = String(n);
  return {
    shapes: [{ kind: "text", x: (text.length * 40) / 2, y: 58, size: 62, text }],
    vbW: text.length * 40,
    vbH: 82,
    hMul: 1.16,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Compose the chosen columns into one coordinate box.
// ─────────────────────────────────────────────────────────────────────────────

function compose(subs: Sub[]): NumeralGlyph {
  if (subs.length === 0) return { shapes: [], width: 0, height: 0 };
  const laid = subs.map((sub) => {
    const targetH = BASE_H * sub.hMul;
    const scale = targetH / sub.vbH;
    return { sub, scale, w: sub.vbW * scale, h: targetH };
  });
  const height = Math.max(...laid.map((l) => l.h));
  let x = 0;
  const shapes: NumeralShape[] = [];
  for (const { sub, scale, w, h } of laid) {
    const dy = height - h; // bottom-align
    for (const sh of sub.shapes) shapes.push(placeShape(sh, scale, x, dy, sub.faint));
    x += w + GAP;
  }
  return { shapes, width: Math.max(0, x - GAP), height };
}

function placeShape(sh: NumeralShape, k: number, dx: number, dy: number, faint?: boolean): NumeralShape {
  switch (sh.kind) {
    case "line":
      return { kind: "line", x1: sh.x1 * k + dx, y1: sh.y1 * k + dy, x2: sh.x2 * k + dx, y2: sh.y2 * k + dy, w: sh.w * k };
    case "ring":
      return { kind: "ring", cx: sh.cx * k + dx, cy: sh.cy * k + dy, r: sh.r * k, w: sh.w * k, faint: faint || sh.faint };
    case "dot":
      return { kind: "dot", cx: sh.cx * k + dx, cy: sh.cy * k + dy, r: sh.r * k };
    case "text":
      return { kind: "text", x: sh.x * k + dx, y: sh.y * k + dy, size: sh.size * k, text: sh.text };
  }
}

/**
 * Build the numeral glyph for `n`. Values are clamped to 0..99999; 0 yields an
 * empty glyph. At/above 10,000 the marks give way to plain digits.
 */
export function buildNumeralGlyph(n: number, opts: NumeralOptions = {}): NumeralGlyph {
  n = Math.max(0, Math.min(NUMERAL_MAX, Math.floor(n)));
  if (n === 0) return { shapes: [], width: 0, height: 0 };

  let subs: Sub[];
  if (n >= 10000) subs = [subDigits(n)];
  else if (n <= 19) subs = stageA(n);
  else if (n <= 99) subs = stageB(n);
  else if (n <= 999) subs = stageC(n);
  else subs = stageD(n);

  if (opts.showDigit && n < 10000) subs = subs.concat(subDigits(n));
  return compose(subs);
}
