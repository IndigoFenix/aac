// client-aac/src/lib/guessing-board-repair.ts
//
// Repairs a Word Finder board where BoardManager wrote the narrowing options'
// LOCALIZED LABELS as ordinary buttons instead of emitting the registry
// `suggestion:<dim>:<value>` keys it was given.
//
// Why this lives on the client: the labels only exist here. The suggestion
// registry (shared/guessing-mode) carries `labelEn` and an i18n `labelKey`;
// the actual translations live in `client-aac/src/i18n/*`, which the server
// tsconfig cannot reach (`@shared/*` only). So the server's own recovery
// (`recoverOfferedSuggestionKey`) can only compare against the raw English
// value — which is exactly the wrong tool in a Hebrew session, and Hebrew is
// where the failure was found.
//
// The failure, from the 2026-08-27 session log (11:34:11): the engine offered
// `suggestion:actions.who:{alone,with_others,together}` and BoardManager
// returned `{"label":"לבד"}`, `{"label":"עם אחרים"}`, `{"label":"ביחד"}` —
// byte-identical to `guessing.who.*` in he.ts. Those are plain buttons, so the
// press left as an ordinary utterance, never reached the narrowing engine, and
// the Word Finder sat on `pace` for four minutes.
//
// The server now also INJECTS the offered keys when a rebuild carries none
// (see the backstop in agent-coordinator's rebuild_board handler). That fixes
// reachability but would leave the AI's hand-authored copy sitting next to the
// real button — same word, twice. Re-tagging here makes the duplicate
// detectable, and the de-dup pass collapses it.

import {
  parseSuggestionKey,
  getSuggestionEntry,
} from "@shared/guessing-mode/suggestion-registry";

interface RepairableButton {
  label?: string;
  buttonType?: string;
  suggestionKey?: string;
  [k: string]: unknown;
}

/** Loose label comparison: case/whitespace/trailing-punctuation insensitive.
 *  Deliberately NOT locale-aware beyond `toLowerCase` — the strings being
 *  compared are the same registry label rendered twice, not free text. */
function norm(s: string | undefined): string {
  return (s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,!?;:־–—-]+$/u, "")
    .trim();
}

/**
 * Build `normalized label → suggestion key` for the keys the CURRENT narrowing
 * question offers. Each key contributes its localized label, its English label
 * and its raw value, so the match survives whichever of the three the model
 * happened to copy.
 */
function offeredLabelIndex(
  offeredKeys: string[],
  t: (key: string) => string,
): Map<string, string> {
  const index = new Map<string, string>();
  for (const key of offeredKeys) {
    const parsed = parseSuggestionKey(key);
    if (!parsed) continue;
    const entry = getSuggestionEntry(parsed.dimension, parsed.value);
    if (!entry) continue;
    // t() returns the key itself when a translation is missing — never index
    // that, or a button labelled "guessing.who.alone" would match.
    const translated = t(entry.labelKey);
    const candidates = [
      translated !== entry.labelKey ? translated : undefined,
      entry.labelEn,
      parsed.value,
    ];
    for (const c of candidates) {
      const n = norm(c);
      // First key wins: two offered keys should never share a label, but if
      // they somehow do, silently rebinding the second is worse than skipping.
      if (n && !index.has(n)) index.set(n, key);
    }
  }
  return index;
}

/**
 * Put the LOCALIZED label on every registry suggestion button.
 *
 * The server expands these from the shared registry and can only bake
 * `labelEn`; the translation is the client's job. `DynamicBoard` and
 * `SentenceConstructorBoard` each localize at render, but `AppMiniBoard` — the
 * strip beside an open app, and the board during a game — renders `label`
 * straight through `SentenceButton`, so English leaked onto a Hebrew board
 * whenever the Word Finder was used with an app open (reported 2026-08-27).
 * `spokenText` moves with it: `AppMiniBoard.handleClick` speaks
 * `spokenText || label`, so a stale English label is also SPOKEN in a Hebrew
 * voice.
 *
 * Doing it here — once, at ingest — means every surface gets it, including any
 * renderer added later. The per-render calls stay correct and idempotent:
 * `t(labelKey)` on an already-localized button returns the same string.
 */
export function localizeSuggestionButtons<T extends RepairableButton>(
  buttons: T[],
  t: (key: string) => string,
): T[] {
  let changed = false;
  const out = buttons.map((b) => {
    if (b.buttonType !== "suggestion" || !b.suggestionKey) return b;
    const parsed = parseSuggestionKey(b.suggestionKey);
    const entry = parsed ? getSuggestionEntry(parsed.dimension, parsed.value) : null;
    if (!entry) return b;
    const translated = t(entry.labelKey);
    // t() echoes the key when the translation is missing — keep the server's
    // English rather than rendering "guessing.who.alone".
    if (!translated || translated === entry.labelKey || translated === b.label) return b;
    changed = true;
    return { ...b, label: translated, spokenText: translated };
  });
  return changed ? out : buttons;
}

/**
 * Re-tag hand-authored copies of the offered narrowing options as real
 * suggestion buttons, then drop duplicates of the same key.
 *
 * A button that ALREADY arrived as `buttonType: "suggestion"` is canonical —
 * the server expanded it from the registry, so it carries the right icon and
 * colour. When a canonical button and a re-tagged one collide, the canonical
 * one survives regardless of board order.
 */
export function repairGuessingButtons<T extends RepairableButton>(
  buttons: T[],
  offeredKeys: string[],
  t: (key: string) => string,
): T[] {
  if (!buttons.length) return buttons;
  // No live question (not narrowing, or ready for guesses) — nothing to re-tag,
  // but any suggestion button already on the board still needs its translation.
  const index = offeredKeys.length ? offeredLabelIndex(offeredKeys, t) : new Map<string, string>();
  if (index.size === 0) return localizeSuggestionButtons(buttons, t);

  const repaired = buttons.map((b) => {
    if (b.buttonType === "suggestion" && b.suggestionKey) return b;
    const key = index.get(norm(b.label));
    if (!key) return b;
    // Keep the model's own artwork — it drew something for this concept and
    // the child may already be aiming at it. Only the routing is wrong.
    return { ...b, buttonType: "suggestion", suggestionKey: key };
  });

  // De-dup by key, preferring a button that arrived canonical.
  const bestIndexForKey = new Map<string, number>();
  repaired.forEach((b, i) => {
    const key = b.suggestionKey;
    if (!key) return;
    const prev = bestIndexForKey.get(key);
    if (prev == null) {
      bestIndexForKey.set(key, i);
      return;
    }
    const prevCanonical = buttons[prev].buttonType === "suggestion";
    const thisCanonical = buttons[i].buttonType === "suggestion";
    if (!prevCanonical && thisCanonical) bestIndexForKey.set(key, i);
  });

  const deduped = repaired.filter((b, i) => {
    const key = b.suggestionKey;
    if (!key) return true;
    return bestIndexForKey.get(key) === i;
  });
  return localizeSuggestionButtons(deduped, t);
}

/** Board-IR wrapper for {@link repairGuessingButtons} — repairs every page. */
export function repairGuessingBoard<B>(
  board: B,
  offeredKeys: string[],
  t: (key: string) => string,
): B {
  const b = board as unknown as { pages?: Array<{ buttons?: RepairableButton[] }> } | null;
  if (!b?.pages?.length) return board;
  let changed = false;
  const pages = b.pages.map((page) => {
    if (!page?.buttons?.length) return page;
    const next = repairGuessingButtons(page.buttons, offeredKeys, t);
    if (next === page.buttons) return page;
    changed = true;
    return { ...page, buttons: next };
  });
  return changed ? ({ ...b, pages } as unknown as B) : board;
}
