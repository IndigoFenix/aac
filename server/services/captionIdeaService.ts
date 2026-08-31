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
import type { DisclosureContext } from "./processorDisclosure";

/** One word with its timing — supplied by the STT path so the idea pass can
 *  split on REAL word boundaries instead of estimating sub-line timings. */
export interface TimedWord {
  text: string;
  startMs: number;
  endMs: number;
}

/** A timed transcript line in (from STT or a caption file). `words` is present
 *  only on the STT path; with it, splitting uses exact word timings. */
export interface TranscriptLine {
  startMs: number;
  endMs: number;
  text: string;
  words?: TimedWord[];
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
      description:
        "Ordered, non-overlapping idea units (small subject-verb-object chunks or short fragments) covering the video. Usually MORE units than source lines — split sentences aggressively.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["startMs", "endMs", "idea"],
        properties: {
          startMs: { type: "integer", description: "Start (ms) of when this chunk is spoken. For a sub-line split, a consecutive sub-range of the source line's span." },
          endMs: { type: "integer", description: "End (ms) of when this chunk is spoken. Must be > startMs and not overlap the next unit." },
          idea: {
            type: "string",
            description: "Short rephrasing of ONE small idea — a subject-verb-object chunk or fragment (the meaning, not the literal words).",
          },
        },
      },
    },
  },
};

// Above this many words the numbered-word prompt gets unwieldy, so we fall back
// to ms mode (proportional estimation) to keep the single call's prompt sane.
const WORD_MODE_MAX_WORDS = 1500;

// Word-index mode: the model selects the SOURCE word range each chunk covers,
// and we compute exact ms from the words. Avoids the model doing millisecond
// math and lands splits on real word boundaries.
const IDEAS_WORD_SCHEMA: JSONSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ideas"],
  properties: {
    ideas: {
      type: "array",
      description:
        "Ordered idea units (small subject-verb-object chunks or short fragments) covering the words in order. Usually MORE units than source lines — split aggressively.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["startWord", "endWord", "idea"],
        properties: {
          startWord: { type: "integer", description: "Global index of the FIRST transcript word this chunk covers." },
          endWord: { type: "integer", description: "Global index of the LAST transcript word this chunk covers (>= startWord)." },
          idea: {
            type: "string",
            description: "Short rephrasing of ONE small idea — a subject-verb-object chunk or fragment (the meaning, not the literal words).",
          },
        },
      },
    },
  },
};

function buildInstructions(opts: ExtractIdeasOptions, mode: "ms" | "word"): string {
  const lang = opts.language || "the caption language";
  const custom = opts.customInstructions?.trim()
    ? `\n\nAdditional instructions from the user (honor these):\n${opts.customInstructions.trim()}`
    : "";
  const intro = mode === "word"
    ? `You are the FIRST pass of a video-captioning pipeline for non-verbal AAC users. You receive the full transcript of a video as a sequence of WORDS, each prefixed with its global \`[index]\`. Line breaks mark the recognizer's natural phrase groupings.`
    : `You are the FIRST pass of a video-captioning pipeline for non-verbal AAC users. You receive the full timed transcript of a video as numbered lines, each with start/end times in milliseconds.`;
  const timingBullet = mode === "word"
    ? `  - \`startWord\`/\`endWord\`: the GLOBAL \`[index]\` of the FIRST and LAST source words this chunk covers (endWord >= startWord). Cover words in spoken order; consecutive chunks must NOT overlap word ranges. The on-screen time is computed from those words — do NOT output milliseconds, just the word indices.`
    : `  - \`startMs\`/\`endMs\`: WHEN that chunk is spoken.
      • A unit that covers a whole source line → use that line's start/end.
      • When you split ONE source line into several units, divide that line's [start, end] span into CONSECUTIVE, NON-OVERLAPPING sub-ranges in spoken order, roughly proportional to each chunk's share of the words. (e.g. a line 1000–3000ms split into two even chunks → 1000–2000 and 2000–3000.)
      • Units must stay in chronological order and never overlap.`;
  return `<task>
${intro}

Break the speech into a sequence of SMALL idea units — each a single subject–verb–object chunk (who does what to whom/what) or a short standalone fragment — and decide WHEN each appears, so an AAC user follows along one bite-sized thought at a time. Output an ordered list of idea units. Each unit:
  - is ONE small idea: ideally a subject + verb + object with its adjectives/adverbs ("Mom drove the red car"), OR a short standalone fragment when that's the natural unit ("at the park", "every morning", "because it's late", "yes!").
  - SPLIT AGGRESSIVELY — prefer MORE, SMALLER units over fewer big ones. A single spoken sentence usually becomes SEVERAL units. Break on clauses, conjunctions (and / but / so / because / then), relative clauses, and list items:
      • "Mom went to the store and bought apples" → "Mom went to the store" + "she bought apples".
      • "I'm tired but I want to keep playing" → "I'm tired" + "I want to keep playing".
    Only KEEP together words that make no sense apart (a verb and its object, a noun and its adjective).
  - is a simplified rephrasing in the VOICE of the speaker ("we should go to the park", NOT "the speaker thinks going to the park is good"), keeping the original purpose and tone. Drop filler, hedges, and asides.
${timingBullet}
  - READABILITY: keep each unit on screen long enough to read. Don't make a unit out of a single tiny word — merge it with its neighbour.
  - \`idea\`: the short rephrasing in ${lang} (the meaning, not a literal transcription).

Cover the whole video in order. Do not invent content that isn't in the transcript.${custom}
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

  // WORD MODE: when every line carries word timings (STT path) and the total is
  // bounded, let the model pick split points by WORD INDEX and compute exact ms
  // from the words — no proportional guessing. Otherwise (SRT/VTT, or a very
  // long transcript) fall back to MS MODE (model estimates sub-line timings).
  const totalWords = transcript.reduce((n, l) => n + (l.words?.length ?? 0), 0);
  const useWords = transcript.every((l) => (l.words?.length ?? 0) > 0) && totalWords > 0 && totalWords <= WORD_MODE_MAX_WORDS;

  // Flat, globally-indexed word list (word mode only) — the model references
  // these [index] numbers, and we map index → exact ms after.
  const globalWords: TimedWord[] = [];
  let input: GPTInputItem[];
  if (useWords) {
    const lines = transcript.map((l) => {
      const toks = (l.words ?? []).map((w) => {
        const idx = globalWords.length;
        globalWords.push(w);
        return `[${idx}]${w.text}`;
      });
      return toks.join(" ");
    });
    input = [{
      type: "message",
      role: "user",
      content: "Transcript as timed WORDS — use these [index] numbers for startWord/endWord:\n" + lines.join("\n"),
    }];
  } else {
    input = [{
      type: "message",
      role: "user",
      content:
        "Timed transcript lines:\n" +
        JSON.stringify(transcript.map((l, index) => ({ index, startMs: l.startMs, endMs: l.endMs, text: l.text }))),
    }];
  }

  const mode = useWords ? "word" : "ms";
  const ideaInstructions = buildInstructions(opts, mode);
  captionDebugSeparator(`IDEA PASS — ${transcript.length} lines, ${mode} mode${useWords ? ` (${globalWords.length} words)` : ""} (${cfg.provider}/${cfg.model})`);
  captionDebug("SYSTEM INSTRUCTIONS (sent to model)", ideaInstructions);
  captionDebug("USER INPUT (sent to model)", input);

  const response = await provider.structuredComplete({
    // AKIM §18.5 — a video transcript of the student is PHI leaving for the
    // clinician-path processor.
    disclosure: {
      studentId: opts.studentId ?? null,
      sessionId: opts.sessionId ?? null,
      userId: opts.userId ?? null,
      instituteId: opts.instituteId ?? null,
      useCase: "clinician",
    } satisfies DisclosureContext,
    // Background: caption ideas are precomputed, not awaited.
    background: true,
    model: cfg.model,
    input,
    instructions: ideaInstructions,
    schemaName: "CaptionIdeas",
    schema: useWords ? IDEAS_WORD_SCHEMA : IDEAS_SCHEMA,
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
      // The model output is built over the video transcript — size only on stdout.
      console.error("[captionIdeaService] content was not valid JSON:", String(parsed).length, "chars");
      return [];
    }
  }
  const ideas = parsed?.ideas;
  if (!Array.isArray(ideas)) return [];

  const out: IdeaSegment[] = [];
  for (const entry of ideas) {
    if (!entry || typeof entry.idea !== "string" || entry.idea.trim() === "") continue;

    let startMs: number;
    let endMs: number;
    if (useWords) {
      // Word mode — map the chosen word range to exact ms from the words.
      if (typeof entry.startWord !== "number" || typeof entry.endWord !== "number") continue;
      const n = globalWords.length;
      const s = Math.max(0, Math.min(n - 1, Math.round(entry.startWord)));
      const e = Math.max(s, Math.min(n - 1, Math.round(entry.endWord)));
      startMs = globalWords[s].startMs;
      endMs = globalWords[e].endMs;
    } else {
      // Ms mode — the model estimated the span; clamp it.
      if (typeof entry.startMs !== "number" || typeof entry.endMs !== "number") continue;
      startMs = Math.round(entry.startMs);
      endMs = Math.round(entry.endMs);
    }
    // Clamp to the transcript's span and ensure a positive duration.
    startMs = Math.max(minMs, startMs);
    if (endMs <= startMs) endMs = startMs + 1;
    endMs = Math.min(maxMs, Math.max(endMs, startMs + 1));
    out.push({ startMs, endMs, text: entry.idea.trim() });
  }

  out.sort((a, b) => a.startMs - b.startMs);

  // Safety net: finer SVO/fragment splitting makes overlaps likelier, and two
  // captions claiming the same instant would render ambiguously (the client
  // picks the first interval covering a time). Force consecutive non-overlap by
  // clamping each unit's start to the previous unit's end.
  for (let i = 1; i < out.length; i++) {
    if (out[i].startMs < out[i - 1].endMs) out[i].startMs = out[i - 1].endMs;
    if (out[i].endMs <= out[i].startMs) out[i].endMs = out[i].startMs + 1;
  }
  return out;
}
