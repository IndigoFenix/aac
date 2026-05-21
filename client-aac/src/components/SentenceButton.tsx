// client-aac/src/components/SentenceButton.tsx
//
// Shared SENTENCE BUTTON component — one renderer for every surface that
// voices a SENTENCE on press: the RESPONSE BOARD (DynamicBoard), the
// binary-choice overlay, and anywhere else that ends up showing the same
// pipe-format button. Wraps the Glyph compositor (so animated SYMBOLs and
// every modifier transform work automatically) and a small set of static
// fallbacks (face / custom symbol / icon / emoji).
//
// The same component is rendered at two sizes via `variant`:
//   - "board"   → compact, fits a grid cell; entrance is a quick fade-in
//   - "overlay" → large, modal-style; entrance is a spring bounce
// Both variants share the SAME icon-resolution rules and the SAME default-
// color rules (a SENTENCE that contains a `yes` SYMBOL defaults to green;
// `no` defaults to red; explicit `color` always wins).

import { type ReactNode, useMemo } from "react";
import { motion } from "framer-motion";
import { Glyph } from "@/components/Glyph";
import { apiUrl } from "@/lib/queryClient";
import { resolveStaticIconPath } from "@/lib/utils";

// One-shot keyframe injection for the legacy imageKey loading spinner.
// Module side-effect so every SentenceButton can rely on the rule existing
// without each instance rendering its own <style> tag. Guarded against
// SSR (no document) and double-injection on HMR.
if (typeof document !== "undefined" && !document.getElementById("sentence-button-spin-keyframes")) {
  const styleEl = document.createElement("style");
  styleEl.id = "sentence-button-spin-keyframes";
  styleEl.textContent = "@keyframes sentence-button-spin { to { transform: rotate(360deg); } }";
  document.head.appendChild(styleEl);
}

/** The shape every SENTENCE BUTTON surface speaks. */
export interface SentenceButtonInput {
  /** Short on-button text. */
  label: string;
  /** The natural-language SENTENCE the TTS voices on press. */
  sentence?: string;
  /** Visual encoding — composed GLYPHs + MODIFIER SYMBOLs + OPERATORs. */
  glyph?: string;
  /** Fallback `sentence` encoding using no `generate:` SYMBOLs. */
  glyphFallback?: string;
  /** Optional explicit background color (named or hex). Overrides defaults. */
  color?: string;
  /** Single-SYMBOL paths used when the button doesn't carry a full glyph. */
  iconRef?: string;
  symbolPath?: string;
  imageKey?: string;
}

const COLOR_MAP: Record<string, string> = {
  yellow: "#FEF3C7",
  blue: "#DBEAFE",
  green: "#D1FAE5",
  red: "#FEE2E2",
  orange: "#FFEDD5",
  purple: "#EDE9FE",
  pink: "#FCE7F3",
  white: "#FFFFFF",
  gray: "#F3F4F6",
};

/**
 * Pick the background color for a SENTENCE BUTTON.
 *
 * Resolution order:
 *   1. Explicit `color` (named key or raw CSS color) — always wins.
 *   2. Auto-default from the SENTENCE encoding:
 *        - contains `yes` SYMBOL → green
 *        - contains `no` SYMBOL  → red
 *        - contains both         → no auto-color (returns white)
 *   3. Plain white.
 */
export function resolveButtonBackground(color?: string, glyph?: string): string {
  if (color) {
    return COLOR_MAP[color.toLowerCase()] ?? color;
  }
  const autoColor = detectYesNoDefaultColor(glyph);
  if (autoColor) return COLOR_MAP[autoColor];
  return "#FFFFFF";
}

/**
 * Scan a SENTENCE encoding for the `yes` / `no` canonical SYMBOLs.
 * Returns "green" when only `yes` is present, "red" when only `no`,
 * undefined when both (ambiguous — let the caller fall through to white)
 * or neither.
 *
 * We tokenize the glyph string by the syntactic separators (`+` between
 * GLYPHs, `.` between HEAD/MODIFIER SYMBOLs, `#` for OPERATORs, plus the
 * composable-host `(payload)` notation) and look for bare `yes`/`no`
 * tokens. We deliberately don't match inside emoji or other arbitrary
 * SYMBOLs — only the canonical keys count.
 */
function detectYesNoDefaultColor(glyph?: string): "green" | "red" | undefined {
  if (!glyph) return undefined;
  const tokens = glyph.split(/[+.#()]/).map((t) => t.trim()).filter(Boolean);
  let hasYes = false;
  let hasNo = false;
  for (const t of tokens) {
    if (t === "yes") hasYes = true;
    else if (t === "no") hasNo = true;
  }
  if (hasYes && hasNo) return undefined; // ambiguous
  if (hasYes) return "green";
  if (hasNo) return "red";
  return undefined;
}

interface SentenceButtonProps {
  button: SentenceButtonInput;
  onClick: () => void;
  /** Sizing + chrome preset. */
  variant: "board" | "overlay";
  /** Override border styling (board variant uses this for link/back/guess buttons). */
  borderClassName?: string;
  /** Resolve __FACE__:id pseudo-paths against the client-side face cache. */
  getFaceImage?: (id: string) => string | null;
  /** Board-variant icon/text sizing — computed by the host to match the grid. */
  iconFontSize?: string;
  textFontSize?: string;
  iconFlex?: number;
  textFlex?: number;
  /** Show the entrance animation (board variant). */
  entering?: boolean;
  /** Stagger the overlay variant's spring entrance. */
  overlayEntranceDelay?: number;
  /** Optional accessible label override (defaults to the button's label). */
  ariaLabel?: string;
  /** Optional extra content rendered as an absolute overlay (e.g. link arrow). */
  cornerIndicator?: ReactNode;
  /** Passed through to motion.button so callers can pin data-dwell-cell etc. */
  extraButtonProps?: Record<string, unknown>;
}

/**
 * Render the icon area inside the button frame. Resolves in priority order:
 *   glyph (preferred) → __FACE__ → __SYMBOL__ → static path → imageKey w/ spinner
 *   → iconRef → emoji fallback. The Glyph branch handles animated SYMBOLs
 *   (yes/no) automatically via the AAC Glyph wrapper.
 */
function renderIcon(
  button: SentenceButtonInput,
  iconFontSize: string,
  getFaceImage: ((id: string) => string | null) | undefined,
): ReactNode {
  const imgStyle = {
    maxWidth: "100%",
    maxHeight: "100%",
    width: "auto",
    height: "auto",
    objectFit: "contain" as const,
  };
  const emojiStyle = { fontSize: iconFontSize, lineHeight: 1 };

  // Glyph wins over everything except the __FACE__/__SYMBOL__ pseudo-paths.
  if (
    (button.glyph || button.glyphFallback) &&
    !button.symbolPath?.startsWith("__FACE__:") &&
    !button.symbolPath?.startsWith("__SYMBOL__:")
  ) {
    return (
      <div style={{ width: "100%", height: "100%" }}>
        <Glyph
          glyph={button.glyph}
          fallback={button.glyphFallback}
          noBackground
          ariaLabel={button.label}
        />
      </div>
    );
  }

  if (button.symbolPath?.startsWith("__FACE__:")) {
    const contactId = button.symbolPath.substring(9);
    const cached = getFaceImage?.(contactId);
    if (cached) {
      return <img src={cached} alt={button.label} className="rounded-full" style={imgStyle} />;
    }
    return <span style={emojiStyle}>👤</span>;
  }
  if (button.symbolPath?.startsWith("__SYMBOL__:")) {
    const symbolId = button.symbolPath.substring(11);
    return (
      <img
        src={apiUrl(`/api/custom-symbols/${symbolId}/image`)}
        alt={button.label}
        style={imgStyle}
        loading="lazy"
      />
    );
  }
  if (button.symbolPath) {
    return <img src={resolveStaticIconPath(button.symbolPath)} alt={button.label} style={imgStyle} />;
  }
  // Legacy single-concept imageKey path — show the emoji with a small
  // spinner badge while the symbol generates. New buttons with a `glyph`
  // never hit this branch (Glyph handles its own per-slot loading state).
  if (button.imageKey) {
    const emoji = button.iconRef && /[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]/u.test(button.iconRef)
      ? button.iconRef
      : "💬";
    return (
      <span
        style={{
          ...emojiStyle,
          ...(emoji.length > 2 ? { fontSize: `calc(${iconFontSize} * 0.5)` } : {}),
          position: "relative",
          display: "inline-block",
        }}
      >
        {emoji}
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
              animation: "sentence-button-spin 1s linear infinite",
            }}
          />
        </span>
      </span>
    );
  }
  if (button.iconRef) {
    const isEmojiOrText =
      [...button.iconRef].length === 1 ||
      /[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]/u.test(button.iconRef);
    if (isEmojiOrText) {
      const style = button.iconRef.length > 2 ? { ...emojiStyle, fontSize: `calc(${iconFontSize} * 0.5)` } : emojiStyle;
      return <span style={style}>{button.iconRef}</span>;
    }
    return <i className={button.iconRef} style={emojiStyle} />;
  }
  return <span style={emojiStyle}>💬</span>;
}

export function SentenceButton(props: SentenceButtonProps) {
  const {
    button,
    onClick,
    variant,
    borderClassName,
    getFaceImage,
    iconFontSize,
    textFontSize,
    iconFlex = 3,
    textFlex = 1,
    entering = false,
    overlayEntranceDelay = 0,
    ariaLabel,
    cornerIndicator,
    extraButtonProps,
  } = props;

  const background = useMemo(
    () => resolveButtonBackground(button.color, button.glyph),
    [button.color, button.glyph],
  );

  if (variant === "overlay") {
    // Modal-style — full SENTENCE BUTTON rules apply (Glyph compositor,
    // animated SYMBOLs, default colors) but rendered at overlay scale.
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
          width: "min(45vw, 300px)",
          height: "min(45vw, 300px)",
          fontSize: "clamp(1.1rem, 3.5vw, 1.8rem)",
          backgroundColor: background,
        }}
        initial={{ scale: 0.3, y: 120, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        exit={{ scale: 0.3, y: 120, opacity: 0 }}
        transition={{ type: "spring", stiffness: 400, damping: 25, delay: overlayEntranceDelay }}
        {...extraButtonProps}
      >
        <div
          className="mb-2 flex items-center justify-center"
          style={{ width: "min(28vw, 180px)", height: "min(28vw, 180px)" }}
        >
          {renderIcon(button, "min(28vw, 180px)", getFaceImage)}
        </div>
        {button.label}
        {cornerIndicator}
      </motion.button>
    );
  }

  // Board variant.
  return (
    <motion.button
      data-dwell
      onClick={onClick}
      aria-label={ariaLabel ?? button.label}
      initial={entering ? { opacity: 0, scale: 0.8 } : { opacity: 1, scale: 1 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: entering ? 0.3 : 0.15 }}
      className={
        "flex flex-col items-center justify-center p-1 rounded-xl shadow-sm border min-h-0 min-w-0 overflow-hidden relative " +
        (borderClassName ?? "border-gray-200")
      }
      style={{ backgroundColor: background }}
      whileHover={{ scale: 1.05 }}
      whileTap={{ scale: 0.95 }}
      {...extraButtonProps}
    >
      <div
        className="flex items-center justify-center min-h-0 w-full overflow-hidden"
        style={{ flex: `${iconFlex} 1 0px` }}
      >
        {renderIcon(button, iconFontSize ?? "2rem", getFaceImage)}
      </div>
      <div
        className="flex items-center justify-center w-full overflow-hidden"
        style={{ flex: `${textFlex} 1 0px` }}
      >
        <span
          className="font-medium text-center text-gray-800 leading-tight line-clamp-2"
          style={{ fontSize: textFontSize ?? "0.875rem" }}
        >
          {button.label}
        </span>
      </div>
      {cornerIndicator}
    </motion.button>
  );
}
