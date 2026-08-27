// client-aac/src/lib/sidebar-layout.ts
//
// HOW THE SENTENCE BUILDER'S TWO SIDEBAR COLUMNS DIVIDE THEIR HEIGHT.
//
// The board's category tabs and sub-category chips are `flex-col` columns
// inside a fixed-height board. They used to hold at most SIX content-sized
// buttons — a constant picked for the shortest screen we ship, so it was wrong
// at both ends: a tall screen drew six small buttons and left the bottom third
// of the column empty, a short one still squeezed six in and clipped their
// labels.
//
// So the column is MEASURED and the buttons FILL it (user, 2026-08-27):
//
//   capacity  — how many buttons of at least `SIDEBAR_MIN_BUTTON_PX` fit in the
//               measured height. This is the WHOLE column's budget: the pinned
//               entries ("all", "photos") and the "…" pager each cost one, the
//               same rule the old constant answered to.
//   page      — which items are shown when there are more than fit, and
//               whether the pager is needed at all.
//   fill      — the class that makes each button share the height instead of
//               sizing to its content, so the column ends flush with the board.
//   density   — how tightly a button draws, keyed off the height it ACTUALLY
//               gets rather than off how many buttons there are: five buttons
//               on a tall screen are roomy and five on a short one are not, and
//               only the measurement can tell those apart.
//
// Pure arithmetic + class names, no DOM: the component owns the ResizeObserver
// and passes the height in. Extracted so the geometry has a test of its own —
// the same split `builder-rules.ts` already makes for the board's compose rules.

/** The smallest button that still reads: an icon over one line of label. */
export const SIDEBAR_MIN_BUTTON_PX = 58;
/** `gap-2` / `p-2` on the nav, in pixels — the arithmetic must match the CSS. */
export const SIDEBAR_GAP_PX = 8;
export const SIDEBAR_PAD_PX = 8;
/** Never fewer than this, however short the screen (a column of one is a pager
 *  with nothing to page), nor more — past ten a button is a sliver whatever the
 *  measurement says. */
export const SIDEBAR_MIN_BUTTONS = 3;
export const SIDEBAR_MAX_BUTTONS = 10;
/** Before the first measurement lands: the historical cap, so nothing jumps. */
export const SIDEBAR_FALLBACK_BUTTONS = 6;

/** Every sidebar button shares the column's height rather than sizing to its
 *  own content — `basis-0` so the flex line starts from nothing and the space
 *  is split evenly, `min-h-0` so a long label cannot push the column taller
 *  than the board. This is the class that makes the column FULL. */
export const SIDEBAR_BUTTON_FILL = "flex-1 basis-0 min-h-0";

/** How many buttons a column of this pixel height may hold, pager included.
 *  `0` (unmeasured) keeps the pre-measurement cap. */
export function sidebarCapacity(heightPx: number): number {
  if (!heightPx) return SIDEBAR_FALLBACK_BUTTONS;
  const usable = heightPx - SIDEBAR_PAD_PX * 2 + SIDEBAR_GAP_PX;
  const fits = Math.floor(usable / (SIDEBAR_MIN_BUTTON_PX + SIDEBAR_GAP_PX));
  return Math.max(SIDEBAR_MIN_BUTTONS, Math.min(SIDEBAR_MAX_BUTTONS, fits));
}

/**
 * One page of a sidebar column: how many ITEMS fit beside the `fixed` pinned
 * buttons, and whether a pager is needed at all. The pager takes a slot of its
 * own, so asking for it costs an item.
 *
 * Paging WRAPS (the pager is a cycle, not an end-stop) — a child who keeps
 * pressing "…" comes back round to where they started rather than reaching a
 * dead button.
 */
export function sidebarPage<T>(
  items: readonly T[],
  fixed: number,
  page: number,
  capacity: number,
): { items: T[]; needsMore: boolean } {
  const room = Math.max(1, capacity - fixed);
  if (items.length <= room) return { items: [...items], needsMore: false };
  const perPage = Math.max(1, room - 1);
  const start = (((page * perPage) % items.length) + items.length) % items.length;
  return { items: [...items.slice(start), ...items.slice(0, start)].slice(0, perPage), needsMore: true };
}

export interface SidebarDensity {
  pad: string;
  icon: string;
  label: string;
  face: string;
}

/**
 * COMPRESS BEFORE YOU CLIP. A column of two buttons can afford a big icon and a
 * roomy label; a column of ten cannot, and squashing them equally is what made
 * the labels unreadable. The classes step down together so the button keeps its
 * shape — icon, gap and label — instead of the label being cut off.
 *
 * `heightPx` of 0 (unmeasured) falls back to the count thresholds this drew
 * with before the column was measured.
 */
export function sidebarDensity(count: number, heightPx: number): SidebarDensity {
  const n = Math.max(1, count);
  const per = heightPx ? (heightPx - SIDEBAR_PAD_PX * 2 - SIDEBAR_GAP_PX * (n - 1)) / n : 0;
  const tight = per ? per < 66 : count >= 5;
  const snug = per ? per < 88 : count === 4;
  return {
    pad: tight ? "py-1 gap-0.5" : snug ? "py-1.5 gap-1" : "py-2 gap-1",
    icon: tight ? "text-lg" : snug ? "text-xl" : "text-2xl",
    label: tight ? "text-[10px] leading-tight" : "text-xs",
    face: tight ? "w-8 h-8" : snug ? "w-10 h-10" : "w-12 h-12",
  };
}
