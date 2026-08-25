// client-shared/src/board/BoardButtonVisual.tsx
//
// The single per-button renderer shared by every AAC surface that shows a
// communication-board button: the student app's response board and binary
// overlay, and the clinician editor's canvas. Extracted from the AAC
// `SentenceButton` so the clinician editor renders pixel-identical buttons.
//
// Client-specific behavior (how an icon path resolves, which Glyph wrapper to
// use, RTL) is injected via `BoardRenderDeps` — this file imports no `@/` module.
//
// Two sizes via `variant`:
//   - "board"   → compact grid cell; quick fade-in entrance.
//   - "overlay" → large modal option; spring entrance.
// `interactive: false` (clinician edit mode) renders the SAME inner markup in a
// plain <div> with no click/hover/animation, so the editor can own selection.

import { type ReactNode, useMemo } from "react";
import { motion } from "framer-motion";
import { resolveButtonBackground, MORE_OPTIONS_ICON } from "@shared/button-color";
import { rtlMirrorStyle } from "@shared/emoji-registry";
import { labelFontSize, labelLines, type RatioLevel } from "@shared/button-sizing";
import { ShapedButton, type CornerSpace } from "./ShapedButton";
import { parseGlyph } from "@shared/glyph-compositor";
import {
  hasProsodyMark,
  hasTenseMark,
  ProsodyMarkBadge,
  TenseMarkBadge,
} from "@shared/glyph-compositor.tsx";
import type { BoardButtonInput, BoardRenderDeps, IconVisual } from "./types";

// One-shot keyframe injection for the legacy imageKey loading spinner. Guarded
// against SSR (no document) and double-injection on HMR.
if (typeof document !== "undefined" && !document.getElementById("board-button-spin-keyframes")) {
  const styleEl = document.createElement("style");
  styleEl.id = "board-button-spin-keyframes";
  styleEl.textContent = "@keyframes board-button-spin { to { transform: rotate(360deg); } }";
  document.head.appendChild(styleEl);
}

export interface BoardButtonVisualProps {
  button: BoardButtonInput;
  deps: BoardRenderDeps;
  onClick?: () => void;
  variant: "board" | "overlay";
  /** Pre-resolved background hex. Falls back to deps.resolveColor / shared default. */
  backgroundColor?: string;
  /** Override border styling (link/back/guess/etc.). */
  borderClassName?: string;
  /** Board-variant icon/text sizing, computed by the host grid. */
  iconFontSize?: string;
  textFontSize?: string;
  /** Show the entrance animation (board variant). */
  entering?: boolean;
  /** Stagger the overlay variant's spring entrance. */
  overlayEntranceDelay?: number;
  /** Override overlay-variant dimensions (defaults sized for two big options). */
  overlaySize?: { button: string; icon: string };
  /** Optional accessible label override (defaults to the button's label). */
  ariaLabel?: string;
  /** Optional extra content rendered as an absolute overlay (e.g. link arrow). */
  cornerIndicator?: ReactNode;
  /**
   * CSS length to keep clear at the label row's inline END — used when a corner
   * indicator sits in the lower corner (the AAC's SELECTION AREA eye mark) and
   * must not cover the text. Logical, so it pads the left under `dir="rtl"`,
   * matching a mark positioned with `inset-inline-end`.
   */
  labelInsetEnd?: string;
  /**
   * Tag the button's content boxes with `data-dwell-zone` so the AAC's gaze
   * INTENT DECODER can tell where on the button a fixation landed:
   *   core — the icon/glyph, the fast path to selecting;
   *   ink  — the label text, which charges more slowly because reading it is
   *          the thing students must be able to do WITHOUT selecting;
   *   rest — everything else (padding, and the grid gutters outside), which
   *          never charges and is the board's distributed rest area.
   * Presence of these markers is what puts a button in decoder mode, so this
   * stays off for every surface that isn't the student's main board.
   */
  dwellZones?: boolean;
  /**
   * Icon-to-text sizing (`aacSettings.iconTextRatio`, via `ratioLevel()`). When
   * given, icon and label each fill a real flex share of the button and the
   * label's font-size is derived from its own box — so `textFontSize` is
   * ignored. When omitted, the older fixed-font-size layout is used unchanged,
   * which is what the fixed-scale surfaces (mini board, world-lab, the
   * clinician canvas) still want.
   */
  ratioLevel?: RatioLevel;
  /** Extra content rendered between the icon and the label, centred. */
  midIndicator?: ReactNode;
  /**
   * Draw the surface as an SVG path with concave corner cuts instead of a CSS
   * box, so the space where four buttons meet reads as one circle. Board
   * variant only — overlay buttons are big modal choices with no grid to share
   * corners with. Omit for the unchanged CSS box.
   */
  cornerSpace?: CornerSpace | null;
  /** Passed through to the motion.button so callers can pin data-* attributes etc. */
  extraButtonProps?: Record<string, unknown>;
  /**
   * When false, render a non-interactive <div> (same visual) instead of a
   * button — used by the clinician editor, which owns click-to-select on its
   * own wrapper. Defaults to true.
   */
  interactive?: boolean;
}

/**
 * True for a string that should fill the icon box as one grapheme (a single
 * char or a short emoji sequence) rather than render at a fixed label size.
 */
function isSingleVisual(str: string): boolean {
  const cps = [...str];
  if (cps.length === 1) return true;
  // Emoji sequences (ZWJ joins, flags, skin tones) read as one visual but are
  // several code points. Cap at 4 so a real multi-word label isn't blown up.
  return cps.length <= 4 && /[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]|[\u{2190}-\u{21FF}]|[\u{2300}-\u{27BF}]/u.test(str);
}

/** Render the icon area from a resolved IconVisual. Every branch fills its container. */
function renderIcon(visual: IconVisual, button: BoardButtonInput, deps: BoardRenderDeps, iconFontSize: string): ReactNode {
  // A board button shows the same concept the composed glyph does, so it
  // mirrors on the same terms — otherwise pressing 🏃 in Hebrew puts a symbol
  // into the sentence facing the opposite way from the button it came from.
  // The `glyph` branch is exempt: the compositor mirrors per slot internally,
  // and flipping the wrapper too would undo it.
  // The MORE affordance is chrome rather than a word — the same 🔄 renders
  // unmirrored in the quick-actions row, so flipping it here would give one
  // icon two readings on the same screen. Navigation resolves to `fontawesome`,
  // which no branch mirrors, and whose arrow class is already picked by RTL.
  const rtl = !!deps.rtl && button.buttonType !== "more";
  // `iconRef` is this button's emoji whichever branch wins, so the image and
  // its emoji stand-in agree instead of turning around on load.
  const mirror = rtlMirrorStyle(rtl, { key: button.symbolPath, emoji: button.iconRef });
  switch (visual.kind) {
    case "glyph": {
      const Glyph = deps.GlyphComponent;
      return (
        <div style={{ width: "100%", height: "100%" }}>
          <Glyph glyph={visual.glyph} fallback={visual.fallback} noBackground badges="none" ariaLabel={button.label} />
        </div>
      );
    }
    case "image":
      return (
        <img
          src={visual.src}
          alt={button.label}
          className={`icon-fill-img${visual.rounded ? " rounded-full" : ""}`}
          loading="lazy"
          // `rounded` is the face-photo marker on this branch, and a portrait
          // never mirrors — the student is being asked to recognize someone.
          style={visual.rounded ? undefined : mirror}
        />
      );
    case "spinner":
      return (
        // Only the emoji mirrors; the spinner badge is chrome pinned to a
        // corner, and flipping the wrapper would move it to the wrong side.
        <span className="icon-fill-emoji" style={{ position: "relative", display: "inline-block" }}>
          <span style={rtlMirrorStyle(rtl, visual.emoji)}>{visual.emoji}</span>
          <span
            style={{
              position: "absolute",
              top: 0,
              right: 0,
              width: 16,
              height: 16,
              borderRadius: "50%",
              backgroundColor: "#ffffff",
              boxShadow: "0 0 0 1px rgba(0,0,0,0.15)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <span
              style={{
                width: 12,
                height: 12,
                borderRadius: "50%",
                border: "2px solid rgb(59,130,246)",
                borderTopColor: "transparent",
                display: "inline-block",
                animation: "board-button-spin 1s linear infinite",
              }}
            />
          </span>
        </span>
      );
    case "emoji": {
      // The literal rendered char decides here, not the button's iconRef —
      // this branch may be showing a label-derived emoji the button never
      // declared, and a "?" or a digit must stay upright either way.
      const emojiMirror = rtlMirrorStyle(rtl, { key: button.symbolPath, emoji: visual.text });
      if (isSingleVisual(visual.text)) {
        return <span className="icon-fill-emoji" style={emojiMirror}>{visual.text}</span>;
      }
      // Multi-character text — fixed size so it can't overflow the cell width.
      // Left unmirrored: several glyphs side by side read as a sequence, and a
      // mirror would reverse their order as well as each shape.
      return <span style={{ fontSize: `calc(${iconFontSize} * 0.5)`, lineHeight: 1 }}>{visual.text}</span>;
    }
    case "fontawesome":
      return <i className={`${visual.className} icon-fill-emoji`} />;
    case "placeholder":
    default:
      return <span className="icon-fill-emoji" style={mirror}>💬</span>;
  }
}

export function BoardButtonVisual(props: BoardButtonVisualProps) {
  const {
    button,
    deps,
    onClick,
    variant,
    backgroundColor,
    borderClassName,
    iconFontSize,
    textFontSize,
    entering = false,
    overlayEntranceDelay = 0,
    overlaySize,
    ariaLabel,
    cornerIndicator,
    labelInsetEnd,
    dwellZones = false,
    ratioLevel,
    midIndicator,
    cornerSpace,
    extraButtonProps,
    interactive = true,
  } = props;

  const background = useMemo(
    () =>
      backgroundColor ??
      deps.resolveColor?.(button) ??
      resolveButtonBackground(button.color, button.glyph, button.buttonType, button.role),
    [backgroundColor, deps, button],
  );

  // A `more` button is the MORE OPTIONS affordance, not a word — it always
  // wears the reload symbol, matching the fixed quick-actions button so the
  // student reads one visual for "show me other things I could say". Forced
  // here rather than trusted from the button's own fallback, which still
  // carries the legacy `➕` on boards minted server-side.
  const iconVisual: IconVisual =
    button.buttonType === "more"
      ? { kind: "emoji", text: MORE_OPTIONS_ICON }
      : deps.resolveIcon(button);
  const icon = renderIcon(iconVisual, button, deps, iconFontSize ?? "2rem");

  if (variant === "overlay") {
    const sz = overlaySize ?? { button: "min(45vw, 300px)", icon: "min(28vw, 180px)" };
    return (
      <motion.button
        data-dwell
        onClick={onClick}
        aria-label={ariaLabel ?? button.label}
        className={
          "flex flex-col items-center justify-center rounded-3xl shadow-2xl border-4 select-none p-3 " +
          (borderClassName ?? "border-blue-400 text-blue-900 font-bold")
        }
        style={{
          width: sz.button,
          height: sz.button,
          fontSize: "clamp(1.1rem, 3.5vw, 1.8rem)",
          backgroundColor: background,
        }}
        initial={{ scale: 0.3, y: 120, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        exit={{ scale: 0.3, y: 120, opacity: 0 }}
        transition={{ type: "spring", stiffness: 400, damping: 25, delay: overlayEntranceDelay }}
        {...extraButtonProps}
      >
        <div className="icon-fill-area mb-2" style={{ flex: "0 0 auto", width: sz.icon, height: sz.icon }}>
          {icon}
        </div>
        {button.label}
        {cornerIndicator}
      </motion.button>
    );
  }

  // Board variant — shared inner markup for both interactive and static modes.
  // With a ratio level the two rows split the button's height proportionally
  // and each fills its own share; without one, the legacy fixed-font layout.
  const lines = ratioLevel ? labelLines(button.label, ratioLevel) : 2;
  const inner = (
    <>
      <div
        className="icon-fill-area"
        data-dwell-zone={dwellZones ? "ink" : undefined}
        style={ratioLevel ? { flex: `${ratioLevel.iconFlex} 1 0` } : undefined}
      >
        {icon}
      </div>
      {midIndicator}
      <div
        className={
          ratioLevel
            ? "label-fill-area"
            : "flex items-center justify-center w-full overflow-hidden shrink-0"
        }
        data-dwell-zone={dwellZones ? "ink" : undefined}
        style={
          ratioLevel
            ? { flex: `${ratioLevel.textFlex} 1 0`, paddingInlineEnd: labelInsetEnd }
            : { maxHeight: "40%", marginTop: 2, paddingInlineEnd: labelInsetEnd }
        }
      >
        <span
          className="font-medium text-center text-gray-800 leading-tight"
          style={{
            fontSize: ratioLevel ? labelFontSize(button.label, ratioLevel) : (textFontSize ?? "0.875rem"),
            display: "-webkit-box",
            WebkitBoxOrient: "vertical",
            WebkitLineClamp: lines,
            overflow: "hidden",
            overflowWrap: "break-word",
          }}
        >
          {button.label}
        </span>
      </div>
      {/* Corner indicators anchor to the button's corners — which is exactly
          what a corner cut removes. Re-anchor them to the inset box so the
          link arrow, launch mark and busy spinner stay on the button instead
          of being clipped away. `--corner-inset` is published by ShapedButton. */}
      {cornerIndicator && cornerSpace ? (
        <div style={{ position: "absolute", inset: "var(--corner-inset, 0px)", pointerEvents: "none" }}>
          {cornerIndicator}
        </div>
      ) : (
        cornerIndicator
      )}
    </>
  );

  const className =
    "flex flex-col items-center justify-center rounded-xl shadow-sm border min-h-0 min-w-0 overflow-hidden relative " +
    (borderClassName ?? "border-gray-200");

  // GLYPH MARK badges at the BUTTON's corners.
  //
  // The compositor suppresses its own inline badges above (`badges="none"`),
  // because its SVG letterboxes inside this cell — a 3-slot sentence in a
  // squarish button left deep empty bands and the badge drew a third of the way
  // DOWN rather than at a corner. Drawn here instead, against the button box,
  // they land where a corner mark belongs whatever the sentence's width.
  //
  // ShapedButton suppresses the corner bite under each badge and picks the px
  // size from its measured box; sides below are PHYSICAL, RTL already resolved.
  const markTags = button.glyph ? parseGlyph(button.glyph).toneTags : [];
  const prosody = hasProsodyMark(markTags)
    ? (size: number) => <ProsodyMarkBadge tags={markTags} size={size} />
    : undefined;
  const tense = hasTenseMark(markTags)
    ? (size: number) => <TenseMarkBadge tags={markTags} size={size} rtl={deps.rtl} />
    : undefined;
  const cornerBadges =
    prosody || tense
      ? deps.rtl
        ? { topLeft: prosody, topRight: tense }
        : { topRight: prosody, topLeft: tense }
      : null;

  if (!interactive) {
    // Clinician editor: the outer element owns selection/click; render a plain
    // div (filling that wrapper) so this inner visual never intercepts pointer
    // events.
    return (
      <div
        className={className + " h-full w-full"}
        style={{ backgroundColor: background, padding: 5 }}
        aria-label={ariaLabel ?? button.label}
      >
        {inner}
      </div>
    );
  }

  return (
    <ShapedButton
      cornerSpace={cornerSpace}
      cornerBadges={cornerBadges}
      background={background}
      className={className}
      style={{ padding: 5 }}
      onClick={onClick}
      ariaLabel={ariaLabel ?? button.label}
      domProps={{ "data-dwell": "", ...extraButtonProps }}
      motionProps={{
        initial: entering ? { opacity: 0, scale: 0.8 } : { opacity: 1, scale: 1 },
        animate: { opacity: 1, scale: 1 },
        transition: { duration: entering ? 0.3 : 0.15 },
        whileHover: { scale: 1.05 },
        whileTap: { scale: 0.95 },
      }}
    >
      {inner}
    </ShapedButton>
  );
}
