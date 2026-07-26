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

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { motion } from "framer-motion";
import { cornerCutPath, cornerInset } from "@shared/button-shape";

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

export function ShapedButton({
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
}: Props) {
  const wants = !!cornerSpace && cornerSpace.ratio > 0;
  const { ref, box, stroke } = useBorderBox(wants);
  const shaped = wants && !!box && box.w > 0 && box.h > 0;

  const radius = shaped ? Math.min(box!.w, box!.h) * cornerSpace!.ratio : 0;
  const offset = shaped ? cornerSpace!.gapPx / 2 : 0;
  // The outline in the element's own border-box coordinates. Used BOTH to clip
  // the element and to draw it, so what you can hit is exactly what you see.
  const outline = shaped ? cornerCutPath({ w: box!.w, h: box!.h, radius, offset }) : "";
  const inset = shaped ? cornerInset(radius, offset) : 0;

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
  const cutAttr = shaped ? { "data-corner-cut": `${radius.toFixed(2)},${offset.toFixed(2)}` } : {};

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
  if (as === "div") {
    return (
      <motion.div ref={ref as never} {...common}>
        {surface}
        {children}
      </motion.div>
    );
  }
  return (
    <motion.button ref={ref as never} {...common} onClick={onClick} aria-label={ariaLabel}>
      {surface}
      {children}
    </motion.button>
  );
}
