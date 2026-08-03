// shared/button-color.ts
//
// Single source of truth for AAC board-button color. Pure and server-safe (no
// React, no client imports) so the server can compute a button's color and ship
// it with the rest of the button data, and the shared renderer + the DB
// migration script can all agree on the mapping.
//
// Model (decided 2026-06-05):
//   - The server fills `button.color` with a COLOR TOKEN via
//     `resolveButtonColorToken`. A token is either a named color
//     (yellow/blue/green/red/orange/purple/pink/white/gray) or a raw CSS color
//     (e.g. a clinician-picked "#3B82F6").
//   - The renderer paints `mapColorToHex(button.color)` — named tokens map to a
//     pastel hex, raw colors pass through untouched.
//   - Auto-coloring (yes→green, no→red, find→purple, more→teal) applies ONLY
//     when no explicit color is present.

/** Named color tokens the palette understands. */
export type ColorToken =
  | "yellow"
  | "blue"
  | "green"
  | "red"
  | "orange"
  | "purple"
  | "pink"
  | "white"
  | "gray";

/** Named token → pastel background hex. */
export const COLOR_MAP: Record<ColorToken, string> = {
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
 * The MORE OPTIONS affordance — one appearance, wherever it comes from.
 *
 * The fixed quick-actions "More" button and any AI-authored board button with
 * `buttonType: "more"` are the SAME promise to the student ("show me other
 * things I could say"), so they must look the same. Both import these two
 * constants; neither may re-state the hex or the emoji locally.
 *
 * Teal is deliberately outside the rest of the AAC palette (yes-green,
 * no-red, home-blue, back/guess-violet, speak-amber, exit-red) so "more
 * options" reads as its own category rather than as neutral chrome.
 *
 * The icon is the RELOAD arrows — the same symbol the AI already uses for its
 * "something else" buttons — because students read a `+` as "add one more of
 * this thing" rather than "show me other options".
 */
export const MORE_OPTIONS_COLOR = "#CCFBF1";
export const MORE_OPTIONS_ICON = "🔄";

/**
 * Fixed background colors for the meta buttons (the board-embedded twins of the
 * quick-actions Word Finder / More buttons). Kept as explicit values so the
 * appearance matches exactly what `DynamicBoard` renders.
 */
export const SPECIAL_BUTTON_COLORS: Record<"wordfinder" | "more", string> = {
  wordfinder: "#EDE9FE",
  more: MORE_OPTIONS_COLOR,
};

/**
 * Scan a SENTENCE (glyph) encoding for the canonical `yes` / `no` SYMBOLs.
 * Returns "green" when only `yes` is present, "red" when only `no`, and
 * undefined when both (ambiguous) or neither.
 *
 * Tokenizes by the syntactic separators (`+` between GLYPHs, `.` between
 * HEAD/MODIFIER SYMBOLs, `#` for OPERATORs, plus the composable-host `(payload)`
 * notation) and looks for bare `yes`/`no` tokens — never matches inside emoji or
 * arbitrary SYMBOLs.
 */
export function detectYesNoDefaultColor(glyph?: string): "green" | "red" | undefined {
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

/**
 * Decide the color TOKEN for a button. Resolution order:
 *   1. Explicit `color` (named token or raw CSS color) — always wins.
 *   2. Special meta buttons: `wordfinder` → purple hex, `more` → teal hex.
 *   3. Auto yes/no from the glyph: yes → green, no → red.
 *   4. Plain white.
 *
 * The result is a value suitable for `button.color`; the renderer turns it into
 * a background via {@link mapColorToHex}.
 */
export function resolveButtonColorToken(input: {
  color?: string;
  glyph?: string;
  buttonType?: string;
}): string {
  const { color, glyph, buttonType } = input;
  if (color && color.trim()) return color;
  if (buttonType === "wordfinder") return SPECIAL_BUTTON_COLORS.wordfinder;
  if (buttonType === "more") return SPECIAL_BUTTON_COLORS.more;
  const auto = detectYesNoDefaultColor(glyph);
  if (auto) return auto;
  return "white";
}

/**
 * Map a color token (or raw CSS color) to a background hex. Named tokens resolve
 * through {@link COLOR_MAP}; anything else (a raw hex like "#3B82F6", or an
 * already-resolved value) passes through unchanged. Missing input → white.
 */
export function mapColorToHex(token?: string): string {
  if (!token) return "#FFFFFF";
  const named = COLOR_MAP[token.toLowerCase() as ColorToken];
  return named ?? token;
}

/**
 * Convenience: resolve a button straight to a background hex. Equivalent to
 * `mapColorToHex(resolveButtonColorToken(...))`. This preserves the old
 * client-side `resolveButtonBackground(color, glyph)` behavior and doubles as
 * the renderer's fallback for boards that predate server-side color fill.
 */
export function resolveButtonBackground(color?: string, glyph?: string, buttonType?: string): string {
  return mapColorToHex(resolveButtonColorToken({ color, glyph, buttonType }));
}

/**
 * Tailwind border classes by button kind, shared by every board grid so a
 * guess/suggestion/link/back button looks identical on every surface. The grid
 * picks the class from a mix of `buttonType` and the button's action type.
 */
export function resolveBorderClass(input: {
  buttonType?: string;
  isLink?: boolean;
  isBack?: boolean;
}): string {
  const { buttonType, isLink, isBack } = input;
  if (buttonType === "guess") return "border-amber-400 border-2 ring-2 ring-amber-300/50";
  if (buttonType === "suggestion") return "border-violet-400 border-2 ring-2 ring-violet-300/40";
  if (buttonType === "wordfinder") return "border-violet-400 border-2 ring-2 ring-violet-300/40";
  if (buttonType === "more") return "border-gray-300 dark:border-gray-600 border-2";
  if (isLink) return "border-blue-400 border-2";
  if (isBack) return "border-amber-400 border-2";
  return "border-gray-200";
}
