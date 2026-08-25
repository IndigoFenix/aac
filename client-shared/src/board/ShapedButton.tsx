// client-shared/src/board/ShapedButton.tsx
//
// A board cell whose SURFACE is an SVG path rather than a CSS box, so its
// corners can be cut concavely and its BORDER follows the cut. See
// shared/button-shape.ts for the geometry and why it has to work this way.
//
// Every cell in a grid must use this once any of them does. The empty circle
// at a vertex is composed from the four bites around it, so a single
// un-cut neighbour — a nav button, a blank placeholder — leaves the circle
// with a square quadrant and the whole effect reads as a mistake.
//
// With no `cornerSpace` this renders exactly the CSS box it always did: same
// element, same classes, no SVG, no measurement. Surfaces that don't opt in
// are untouched.

import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from "react";
import { motion } from "framer-motion";
import { cornerCutPath, cornerInset, type CornerSkip } from "@shared/button-shape";

/** How much of the button's smaller side to bite out, and the grid gap to
 *  centre the cut circles in. `ratio` 0 disables shaping entirely. */
export interface CornerSpace {
  ratio: number;
  gapPx: number;
}

/** Stroke width for the surface outline — matches the 1px CSS border it replaces. */
const STROKE_W = 1;

interface Props {
  cornerSpace?: CornerSpace | null;
  /** Painted as the path's fill when shaped, or the box background when not. */
  background?: string;
  /** Dash the stroke (blank-slot placeholders). */
  dashed?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
  /** Render a div instead of a button (placeholders, fading cells). */
  as?: "button" | "div";
  onClick?: () => void;
  ariaLabel?: string;
  motionProps?: Record<string, unknown>;
  domProps?: Record<string, unknown>;
  /**
   * GLYPH MARK badges drawn at the button's OWN top corners, each suppressing
   * that corner's bite.
   *
   * A badge has to sit at the true corner to read as a corner mark, and the
   * interior of a board button is already cramped — squeezing the badge inboard
   * of the cut just crowds the artwork. So the badge takes the corner and the
   * bite gives way. The vertex disc loses a quadrant where this happens (user
   * call, 2026-08-24); badges only ever take TOP corners, so enough of the
   * circle survives to rest a gaze on.
   *
   * Sides are PHYSICAL, not logical — the caller has already resolved RTL when
   * deciding which mark goes where.
   */
  cornerBadges?: { topLeft?: (size: number) => ReactNode; topRight?: (size: number) => ReactNode } | null;
}

/**
 * Measure the element's border box. Uses ResizeObserver's own numbers rather
 * than `getBoundingClientRect`, which would report the hover scale transform
 * and re-trigger the observer in a loop.
 */
function useBorderBox(active: boolean) {
  const ref = useRef<HTMLElement | null>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const [stroke, setStroke] = useState("transparent");

  useEffect(() => {
    const el = ref.current;
    if (!active || !el) {
      setBox(null);
      return;
    }
    const measure = () => {
      setBox({ w: el.offsetWidth, h: el.offsetHeight });
      // Border COLOUR survives `border-width: 0`, so the existing Tailwind
      // variant classes (link blue, back grey, guess purple…) keep telling us
      // what to stroke with — no class-to-colour table to keep in step.
      const c = getComputedStyle(el).borderTopColor;
      if (c) setStroke(c);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [active]);

  return { ref, box, stroke };
}

/**
 * Ref-forwarding is NOT decoration here.
 *
 * Every board cell is rendered inside `<AnimatePresence mode="popLayout">`
 * (DynamicBoard). popLayout works by cloning each child with a ref, measuring
 * it, and popping an EXITING child out of flow so the survivors reflow at once.
 * A plain function component cannot take that ref, so React warned on every
 * render ("Function components cannot be given refs… Check the render method of
 * PopChild") and framer-motion silently lost its measurement.
 *
 * Two refs therefore have to land on the same node: ours, for the corner-cut
 * measurement, and the caller's. `mergeRefs` does that.
 */
function mergeRefs<T>(...refs: Array<Ref<T> | undefined>) {
  return (node: T | null) => {
    for (const r of refs) {
      if (!r) continue;
      if (typeof r === "function") r(node);
      else (r as { current: T | null }).current = node;
    }
  };
}

export const ShapedButton = forwardRef<HTMLElement, Props>(function ShapedButton({
  cornerSpace,
  background,
  dashed = false,
  className = "",
  style,
  children,
  as = "button",
  onClick,
  ariaLabel,
  motionProps,
  domProps,
  cornerBadges,
}: Props, forwardedRef) {
  const wants = !!cornerSpace && cornerSpace.ratio > 0;
  const { ref, box, stroke } = useBorderBox(wants);
  // Recreated only when the caller's ref identity changes, so the merged
  // callback does not detach and reattach on every render (which would make
  // the ResizeObserver in useBorderBox churn).
  const setRefs = useCallback(mergeRefs<HTMLElement>(ref, forwardedRef), [ref, forwardedRef]);
  const shaped = wants && !!box && box.w > 0 && box.h > 0;

  const radius = shaped ? Math.min(box!.w, box!.h) * cornerSpace!.ratio : 0;
  const offset = shaped ? cornerSpace!.gapPx / 2 : 0;
  // The outline in the element's own border-box coordinates. Used BOTH to clip
  // the element and to draw it, so what you can hit is exactly what you see.
  // A badge takes its corner whole, so that corner keeps its right angle.
  const skip: CornerSkip = {
    topLeft: !!cornerBadges?.topLeft,
    topRight: !!cornerBadges?.topRight,
  };
  const anySkip = !!(skip.topLeft || skip.topRight);
  const outline = shaped ? cornerCutPath({ w: box!.w, h: box!.h, radius, offset, skip }) : "";
  const inset = shaped ? cornerInset(radius, offset) : 0;
  // The badge is sized off the cut it replaces, so it reads as filling the
  // space the bite would have taken rather than as an arbitrary sticker. Held
  // to a legible floor for small buttons and a ceiling so it can never
  // dominate a large one.
  const badgePx = shaped ? Math.max(18, Math.min(inset * 1.15, Math.min(box!.w, box!.h) * 0.26)) : 22;

  const surfaceStyle: CSSProperties = shaped
    ? {
        ...style,
        backgroundColor: "transparent",
        // The path draws the border now; the box must not draw a second one.
        // Width 0 rather than a transparent colour, so the colour stays
        // readable for the stroke.
        borderWidth: 0,
        borderRadius: 0,
        boxShadow: "none",
        // REQUIRED, not cosmetic. The surface sits at z-index -1 so the cell's
        // content paints over it, and a negative z-index child only stays
        // inside its parent if the parent forms a stacking context. Framer
        // drops the transform once a button is at rest, so without this the
        // surface escaped and painted behind the page — the button looked to
        // have no background at all until a hover re-applied `scale` and
        // recreated the context.
        isolation: "isolate",
        // A BADGE-BEARING BUTTON PAINTS ABOVE THE REST-SPACE DOTS.
        //
        // `CornerVoids` (DynamicBoard) renders the vertex dots as SIBLINGS of
        // the cells and AFTER them, so with everything at `z-index: auto` the
        // dots win on DOM order. That normally costs nothing — the dot fits
        // inside the union of the four bites, so no button overlaps it. But a
        // badge corner has no bite: the badge sits exactly where the dot is,
        // and the dot covered it.
        //
        // Raising the badge child cannot fix this. `isolation: isolate` above
        // makes this button a stacking context, so the badge's own z-index is
        // sealed inside it; only the BUTTON's position among its siblings can
        // lift it. Applied only when a badge is present, so an ordinary cell
        // keeps its old stacking exactly.
        ...(anySkip ? { zIndex: 1 } : {}),
        // OFF THE BUTTON IS COMPLETELY OFF THE BUTTON. Without this the cut is
        // only a picture: the element's layout box stays rectangular, so a
        // click in the corner still activates it and framer's hover still
        // scales it. A clipped region receives no pointer events at all, so
        // this makes the drawn shape the real one for the mouse and for touch
        // — the gaze path already excluded the cuts via `data-corner-cut`.
        clipPath: `path('${outline}')`,
        // Published for anything that must stay clear of the cut corners.
        ["--corner-inset" as string]: `${inset.toFixed(1)}px`,
      }
    : { ...style, backgroundColor: background };

  const surface = shaped ? (
    <svg
      aria-hidden="true"
      width={box!.w}
      height={box!.h}
      viewBox={`0 0 ${box!.w} ${box!.h}`}
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        zIndex: -1, // behind the cell's content; see `isolation` above
        pointerEvents: "none",
        filter: "drop-shadow(0 1px 1px rgb(0 0 0 / 0.06))",
      }}
    >
      {/* Inset by half the stroke. A stroke is centred ON its path, so drawing
          the outline along the box's exact edges puts half of it outside the
          viewport, where it is clipped — leaving a 0.5px ghost that reads as
          no border at all. The cut circles stay put in space, so relative to
          the inset box their centres move out by the same half-stroke. */}
      <g transform={`translate(${STROKE_W / 2} ${STROKE_W / 2})`}>
        <path
          d={cornerCutPath({
            w: box!.w - STROKE_W,
            h: box!.h - STROKE_W,
            radius,
            offset: offset + STROKE_W / 2,
          })}
          fill={background ?? "transparent"}
          stroke={stroke}
          strokeWidth={STROKE_W}
          strokeDasharray={dashed ? "6 4" : undefined}
        />
      </g>
    </svg>
  ) : null;

  // Published for the gaze hit-test: the LAYOUT box stays rectangular however
  // the surface is drawn, so the corner cuts have to be excluded explicitly.
  // A skipped corner is SOLID surface, so it must not read as void to a gaze —
  // the flags ride along in the same attribute (`radius,offset[,skipTL,skipTR]`).
  const cutAttr = shaped
    ? {
        "data-corner-cut": anySkip
          ? `${radius.toFixed(2)},${offset.toFixed(2)},${skip.topLeft ? 1 : 0},${skip.topRight ? 1 : 0}`
          : `${radius.toFixed(2)},${offset.toFixed(2)}`,
      }
    : {};

  const common = {
    className: className + (shaped ? " !rounded-none" : ""),
    style: surfaceStyle,
    ...cutAttr,
    ...domProps,
    ...motionProps,
  };

  // `ref` is passed explicitly rather than inside the spread: the whole shape
  // depends on this measurement landing, and a ref that silently fails to
  // attach degrades to the plain CSS box — the exact failure that is hardest
  // to notice, because it looks like the feature simply isn't switched on.
  // Above the content, and pointer-transparent.
  //
  // Deliberately NOT `data-dwell-void`: we suppressed the bite so this corner
  // is solid, selectable button, and marking it void would turn the corner we
  // just reclaimed into a dead zone. `pointerEvents: "none"` keeps the badge
  // out of `elementFromPoint` entirely, so both mouse and gaze land on the
  // button underneath — the mark is decoration over a live target.
  const badgeLayer = cornerBadges && (cornerBadges.topLeft || cornerBadges.topRight) ? (
    <>
      {cornerBadges.topLeft && (
        <span
          aria-hidden="true"
          style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none", zIndex: 2, lineHeight: 0 }}
        >
          {cornerBadges.topLeft(badgePx)}
        </span>
      )}
      {cornerBadges.topRight && (
        <span
          aria-hidden="true"
          style={{ position: "absolute", top: 0, right: 0, pointerEvents: "none", zIndex: 2, lineHeight: 0 }}
        >
          {cornerBadges.topRight(badgePx)}
        </span>
      )}
    </>
  ) : null;

  if (as === "div") {
    return (
      <motion.div ref={setRefs as never} {...common}>
        {surface}
        {children}
        {badgeLayer}
      </motion.div>
    );
  }
  return (
    <motion.button ref={setRefs as never} {...common} onClick={onClick} aria-label={ariaLabel}>
      {surface}
      {children}
      {badgeLayer}
    </motion.button>
  );
});
