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
//   - A `role: "bid"` button (a question or request that hands the turn back)
//     is painted BID_COLOR. See the note on `resolveButtonColorToken`.

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
 *   3. `role: "bid"` → BID_COLOR. Everything else is deliberately unpainted.
 *   4. Plain white.
 *
 * ONE OWNER. This function is the only place a BUTTON's fill is decided. The
 * glyph compositor has its own `TONE_COLORS` plate, but every button surface
 * passes `noBackground` to suppress it — that palette predates the fixed
 * quick-action row and collides with it in three places. TONE_COLORS survives
 * only for standalone, shell-less glyph surfaces such as the world-engine's
 * baked SVGs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY SO FEW COLOURS (narrowed 2026-08-24)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A board carries THREE fills and no more: yes-green, no-red, bid-orange.
 *
 * Green and red are symbol-derived and absolute. They are the two most
 * overlearned buttons on the device, anchored to the same hexes in the fixed
 * quick-action row, and nothing may repaint them.
 *
 * BID is the third because it is the one distinction that is both worth drawing
 * and reliably known. It means "this button hands the conversation back", and
 * the Board Manager sets `role` on essentially every button it authors (91 in
 * one live session, against 0 for the speech-act field that briefly lived
 * beside it). It is also the right density for a colour — the prompt asks for
 * 2–3 bids on a conversational board, so it marks a few buttons out of twelve
 * rather than the majority.
 *
 * A wider palette was tried and pulled: social→pink, repair→violet, and a
 * widening of green/red to the whole affirm/reject family. Those keyed off the
 * glyph registry's `ToneFamily`, which classifies WORDS rather than utterances
 * — `tone: "social"` holds twelve people nouns — so pink landed on "I want to
 * talk to mom" and read as random. `role` cannot fail that way: it comes from
 * the model reading the conversation, not from a word-level tag. See the note
 * at the top of shared/aac/speech-act.ts.
 *
 * The result is a value suitable for `button.color`; the renderer turns it into
 * a background via {@link mapColorToHex}.
 */
export function resolveButtonColorToken(input: {
  color?: string;
  glyph?: string;
  buttonType?: string;
  /** Conversational role. "bid" earns BID_COLOR; "reply"/omitted earn nothing. */
  role?: string;
}): string {
  const { color, glyph, buttonType, role } = input;
  // ⚖️ PURPLE IS THE WORD FINDER'S MEANING, not its default — the ONE token
  // that outranks an explicit `color`. Its label and icon are the AI's to
  // choose (an entry may read "something else" or "I'm afraid of…"), so the
  // fill is all that is left to tell a child this press opens a search
  // instead of speaking a sentence. A model that also paints its buttons
  // must not be able to spend that signal.
  //
  // `more` is deliberately NOT in this position: its appearance is fixed
  // anyway (reload symbol, fixed caption), so its colour carries no load an
  // explicit override could destroy — and letting a colour win there is
  // behaviour that predates this and is pinned by board-more-button.test.ts.
  if (buttonType === "wordfinder") return SPECIAL_BUTTON_COLORS.wordfinder;
  if (color && color.trim()) return color;
  if (buttonType === "more") return SPECIAL_BUTTON_COLORS.more;
  // Yes/no BEFORE bid: a yes/no button is essentially never a bid, but if one
  // were ever marked as both, the learned colour has to win.
  const auto = detectYesNoDefaultColor(glyph);
  if (auto) return auto;
  if (role === "bid") return "orange";
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
export function resolveButtonBackground(
  color?: string,
  glyph?: string,
  buttonType?: string,
  role?: string,
): string {
  return mapColorToHex(resolveButtonColorToken({ color, glyph, buttonType, role }));
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
