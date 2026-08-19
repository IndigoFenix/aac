// server/services/venue-menus/refinement-agent.ts
//
// The model call behind the refinement pass (§4.2a). Produces ANNOTATIONS;
// `applyMenuRefinement` in menu-refinement.ts decides what of them survives.
//
// Read that file before changing this one. The division of labour is the whole
// safety story: this module may ask for anything, because nothing it returns is
// trusted. Facts are re-read from the raw record, so an invented dish has no
// field to arrive in. Keep it that way — do not "simplify" by having the model
// return whole items.
//
// Claude Haiku 4.5 through the project's existing plumbing. Runs ONCE per venue
// ever (the menu cache is global), so cost and latency are immaterial.

import type { JSONSchema } from "../chat/gpt";
import { getStructuredProvider } from "../providers/provider-factory";
import type { RawMenuItem } from "./menu-refinement.js";
import { extractStructuredPayload } from "./structured-payload.js";

const PROVIDER = "claude" as const;
/** Resolved by shared/llm-options to claude-haiku-4-5. */
const MODEL = "claude-haiku";

/** ~60 items of annotations plus envelope. */
const MAX_TOKENS = 8000;

const REFINEMENT_SCHEMA: JSONSchema = {
  type: "object",
  additionalProperties: false,
  required: ["entries"],
  properties: {
    entries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "keep", "kind"],
        properties: {
          index: { type: "number", description: "The row number given in the input." },
          keep: { type: "boolean", description: "False for anything that is not orderable." },
          kind: {
            type: "string",
            enum: ["food", "drink", "condiment", "notice", "unknown"],
            description: "notice = a message to customers, not something to order.",
          },
          imageKey: {
            type: "string",
            description: "English snake_case concept for icon art, e.g. iced_coffee.",
          },
          translatedName: { type: "string", description: "The dish name in the TARGET language." },
          duplicateOf: { type: "number", description: "Row number this repeats." },
        },
      },
    },
  },
};

/**
 * Terse by policy (docs/PROMPT_WRITING.md). The examples are real rows from the
 * טומי רול and Aroma teardowns — the exact failures this pass exists to fix.
 */
const REFINEMENT_PROMPT = `
You label rows scraped from a restaurant menu so they can become picture buttons
for a child who cannot speak.

<rules>
- Label every row. Never rename, reprice, or merge one.
- keep=false for anything not orderable: notices, headings, opening hours.
- imageKey: English, snake_case, generic. A brand becomes its food.
- duplicateOf: only for the SAME dish at the SAME price.
</rules>

<examples>
"לקוחות יקרים!" (a message about delivery) -> keep false, kind notice
"רוטב שום" ₪1                              -> keep true, kind condiment, imageKey garlic_sauce
"Ice Aroma" (blended coffee)               -> keep true, kind drink, imageKey iced_coffee
second "Greek Chickpea Salad" at ₪40       -> duplicateOf the first row
</examples>
`.trim();

export interface RefinementAgentOptions {
  /** Language to translate names into. Omit to skip translation. */
  targetLanguage?: string;
  model?: string;
}

/**
 * Ask the model to annotate `items`. Returns the raw entries array for
 * `applyMenuRefinement` to validate — deliberately NOT the applied result, so
 * the validation step can never be skipped by a caller reaching for a
 * convenience wrapper.
 *
 * Returns [] on any failure. An empty annotation set means every row is kept
 * unannotated (annotation fails OPEN), which is a worse board but never a
 * wrong one.
 */
export async function requestMenuRefinement(
  items: readonly RawMenuItem[],
  options: RefinementAgentOptions = {},
): Promise<unknown[]> {
  if (!items.length) return [];

  // Numbered so the model's `index` refers to something unambiguous. Price is
  // included because it is what distinguishes two sizes of one dish from a
  // genuine duplicate.
  const rows = items
    .map((item, i) => {
      const price = item.priceText ?? (item.price !== undefined ? String(item.price) : "");
      const parts = [`${i}.`, item.name, price, item.category ? `[${item.category}]` : ""];
      return parts.filter(Boolean).join(" ");
    })
    .join("\n");

  const target = options.targetLanguage
    ? `\nTranslate each name into ${options.targetLanguage}.`
    : "\nDo not translate.";

  try {
    const response = await getStructuredProvider(PROVIDER).structuredComplete({
      model: options.model ?? MODEL,
      instructions: REFINEMENT_PROMPT + target,
      schemaName: "menu_refinement",
      schema: REFINEMENT_SCHEMA,
      maxTokens: MAX_TOKENS,
      temperature: 0,
      input: [{ type: "message", role: "user", content: rows }],
    });

    return parseRefinementResponse(response);
  } catch (err) {
    console.warn("[refinement-agent] failed, keeping raw items:", (err as Error)?.message);
    return [];
  }
}

/**
 * Pull the entries array out of a provider response. Exported for tests —
 * this parses untrusted model output and earns direct coverage.
 */
export function parseRefinementResponse(response: unknown): unknown[] {
  const payload = extractStructuredPayload(response);
  const entries = payload?.entries;
  return Array.isArray(entries) ? entries : [];
}
