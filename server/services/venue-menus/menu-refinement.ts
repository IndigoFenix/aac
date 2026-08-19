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
//                              imageKey is rejected; the raw item stands as-is.
//
// The allergen filter (§3.3) runs AFTER this and stays fail-closed. It reads raw
// name/description text, never a translation or a `kind` from here — a refinement
// pass must not be able to widen what a student is shown.

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
  /** Auto-icon pipeline key. English, snake_case, unambiguous, no proper nouns. */
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
      ...(entry.imageKey ? { imageKey: entry.imageKey } : {}),
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
