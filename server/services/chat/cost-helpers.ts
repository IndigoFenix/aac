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

/**
 * Calculate credits for a specific provider+model using the MODEL_OPTIONS catalog.
 * Falls back to gpt-4o-mini rates if the model is not found.
 */
export const creditsForModelUsage = (
    provider: LLMProviderKey,
    model: string,
    promptTokens: number,
    completionTokens: number,
    cachedTokens: number = 0,
): number => {
    const option = getModelOption(provider, model);
    // Fallback: gpt-4o-mini rates
    const inputPer1M  = option?.inputCostPer1M  ?? 0.15;
    const outputPer1M = option?.outputCostPer1M ?? 0.60;

    const creditsPerInput  = ChargeToCredits(inputPer1M / MILLION);
    const creditsPerOutput = ChargeToCredits(outputPer1M / MILLION);

    const fullPromptCharge   = (promptTokens - cachedTokens) * creditsPerInput;
    // Anthropic charges cached reads at 10% of base; OpenAI at 50%
    const cacheDiscount = provider === "claude" ? 0.1 : 0.5;
    const cachedPromptCharge = cachedTokens * (creditsPerInput * cacheDiscount);
    const completionCharge   = completionTokens * creditsPerOutput;

    return fullPromptCharge + cachedPromptCharge + completionCharge;
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
    const option = getModelOption(provider, model);
    const textInputPer1M   = option?.inputCostPer1M        ?? 0.15;
    const textOutputPer1M  = option?.outputCostPer1M       ?? 0.60;
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