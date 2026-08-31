// server/services/venue-menus/web-menu-extraction.ts
//
// Reading a fetched menu PAGE into rows (§4.2b) — the text twin of
// camera-extraction.ts.
//
// Same contract as the camera path, and for the same reason: this model may
// COPY rows and may not author them. Nothing it returns is trusted downstream
// either — `cacheMenu` runs `applyMenuRefinement`, which re-reads every factual
// field from the raw record, so an invented dish has no field to arrive in.
//
// A web page differs from a photograph in one way that matters here: it is full
// of things that look like menu rows and are not. Cookie banners, delivery-fee
// notices, "our story", opening hours, and the restaurant's own warning that
// delivery prices differ. The prompt spends its length on that, because a junk
// row that survives becomes a button a child presses.

import type { JSONSchema } from "../chat/gpt";
import { getStructuredProvider } from "../providers/provider-factory";
import { extractStructuredPayload } from "./structured-payload.js";
import { mergeExtractedPages, type ExtractedPage, type MergeResult } from "./page-merge.js";
import type { DisclosureContext } from "../processorDisclosure";

const PROVIDER = "gemini" as const;
const MODEL = "gemini-2.5-flash";

/** A long menu page can carry 100+ rows. */
const MAX_TOKENS = 16_000;

const MENU_PAGE_SCHEMA: JSONSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    language: { type: "string", description: "Language code the menu is WRITTEN in, e.g. he." },
    currency: { type: "string", description: "ISO-4217 code, e.g. ILS. Omit if unclear." },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "confidence"],
        properties: {
          name: { type: "string", description: "The dish name EXACTLY as written." },
          description: { type: "string" },
          price: { type: "number", description: "Numeric price. Omit if none is shown." },
          priceText: { type: "string", description: "Price as written, e.g. ₪48." },
          category: { type: "string", description: "The page's own section heading." },
          confidence: {
            type: "number",
            description: "0-1. Lower when you are unsure this is an orderable dish.",
          },
        },
      },
    },
  },
};

/**
 * Terse by policy (docs/PROMPT_WRITING.md). The DO NOT list is drawn from the
 * live teardowns — every item on it was extracted as a dish by a working
 * prototype.
 */
const EXTRACTION_PROMPT = `
You read RESTAURANT MENU PAGES into structured data.

<rules>
- COPY each dish name exactly as written. Never translate, correct, or tidy it.
- Omit any field you cannot see. Never guess a price.
- Only ORDERABLE dishes and drinks. Nothing else is an item.
- Set confidence below 0.6 when you are unsure a row is a real dish.
</rules>

<not_items>
"Dear customers!" and other notices  ·  delivery fees  ·  opening hours
cookie and privacy banners  ·  "about us"  ·  branch addresses  ·  social links
</not_items>

<example>
Page text:  רול אנטריקוט 48₪ - בחרו ירקות, סלטים ורטבים
Emitted:    name "רול אנטריקוט", priceText "₪48", price 48,
            description "בחרו ירקות, סלטים ורטבים", confidence 0.9
</example>
`.trim();

export interface WebExtractionOptions {
  venueName: string;
  expectedLanguage?: string;
  /** AKIM §18.5 — who this menu work is being done for. */
  disclosure?: DisclosureContext;
}

/**
 * Extract a menu from page text.
 *
 * Returns a MergeResult so the shape matches the camera path exactly — one
 * "page", merged through the same code, so dedupe, the low-confidence rule, and
 * the review escalation all behave identically whichever source produced the
 * rows. Returns null on failure; the caller treats that as "no menu here".
 */
export async function extractMenuFromText(
  text: string,
  options: WebExtractionOptions,
): Promise<MergeResult | null> {
  if (!text.trim()) return null;

  const language = options.expectedLanguage
    ? `\nThe menu is probably written in ${options.expectedLanguage}.`
    : "";

  try {
    const response = await getStructuredProvider(PROVIDER).structuredComplete({
      // Background: web extraction runs once per venue, behind the cache write.
      disclosure: options.disclosure,
      background: true,
      model: MODEL,
      instructions: `${EXTRACTION_PROMPT}\n\nThis page is for: ${options.venueName}.${language}`,
      schemaName: "web_menu_page",
      schema: MENU_PAGE_SCHEMA,
      maxTokens: MAX_TOKENS,
      temperature: 0,
      input: [{ type: "message", role: "user", content: text }],
    });

    const page = parseWebExtraction(response);
    return page ? mergeExtractedPages([page]) : null;
  } catch (error) {
    console.warn("[web-menu-extraction] failed:", (error as Error)?.message);
    return null;
  }
}

/**
 * Pull one page out of a provider response.
 *
 * Exported for tests: this parses untrusted model output, and the envelope it
 * arrives in is the thing that silently broke both other parsers in this
 * folder — see structured-payload.ts.
 */
export function parseWebExtraction(response: unknown): ExtractedPage | null {
  const payload = extractStructuredPayload(response);
  if (!payload || !Array.isArray(payload.items)) return null;

  const items = payload.items
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((item) => ({
      name: typeof item.name === "string" ? item.name : "",
      ...(typeof item.description === "string" && item.description
        ? { description: item.description }
        : {}),
      ...(typeof item.price === "number" && Number.isFinite(item.price)
        ? { price: item.price }
        : {}),
      ...(typeof item.priceText === "string" && item.priceText
        ? { priceText: item.priceText }
        : {}),
      ...(typeof item.category === "string" && item.category ? { category: item.category } : {}),
      ...(typeof item.confidence === "number" ? { confidence: item.confidence } : {}),
    }))
    .filter((item) => item.name.trim().length > 0);

  return {
    items,
    ...(typeof payload.language === "string" && payload.language
      ? { language: payload.language }
      : {}),
    ...(typeof payload.currency === "string" && payload.currency
      ? { currency: payload.currency }
      : {}),
  };
}
