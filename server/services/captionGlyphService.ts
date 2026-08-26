// server/services/captionGlyphService.ts
//
// Video Caption Studio — the text→glyph step. Takes caption lines (already
// parsed from an SRT/VTT on the client) and asks the LLM to express each one
// as an AAC glyph SENTENCE, using the SAME glyph grammar the live board-manager
// speaks — the STRUCTURED JSON form (`{ sym | gen, mods?, fb? }` GLYPH objects),
// NOT the brittle `+`/`.`/`#` string DSL. The model authors a structured glyph
// array per caption; we serialize it to the canonical glyph/fallback STRINGS via
// serializeGlyph (exactly as the BoardManager does), keyed by index. The client
// overlays those strings on the video and bakes them into an exported MP4.
//
// This is the OPPOSITE direction from interpretationService (glyph→text); here
// we GENERATE glyphs from natural language, so we reuse the generation grammar
// rather than the interpretation prompt.

import { getStructuredProvider } from "./providers/provider-factory";
import type { JSONSchema, GPTInputItem } from "./chat/gpt";
import { settingsRepository } from "../repositories/settingsRepository";
import { chargeCaptionModelUsage } from "./captionCost";
import { buildGlyphSyntaxJson, glyphItemJsonSchema, buildCustomSymbolsBlock, buildKnownPeopleBlock } from "./memory-schema/glyph-syntax";
import type { GlyphCustomSymbol, GlyphKnownPerson } from "./memory-schema/glyph-syntax";
import { getBundledIconsBlock } from "./memory-schema/aac-memory-schema";
import { serializeGlyph, type GlyphSym, type GlyphOp } from "./dual-agent/interactive-agent";
import { captionDebug, captionDebugSeparator } from "./caption-debug-log";
import { getVocabularyItem } from "@shared/glyph-registry";
import { resolveEmoji, isEmoji } from "@shared/emoji-registry";

/** One caption line to convert. `index` ties the result back to its segment. */
export interface CaptionGlyphInput {
  index: number;
  text: string;
}

/** The glyph string produced for a caption line. */
export interface CaptionGlyphResult {
  index: number;
  glyph: string;
  /** Immediate stand-in glyph for a `generate:` sentence (shown until/if the
   * generated image is ready). Empty when the glyph needs no generation. */
  fallback?: string;
}

export interface ConvertCaptionsOptions {
  /** BCP-47-ish language label for the caption text (e.g. "en", "he"). */
  language?: string;
  /** Per-student custom SYMBOLs the AI may reference as `symbol:ID`. */
  customSymbols?: GlyphCustomSymbol[];
  /** Per-student known people the AI may reference as `face:ID`. */
  knownPeople?: GlyphKnownPerson[];
  /** Free-form caption requests from the user (e.g. via the chat tool). */
  customInstructions?: string;
  /** For cost attribution. */
  studentId?: string | null;
  userId?: string | null;
  instituteId?: string | null;
  sessionId?: string | null;
  videoHash?: string | null;
  videoName?: string | null;
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
            type: "array",
            description:
              "The SENTENCE for this caption: an ARRAY of 1–3 structured GLYPH objects (see <glyph_syntax>), rendered left→right. A `gen` GLYPH carries its own `fb` fallback — never write a separate fallback string.",
            items: glyphItemJsonSchema({ allowGenerate: true }) as any,
          },
          op: {
            type: "string",
            enum: ["past", "future", "question"],
            description:
              "OPTIONAL sentence-level OPERATOR tagging the whole SENTENCE. Omit unless the caption is clearly past/future/a question.",
          },
        },
      },
    },
  },
};

function buildInstructions(opts: ConvertCaptionsOptions): string {
  // Same grammar source (incl. `gen` + `fb` rules) the AAC board-manager uses,
  // in its STRUCTURED JSON form, so caption glyphs follow identical rules.
  // Generated images are produced in the background and the fallback is shown
  // until they're ready (see the controller + client).
  const grammar = buildGlyphSyntaxJson({ singleGlyphButtons: false, allowGenerate: true, generationStance: "eager" });
  const icons = getBundledIconsBlock();
  const customSymbols = buildCustomSymbolsBlock(opts.customSymbols);
  const knownPeople = buildKnownPeopleBlock(opts.knownPeople);
  const lang = opts.language || "the caption language";

  const task = `<task>
You are converting the captions/subtitles of a video into AAC glyph SENTENCEs, so a non-verbal AAC user can follow the video visually. The caption text is in ${lang}.

Convey the IDEA, not the words. For EACH numbered caption line, produce ONE glyph SENTENCE — an ARRAY of 1–3 structured GLYPH objects following <glyph_syntax> above — that captures what the speaker is communicating: the meaning an AAC user should grasp at a glance, NOT a literal word-for-word transcription. For THIS task:
  - Distil each line to its essential idea (a 1–3 GLYPH SENTENCE). Drop filler, hedges, and connective words that don't carry the idea.
  - Glyphs are language-neutral pictures — choose SYMBOLs by MEANING, regardless of the caption's language.
  - **There is NO spoken field here — the GLYPH is all the user sees. So a \`sym\` MUST render to a real picture: an emoji, a canonical <bundled_icons> key, or \`symbol:ID\`/\`face:ID\`. A plain word that is NOT one of those (e.g. "miss", "history", "alone", "normal", "different", "remember", "together", "hard") renders as a blank ❓ and is USELESS.**
  - For concrete physical objects that are genuinely missing, use a \`gen\` GLYPH with a resolvable \`fb\` fallback (the image generator will draw the object you specify).
  - \`past\` / \`future\` / \`question\` are sentence OPERATORs: put them in \`op\`, NEVER as a \`sym\`.

Conveying abstract ideas is the hardest part of this task. Follow these rules:
  - All GLYPHs must be real, renderable pictures. For abstract ideas, pick a concrete physical object that evokes the idea, or a picture of a person/animal doing something that evokes the idea.
  - Ideally, use a real emoji or canonical key.
  - If no emoji or canonical key fits well, use a \`gen\` GLYPH (with a resolvable \`fb\` fallback) — that's how a richer picture gets drawn. Follow <generation_rules>; a generated picture is encouraged whenever it's clearer than the closest emoji.
  - Remember that the image generator will not be aware of the context of the video, it will simply be told to draw the object you specify. So pick a concrete, unambiguous object that evokes the idea, not an abstract concept.
  - If a word has multiple meanings, use snake_case to clarify which meaning you intend (e.g. \`gen:bat_animal\` vs \`gen:bat_sports\`).
  - Some canonical keys are abstract words, because the system already contains an icon to represent them. You can use these. DO NOT invent a new abstract key and try to generate it, though.

  - If a line carries no concrete communicative content (e.g. "[music]", "♪♪", a stray sound), return a single best-effort GLYPH such as \`[{ "sym": "🎵" }]\`.
  - Return exactly one entry per provided \`index\`. Do not add, drop, or renumber lines.${
    opts.customInstructions?.trim()
      ? `\n\nAdditional instructions from the user (honor these):\n${opts.customInstructions.trim()}`
      : ""
  }
</task>`;

  return [grammar, icons, customSymbols, knownPeople, task]
    .filter((s) => s && s.trim() !== "")
    .join("\n\n");
}

/** A structured entry as the model returns it, before serialization. */
interface RawGlyphEntry {
  index: number;
  glyph: GlyphSym[];
  op?: GlyphOp;
}

/** True iff a head SYMBOL renders to a real visual (NOT ❓). Mirrors the
 *  compositor's canResolveKey: emoji, canonical key (image or emoji), or a
 *  `symbol:`/`face:` reference. A bare unlisted word like "miss" is FALSE. */
function symResolves(sym: string | undefined): boolean {
  if (!sym) return false;
  if (sym.startsWith("symbol:") || sym.startsWith("face:")) return true;
  if (isEmoji(sym)) return true;
  const item = getVocabularyItem(sym);
  if (item?.imagePath || item?.emoji) return true;
  if (resolveEmoji(sym)) return true;
  return false;
}

/** True iff a MODIFIER key renders (canonical modifier facet, or a raw emoji). */
function modValid(mod: string): boolean {
  if (!mod) return false;
  if (isEmoji(mod)) return true;
  return !!getVocabularyItem(mod)?.modifier;
}

/** Tokens in one structured SENTENCE that would render as ❓ / a dead dot. A
 *  `gen` GLYPH is allowed (the image is drawn async) PROVIDED its `fb` itself
 *  resolves — that's what shows until/if generation lands. Empty array = clean. */
function invalidTokens(glyph: GlyphSym[]): string[] {
  const bad: string[] = [];
  for (const g of glyph) {
    if (!g || typeof g !== "object") {
      bad.push("(empty glyph)");
      continue;
    }
    if (g.gen) {
      if (!g.fb || !symResolves(g.fb.sym)) {
        bad.push(`gen:"${g.gen}" (its fallback "${g.fb?.sym ?? ""}" doesn't render — give an emoji/canonical fb)`);
      }
      for (const m of g.fb?.mods ?? []) if (!modValid(m)) bad.push(`.${m}`);
    } else if (!symResolves(g.sym)) {
      bad.push(`"${g.sym ?? ""}"`);
    }
    for (const m of g.mods ?? []) if (!modValid(m)) bad.push(`.${m}`);
  }
  return bad;
}

/** Drop the glyph objects that would render as ❓ (last-resort repair after
 *  retries are exhausted, so a bad line degrades to fewer GLYPHs rather than a
 *  question mark). Keeps `gen` GLYPHs whose `fb` resolves. */
function repairGlyph(glyph: GlyphSym[]): GlyphSym[] {
  return glyph.filter((g) => {
    if (!g || typeof g !== "object") return false;
    if (g.gen) return !!g.fb && symResolves(g.fb.sym);
    return symResolves(g.sym);
  });
}

/** One model call: charge, log, and parse the structured `glyphs` array. */
async function runGlyphModel(
  lines: CaptionGlyphInput[],
  instructions: string,
  correctionNote: string | undefined,
  cfg: { provider: any; model: string },
  opts: ConvertCaptionsOptions,
  attempt: number,
): Promise<RawGlyphEntry[]> {
  const provider = getStructuredProvider(cfg.provider);

  const userText =
    "Convert these caption lines to glyph SENTENCEs. Return one entry per index.\n\n" +
    JSON.stringify(lines.map((b) => ({ index: b.index, text: b.text }))) +
    (correctionNote ? `\n\n${correctionNote}` : "");
  const input: GPTInputItem[] = [{ type: "message", role: "user", content: userText }];

  captionDebugSeparator(`GLYPH PASS — ${lines.length} line(s), attempt ${attempt} (${cfg.provider}/${cfg.model})`);
  if (attempt === 1) captionDebug("SYSTEM INSTRUCTIONS (sent to model)", instructions);
  captionDebug("USER INPUT (sent to model)", input);

  const response = await provider.structuredComplete({
    // Background: caption glyphs are precomputed, not awaited.
    background: true,
    model: cfg.model,
    input,
    instructions,
    schemaName: "CaptionGlyphs",
    schema: GLYPH_RESULT_SCHEMA,
    temperature: 0.4,
    // Structured GLYPH arrays are more verbose than the old glyph strings —
    // give a full batch room so the JSON isn't truncated mid-array.
    maxTokens: 4096,
  });

  captionDebug("RAW MODEL RESPONSE content", response.content);

  // Cost is real even when parsing fails — charge first.
  await chargeCaptionModelUsage(
    {
      userId: opts.userId ?? null,
      studentId: opts.studentId ?? null,
      instituteId: opts.instituteId ?? null,
      sessionId: opts.sessionId ?? null,
      videoHash: opts.videoHash ?? null,
      videoName: opts.videoName ?? null,
      language: opts.language ?? null,
      category: "video-caption",
      label: "video-caption-glyphs",
    },
    {
      provider: cfg.provider,
      model: cfg.model,
      promptTokens: response.promptTokens || 0,
      completionTokens: response.completionTokens || 0,
      cachedTokens: response.cachedTokens || 0,
      cacheCreationTokens: response.cacheCreationTokens || 0,
    },
  );

  let parsed: any = response.content;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      // The model output is built over the video transcript — size only on stdout.
      console.error("[captionGlyphService] content was not valid JSON:", String(parsed).length, "chars");
      return [];
    }
  }
  const glyphs = parsed?.glyphs;
  if (!Array.isArray(glyphs)) return [];

  const out: RawGlyphEntry[] = [];
  for (const entry of glyphs) {
    if (!entry || typeof entry.index !== "number" || !Number.isInteger(entry.index)) continue;
    if (!Array.isArray(entry.glyph)) continue;
    out.push({
      index: entry.index,
      glyph: entry.glyph as GlyphSym[],
      op: typeof entry.op === "string" ? (entry.op as GlyphOp) : undefined,
    });
  }
  return out;
}

// One retry: the model regularly puts bare non-canonical words ("miss",
// "history", "alone") in `sym`, which render as ❓. Relying on the prose rule
// alone doesn't hold (Claude especially), so we VALIDATE the structured output
// against the actual vocabulary and re-ask for the offending lines with
// pointed feedback — the same validate→feedback loop the live BoardManager uses.
const GLYPH_MAX_ATTEMPTS = 2;

async function convertBatch(
  batch: CaptionGlyphInput[],
  instructions: string,
  cfg: { provider: any; model: string },
  opts: ConvertCaptionsOptions,
): Promise<CaptionGlyphResult[]> {
  // Accumulate the best structured entry we have per index across attempts.
  const byIndex = new Map<number, RawGlyphEntry>();
  let pending: CaptionGlyphInput[] = batch;
  let correctionNote: string | undefined;

  for (let attempt = 1; attempt <= GLYPH_MAX_ATTEMPTS && pending.length > 0; attempt++) {
    const raw = await runGlyphModel(pending, instructions, correctionNote, cfg, opts, attempt);
    const rawByIndex = new Map(raw.map((r) => [r.index, r]));

    const stillBad: CaptionGlyphInput[] = [];
    const feedbackLines: string[] = [];
    for (const line of pending) {
      const entry = rawByIndex.get(line.index);
      // Model omitted or blanked this line — don't chase omissions with a retry
      // (the caller renders text only for a gap). Retry is reserved for the real
      // problem: a glyph that came back with non-renderable SYMBOLs.
      if (!entry || entry.glyph.length === 0) continue;
      // Keep the latest attempt's entry (a partly-bad entry still beats nothing
      // and is repaired at the end if it never comes clean).
      byIndex.set(line.index, entry);
      const bad = invalidTokens(entry.glyph);
      if (bad.length > 0) {
        stillBad.push(line);
        feedbackLines.push(`Line ${line.index} ("${line.text}") — non-renderable SYMBOL(s): ${bad.join(", ")}.`);
      }
    }

    captionDebug(`VALIDATION attempt ${attempt}`, {
      clean: pending.length - stillBad.length,
      stillBad: stillBad.map((l) => l.index),
    });

    pending = stillBad;
    if (pending.length === 0) break;
    correctionNote = `Some lines used SYMBOLs that DON'T EXIST in the vocabulary and will render as a blank ❓. A \`sym\` must be a real emoji, a canonical key from <bundled_icons>, or \`symbol:ID\`/\`face:ID\` — NEVER a plain word like "miss", "history", "alone", "normal". For an abstract idea with no emoji and no canonical key, pick the closest emoji or DROP that GLYPH (there is no spoken field to carry it). For a concrete physical object that's genuinely missing, use a \`gen\` GLYPH with a resolvable \`fb\`. \`past\`/\`future\`/\`question\` go in \`op\`, never as a \`sym\`. Re-do ONLY these lines:\n${feedbackLines.join("\n")}`;
  }

  // Serialize survivors, repairing any that never came fully clean so nothing
  // renders as ❓ in the final output.
  const results: CaptionGlyphResult[] = [];
  for (const [index, entry] of byIndex) {
    let glyphObjs = entry.glyph;
    if (invalidTokens(glyphObjs).length > 0) {
      glyphObjs = repairGlyph(glyphObjs);
      captionDebug(`REPAIR line ${index}`, { kept: glyphObjs });
    }
    if (glyphObjs.length === 0) continue; // nothing renderable — drop, client shows text
    const ser = serializeGlyph(glyphObjs, entry.op);
    const glyph = ser.sentence.trim();
    const fallback = (ser.fallback ?? "").trim();
    if (glyph === "") continue;
    results.push({ index, glyph, ...(fallback ? { fallback } : {}) });
  }

  results.sort((a, b) => a.index - b.index);
  captionDebug("SERIALIZED RESULTS (string glyph + fallback, stored in DB)", results);
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
  const byIndex = new Map<number, CaptionGlyphResult>();
  for (const r of all) {
    if (!byIndex.has(r.index)) byIndex.set(r.index, r);
  }
  return Array.from(byIndex.values()).sort((a, b) => a.index - b.index);
}
