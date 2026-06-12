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
import { resolveButtonBackground } from "@shared/button-color";
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
  switch (visual.kind) {
    case "glyph": {
      const Glyph = deps.GlyphComponent;
      return (
        <div style={{ width: "100%", height: "100%" }}>
          <Glyph glyph={visual.glyph} fallback={visual.fallback} noBackground ariaLabel={button.label} />
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
        />
      );
    case "spinner":
      return (
        <span className="icon-fill-emoji" style={{ position: "relative", display: "inline-block" }}>
          {visual.emoji}
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
    case "emoji":
      if (isSingleVisual(visual.text)) {
        return <span className="icon-fill-emoji">{visual.text}</span>;
      }
      // Multi-character text — fixed size so it can't overflow the cell width.
      return <span style={{ fontSize: `calc(${iconFontSize} * 0.5)`, lineHeight: 1 }}>{visual.text}</span>;
    case "fontawesome":
      return <i className={`${visual.className} icon-fill-emoji`} />;
    case "placeholder":
    default:
      return <span className="icon-fill-emoji">💬</span>;
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
    extraButtonProps,
    interactive = true,
  } = props;

  const background = useMemo(
    () =>
      backgroundColor ??
      deps.resolveColor?.(button) ??
      resolveButtonBackground(button.color, button.glyph, button.buttonType),
    [backgroundColor, deps, button],
  );

  const icon = renderIcon(deps.resolveIcon(button), button, deps, iconFontSize ?? "2rem");

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
  const inner = (
    <>
      <div className="icon-fill-area">{icon}</div>
      <div
        className="flex items-center justify-center w-full overflow-hidden shrink-0"
        style={{ maxHeight: "40%", marginTop: 2 }}
      >
        <span
          className="font-medium text-center text-gray-800 leading-tight line-clamp-2"
          style={{ fontSize: textFontSize ?? "0.875rem" }}
        >
          {button.label}
        </span>
      </div>
      {cornerIndicator}
    </>
  );

  const className =
    "flex flex-col items-center justify-center rounded-xl shadow-sm border min-h-0 min-w-0 overflow-hidden relative " +
    (borderClassName ?? "border-gray-200");

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
    <motion.button
      data-dwell
      onClick={onClick}
      aria-label={ariaLabel ?? button.label}
      initial={entering ? { opacity: 0, scale: 0.8 } : { opacity: 1, scale: 1 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: entering ? 0.3 : 0.15 }}
      className={className}
      style={{ backgroundColor: background, padding: 5 }}
      whileHover={{ scale: 1.05 }}
      whileTap={{ scale: 0.95 }}
      {...extraButtonProps}
    >
      {inner}
    </motion.button>
  );
}
