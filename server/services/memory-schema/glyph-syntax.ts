// server/services/memory-schema/glyph-syntax.ts
//
// SINGLE SOURCE for the glyph "button syntax" explanation shared by every AI
// that composes board buttons: the live AAC agents (board-manager + legacy
// single-agent path) AND the clinician board editor (which edits the board via
// memory-modification on /Context_Board). Each consumer keeps only its own
// format wrapper (the live AAC uses a `speech|sentence|fallback|label` PIPE
// string; the clinician edits button JSON objects), but the grammar +
// generation rules + the per-student palette (custom SYMBOLs / faces) all come
// from here so they never drift again.
//
// The grammar/generation-rules text is the live board-manager's (the hot path),
// copied verbatim and parameterized by `singleGlyphButtons`. The static
// canonical-vocabulary block stays in aac-memory-schema's getBundledIconsBlock()
// and is appended by each consumer (buildGlyphSyntax intentionally does NOT call
// it, to avoid an import cycle).

import { T } from "./canonical-terms";

/**
 * The grammar (SYMBOL preference order + GLYPH/modifier rules + SENTENCE/OPERATOR
 * composition) and the `generate:` last-resort + mandatory-fallback rules.
 * Parameterized by single-glyph mode (single GLYPH per button vs up-to-3 joined
 * with `+`). Append getBundledIconsBlock() after this for the canonical vocab.
 */
export function buildGlyphSyntax({ singleGlyphButtons }: { singleGlyphButtons: boolean }): string {
  return `<grammar>
  SYMBOL: one word. Every SENTENCE is built out of SYMBOLs. Choose them in this STRICT preference order — generation is a last resort:

    1. \`symbol:ID\` / \`face:ID\` — a custom SYMBOL or face stored for this user. FIRST CHOICE.
    2. **EMOJI + canonical modifier** — your DEFAULT. Almost any concrete-noun-with-a-quality can be expressed as an emoji HEAD with one or more canonical MODIFIERs from <bundled_icons>:
         • "red apple"   → \`🍎.color_red\`     (NOT \`generate:red_apple\`)
         • "big book"    → \`📖.big\`           (NOT \`generate:big_book\`)
         • "my dog"      → \`🐕.my\`            (NOT \`generate:my_dog\`)
         • "two cookies" → \`🍪.two\`           (NOT \`generate:two_cookies\`)
       This is BY FAR the most common case.
    3. A canonical registry key from <bundled_icons> — for pronouns, abstract verbs, time concepts, deictics, and ALL modifier SYMBOLs.
    4. A raw emoji (🍎, 🤗, 🎮, …) — for concrete nouns not covered by a custom symbol.
    5. \`generate:<key>\` — LAST RESORT. See <generation_rules>.

  NEVER emit a bare snake_case word that isn't in <bundled_icons>. Bare unknown snake_case renders as ❓.

  GLYPH: HEAD SYMBOL + zero or more MODIFIER SYMBOLs joined with \`.\`:
    - \`🍎\`, \`🍎.color_red\`, \`🍪.two\`, \`📖.my\`, \`🤗.big.please\`

  MODIFIER SYMBOLs are ALWAYS either from the canonical registry, or emojis. Words like \`.new\`, \`.old\`, \`.sad\`, \`.funny\`, \`.american\`, \`.scary\` are NOT modifiers — they render as meaningless dots. If you need an adjective the registry doesn't have:
    - Use an emoji if one exists (😢 for "sad", 👴 for "old man", 😨 for "scary").
    - Or drop the adjective from the visual and put it in the spoken \`speech\` field only.
  Never invent a modifier outside the registry${singleGlyphButtons ? "" : ", and never compose multi-GLYPH SENTENCEs just to attach an adjective"}.

${singleGlyphButtons
  ? `  SENTENCE: one GLYPH per ${T.button}. Each ${T.button}'s \`sentence\` field is a single GLYPH (head + optional MODIFIER SYMBOLs).

  OPERATOR: sentence-level tag appended with \`#\`. \`#past\`, \`#future\`, \`#question\` modify the WHOLE sentence — they never add a second GLYPH. Conjugate the spoken \`speech\` accordingly; the visual stays the same.`
  : `  SENTENCE: up to 3 GLYPHs joined with \`+\`:
    - 1-glyph: \`😴\`, \`🍎.color_red\`
    - 2-glyph: \`i_me+🤒\`, \`have+💧\`
    - 3-glyph: \`i_me+want+🍌\`, \`you+give+i_me\`
  Match SENTENCE shape to meaning — don't pad. One-word answers are 1-glyph; full subject+verb+object thoughts are 3-glyph.

  OPERATOR: sentence-level tag via \`#\` — \`#past\`, \`#future\`, \`#question\`. They modify the WHOLE sentence — never substitute for a GLYPH. Conjugate \`speech\` accordingly.`}
</grammar>

<generation_rules>
\`generate:<key>\` triggers async image generation — takes ~5 seconds and may fail. LAST RESORT.

**Self-check before EVERY \`generate:\` call:**
Would the fallback you'd write be a COMPLETE expression of the concept on its own (not just a generic stand-in)? If YES — the fallback IS the answer. Use it as the SENTENCE directly with NO fallback field. \`generate:\` should only fire when the fallback is a deliberately APPROXIMATE placeholder for something the canonical vocab can't fully express.

Examples of the trap (NEVER do this) — the fallback is the complete answer:
  - sentence: \`generate:purple_storm\`, fallback: \`⛈️.color_purple\` ← \`⛈️.color_purple\` IS a purple storm cloud. Write \`sentence: "⛈️.color_purple"\` with no fallback.
  - sentence: \`generate:red_apple\`, fallback: \`🍎.color_red\` ← \`🍎.color_red\` IS a red apple. Use the fallback as sentence.
  - sentence: \`generate:big_dog\`, fallback: \`🐕.big\` ← \`🐕.big\` IS a big dog. Use the fallback as sentence.
  - sentence: \`generate:hippopotamus\`, fallback: \`🦛\` ← the hippo emoji IS a hippo. Use \`🦛\` directly.

Valid \`generate:\` (fallback is a deliberately weaker approximation):
  - sentence: \`generate:planet_mars\`, fallback: \`🌑.color_red\` ← \`🌑.color_red\` is a reddish round object; a generated image actually depicts Mars. Worth the cost.
  - sentence: \`generate:violin\`, fallback: \`🎻\`? — wait, the violin emoji exists, so this would be a trap. Pick a TRULY missing object like \`generate:cello\` (no cello emoji) with fallback \`🎻\` (a stand-in string instrument).
  - sentence: \`generate:seagull\`, fallback: \`🐦.🏖️\` ← "beach bird" is the best approximation, but doesn't really capture a seagull. Generate the image, and use the object and modifier as a fallback.

WHEN NOT to generate (almost always):
  - Color, size, quantity, possession, intensity qualities — canonical modifiers (\`.color_purple\`, \`.big\`, \`.two\`, \`.my\`, \`.very\`) already exist. Compose emoji+modifier; never \`generate:color_noun\`, \`generate:big_noun\`, etc.
  - Phrases or abstractions (\`generate:my_day\`, \`generate:something_new\`) — image generator can't draw an idea.
  - Anything already a normal emoji (including 🦛 hippo, 🦒 giraffe, 🦘 kangaroo, 🦔 hedgehog, 🦥 sloth, 🦦 otter, 🦨 skunk, 🦝 raccoon, 🦡 badger, 🦃 turkey, 🦚 peacock, 🦜 parrot, 🦅 eagle, 🦆 duck, 🦉 owl, 🦩 flamingo — check the bundled icons before assuming an animal is missing).

WHEN to generate (rarely):
  - Specific scientific objects (\`generate:planet_mars\`, \`generate:black_hole\`).
  - Specific animals genuinely missing from emoji (\`generate:t_rex\`, \`generate:seagull\`).
  - Specific tools genuinely missing from emoji (\`generate:cello\`, \`generate:telescope\`).
  - Specific named people not covered by face:ID.

Generation key format: lowercase_snake_case, English, short concrete noun phrase. Include category disambiguators (\`planet_mars\` not \`mars\`, \`animal_bat\` not \`bat\`).

Fallback for a generated SENTENCE — ALWAYS REQUIRED, NEVER contains \`generate:\`:
  - The fallback is shown immediately while generation is in progress (and permanently if generation fails).
  - May only use: emojis, canonical registry keys, \`symbol:ID\` / \`face:ID\`, canonical modifiers.
  - Mirror the SHAPE of the \`sentence\` field. The fallback should be deliberately LESS specific than the generated image will be — that's how you know \`generate:\` is warranted.
</generation_rules>`;
}

/** A custom SYMBOL available to a student (subset of the repository's ResolvedSymbol). */
export interface GlyphCustomSymbol {
  id: string;
  key?: string | null;
  description?: string | null;
}

/**
 * The `<custom_symbols>` palette block — the per-student custom SYMBOLs the AI may
 * reference as `symbol:ID`. Returns "" when there are none. Same format the live
 * board-manager uses, so every consumer lists custom symbols identically.
 */
export function buildCustomSymbolsBlock(symbols: GlyphCustomSymbol[] | undefined): string {
  if (!symbols || symbols.length === 0) return "";
  return `<custom_symbols>
Reference a custom SYMBOL as \`symbol:ID\`. Prefer custom SYMBOLs over canonical keys, emojis, and \`generate:\` when one fits.
${symbols.map(s => `- ${s.key || s.id}${s.description ? ` — ${s.description}` : ""} (id: ${s.id})`).join("\n")}
</custom_symbols>`;
}

/** A known person/face available to a student. */
export interface GlyphKnownPerson {
  id: string;
  name: string;
  relationship?: string | null;
}

/**
 * The `<known_people>` palette block — the per-student faces the AI may reference
 * as `face:ID`. Returns "" when there are none. For consumers without a live
 * `<presence>` block (e.g. the clinician board editor); the live agents already
 * surface faces via presence.
 */
export function buildKnownPeopleBlock(contacts: GlyphKnownPerson[] | undefined): string {
  if (!contacts || contacts.length === 0) return "";
  return `<known_people>
Reference a known person's face as \`face:ID\`. Prefer a face over a plain name when the person is known.
${contacts.map(c => `- ${c.name}${c.relationship ? ` (${c.relationship})` : ""} [face:${c.id}]`).join("\n")}
</known_people>`;
}
