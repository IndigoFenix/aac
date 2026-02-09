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
    const cachedPromptCharge = cachedTokens * (creditsPerInput / 2);
    const completionCharge   = completionTokens * creditsPerOutput;

    return fullPromptCharge + cachedPromptCharge + completionCharge;
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