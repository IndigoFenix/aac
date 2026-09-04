// server/services/venue-menus/menu-refinement.ts
//
// THE REFINEMENT PASS — applying a Claude Haiku annotation pass to raw extracted
// menu items, before anything is written to the global menu cache.
//
// See planning-docs/aac-restaurant-menus.md §4.2a.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE IS SHAPED THE WAY IT IS
//
// Raw extraction is not board-ready. Live teardowns produced notice rows sold as
// menu items ("לקוחות יקרים!" — Dear customers!), machine translations that turn
// שניצלונים into "Survivors", and the same salad twice with different tags. A
// cheap classification pass fixes all of that.
//
// But a model asked to "clean up this menu" is exactly where INVENTION creeps in:
// it will correct a name, fill a missing price, or merge two rows into a
// plausible third. §3.2 forbids a student ever being shown a dish the restaurant
// does not serve — they cannot recover from pressing it.
//
// So this file does NOT validate the model's copy of the facts. It never accepts
// one. Refinement arrives keyed by INDEX into the raw list and may contribute
// only a whitelist of annotation fields; every factual field is re-read from the
// raw record. An invented dish has nowhere to land — there is no field it can
// arrive in. Enforcement is structural, not a promise made in a prompt.
//
// FAIL DIRECTIONS (deliberately different, and easy to get backwards):
//   - ANNOTATION fails OPEN  — a row the model forgot is KEPT, `kind: 'unknown'`.
//                              Losing a real menu item because a model omitted it
//                              is worse than showing an unclassified one.
//   - FACTS fail CLOSED      — a bad index, a repeated index, or a malformed
//                              icon is rejected; the raw item stands as-is.
//
// (Until 2026-09-01 a string-matching allergen filter ran after this pass. It
// is out of the serving path by decision — it erased whole categories on term
// collisions and could not inspect bare names anyway. If allergen handling
// returns, it arrives HERE as an annotation — this pass reads every dish — or
// as ask-the-waiter buttons, never as another term list.)

/** An item exactly as extraction produced it. These fields are the FACTS. */
export interface RawMenuItem {
  name: string;
  description?: string;
  /** Numeric price in the menu's currency, when the source carried one. */
  price?: number;
  /** The source's own rendering ("₪48"). Kept verbatim for display. */
  priceText?: string;
  category?: string;
}

/** What a row turned out to be. Drives board placement, never safety. */
export type MenuItemKind = "food" | "drink" | "condiment" | "notice" | "unknown";

const MENU_ITEM_KINDS: readonly MenuItemKind[] = [
  "food",
  "drink",
  "condiment",
  "notice",
  "unknown",
];

/**
 * One annotation from the refinement model. Note what is NOT here: no `name`,
 * no `price`, no `description`. Those are facts, and facts come from the raw
 * record only.
 */
export interface MenuRefinementEntry {
  /** Index into the raw item list this annotation is about. */
  index: number;
  /** False to drop the row (a notice, a section header, a duplicate). */
  keep?: boolean;
  kind?: MenuItemKind;
  /**
   * Dish icon in the REGULAR BOARD's glyph syntax (shared/glyph-compositor.ts):
   * a snake_case head, `.modifier` parts for toppings/flavors (pizza.olive),
   * `+` to join paired concepts (burger+french_fries), emoji allowed as any
   * part. Rendered by the same pipeline that draws Board Manager buttons, so
   * unknown keys flow into auto-symbol generation instead of dying as 🍽️.
   */
  icon?: string;
  /** LEGACY single auto-icon key. Superseded by `icon`; still accepted. */
  imageKey?: string;
  /** The name rendered into the student's language. The original survives. */
  translatedName?: string;
  /** Index of the row this one duplicates. Drops this row, keeps that one. */
  duplicateOf?: number;
  /** Corrected category. Cosmetic — regrouping is allowed, renaming a dish is not. */
  category?: string;
}

/** A raw item plus whatever annotations survived validation. */
export interface RefinedMenuItem extends RawMenuItem {
  kind: MenuItemKind;
  /** Glyph-syntax icon (see MenuRefinementEntry.icon). */
  icon?: string;
  /** LEGACY single key — stored rows predating `icon` carry this instead. */
  imageKey?: string;
  translatedName?: string;
}

export interface RefinementRejection {
  index: number | null;
  reason:
    | "index_out_of_range"
    | "index_not_an_integer"
    | "duplicate_index"
    | "bad_image_key"
    | "bad_icon"
    | "bad_duplicate_target"
    | "self_duplicate"
    | "malformed_entry";
  detail?: string;
}

export interface RefinementResult {
  /** Kept items, in raw order, carrying only validated annotations. */
  items: RefinedMenuItem[];
  /** Rows the pass dropped, with why — the caretaker review surface shows these. */
  dropped: Array<{ index: number; name: string; reason: "not_kept" | "duplicate" }>;
  /** Annotations we refused. Non-empty here is a signal the prompt is drifting. */
  rejected: RefinementRejection[];
}

/**
 * An imageKey must be a lowercase ASCII snake_case word or words — the shape the
 * auto-icon pipeline expects (planning-docs/aac-icon-auto-generate-plan.md).
 * Anything else (a Hebrew string, a sentence, a proper noun in caps, a path)
 * is rejected rather than sent downstream to generate art from.
 */
const IMAGE_KEY_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/** Generous, but a key this long is a sentence, not a concept. */
const MAX_IMAGE_KEY_LENGTH = 48;

/** A whole icon longer than this is describing the dish, not depicting it. */
const MAX_ICON_LENGTH = 64;
/** More slots than a board button can legibly draw. */
const MAX_ICON_SLOTS = 3;
/** Head + this many `.modifier` badges — the compositor's practical ceiling. */
const MAX_ICON_MODIFIERS = 2;

/**
 * Anything a single emoji (with optional variation selectors / ZWJ pieces)
 * looks like. Deliberately loose — a false positive here just means a slot
 * the client compositor renders as text, never an injection surface, because
 * the STRICT branch below already refused `(`, `#`, `:` and friends.
 */
const EMOJI_PART_RE = /^\p{Extended_Pictographic}[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}0-9]*$/u;

/**
 * Validate a glyph-syntax icon WITHOUT the compositor's tolerance. parseGlyph
 * exists to salvage whatever a live model typed; this is the opposite job —
 * an annotation either uses the documented subset or is refused. The subset:
 * slots joined by `+`, modifiers attached by `.`, each part a snake_case key
 * or an emoji. No payloads `()`, no tone tags `#`, no `symbol:`/`face:` refs
 * (a menu model must never mint references into a student's symbol store),
 * no brackets, no whitespace.
 */
export function isValidMenuIcon(icon: string): boolean {
  if (!icon || icon.length > MAX_ICON_LENGTH) return false;
  if (/[()[\]#:\s]/.test(icon)) return false;
  const slots = icon.split("+");
  if (slots.length > MAX_ICON_SLOTS) return false;
  for (const slot of slots) {
    const parts = slot.split(".");
    if (parts.length > 1 + MAX_ICON_MODIFIERS) return false;
    for (const part of parts) {
      if (!part) return false;
      if (part.length > MAX_IMAGE_KEY_LENGTH) return false;
      if (!IMAGE_KEY_RE.test(part) && !EMOJI_PART_RE.test(part)) return false;
    }
  }
  return true;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Apply a refinement pass to raw extracted items.
 *
 * Pure and synchronous — the model call happens elsewhere, so this is trivially
 * testable and the enforcement can be unit-tested without a network or a mock
 * LLM. Any raw item with no surviving annotation is kept unchanged.
 *
 * @param raw        Items exactly as extraction produced them.
 * @param refinement Whatever the model returned. Treated as untrusted input —
 *                   it may be malformed, partial, or hostile, and none of those
 *                   may corrupt the facts.
 */
export function applyMenuRefinement(
  raw: readonly RawMenuItem[],
  refinement: readonly unknown[] | null | undefined,
): RefinementResult {
  const rejected: RefinementRejection[] = [];
  const byIndex = new Map<number, MenuRefinementEntry>();

  for (const candidate of refinement ?? []) {
    if (!isPlainObject(candidate)) {
      rejected.push({ index: null, reason: "malformed_entry", detail: typeof candidate });
      continue;
    }

    const index = candidate.index;
    if (typeof index !== "number" || !Number.isInteger(index)) {
      rejected.push({ index: null, reason: "index_not_an_integer", detail: String(index) });
      continue;
    }
    if (index < 0 || index >= raw.length) {
      // The model referred to an item that does not exist. This is the shape an
      // invented dish would arrive in, so it is refused outright.
      rejected.push({ index, reason: "index_out_of_range" });
      continue;
    }
    if (byIndex.has(index)) {
      // Two annotations for one row — we cannot know which was meant, so the
      // first stands and the second is refused.
      rejected.push({ index, reason: "duplicate_index" });
      continue;
    }

    const entry: MenuRefinementEntry = { index };

    if (typeof candidate.keep === "boolean") entry.keep = candidate.keep;

    if (typeof candidate.kind === "string" && (MENU_ITEM_KINDS as readonly string[]).includes(candidate.kind)) {
      entry.kind = candidate.kind as MenuItemKind;
    }

    if (candidate.icon !== undefined) {
      const icon = candidate.icon;
      if (typeof icon === "string" && isValidMenuIcon(icon)) {
        entry.icon = icon;
      } else {
        // Reject the ANNOTATION, not the item — the row is still real.
        rejected.push({ index, reason: "bad_icon", detail: String(icon) });
      }
    }

    if (candidate.imageKey !== undefined) {
      const key = candidate.imageKey;
      if (typeof key === "string" && key.length <= MAX_IMAGE_KEY_LENGTH && IMAGE_KEY_RE.test(key)) {
        entry.imageKey = key;
      } else {
        // Reject the ANNOTATION, not the item — the row is still real.
        rejected.push({ index, reason: "bad_image_key", detail: String(key) });
      }
    }

    if (typeof candidate.translatedName === "string" && candidate.translatedName.trim()) {
      entry.translatedName = candidate.translatedName.trim();
    }

    if (typeof candidate.category === "string" && candidate.category.trim()) {
      entry.category = candidate.category.trim();
    }

    if (candidate.duplicateOf !== undefined) {
      const dup = candidate.duplicateOf;
      if (typeof dup !== "number" || !Number.isInteger(dup) || dup < 0 || dup >= raw.length) {
        rejected.push({ index, reason: "bad_duplicate_target", detail: String(dup) });
      } else if (dup === index) {
        rejected.push({ index, reason: "self_duplicate" });
      } else {
        entry.duplicateOf = dup;
      }
    }

    byIndex.set(index, entry);
  }

  const items: RefinedMenuItem[] = [];
  const dropped: RefinementResult["dropped"] = [];

  for (let i = 0; i < raw.length; i++) {
    const source = raw[i];
    const entry = byIndex.get(i);

    // ANNOTATION FAILS OPEN: no entry means keep the row, unclassified.
    if (!entry) {
      items.push({ ...source, kind: "unknown" });
      continue;
    }

    if (entry.keep === false) {
      dropped.push({ index: i, name: source.name, reason: "not_kept" });
      continue;
    }

    if (entry.duplicateOf !== undefined) {
      dropped.push({ index: i, name: source.name, reason: "duplicate" });
      continue;
    }

    // Every factual field is re-read from `source`. The annotation contributes
    // only the three fields below — this spread order is the enforcement, so do
    // not "simplify" it by spreading the entry.
    items.push({
      ...source,
      ...(entry.category ? { category: entry.category } : {}),
      kind: entry.kind ?? "unknown",
      // A legacy single imageKey IS a valid one-slot glyph, so it folds into
      // `icon` here rather than surviving as a second field to check forever.
      ...(entry.icon || entry.imageKey ? { icon: entry.icon ?? entry.imageKey } : {}),
      ...(entry.translatedName ? { translatedName: entry.translatedName } : {}),
    });
  }

  return { items, dropped, rejected };
}

/**
 * Board-ready items: everything the refinement kept, minus the notices.
 *
 * Condiments are KEPT here on purpose. Whether twelve ₪1 sauces each earn a
 * button or fold into a modifier is a board-layout decision (§8), and this
 * function has no business making it — dropping them here would silently
 * remove a student's ability to ask for garlic sauce.
 */
export function boardableItems(result: RefinementResult): RefinedMenuItem[] {
  return result.items.filter((item) => item.kind !== "notice");
}
