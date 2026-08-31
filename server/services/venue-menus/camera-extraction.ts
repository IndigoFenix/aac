// server/services/venue-menus/camera-extraction.ts
//
// CAMERA MENU EXTRACTION — the trust anchor of Location Menus.
//
// The caretaker points the AAC camera at the physical menu; this turns those
// frames into structured items. It is the only source that cannot suffer the
// wrong-restaurant defect (§3.1a): the menu is on the table in front of the
// student, it is current, it includes today's specials, and it is already in
// the right language.
//
// A DEDICATED one-shot call, deliberately NOT the Observer. The Observer runs a
// Live session for scene narration; document extraction is a different task
// with a different prompt and cost profile. Same shape as
// http-observer-agent.ts / http-speaker-agent.ts: one request, structured out,
// no session state.
//
// See planning-docs/aac-restaurant-menus.md §4.2.

import type { JSONSchema } from "../chat/gpt";
import type { LLMProviderKey } from "@shared/llm-options";
import { getStructuredProvider } from "../providers/provider-factory";
import { mergeExtractedPages, type ExtractedPage, type MergeResult } from "./page-merge.js";
import { extractStructuredPayload } from "./structured-payload.js";
import type { DisclosureContext } from "../processorDisclosure";

/** Extraction is a read, not a judgement — the cheap tier is the right tier. */
const DEFAULT_PROVIDER: LLMProviderKey = "gemini";
const DEFAULT_MODEL = "gemini-2.5-flash";

/** A menu page is long. Enough headroom for ~60 items plus the JSON envelope. */
const MAX_TOKENS = 8000;

/** Frames per capture. Beyond this a caretaker is photographing the wallpaper. */
export const MAX_FRAMES = 8;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * One frame's output. Kept flat and shallow on purpose — nested optionals are
 * where small models produce malformed calls.
 */
const MENU_PAGE_SCHEMA: JSONSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    language: {
      type: "string",
      description: "Language code the menu is WRITTEN in, e.g. he, en, ar.",
    },
    currency: {
      type: "string",
      description: "ISO-4217 code if a currency symbol is visible, e.g. ILS.",
    },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "confidence"],
        properties: {
          name: {
            type: "string",
            description: "The dish name EXACTLY as printed. Do not translate.",
          },
          description: { type: "string" },
          price: { type: "number", description: "Numeric price. Omit if none is printed." },
          priceText: { type: "string", description: "Price as printed, e.g. ₪48." },
          category: {
            type: "string",
            description: "The menu's own section heading, as printed.",
          },
          confidence: {
            type: "number",
            description: "0-1. How sure you are you read this row correctly.",
          },
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * Terse by policy (docs/PROMPT_WRITING.md, [[feedback_prompt_conciseness]]):
 * imperatives, tag markup, one example, no explaining.
 *
 * The three COPY / DO NOT rules carry the §3.2 safety requirement into the
 * model's instructions — but they are NOT what enforces it. Enforcement is
 * `applyMenuRefinement` refusing to take facts from a model at all. This
 * prompt just makes the right behavior the easy one.
 */
const EXTRACTION_PROMPT = `
You read PHOTOGRAPHS OF RESTAURANT MENUS into structured data.

<rules>
- COPY each row exactly as printed. Never translate, correct, or tidy a name.
- Omit any field you cannot read. Never guess a price.
- Set confidence below 0.6 when glare, angle, or a hand obscures the row.
- Skip page furniture: logos, addresses, opening hours, "follow us".
</rules>

<example>
Printed:  רול אנטריקוט  48₪   (בחרו ירקות, סלטים ורטבים)
Emitted:  name "רול אנטריקוט", priceText "₪48", price 48,
          description "בחרו ירקות, סלטים ורטבים", confidence 0.95
</example>

Return every food and drink row you can see. One entry per row.
`.trim();

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export interface CameraExtractionOptions {
  provider?: LLMProviderKey;
  model?: string;
  /** Hint from the venue record; the model still reports what it actually sees. */
  expectedLanguage?: string;
  /** AKIM §18.5 — who this capture is about. A menu photo comes off the
   *  student's own device camera, so the send is recorded like any other. */
  disclosure?: DisclosureContext;
}

export interface CameraExtractionResult extends MergeResult {
  /** How many frames produced usable output — a caretaker-facing count. */
  framesRead: number;
  /** Frames that failed outright (model error, unparseable). */
  framesFailed: number;
}

/** Strip a data-URL prefix if the caller passed one; the API wants either. */
function toDataUrl(frame: string): string {
  return frame.startsWith("data:") ? frame : `data:image/jpeg;base64,${frame}`;
}

/**
 * Extract one frame. Exported for tests and for retrying a single bad photo
 * without re-billing the whole capture.
 */
export async function extractMenuPage(
  frameBase64: string,
  options: CameraExtractionOptions = {},
): Promise<ExtractedPage | null> {
  const provider = getStructuredProvider(options.provider ?? DEFAULT_PROVIDER);

  const hint = options.expectedLanguage
    ? `\nThis menu is probably in ${options.expectedLanguage}.`
    : "";

  const response = await provider.structuredComplete({
    disclosure: options.disclosure,
    // Background: menu extraction runs once per venue and is reviewed before use.
    background: true,
    model: options.model ?? DEFAULT_MODEL,
    instructions: EXTRACTION_PROMPT + hint,
    schemaName: "menu_page",
    schema: MENU_PAGE_SCHEMA,
    maxTokens: MAX_TOKENS,
    // Deterministic: two runs over one photo should not disagree about a price.
    temperature: 0,
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_image", image_url: toDataUrl(frameBase64) },
          { type: "input_text", text: "Read this menu." },
        ],
      },
    ],
  });

  return parseExtractionResponse(response);
}

/**
 * Pull the page out of a provider response, tolerating the shapes a structured
 * call can come back in. Returns null rather than throwing — one unreadable
 * frame must not lose the other seven.
 *
 * Exported for tests: this is parsing untrusted model output, so it earns
 * direct coverage rather than only being exercised through a mock provider.
 */
export function parseExtractionResponse(response: unknown): ExtractedPage | null {
  const obj = extractStructuredPayload(response);
  if (!obj) return null;
  if (!Array.isArray(obj.items)) return null;

  const items = obj.items
    .filter((i): i is Record<string, unknown> => !!i && typeof i === "object")
    .map((i) => ({
      name: typeof i.name === "string" ? i.name : "",
      ...(typeof i.description === "string" && i.description ? { description: i.description } : {}),
      ...(typeof i.price === "number" && Number.isFinite(i.price) ? { price: i.price } : {}),
      ...(typeof i.priceText === "string" && i.priceText ? { priceText: i.priceText } : {}),
      ...(typeof i.category === "string" && i.category ? { category: i.category } : {}),
      ...(typeof i.confidence === "number" ? { confidence: i.confidence } : {}),
    }))
    .filter((i) => i.name.trim().length > 0);

  return {
    items,
    ...(typeof obj.language === "string" && obj.language ? { language: obj.language } : {}),
    ...(typeof obj.currency === "string" && obj.currency ? { currency: obj.currency } : {}),
  };
}

/**
 * Extract a whole capture: N frames of one menu, merged.
 *
 * Frames run CONCURRENTLY — a caretaker is standing at a table holding a phone,
 * and eight sequential round trips is a wait they will abandon. Order is
 * preserved by index, not by completion, so menu order survives.
 *
 * A frame that throws is counted and skipped. Losing one photo of a four-page
 * menu is recoverable; failing the whole capture because the third shot was
 * blurry is not.
 */
export async function extractMenuFromFrames(
  frames: readonly string[],
  options: CameraExtractionOptions = {},
): Promise<CameraExtractionResult> {
  const capped = frames.slice(0, MAX_FRAMES);

  const settled = await Promise.all(
    capped.map((frame) =>
      extractMenuPage(frame, options).catch((err) => {
        console.warn("[camera-extraction] frame failed:", (err as Error)?.message);
        return null;
      }),
    ),
  );

  const pages = settled.filter((p): p is ExtractedPage => p !== null);
  const merged = mergeExtractedPages(pages);

  return {
    ...merged,
    framesRead: pages.length,
    framesFailed: capped.length - pages.length,
    // A capture where frames dropped is a partial menu, and the caretaker is
    // the only one who can tell whether what survived is the whole menu.
    requiresReview: merged.requiresReview || pages.length < capped.length,
  };
}
