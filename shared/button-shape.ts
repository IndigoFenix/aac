// shared/button-shape.ts
//
// The board button's OUTLINE, as an SVG path.
//
// WHY A PATH AND NOT CSS. Buttons need a concave bite taken out of each corner,
// so that where four of them meet the empty space reads as one clean circle —
// a place a student can rest their gaze without selecting anything. CSS can
// round a corner outward but not inward, and painting a disc of background
// colour over the corners (the first attempt) leaves each button's own border
// stopping dead at the disc's edge: it reads as a sticker laid on top of the
// buttons rather than a hole through them. Drawing the surface as a path makes
// the border follow the cut, because the border IS the path's stroke.
//
// THE GEOMETRY. Every cut arc is centred on the GRID VERTEX, not on the
// button's own corner — that is, offset outward by half the grid gap in both
// axes. That is the whole trick: all four buttons around a vertex cut against
// the SAME circle, so their four bites plus the gutter cross compose exactly
// one disc. Centring each arc on its own button's corner would give four
// discs at four different points, and their union is a blob, not a circle.
//
//        ─────┐   ┌─────      the arc's centre is here, in the gutter,
//             │   │           shared by all four buttons
//          ───╯ ● ╰───
//          ───╮   ╭───
//             │   │
//        ─────┘   └─────

export interface CornerCutGeometry {
  /** Button box size, px. */
  w: number;
  h: number;
  /** Radius of the shared cut circle, px. */
  radius: number;
  /** Half the grid gap: how far outside the button corner the circle sits. */
  offset: number;
  /**
   * Corners to leave SQUARE — the cut is skipped there and the path turns a
   * right angle instead.
   *
   * The one caller is a corner carrying a GLYPH MARK badge (the `?`, the `!`,
   * the request arc, the tense arrow). Those have to sit at the button's true
   * corner to read as corner marks at all, and the interior is already cramped,
   * so the badge takes the corner and the bite gives way.
   *
   * ⚠️ This DOES break the vertex circle: the empty disc at a grid vertex is
   * composed from the four bites around it, so a skipped corner leaves that
   * disc a quadrant short. That is a deliberate trade (user call, 2026-08-24) —
   * enough of the circle survives to park a gaze on, and badges only ever take
   * TOP corners, so a vertex loses at most half. Do not skip corners for
   * anything less than a badge.
   */
  skip?: CornerSkip;
}

/** Which corners are left square. Omitted / all-false = the usual four bites. */
export interface CornerSkip {
  topLeft?: boolean;
  topRight?: boolean;
  bottomRight?: boolean;
  bottomLeft?: boolean;
}

/** Stop the four cuts from meeting in the middle of a small button. */
function clampRadius(g: CornerCutGeometry): number {
  const half = Math.min(g.w, g.h) / 2;
  // `inset` grows with radius, so solve for the radius whose inset is `half`.
  // inset = sqrt(r² - o²) - o  →  r = sqrt((inset + o)² + o²)
  const maxRadius = Math.sqrt((half + g.offset) ** 2 + g.offset ** 2);
  return Math.max(0, Math.min(g.radius, maxRadius));
}

/**
 * How far along each edge from the corner the cut reaches — where the arc
 * meets the button's straight edge. Zero when the circle is too small to
 * reach past the gutter at all.
 */
export function cornerInset(radius: number, offset: number): number {
  if (radius <= offset) return 0;
  return Math.max(0, Math.sqrt(radius * radius - offset * offset) - offset);
}

/**
 * The button surface as an SVG path, drawn clockwise from the top-left.
 * Concave corners sweep the opposite way from convex ones, hence sweep-flag 0.
 */
export function cornerCutPath(geom: CornerCutGeometry): string {
  const { w, h, offset, skip } = geom;
  const r = clampRadius(geom);
  const a = cornerInset(r, offset);

  // Degenerate: nothing to cut, so a plain rectangle.
  if (a <= 0 || r <= 0) return `M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z`;

  const f = (n: number) => Number(n.toFixed(2));
  // Each corner is either an arc sweeping the bite (concave, sweep-flag 0) or
  // a straight right angle through the corner point itself.
  const arc = (x: number, y: number) => `A ${f(r)} ${f(r)} 0 0 0 ${f(x)} ${f(y)}`;
  const square = (x: number, y: number) => `L ${f(x)} ${f(y)}`;
  const tl = skip?.topLeft, tr = skip?.topRight, br = skip?.bottomRight, bl = skip?.bottomLeft;

  return [
    `M ${f(tl ? 0 : a)} 0`,
    square(tr ? w : w - a, 0),
    tr ? square(w, 0) : arc(w, a),
    square(w, br ? h : h - a),
    br ? square(w, h) : arc(w - a, h),
    square(bl ? 0 : a, h),
    bl ? square(0, h) : arc(0, h - a),
    square(0, tl ? 0 : a),
    tl ? square(0, 0) : arc(a, 0),
    "Z",
  ].join(" ");
}

/**
 * The ordinary rounded rectangle, for buttons with no corner space. Same path
 * machinery so both shapes stroke identically — a button that switches between
 * them must not also change how its border is drawn.
 */
export function roundedRectPath(w: number, h: number, radius: number): string {
  const r = Math.max(0, Math.min(radius, Math.min(w, h) / 2));
  const f = (n: number) => Number(n.toFixed(2));
  if (r <= 0) return `M 0 0 L ${f(w)} 0 L ${f(w)} ${f(h)} L 0 ${f(h)} Z`;
  return [
    `M ${f(r)} 0`,
    `L ${f(w - r)} 0`,
    `A ${f(r)} ${f(r)} 0 0 1 ${f(w)} ${f(r)}`,
    `L ${f(w)} ${f(h - r)}`,
    `A ${f(r)} ${f(r)} 0 0 1 ${f(w - r)} ${f(h)}`,
    `L ${f(r)} ${f(h)}`,
    `A ${f(r)} ${f(r)} 0 0 1 0 ${f(h - r)}`,
    `L 0 ${f(r)}`,
    `A ${f(r)} ${f(r)} 0 0 1 ${f(r)} 0`,
    "Z",
  ].join(" ");
}

/**
 * Is (x, y) inside one of `rect`'s corner cuts? The button's LAYOUT box stays a
 * rectangle however its surface is drawn, so hit-testing has to exclude the
 * cuts explicitly — otherwise a gaze resting in the visible gap would still be
 * landing on a button, and the shape would be lying about what it does.
 * All coordinates are viewport px.
 */
export function pointInCornerCut(
  rect: { left: number; top: number; right: number; bottom: number },
  radius: number,
  offset: number,
  x: number,
  y: number,
  /** Corners left SQUARE by a badge — solid surface, so NOT void to a gaze.
   *  Omitting it keeps the old all-four-corners behaviour. */
  skip?: CornerSkip,
): boolean {
  if (radius <= 0) return false;
  const r2 = radius * radius;
  const corners: Array<[number, number, boolean | undefined]> = [
    [rect.left - offset, rect.top - offset, skip?.topLeft],
    [rect.right + offset, rect.top - offset, skip?.topRight],
    [rect.right + offset, rect.bottom + offset, skip?.bottomRight],
    [rect.left - offset, rect.bottom + offset, skip?.bottomLeft],
  ];
  for (const [px, py, skipped] of corners) {
    if (skipped) continue;
    const dx = x - px;
    const dy = y - py;
    if (dx * dx + dy * dy <= r2) return true;
  }
  return false;
}

/**
 * How much corner space the STUDENT asks for — one setting (aac_settings.
 * rest_space) that applies to every board they open. It is an accessibility
 * need, so no board gets to override it in either direction.
 */
export type RestSpace = "none" | "small" | "large";

/** Cut radius as a fraction of the button's smaller side. */
export const REST_SPACE: Record<RestSpace, number> = {
  none: 0,
  small: 0.15,
  large: 0.24,
};

export const DEFAULT_REST_SPACE: RestSpace = "small";
export const DYNAMIC_REST_SPACE: RestSpace = "large";

export function restSpaceRatio(space: string | null | undefined): number {
  return REST_SPACE[(space as RestSpace) ?? DEFAULT_REST_SPACE] ?? REST_SPACE[DEFAULT_REST_SPACE];
}
