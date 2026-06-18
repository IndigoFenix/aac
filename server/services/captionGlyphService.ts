// server/services/captionGlyphService.ts
//
// Video Caption Studio — the text→glyph step. Takes caption lines (already
// parsed from an SRT/VTT on the client) and asks the LLM to express each one
// as an AAC glyph SENTENCE, using the SAME glyph grammar the live board-manager
// and clinician board editor speak (buildGlyphSyntax + the bundled canonical
// vocabulary). The result is a glyph string per caption, keyed by index, which
// the client overlays on the video and (later) bakes into an exported MP4.
//
// This is the OPPOSITE direction from interpretationService (glyph→text); here
// we GENERATE glyphs from natural language, so we reuse the generation grammar
// rather than the interpretation prompt.

import { getStructuredProvider } from "./providers/provider-factory";
import type { JSONSchema, GPTInputItem } from "./chat/gpt";
import { settingsRepository } from "../repositories/settingsRepository";
import { chargeModelUsage } from "./credit-ledger";
import { buildGlyphSyntax, buildCustomSymbolsBlock, buildKnownPeopleBlock } from "./memory-schema/glyph-syntax";
import type { GlyphCustomSymbol, GlyphKnownPerson } from "./memory-schema/glyph-syntax";
import { getBundledIconsBlock } from "./memory-schema/aac-memory-schema";

/** One caption line to convert. `index` ties the result back to its segment. */
export interface CaptionGlyphInput {
  index: number;
  text: string;
}

/** The glyph string produced for a caption line. */
export interface CaptionGlyphResult {
  index: number;
  glyph: string;
}

export interface ConvertCaptionsOptions {
  /** BCP-47-ish language label for the caption text (e.g. "en", "he"). */
  language?: string;
  /** Per-student custom SYMBOLs the AI may reference as `symbol:ID`. */
  customSymbols?: GlyphCustomSymbol[];
  /** Per-student known people the AI may reference as `face:ID`. */
  knownPeople?: GlyphKnownPerson[];
  /** For cost attribution. */
  studentId?: string | null;
  userId?: string | null;
}

// Convert in batches so a long subtitle file stays within model limits and a
// single malformed line can't poison the whole job. Tuned conservatively;
// raise once we've watched real-world token use.
const BATCH_SIZE = 25;

const GLYPH_RESULT_SCHEMA: JSONSchema = {
  type: "object",
  additionalProperties: false,
  required: ["glyphs"],
  properties: {
    glyphs: {
      type: "array",
      description: "One entry per caption line provided, in any order.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "glyph"],
        properties: {
          index: {
            type: "integer",
            description: "The `index` of the caption line this glyph is for.",
          },
          glyph: {
            type: "string",
            description:
              "The glyph SENTENCE for this caption, following the grammar (e.g. \"i_me+want+🍎\", \"🐕.big\", \"😴#question\").",
          },
        },
      },
    },
  },
};

function buildInstructions(opts: ConvertCaptionsOptions): string {
  const grammar = buildGlyphSyntax({ singleGlyphButtons: false });
  const icons = getBundledIconsBlock();
  const customSymbols = buildCustomSymbolsBlock(opts.customSymbols);
  const knownPeople = buildKnownPeopleBlock(opts.knownPeople);
  const lang = opts.language || "the caption language";

  const task = `<task>
You are converting the captions/subtitles of a video into AAC glyph SENTENCEs, so a non-verbal AAC user can follow along visually. The caption text is in ${lang}.

For EACH numbered caption line you receive, produce ONE glyph SENTENCE that captures its core communicative meaning, following the <grammar> above. Rules for THIS task:
  - Keep it simple and concrete. Captions are often long; distil each to its essential meaning (a 1–3 GLYPH SENTENCE), not a word-for-word transcription.
  - Glyphs are language-neutral pictures — choose SYMBOLs by MEANING, regardless of the caption's language.
  - Prefer emoji + canonical modifier and canonical registry keys. Use \`generate:\` only as a true last resort per <generation_rules>.
  - If a caption carries no concrete communicative content (e.g. "[music]", "♪♪", a stray sound), return a single best-effort GLYPH such as \`🎵\` rather than inventing words.
  - Return exactly one entry per provided \`index\`. Do not add, drop, or renumber lines.
</task>`;

  return [grammar, icons, customSymbols, knownPeople, task]
    .filter((s) => s && s.trim() !== "")
    .join("\n\n");
}

async function convertBatch(
  batch: CaptionGlyphInput[],
  instructions: string,
  cfg: { provider: any; model: string },
  opts: ConvertCaptionsOptions,
): Promise<CaptionGlyphResult[]> {
  const provider = getStructuredProvider(cfg.provider);

  const input: GPTInputItem[] = [
    {
      type: "message",
      role: "user",
      content:
        "Convert these caption lines to glyph SENTENCEs. Return one entry per index.\n\n" +
        JSON.stringify(batch.map((b) => ({ index: b.index, text: b.text }))),
    },
  ];

  const response = await provider.structuredComplete({
    model: cfg.model,
    input,
    instructions,
    schemaName: "CaptionGlyphs",
    schema: GLYPH_RESULT_SCHEMA,
    temperature: 0.4,
    maxTokens: 2048,
  });

  // Cost is real even when parsing fails — charge first.
  await chargeModelUsage({
    provider: cfg.provider,
    model: cfg.model,
    promptTokens: response.promptTokens || 0,
    completionTokens: response.completionTokens || 0,
    cachedTokens: response.cachedTokens || 0,
    cacheCreationTokens: response.cacheCreationTokens || 0,
    studentId: opts.studentId ?? null,
    userId: opts.userId ?? null,
    category: "video-caption",
    label: "video-caption-glyphs",
  }).catch((err) => console.error("[captionGlyphService] cost ledger charge failed:", err));

  // Structured providers return `content` as a JSON string (see sessionSummary).
  let parsed: any = response.content;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      console.error("[captionGlyphService] content was not valid JSON:", String(parsed).slice(0, 200));
      return [];
    }
  }

  const glyphs = parsed?.glyphs;
  if (!Array.isArray(glyphs)) return [];

  const results: CaptionGlyphResult[] = [];
  for (const entry of glyphs) {
    if (
      entry &&
      typeof entry.index === "number" &&
      Number.isInteger(entry.index) &&
      typeof entry.glyph === "string" &&
      entry.glyph.trim() !== ""
    ) {
      results.push({ index: entry.index, glyph: entry.glyph.trim() });
    }
  }
  return results;
}

/**
 * Convert caption lines into glyph SENTENCEs. Processes in batches and merges
 * the results, keyed by the caller-supplied `index`. Missing/malformed entries
 * are simply omitted from the result — the caller decides how to render gaps.
 *
 * Throws only on a hard provider failure; per-line parse problems degrade
 * gracefully to fewer results.
 */
export async function convertCaptionsToGlyphs(
  captions: CaptionGlyphInput[],
  opts: ConvertCaptionsOptions = {},
): Promise<CaptionGlyphResult[]> {
  if (captions.length === 0) return [];

  const cfg = await settingsRepository.getLLMConfig("clinician");
  const instructions = buildInstructions(opts);

  const batches: CaptionGlyphInput[][] = [];
  for (let i = 0; i < captions.length; i += BATCH_SIZE) {
    batches.push(captions.slice(i, i + BATCH_SIZE));
  }

  const all: CaptionGlyphResult[] = [];
  for (const batch of batches) {
    const batchResults = await convertBatch(batch, instructions, cfg, opts);
    all.push(...batchResults);
  }

  // De-dupe by index (defensive — a model could echo an index twice) and order
  // by index so the caller can zip straight onto its ordered segment list.
  const byIndex = new Map<number, string>();
  for (const r of all) {
    if (!byIndex.has(r.index)) byIndex.set(r.index, r.glyph);
  }
  return Array.from(byIndex.entries())
    .map(([index, glyph]) => ({ index, glyph }))
    .sort((a, b) => a.index - b.index);
}
