// server/services/dual-agent/board-button-validator.ts
//
// Pure, dependency-light board-button validation extracted from live-relay so
// it can be unit-tested without pulling in the relay's heavy runtime deps
// (ws, live providers, TTS, repositories). Depends only on the shared glyph /
// emoji modules and the canonical-terms constants.

import { getVocabularyItem } from "@shared/glyph-registry";
import { resolveEmoji, isEmoji } from "@shared/emoji-registry";
import { parseGlyph, stripBrackets } from "@shared/glyph-compositor.js";
import { T } from "../memory-schema/canonical-terms";

/**
 * Walk a glyph string and add any slot keys, payload keys, or modifier
 * keys that look like generation-eligible imageKeys into `into`. A key is
 * eligible only when it would otherwise render as "❓": NOT a raw emoji,
 * NOT a `symbol:`/`face:` ref, NOT in the glyph registry with a bundled
 * image or emoji, and NOT covered by the supplementary emoji registry.
 *
 * Modifiers are walked too — `water.spicy` should queue generation for
 * "spicy" so the badge resolves to a real image instead of a dot
 * placeholder. Canonical modifiers (in the registry) skip the lookup.
 */
export function collectGlyphImageKeys(glyph: string, into: Set<string>): void {
  if (!glyph) return;
  const parsed = parseGlyph(glyph);
  const addIfImageKey = (key: string) => {
    if (!key) return;
    if (isEmoji(key)) return;
    if (key.startsWith("symbol:") || key.startsWith("face:")) return;
    const item = getVocabularyItem(key);
    if (item?.imagePath || item?.emoji) return;
    if (resolveEmoji(key)) return;
    into.add(key);
  };
  for (const slot of parsed.slots) {
    addIfImageKey(slot.key);
    if (slot.payload) addIfImageKey(slot.payload);
    for (const modKey of slot.modifiers) addIfImageKey(modKey);
  }
}

/**
 * True when `glyphString` contains at least one slot/payload/modifier that
 * would route to async image generation — i.e. a snake_case key that is
 * neither a raw emoji, nor a `symbol:`/`face:` ref, nor a canonical
 * registry entry, nor present in the supplementary emoji registry. Pure
 * read-only check — does NOT queue generation.
 */
export function glyphHasImageKey(glyphString: string | undefined): boolean {
  if (!glyphString) return false;
  const set = new Set<string>();
  collectGlyphImageKeys(glyphString, set);
  return set.size > 0;
}

/**
 * Collect modifier slots that aren't in the canonical registry's modifier
 * vocabulary. The model frequently invents modifiers like `.new`, `.old`,
 * `.sad`, `.funny`, `.adventure`, `.american` — none of which are real
 * modifier SYMBOLs. The compositor has no image for them so the slot
 * renders as a meaningless dot. We reject these so the AI gets feedback
 * and can rebuild with a real modifier (or carry the quality in the
 * speech field instead).
 *
 * A modifier is valid when the registry entry exists AND carries a
 * `modifier` facet — same gate the compositor uses to decide whether to
 * actually render the badge.
 */
export function collectInvalidModifiers(glyph: string | undefined): string[] {
  if (!glyph) return [];
  const bad: string[] = [];
  const seen = new Set<string>();
  const parsed = parseGlyph(glyph);
  for (const slot of parsed.slots) {
    for (const modKey of slot.modifiers) {
      if (!modKey) continue;
      // Strip a possible `generate:` prefix so we evaluate the bare key.
      // The AI shouldn't be using `generate:` in modifier position at all,
      // but we want a clear "this isn't a modifier" error rather than a
      // generation attempt for the inner string.
      const bareKey = stripBrackets(modKey);
      if (seen.has(bareKey)) continue;
      seen.add(bareKey);
      // Emojis are valid modifiers — the compositor renders them as
      // image badges in a corner. (E.g. `📖.😢` = sad book.) Skip the
      // registry check for emoji modifiers.
      if (isEmoji(bareKey)) continue;
      const item = getVocabularyItem(bareKey);
      // A registry hit only counts as a modifier when it actually carries
      // a modifier facet — `apple` has a registry entry but isn't a
      // modifier; `.apple` would render nonsensically.
      if (!item || !item.modifier) {
        bad.push(modKey);
      }
    }
  }
  return bad;
}

/**
 * Hard-coded board-button validator. Drops buttons that fail any of the
 * structural rules below and returns the kept set plus a list of human-
 * readable error strings the relay forwards to the AI via tool_response
 * so it can rebuild correctly:
 *
 *   1. A glyph containing any imageKey MUST come with a non-empty
 *      glyphFallback. Without it the button renders as ❓ until generation
 *      completes (or forever, if it fails).
 *   2. The glyphFallback itself MUST NOT contain any imageKey. The fallback
 *      is what renders WHILE generation is pending, so anything that needs
 *      generation (`generate:`, bare unknown snake_case, non-canonical
 *      modifier on a head) leaves the slot blank → ❓.
 *   3. Modifier slots in EITHER the glyph or the fallback must be from the
 *      canonical registry's modifier vocabulary. Invented modifiers like
 *      `.new`, `.old`, `.sad`, `.funny` have no image and render as a
 *      meaningless dot.
 *   4. No two buttons may share an identical glyph string. The student
 *      can't visually distinguish them.
 *   5. No two buttons may share an identical glyphFallback string (when
 *      both have a fallback). Same visual-collision reasoning.
 *   6. A button must have SOMETHING displayable: a glyph, a glyphFallback,
 *      a symbolPath (`symbol:`/`face:`), or an emoji iconRef. A button left
 *      with only the default `fas fa-comment` iconRef (or a bare legacy
 *      imageKey that never resolved to an emoji) renders as an empty
 *      FontAwesome speech-bubble — never useful to the student. This is the
 *      case that slipped through when the AI omitted both the sentence and
 *      the fallback, or emitted a bare snake_case imageKey with no fallback.
 *
 * Filtered buttons survive; the rest of the board still renders. The AI
 * is expected to retry / patch via a follow-up rebuild_board call when it
 * sees the error array in the tool response.
 */
export function validateBoardButtons<
  T extends {
    label: string;
    glyph?: string;
    glyphFallback?: string;
    imageKey?: string;
    iconRef?: string;
    symbolPath?: string;
  }
>(buttons: T[]): { buttons: T[]; errors: string[] } {
  const kept: T[] = [];
  const errors: string[] = [];
  // Track first-seen owners so the error message can name the conflict.
  const seenGlyph = new Map<string, string>();
  const seenFallback = new Map<string, string>();

  for (const btn of buttons) {
    // (0) Malformed [NARROW:...] prefix surviving the parser. parseBoardButtons
    // strips `[NARROW:<dim>] <value>` when BOTH parts are non-empty and tags
    // the button as `narrow`. A malformed shape — empty dim, missing value,
    // unclosed bracket — leaves the prefix in the label. Surface that here so
    // the model can correct it rather than shipping a confused button to the
    // user.
    if (btn.label.startsWith("[NARROW")) {
      errors.push(
        `Button "${btn.label}" — malformed [NARROW:<dimension>] prefix. ` +
        `Use the exact shape \`[NARROW:dimension_label] value\` with BOTH a non-empty ` +
        `dimension (e.g. "genre", "time of day", "kind of place") AND a non-empty ` +
        `value (the user's choice, e.g. "comedy"). The visible button label is just ` +
        `the value; the dimension is internal narrowing-state metadata.`
      );
      continue;
    }

    // (0b) Malformed [CONTRAST:...] prefix surviving the expander. A well-formed
    // `[CONTRAST:<dim>] A | B` is expanded into one narrow button per pole BEFORE
    // validation; if the prefix is still here the shape was bad (empty dim, or
    // fewer than two poles).
    if (btn.label.startsWith("[CONTRAST")) {
      errors.push(
        `Button "${btn.label}" — malformed [CONTRAST:<dimension>] prefix. ` +
        `Use the exact shape \`[CONTRAST:dimension_label] poleA | poleB\` with a non-empty ` +
        `dimension AND at least two non-empty poles separated by "|" (e.g. ` +
        `"[CONTRAST:feel] more like a cat | more like a dog"). Only valid on rebuild_board.`
      );
      continue;
    }

    // (1) imageKey without fallback.
    if (btn.glyph && glyphHasImageKey(btn.glyph) && !btn.glyphFallback) {
      errors.push(
        `Button "${btn.label}" — glyph "${btn.glyph}" contains an imageKey but no fallback was provided. ` +
        `Wrap imageKeys in [] AND supply a fallback built from emojis or canonical registry keys.`
      );
      continue;
    }

    // (2) imageKey IN the fallback. The fallback must render immediately —
    // anything generation-eligible there leaves the slot blank (❓).
    if (btn.glyphFallback && glyphHasImageKey(btn.glyphFallback)) {
      const fallbackImageKeys = new Set<string>();
      collectGlyphImageKeys(btn.glyphFallback, fallbackImageKeys);
      errors.push(
        `Button "${btn.label}" — fallback "${btn.glyphFallback}" contains ${fallbackImageKeys.size === 1 ? "a key" : "keys"} ` +
        `that would route to image generation: ${[...fallbackImageKeys].map(k => `\`${k}\``).join(", ")}. ` +
        `The fallback must render immediately, so it can use ONLY emojis, canonical registry keys, ` +
        `\`symbol:ID\`, \`face:ID\`, and canonical modifiers. NEVER \`generate:\` in the fallback. ` +
        `Mirror the shape of the sentence (e.g. \`i_me+want+generate:planet_mars\` → fallback \`i_me+want+🌑.color_red\` — pair an existing emoji with a canonical modifier to approximate the generated concept).`
      );
      continue;
    }

    // (3) Non-canonical modifiers in glyph or fallback. These have no
    // registry entry → render as a meaningless dot.
    const badGlyphMods = collectInvalidModifiers(btn.glyph);
    const badFallbackMods = collectInvalidModifiers(btn.glyphFallback);
    if (badGlyphMods.length > 0 || badFallbackMods.length > 0) {
      const parts: string[] = [];
      if (badGlyphMods.length > 0) {
        parts.push(`glyph "${btn.glyph}" uses non-canonical modifier${badGlyphMods.length === 1 ? "" : "s"}: ${badGlyphMods.map(m => `\`.${m}\``).join(", ")}`);
      }
      if (badFallbackMods.length > 0) {
        parts.push(`fallback "${btn.glyphFallback}" uses non-canonical modifier${badFallbackMods.length === 1 ? "" : "s"}: ${badFallbackMods.map(m => `\`.${m}\``).join(", ")}`);
      }
      errors.push(
        `Button "${btn.label}" — ${parts.join("; ")}. ` +
        `Modifiers must be EITHER from the canonical registry's modifier list (count, possession, negation, ` +
        `intensity, size_shape, temperature, color, social — see <bundled_icons>) OR a raw emoji ` +
        `(e.g. \`📖.😢\` for "sad book"). Bare unknown snake_case words like \`.new\`, \`.old\`, \`.funny\` are NOT ` +
        `modifiers — they render as a dot. Either use the emoji version of the quality (\`.😢\` instead of \`.sad\`), ` +
        `pick a different HEAD that already encodes the quality (😢 for "sad"), or carry the quality in the speech field only.`
      );
      continue;
    }

    // (4) duplicate glyph.
    if (btn.glyph) {
      const sig = btn.glyph;
      const owner = seenGlyph.get(sig);
      if (owner !== undefined) {
        errors.push(
          `Button "${btn.label}" — glyph "${btn.glyph}" is identical to button "${owner}". ` +
          `Each button needs a distinct visual; vary the slots or add descriptors.`
        );
        continue;
      }
    }

    // (5) duplicate fallback.
    if (btn.glyphFallback) {
      const sig = btn.glyphFallback;
      const owner = seenFallback.get(sig);
      if (owner !== undefined) {
        errors.push(
          `Button "${btn.label}" — fallback "${btn.glyphFallback}" is identical to button "${owner}". ` +
          `Each fallback must produce a distinct visual.`
        );
        continue;
      }
    }

    // (6) Nothing displayable. After toolArgsToButtons, a button with no
    // glyph, no fallback and no symbolPath falls back to its iconRef. The
    // default sentinel is "fas fa-comment" (a FontAwesome speech bubble),
    // and a bare imageKey that never resolved to an emoji leaves that
    // sentinel in place. Either way the student sees a meaningless bubble
    // with (at best) a spinner, so reject it and tell the AI to supply a
    // real visual. An emoji/text iconRef IS renderable, so single-emoji
    // buttons (fallback "🍎" → iconRef "🍎") still pass.
    const iconRef = btn.iconRef ?? "";
    const iconIsFontAwesome = iconRef.startsWith("fa");
    const iconIsRenderable = iconRef.length > 0 && !iconIsFontAwesome;
    if (!btn.glyph && !btn.glyphFallback && !btn.symbolPath && !iconIsRenderable) {
      errors.push(
        `Button "${btn.label}" has no displayable image — it would render as a blank speech-bubble icon. ` +
        `Give it a \`sentence\` (and, if that sentence uses any \`generate:\` SYMBOL, a \`fallback\`), ` +
        `or a single emoji / \`symbol:ID\` / \`face:ID\`. Never leave a ${T.button} with only a label.`
      );
      continue;
    }

    // Passed all checks. Record signatures so subsequent buttons can clash
    // with this one.
    if (btn.glyph) seenGlyph.set(btn.glyph, btn.label);
    if (btn.glyphFallback) seenFallback.set(btn.glyphFallback, btn.label);
    kept.push(btn);
  }

  return { buttons: kept, errors };
}
