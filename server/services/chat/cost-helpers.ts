import { getModelOption, type LLMProviderKey } from "@shared/llm-options";

/*
Unused right now, but don't delete it - will be needed when we re-enable prepaid credits system.

const ORIGNAL_DOLLARS_PER_CREDIT = 0.00026;
const PROFIT_MARGIN = 1.3;
const DOLLARS_PER_CREDIT = ORIGNAL_DOLLARS_PER_CREDIT / PROFIT_MARGIN;

const ChargeToCredits = (charge: number) => {
    return charge / DOLLARS_PER_CREDIT;
}
*/

export const CREDITS_PER_WEB_SEARCH = 2;

const MILLION = 1000000;

const ChargeToCredits = (charge: number) => {
    return charge;
}

// Fallback rates used when a (provider, model) pair is NOT found in the
// MODEL_OPTIONS catalog. Previously these were gpt-4o-mini rates ($0.15/$0.60),
// which massively under-billed Claude usage (our real calls go to Claude Haiku
// or pricier). We default to Claude Haiku rates instead so an unrecognized model
// at least produces a figure in the right ballpark. A miss is still a BUG — the
// catalog and the configured model id must be kept in sync — so we log loudly.
const FALLBACK_INPUT_PER_1M  = 0.80;  // Claude Haiku input
const FALLBACK_OUTPUT_PER_1M = 4.00;  // Claude Haiku output

/**
 * Look up a model's catalog entry. When it is missing, log a loud warning
 * (the cost of an unrecognized model is being estimated, not measured) and
 * return Claude-Haiku fallback rates. Returns the resolved input/output rates
 * plus the raw option (which may be undefined) so callers can read extra
 * fields (e.g. audio rates) when present.
 */
const warnedUnknownModels = new Set<string>();
const resolveModelRates = (provider: LLMProviderKey, model: string) => {
    const option = getModelOption(provider, model);
    if (!option) {
        // Dedupe: log once per (provider, model) per process so a recurring
        // mismatch (e.g. an agent-prefixed model id) can't spam the logs.
        const key = `${provider}/${model}`;
        if (!warnedUnknownModels.has(key)) {
            warnedUnknownModels.add(key);
            console.error(
                `[cost-helpers] ⚠ UNRECOGNIZED MODEL "${key}" — not in MODEL_OPTIONS catalog. ` +
                `Billing at Claude-Haiku fallback rates ($${FALLBACK_INPUT_PER_1M}/$${FALLBACK_OUTPUT_PER_1M} per 1M). ` +
                `This is an estimate, not the true cost. Add the model to the catalog or fix the configured model id.`
            );
        }
    }
    return {
        option,
        inputPer1M:  option?.inputCostPer1M  ?? FALLBACK_INPUT_PER_1M,
        outputPer1M: option?.outputCostPer1M ?? FALLBACK_OUTPUT_PER_1M,
    };
};

// Anthropic prompt-cache multipliers (relative to base input rate):
//   cache write (creation) = 1.25x, cache read = 0.10x.
const CLAUDE_CACHE_WRITE_MULT = 1.25;
const CLAUDE_CACHE_READ_MULT  = 0.10;
// OpenAI bills cached input reads at 0.50x base.
const OPENAI_CACHE_READ_MULT  = 0.50;
// Gemini implicit cache reads bill at 0.25x base (Gemini 2.5 Flash/Pro).
const GEMINI_CACHE_READ_MULT  = 0.25;

/**
 * Calculate credits for a specific provider+model using the MODEL_OPTIONS catalog.
 * Falls back to Claude-Haiku rates (with a loud warning) if the model is not found.
 *
 * Token-accounting differs by provider:
 *  - Anthropic: `promptTokens` (input_tokens) EXCLUDES both cache reads and cache
 *    writes. So we bill input_tokens at 1x, cache *writes* at 1.25x, and cache
 *    *reads* at 0.1x — all additive. (Previously cache writes were dropped
 *    entirely and cache reads were wrongly subtracted from input_tokens.)
 *  - OpenAI/Gemini: `promptTokens` INCLUDES cached reads, so we subtract them and
 *    bill the remainder at 1x and the cached reads at 0.5x. They don't report a
 *    separate cache-write bucket.
 */
export const creditsForModelUsage = (
    provider: LLMProviderKey,
    model: string,
    promptTokens: number,
    completionTokens: number,
    cachedTokens: number = 0,
    cacheCreationTokens: number = 0,
): number => {
    const { inputPer1M, outputPer1M } = resolveModelRates(provider, model);

    const creditsPerInput  = ChargeToCredits(inputPer1M / MILLION);
    const creditsPerOutput = ChargeToCredits(outputPer1M / MILLION);

    const completionCharge = completionTokens * creditsPerOutput;

    let inputCharge: number;
    if (provider === "claude") {
        // input_tokens is already the non-cached, freshly-processed input.
        inputCharge =
            promptTokens * creditsPerInput +
            cacheCreationTokens * creditsPerInput * CLAUDE_CACHE_WRITE_MULT +
            cachedTokens * creditsPerInput * CLAUDE_CACHE_READ_MULT;
    } else {
        // OpenAI + Gemini both report `promptTokens` INCLUDING cached
        // reads, so split them out. Discount differs by provider — Gemini
        // 2.5's implicit caching bills at 0.25x; OpenAI at 0.50x.
        const cacheReadMult = provider === "gemini" ? GEMINI_CACHE_READ_MULT : OPENAI_CACHE_READ_MULT;
        const fullPromptTokens = Math.max(0, promptTokens - cachedTokens);
        inputCharge =
            fullPromptTokens * creditsPerInput +
            cachedTokens * creditsPerInput * cacheReadMult;
    }

    return inputCharge + completionCharge;
};

/**
 * Modality-aware usage breakdown (one turn of a Live API session).
 * Non-text input modalities (image, video) share the audio rate on Gemini
 * Live models, so we sum them into a single non-text bucket.
 */
export interface LiveUsageBreakdown {
    textInputTokens: number;
    nonTextInputTokens: number; // audio + image + video
    textOutputTokens: number;
    audioOutputTokens: number;
    cachedInputTokens?: number; // text input only; cached audio is rare
}

/**
 * Calculate credits for a Live API turn using modality-separated token
 * counts. When the model has no audio pricing configured, non-text tokens
 * are billed at the flat input rate (matches legacy behavior for safety).
 */
export const creditsForLiveUsage = (
    provider: LLMProviderKey,
    model: string,
    usage: LiveUsageBreakdown,
): number => {
    const { option, inputPer1M: textInputPer1M, outputPer1M: textOutputPer1M } =
        resolveModelRates(provider, model);
    // Audio/non-text rates fall back to text rates when the catalog entry
    // doesn't provide them (e.g. non-live models getting a Live usage event).
    const audioInputPer1M  = option?.audioInputCostPer1M   ?? textInputPer1M;
    const audioOutputPer1M = option?.audioOutputCostPer1M  ?? textOutputPer1M;

    const per = (rate: number, tokens: number) =>
        ChargeToCredits((rate / MILLION) * tokens);

    const cached = usage.cachedInputTokens ?? 0;
    const cacheDiscount = provider === "claude" ? 0.1 : 0.5;
    const textInputBillable = Math.max(0, usage.textInputTokens - cached);

    return (
        per(textInputPer1M,  textInputBillable) +
        per(textInputPer1M,  cached) * cacheDiscount +
        per(audioInputPer1M, usage.nonTextInputTokens) +
        per(textOutputPer1M,  usage.textOutputTokens) +
        per(audioOutputPer1M, usage.audioOutputTokens)
    );
};

// ---------------------------------------------------------------------------
// TTS pricing — flat per-1000-char rates per provider, approximate.
// ---------------------------------------------------------------------------
//
// Sources (as of 2026):
//   - ElevenLabs Flash v2:        ~$0.30 per 1k chars
//   - Gemini 2.5 Flash TTS:       ~$0.10 per 1k chars (output tokens equivalent)
//   - Google Cloud TTS Standard:  ~$0.004 per 1k chars
//   - OpenAI TTS:                 ~$0.015 per 1k chars
//
// These are rough. The catalog doesn't carry TTS rates today, so we hard-
// code per-provider rates here. Refine later by reading per-voice tier
// from the voice config (Standard vs Studio for Google, Flash vs Multi
// for ElevenLabs, etc.).
export type TtsProvider = "elevenlabs" | "gemini-live" | "gemini" | "google" | "openai";

const TTS_USD_PER_1K_CHARS: Record<TtsProvider, number> = {
    "elevenlabs":  0.30,
    "gemini-live": 0.10,
    "gemini":      0.10,
    "google":      0.004,
    "openai":      0.015,
};

/**
 * Calculate credits for one TTS synthesis. Charged per character of input
 * text — actual audio length doesn't matter to the providers' billing.
 */
export const creditsForTtsUsage = (
    provider: TtsProvider,
    characters: number,
): number => {
    if (characters <= 0) return 0;
    const ratePer1k = TTS_USD_PER_1K_CHARS[provider] ?? TTS_USD_PER_1K_CHARS.gemini;
    return ChargeToCredits((ratePer1k / 1000) * characters);
};

// Google Cloud Speech-to-Text v1 standard model, ~$0.024/min. Charged by audio
// duration (the only metric STT bills on).
const STT_USD_PER_MINUTE = 0.024;

/** Credits for a speech-to-text run, by audio duration in seconds. */
export const creditsForSttUsage = (seconds: number): number => {
    if (seconds <= 0) return 0;
    return ChargeToCredits((STT_USD_PER_MINUTE / 60) * seconds);
};

// number of credits to charge for ONE web_search_preview tool call
export const CreditsPerSearchByIntelligence = (
    intelligence: 0|1|2|3,           // 0 = mini, 1 = mini, 2 = 4o, 3 = o3-pro
    contextSize: 1|2|3               // 1=low  2=med  3=high
  ) => {
    if (intelligence === 0) intelligence = 1;
    // $ surcharge per call from OpenAI’s table  (Jul-2025)
    const surchargeUSD = {
      1: [0.003, 0.006, 0.012],      // 4o-mini-search
      2: [0.03 , 0.06 , 0.12 ],      // 4o-search
      3: [0.06 , 0.12 , 0.24 ]       // o3-pro, same ×2 guess until OpenAI posts
    }[intelligence][contextSize-1];
  
    return ChargeToCredits(surchargeUSD);
  };