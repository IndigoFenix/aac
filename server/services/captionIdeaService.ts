// server/services/captionIdeaService.ts
//
// Video Caption Studio — the FIRST pass of the two-pass pipeline.
//
// Reads the WHOLE timed transcript and decides the sequence of IDEAS the video
// conveys and WHEN each should appear — re-segmenting raw transcript lines into
// caption-sized units that each express a single idea (the MEANING, not the
// literal words). The second pass (captionGlyphService) then turns each idea
// into a glyph SENTENCE.
//
// This pass deliberately runs as ONE call over the full transcript so the model
// has whole-video context for deciding idea boundaries; the glyph pass is the
// one that batches/caches.

import { getStructuredProvider } from "./providers/provider-factory";
import type { JSONSchema, GPTInputItem } from "./chat/gpt";
import { settingsRepository } from "../repositories/settingsRepository";
import { chargeCaptionModelUsage } from "./captionCost";
import { captionDebug, captionDebugSeparator } from "./caption-debug-log";

/** A timed transcript line in (from STT or a caption file). */
export interface TranscriptLine {
  startMs: number;
  endMs: number;
  text: string;
}

/** A timed idea unit out — `text` is the rephrased idea. */
export interface IdeaSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface ExtractIdeasOptions {
  language?: string;
  /** Free-form caption requests from the user (e.g. via the chat tool). */
  customInstructions?: string;
  studentId?: string | null;
  userId?: string | null;
  /** Cost-attribution context. */
  instituteId?: string | null;
  sessionId?: string | null;
  videoHash?: string | null;
  videoName?: string | null;
}

const IDEAS_SCHEMA: JSONSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ideas"],
  properties: {
    ideas: {
      type: "array",
      description: "Ordered, non-overlapping idea units covering the video.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["startMs", "endMs", "idea"],
        properties: {
          startMs: { type: "integer", description: "Start of the speech expressing this idea (ms)." },
          endMs: { type: "integer", description: "End of the speech expressing this idea (ms)." },
          idea: {
            type: "string",
            description: "Short plain rephrasing of the single idea — the meaning, not the literal words.",
          },
        },
      },
    },
  },
};

function buildInstructions(opts: ExtractIdeasOptions): string {
  const lang = opts.language || "the caption language";
  const custom = opts.customInstructions?.trim()
    ? `\n\nAdditional instructions from the user (honor these):\n${opts.customInstructions.trim()}`
    : "";
  return `<task>
You are the FIRST pass of a video-captioning pipeline for non-verbal AAC users. You receive the full timed transcript of a video as numbered lines, each with start/end times in milliseconds.

Decide the sequence of IDEAS the video conveys and WHEN each should appear, so an AAC user can follow along. Output an ordered list of idea units. Each unit:
  - should be a simplified rephrasing of what is being communicated, but you should still use the voice of the speaker (e.g. if they say "I think we should go to the park", the idea might be "we should go to the park", not "The speaker thinks going to the park is a good idea").
  - should keep the overall purpose and tone of the original speech, and focus on what is most important for an AAC user to understand from it.
  - expresses ONE clear idea — a single statement/concept the audience should grasp at that moment. Split compound or run-on sentences into separate ideas; merge fragments that together form one idea.
  - each idea unit should ideally consist of a subject, verb, and object (who is doing what to whom/what), along with modifiers such as adjectives and adverbs.
  - \`startMs\`/\`endMs\`: the span of speech that expresses the idea. Use the source-line timings — start at the first contributing line's start, end at the last contributing line's end. Keep units in chronological order and non-overlapping.
  - \`idea\`: a short, plain rephrasing in ${lang} of WHAT is being communicated (the meaning), not a literal transcription. Drop filler, hedges, and asides.

Cover the whole video in order. Do not invent content that isn't in the transcript. Aim for caption-sized units — roughly one short sentence each.${custom}
</task>`;
}

/**
 * Extract timed idea units from a transcript. One LLM call over the full
 * transcript. Returns ordered, validated idea segments (text = the idea).
 * Falls back to the input lines if the model returns nothing usable.
 */
export async function extractCaptionIdeas(
  transcript: TranscriptLine[],
  opts: ExtractIdeasOptions = {},
): Promise<IdeaSegment[]> {
  if (transcript.length === 0) return [];

  const cfg = await settingsRepository.getLLMConfig("clinician");
  const provider = getStructuredProvider(cfg.provider);

  const minMs = Math.min(...transcript.map((l) => l.startMs));
  const maxMs = Math.max(...transcript.map((l) => l.endMs));

  const input: GPTInputItem[] = [
    {
      type: "message",
      role: "user",
      content:
        "Timed transcript lines:\n" +
        JSON.stringify(transcript.map((l, index) => ({ index, startMs: l.startMs, endMs: l.endMs, text: l.text }))),
    },
  ];

  const ideaInstructions = buildInstructions(opts);
  captionDebugSeparator(`IDEA PASS — ${transcript.length} transcript lines (${cfg.provider}/${cfg.model})`);
  captionDebug("SYSTEM INSTRUCTIONS (sent to model)", ideaInstructions);
  captionDebug("USER INPUT (sent to model)", input);

  const response = await provider.structuredComplete({
    model: cfg.model,
    input,
    instructions: ideaInstructions,
    schemaName: "CaptionIdeas",
    schema: IDEAS_SCHEMA,
    temperature: 0.4,
    maxTokens: 4096,
  });

  captionDebug("RAW MODEL RESPONSE content", response.content);

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
      label: "video-caption-ideas",
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
      console.error("[captionIdeaService] content was not valid JSON:", String(parsed).slice(0, 200));
      return [];
    }
  }
  const ideas = parsed?.ideas;
  if (!Array.isArray(ideas)) return [];

  const out: IdeaSegment[] = [];
  for (const entry of ideas) {
    if (
      !entry ||
      typeof entry.idea !== "string" ||
      entry.idea.trim() === "" ||
      typeof entry.startMs !== "number" ||
      typeof entry.endMs !== "number"
    ) {
      continue;
    }
    // Clamp to the transcript's span and ensure a positive duration.
    const startMs = Math.max(minMs, Math.round(entry.startMs));
    let endMs = Math.round(entry.endMs);
    if (endMs <= startMs) endMs = startMs + 1;
    endMs = Math.min(maxMs, Math.max(endMs, startMs + 1));
    out.push({ startMs, endMs, text: entry.idea.trim() });
  }

  out.sort((a, b) => a.startMs - b.startMs);
  return out;
}
